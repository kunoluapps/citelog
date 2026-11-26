// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { FetchLike } from '../../src/types.js';

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/engines/${name}`, import.meta.url), 'utf8')) as unknown;

export interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type Reply = { status?: number; body: unknown; headers?: Record<string, string> } | ((req: Recorded) => Promise<Response> | Response);

export const ENGINE_HOSTS = ['api.openai.com', 'api.anthropic.com', 'api.perplexity.ai', 'generativelanguage.googleapis.com'];

/**
 * A fetch that serves replies per host in order (the last reply repeats), records every request
 * and fails the test if anything other than an engine host is called.
 */
export function fakeFetch(replies: Record<string, Reply[]>) {
  const calls: Recorded[] = [];
  const served = new Map<string, number>();
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    expect(ENGINE_HOSTS).toContain(url.host);
    expect(init?.method).toBe('POST');
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const req: Recorded = { url: input, headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    calls.push(req);
    const list = replies[url.host];
    if (!list || list.length === 0) throw new Error(`no reply for ${url.host}`);
    const n = served.get(url.host) ?? 0;
    served.set(url.host, n + 1);
    const reply = list[Math.min(n, list.length - 1)]!;
    if (typeof reply === 'function') return reply(req);
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

export const errorBody = (message: string, code?: string) => ({ error: { message, ...(code ? { code, type: code } : {}) } });
