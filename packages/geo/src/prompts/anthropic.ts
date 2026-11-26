// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { TokenUsage } from '@morningdesk/core';
import { EngineError } from '../types.js';
import type { Citation, EngineAnswer } from '../types.js';
import { arr, badResponse, costFor, num, obj, postJson, str } from './http.js';
import type { CallContext, Json } from './http.js';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2026-10-21';
const MAX_PAUSE_RESENDS = 2;

export function anthropicRequest(prompt: string, model: string, assistant?: unknown[]) {
  const messages: { role: string; content: unknown }[] = [{ role: 'user', content: prompt }];
  if (assistant) messages.push({ role: 'assistant', content: assistant });
  return {
    model,
    max_tokens: 2048,
    messages,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'US' } }],
  };
}

interface Turn {
  content: unknown[];
  stop: string | undefined;
  usage: TokenUsage;
  searches: number;
  model: string | undefined;
}

function readTurn(body: unknown): Turn {
  const root = obj(body);
  if (!root || !Array.isArray(root.content)) throw badResponse('anthropic', 'no content[]');
  const u = obj(root.usage) ?? {};
  return {
    content: root.content,
    stop: str(root.stop_reason),
    usage: {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheWriteTokens: num(u.cache_creation_input_tokens),
    },
    searches: num(obj(u.server_tool_use)?.web_search_requests),
    model: str(root.model),
  };
}

/**
 * Messages API: content[type=text].citations[type=web_search_result_location] are cited; every
 * web_search_tool_result.content[type=web_search_result] is a source the model retrieved (deduplicated by URL
 * across searches and paused turns).
 */
export function parseAnthropic(content: unknown[], model: string, usage: TokenUsage | undefined, searches: number): EngineAnswer {
  const texts: string[] = [];
  const citations: Citation[] = [];
  const sources: Citation[] = [];
  const seen = new Set<string>();
  const searchErrors: string[] = [];
  let searchResults = 0;
  for (const raw of content) {
    const block = obj(raw);
    if (!block) continue;
    if (block.type === 'text') {
      const text = str(block.text);
      if (text) texts.push(text);
      for (const c of arr(block.citations)) {
        const cit = obj(c);
        const url = str(cit?.url);
        if (cit?.type === 'web_search_result_location' && url) citations.push({ url, title: str(cit.title) });
      }
    } else if (block.type === 'web_search_tool_result') {
      const err: Json | undefined = obj(block.content);
      if (err?.type === 'web_search_tool_result_error') {
        searchErrors.push(str(err.error_code) ?? 'unknown');
        continue;
      }
      searchResults++;
      for (const r of arr(block.content)) {
        const res = obj(r);
        const url = str(res?.url);
        if (res?.type !== 'web_search_result' || !url || seen.has(url)) continue;
        seen.add(url);
        sources.push({ url, title: str(res.title) });
      }
    }
  }
  if (citations.length === 0 && searchErrors.length > 0 && searchResults === 0) {
    const code = searchErrors[0] ?? 'unknown';
    throw new EngineError('anthropic', code === 'too_many_requests' ? 'rate_limited' : 'provider_error', `web search failed (${code})`);
  }
  return { engine: 'anthropic', model, text: texts.join(''), citations, sources, sourcesBy: 'page', usage, searches, costUsdMicros: costFor(model, usage, searches) };
}

export async function askAnthropic(prompt: string, ctx: CallContext): Promise<EngineAnswer> {
  const headers = { 'x-api-key': ctx.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' };
  let turn = readTurn(await postJson(ctx, ANTHROPIC_URL, headers, anthropicRequest(prompt, ctx.model)));
  const content = [...turn.content];
  const usage: TokenUsage = { ...turn.usage };
  let searches = turn.searches;
  for (let i = 0; i < MAX_PAUSE_RESENDS && turn.stop === 'pause_turn'; i++) {
    turn = readTurn(await postJson(ctx, ANTHROPIC_URL, headers, anthropicRequest(prompt, ctx.model, content)));
    content.push(...turn.content);
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (turn.usage.cacheReadTokens ?? 0);
    usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (turn.usage.cacheWriteTokens ?? 0);
    searches += turn.searches;
  }
  return parseAnthropic(content, ctx.model, usage, searches);
}

export function parseAnthropicBody(body: unknown, model: string): EngineAnswer {
  const turn = readTurn(body);
  return parseAnthropic(turn.content, turn.model ?? model, turn.usage, turn.searches);
}
