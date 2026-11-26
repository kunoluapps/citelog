// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { usdToMicros } from '@morningdesk/core';
import type { TokenUsage, UsdMicros } from '@morningdesk/core';
import type { Citation, EngineAnswer } from '../types.js';
import { arr, badResponse, costFor, num, obj, postJson, str } from './http.js';
import type { CallContext, Json } from './http.js';
import { cleanUrl } from './cited.js';

export const PERPLEXITY_URL = 'https://api.perplexity.ai/v1/agent';

export function perplexityRequest(prompt: string, model: string) {
  return { model, input: prompt, tools: [{ type: 'web_search' }] };
}

function usageOf(u: Json | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  return { inputTokens: num(u.input_tokens ?? u.prompt_tokens), outputTokens: num(u.output_tokens ?? u.completion_tokens) };
}

function reportedCost(u: Json | undefined): UsdMicros | undefined {
  const c = obj(u?.cost);
  return typeof c?.total_cost === 'number' ? usdToMicros(c.total_cost) : undefined;
}

function dedupe(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

/**
 * Perplexity's docs don't say whether search_results lists results the answer didn't cite. The results count as
 * considered sources only when they show at least one URL beyond the citations; otherwise retrieved can't be told
 * from cited and the sources are not collected (null).
 */
function sourcesBeyondCitations(results: Citation[], citations: Citation[]): Citation[] | null {
  const cited = new Set(citations.map((c) => cleanUrl(c.url)));
  const all = dedupe(results);
  return all.some((r) => !cited.has(cleanUrl(r.url))) ? all : null;
}

/** Agent API: annotations[].url when present, else search_results ids named as [n] in the text. */
function parseAgent(root: Json, model: string): EngineAnswer {
  const status = str(root.status);
  if (status !== undefined && status !== 'completed') throw badResponse('perplexity', `status "${status}"`);
  const results = new Map<number, Citation>();
  const retrieved: Citation[] = [];
  const texts: string[] = [];
  const annotated: Citation[] = [];
  let searches = 0;
  for (const raw of arr(root.output)) {
    const item = obj(raw);
    if (!item) continue;
    if (item.type === 'search_results') {
      searches += Math.max(1, arr(item.queries).length);
      for (const r of arr(item.results)) {
        const res = obj(r);
        const url = str(res?.url);
        if (!res || !url) continue;
        retrieved.push({ url, title: str(res.title) });
        if (typeof res.id === 'number') results.set(res.id, { url, title: str(res.title) });
      }
    } else if (item.type === 'message') {
      for (const c of arr(item.content)) {
        const part = obj(c);
        if (!part || part.type !== 'output_text') continue;
        const text = str(part.text);
        if (text) texts.push(text);
        for (const a of arr(part.annotations)) {
          const ann = obj(a);
          const url = str(ann?.url);
          if (url) annotated.push({ url, title: str(ann?.title) });
        }
      }
    }
  }
  const text = texts.join('');
  const citations = annotated;
  if (citations.length === 0) {
    for (const m of text.matchAll(/\[(\d+)\]/g)) {
      const hit = results.get(Number(m[1]));
      if (hit) citations.push(hit);
    }
  }
  const u = obj(root.usage);
  const usage = usageOf(u);
  const cost = reportedCost(u) ?? costFor(model, usage, searches);
  const cited = dedupe(citations);
  return {
    engine: 'perplexity',
    model: str(root.model) ?? model,
    text,
    citations: cited,
    sources: sourcesBeyondCitations(retrieved, cited),
    sourcesBy: 'page',
    usage,
    searches,
    costUsdMicros: cost,
  };
}

/** Old Sonar chat completions shape: choices[0].message.content and top-level citations[] strings. */
function parseSonar(root: Json, model: string): EngineAnswer {
  const choice = obj(arr(root.choices)[0]);
  const text = str(obj(choice?.message)?.content);
  if (text === undefined) throw badResponse('perplexity', 'no choices[0].message.content');
  const titles = new Map<string, string | undefined>();
  const retrieved: Citation[] = [];
  for (const r of arr(root.search_results)) {
    const res = obj(r);
    const url = str(res?.url);
    if (!url) continue;
    titles.set(url, str(res?.title));
    retrieved.push({ url, title: str(res?.title) });
  }
  const citations: Citation[] = [];
  for (const c of arr(root.citations)) {
    const url = str(c);
    if (url) citations.push({ url, title: titles.get(url) });
  }
  const u = obj(root.usage);
  const usage = usageOf(u);
  const cost = reportedCost(u) ?? costFor(model, usage, 1);
  const cited = dedupe(citations);
  return {
    engine: 'perplexity',
    model: str(root.model) ?? model,
    text,
    citations: cited,
    sources: sourcesBeyondCitations(retrieved, cited),
    sourcesBy: 'page',
    usage,
    costUsdMicros: cost,
  };
}

export function parsePerplexity(body: unknown, model: string): EngineAnswer {
  const root = obj(body);
  if (!root) throw badResponse('perplexity', 'not an object');
  if (Array.isArray(root.choices)) return parseSonar(root, model);
  if (Array.isArray(root.output)) return parseAgent(root, model);
  throw badResponse('perplexity', 'neither output[] nor choices[]');
}

export async function askPerplexity(prompt: string, ctx: CallContext): Promise<EngineAnswer> {
  const body = await postJson(
    ctx,
    PERPLEXITY_URL,
    { authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' },
    perplexityRequest(prompt, ctx.model),
  );
  return parsePerplexity(body, ctx.model);
}
