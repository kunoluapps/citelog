// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { TokenUsage } from '@morningdesk/core';
import type { Citation, EngineAnswer } from '../types.js';
import { arr, badResponse, costFor, num, obj, postJson, str } from './http.js';
import type { CallContext } from './http.js';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

export function geminiUrl(model: string): string {
  return `${GEMINI_BASE}${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
}

export function geminiRequest(prompt: string) {
  return { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] };
}

/**
 * generateContent: candidates[0].groundingMetadata. Chunks named by any groundingSupports entry are cited; every chunk
 * is a source. Chunk URIs are Google redirect links; they are returned as given and never fetched, so sources are
 * known by host only (from the chunk title). When no chunk is left unreferenced, retrieved can't be told from cited
 * and the sources are not collected (null).
 */
export function parseGemini(body: unknown, model: string): EngineAnswer {
  const root = obj(body);
  const cand = obj(arr(root?.candidates)[0]);
  if (!root || !cand) throw badResponse('gemini', 'no candidates[0]');
  const text = arr(obj(cand.content)?.parts)
    .map((p) => str(obj(p)?.text) ?? '')
    .join('');
  const gm = obj(cand.groundingMetadata);
  const chunks = arr(gm?.groundingChunks).map((c) => obj(obj(c)?.web));
  const order: number[] = [];
  for (const s of arr(gm?.groundingSupports)) {
    for (const i of arr(obj(s)?.groundingChunkIndices)) {
      if (typeof i === 'number' && !order.includes(i)) order.push(i);
    }
  }
  const citations: Citation[] = [];
  for (const i of order) {
    const web = chunks[i];
    const url = str(web?.uri);
    if (url) citations.push({ url, title: str(web?.title) });
  }
  const sources: Citation[] = [];
  for (const web of chunks) {
    const url = str(web?.uri);
    if (url) sources.push({ url, title: str(web?.title) });
  }
  const unreferenced = chunks.some((web, i) => str(web?.uri) !== undefined && !order.includes(i));
  const u = obj(root.usageMetadata);
  const usage: TokenUsage | undefined = u
    ? {
        inputTokens: Math.max(0, num(u.promptTokenCount) - num(u.cachedContentTokenCount)),
        outputTokens: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount),
        cacheReadTokens: num(u.cachedContentTokenCount),
      }
    : undefined;
  const searches = arr(gm?.webSearchQueries).length;
  return { engine: 'gemini', model: str(root.modelVersion) ?? model, text, citations, sources: unreferenced ? sources : null, sourcesBy: 'host', usage, searches, costUsdMicros: costFor(model, usage, searches) };
}

export async function askGemini(prompt: string, ctx: CallContext): Promise<EngineAnswer> {
  const body = await postJson(
    ctx,
    geminiUrl(ctx.model),
    { 'x-goog-api-key': ctx.apiKey, 'content-type': 'application/json' },
    geminiRequest(prompt),
  );
  return parseGemini(body, ctx.model);
}
