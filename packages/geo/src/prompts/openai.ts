// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { TokenUsage } from '@morningdesk/core';
import type { Citation, EngineAnswer } from '../types.js';
import { arr, badResponse, costFor, num, obj, postJson, str } from './http.js';
import type { CallContext, Json } from './http.js';

export const OPENAI_URL = 'https://api.openai.com/v1/responses';

export function openaiRequest(prompt: string, model: string) {
  return {
    model,
    tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'US' } }],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    input: prompt,
  };
}

/**
 * `web_search_call.action.sources[]` (requested with `include`): the URLs the model consulted. Only `{type:"url", url}`
 * entries are read; labelled feeds (oai-weather and the like) carry no URL. A search action without the array means
 * the sources weren't returned, so the answer's sources are not collected (null).
 */
function readSources(action: Json | undefined, acc: Citation[] | null): Citation[] | null {
  const list = action?.sources;
  if (acc === null || !Array.isArray(list)) return null;
  for (const s of list) {
    const src = obj(s);
    const url = str(src?.url);
    if (src?.type === 'url' && url) acc.push({ url, title: str(src.title) });
  }
  return acc;
}

/** Responses API: output[type=message].content[type=output_text].annotations[type=url_citation]. */
export function parseOpenai(body: unknown, model: string): EngineAnswer {
  const root = obj(body);
  if (!root || !Array.isArray(root.output)) throw badResponse('openai', 'no output[]');
  if (str(root.status) === 'failed') throw badResponse('openai', 'status "failed"');
  const texts: string[] = [];
  const citations: Citation[] = [];
  let sources: Citation[] | null = [];
  let searches = 0;
  for (const raw of root.output) {
    const item = obj(raw);
    if (!item) continue;
    if (item.type === 'web_search_call') {
      const action = obj(item.action);
      if (!action || action.type === undefined || action.type === 'search') {
        searches++;
        sources = readSources(action, sources);
      }
      continue;
    }
    if (item.type !== 'message') continue;
    for (const c of arr(item.content)) {
      const part = obj(c);
      if (!part || part.type !== 'output_text') continue;
      const text = str(part.text);
      if (text) texts.push(text);
      for (const a of arr(part.annotations)) {
        const ann = obj(a);
        const url = str(ann?.url);
        if (ann?.type === 'url_citation' && url) citations.push({ url, title: str(ann.title) });
      }
    }
  }
  const u = obj(root.usage);
  let usage: TokenUsage | undefined;
  if (u) {
    const cached = num(obj(u.input_tokens_details)?.cached_tokens);
    usage = { inputTokens: Math.max(0, num(u.input_tokens) - cached), outputTokens: num(u.output_tokens), cacheReadTokens: cached };
  }
  const answerModel = str(root.model) ?? model;
  return { engine: 'openai', model: answerModel, text: texts.join(''), citations, sources, sourcesBy: 'page', usage, searches, costUsdMicros: costFor(model, usage, searches) };
}

export async function askOpenai(prompt: string, ctx: CallContext): Promise<EngineAnswer> {
  const body = await postJson(
    ctx,
    OPENAI_URL,
    { authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' },
    openaiRequest(prompt, ctx.model),
  );
  return parseOpenai(body, ctx.model);
}
