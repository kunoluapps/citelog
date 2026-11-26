// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { FetchLike } from '../../src/types.js';

export type Route =
  | { status?: number; body?: string | Uint8Array; headers?: Record<string, string> }
  | ((url: string, init?: RequestInit) => Promise<Response> | Response);

export interface FakeFetch {
  fetch: FetchLike;
  calls: { url: string; at: number; headers: Record<string, string> }[];
  maxInFlight: () => number;
}

/** A FetchLike over a route table. Unknown URLs get 404. Nothing reaches the network. */
export function fakeFetch(routes: Record<string, Route>, latencyMs = 0): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  let inFlight = 0;
  let max = 0;
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: input, at: Date.now(), headers });
    inFlight++;
    max = Math.max(max, inFlight);
    try {
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      const route = routes[input];
      if (typeof route === 'function') return await route(input, init);
      if (!route) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      const status = route.status ?? 200;
      const body = status === 204 || (status >= 300 && status < 400) ? null : (route.body ?? '');
      return new Response(body as ConstructorParameters<typeof Response>[0], { status, headers: route.headers ?? {} });
    } finally {
      inFlight--;
    }
  };
  return { fetch, calls, maxInFlight: () => max };
}

export const html = (body: string) => ({ body, headers: { 'content-type': 'text/html; charset=utf-8' } });
export const xml = (body: string) => ({ body, headers: { 'content-type': 'application/xml' } });
export const text = (body: string) => ({ body, headers: { 'content-type': 'text/plain' } });

export function urlset(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}\n</urlset>`;
}

export function sitemapIndex(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <sitemap><loc>${u}</loc></sitemap>`).join('\n')}\n</sitemapindex>`;
}
