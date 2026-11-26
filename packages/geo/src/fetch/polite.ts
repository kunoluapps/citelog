// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { GEO_TOOL_USER_AGENT } from '@morningdesk/core';
import type { CrawlOptions, FetchLike } from '../types.js';

export const DEFAULT_USER_AGENT = GEO_TOOL_USER_AGENT;
export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_DELAY_MS = 250;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

export interface FetchResult {
  /** URL as requested. */
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  /** HTTP status of the final response; null when nothing came back. */
  status: number | null;
  /** Response headers, lower-cased names. */
  headers: Record<string, string>;
  bytes: Uint8Array;
  /** Body decoded as UTF-8. */
  text: string;
  /** True when the body was cut at the size cap. */
  truncated: boolean;
  /** Why nothing usable came back: "timeout after 10 s", "more than 5 redirects", "redirects to other.example", a network error code. */
  error?: string;
  /** The failure won't change on a retry (a refused redirect). */
  final?: boolean;
}

/** Host without a leading "www.", lower-cased: example.com and www.example.com are one site. */
export function siteHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * Redirect rule (FIX-P1 M5): follow only http(s) redirects that stay on the site asked for. An off-site redirect is
 * reported ("redirects to other.example"), not followed, so robots.txt and llms.txt are never read from another origin
 * and a public page can't bounce the checker to a private address (the target itself may be local: `citelog check
 * http://localhost:3000`).
 */
export function refuseRedirect(from: string, to: URL): string | null {
  if (to.protocol !== 'http:' && to.protocol !== 'https:') return `redirects to a ${to.protocol.replace(/:$/, '')}: address`;
  let origin: URL;
  try {
    origin = new URL(from);
  } catch {
    return 'redirects from an invalid address';
  }
  if (siteHost(origin) !== siteHost(to)) return `redirects to ${to.host}`;
  return null;
}

function failed(url: string, finalUrl: string, status: number | null, error: string): FetchResult {
  return { url, finalUrl, status, headers: {}, bytes: new Uint8Array(0), text: '', truncated: false, error, final: true };
}

export interface PoliteFetcherOptions {
  fetch: FetchLike;
  concurrency?: number;
  delayMs?: number;
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Attempts per URL for timeouts, network errors and 5xx (default 2). */
  tries?: number;
}

interface HostState {
  active: number;
  /** When the last request to this host actually started (ms). */
  lastStart: number;
  /** Starts pass through this chain one at a time, so real start times keep the gap even when a timer fires late. */
  gate: Promise<void>;
  waiters: (() => void)[];
}

class TimeoutError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : Number(s.toFixed(2))} s`;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function networkErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    if (cause && typeof cause.code === 'string') return `network error (${cause.code})`;
    return err.message ? `network error (${err.message})` : 'network error';
  }
  return 'network error';
}

async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, truncated };
}

/**
 * Polite HTTP GET over an injected fetch: per-host concurrency and minimum gap between request starts, a timeout that
 * covers headers and body, manual redirects (at most 5), a body size cap, and one retry for timeouts, network errors and 5xx.
 */
export class PoliteFetcher {
  private readonly hosts = new Map<string, HostState>();
  private readonly fetchImpl: FetchLike;
  readonly concurrency: number;
  readonly delayMs: number;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly tries: number;

  constructor(opts: PoliteFetcherOptions) {
    this.fetchImpl = opts.fetch;
    this.concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
    this.delayMs = Math.max(0, opts.delayMs ?? DEFAULT_DELAY_MS);
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.tries = Math.max(1, opts.tries ?? 2);
  }

  static fromCrawlOptions(opts: CrawlOptions): PoliteFetcher {
    return new PoliteFetcher({
      fetch: opts.fetch,
      concurrency: opts.concurrency,
      delayMs: opts.delayMs,
      userAgent: opts.userAgent,
      timeoutMs: opts.timeoutMs,
    });
  }

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) {
      s = { active: 0, lastStart: 0, gate: Promise.resolve(), waiters: [] };
      this.hosts.set(host, s);
    }
    return s;
  }

  private async acquire(host: string): Promise<void> {
    const s = this.state(host);
    if (s.active >= this.concurrency) await new Promise<void>((resolve) => s.waiters.push(resolve));
    else s.active++;
    const turn = s.gate.then(async () => {
      const wait = s.lastStart + this.delayMs - Date.now();
      if (s.lastStart > 0 && wait > 0) await sleep(wait);
      s.lastStart = Date.now();
    });
    s.gate = turn;
    await turn;
  }

  private release(host: string): void {
    const s = this.state(host);
    const next = s.waiters.shift();
    if (next) next();
    else s.active--;
  }

  private async once(url: string, accept: string): Promise<{ res: Response; bytes: Uint8Array; truncated: boolean }> {
    const host = new URL(url).host;
    await this.acquire(host);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError());
      }, this.timeoutMs);
    });
    try {
      const work = (async () => {
        const res = await this.fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': this.userAgent, accept },
        });
        const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has('location');
        if (isRedirect) {
          await res.body?.cancel().catch(() => undefined);
          return { res, bytes: new Uint8Array(0), truncated: false };
        }
        const body = await readCapped(res, this.maxBytes);
        return { res, ...body };
      })();
      work.catch(() => undefined);
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      this.release(host);
    }
  }

  private async attempt(url: string, accept: string): Promise<FetchResult> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let out: { res: Response; bytes: Uint8Array; truncated: boolean };
      try {
        out = await this.once(current, accept);
      } catch (err) {
        const error = err instanceof TimeoutError ? `timeout after ${formatSeconds(this.timeoutMs)}` : networkErrorMessage(err);
        return { url, finalUrl: current, status: null, headers: {}, bytes: new Uint8Array(0), text: '', truncated: false, error };
      }
      const { res, bytes, truncated } = out;
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return failed(url, current, res.status, `redirects to an invalid address`);
        }
        const refused = refuseRedirect(url, next);
        if (refused) return failed(url, current, res.status, refused);
        current = next.toString();
        continue;
      }
      return {
        url,
        finalUrl: current,
        status: res.status,
        headers: headersToRecord(res.headers),
        bytes,
        text: new TextDecoder('utf-8').decode(bytes),
        truncated,
      };
    }
    return failed(url, current, null, `more than ${MAX_REDIRECTS} redirects`);
  }

  /** GET a URL politely. Never throws; failures come back in `error` or a non-2xx `status`. */
  async get(url: string, accept = '*/*'): Promise<FetchResult> {
    let result = await this.attempt(url, accept);
    for (let i = 1; i < this.tries; i++) {
      const retryable = result.final ? false : result.status === null || result.status >= 500;
      if (!retryable) break;
      result = await this.attempt(url, accept);
    }
    return result;
  }
}

export function isHtmlBody(text: string, headers: Record<string, string>): boolean {
  const type = headers['content-type'] ?? '';
  if (type.includes('text/html')) return true;
  return /^\s*(<!doctype html|<html[\s>])/i.test(text);
}
