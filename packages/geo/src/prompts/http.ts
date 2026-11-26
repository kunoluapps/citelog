// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { estimateCost, usdToMicros } from '@morningdesk/core';
import type { TokenUsage, UsdMicros } from '@morningdesk/core';
import { EngineError } from '../types.js';
import type { EngineErrorKind, EngineId, FetchLike } from '../types.js';
import { ENGINE_PRICES } from './prices.js';

export const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_5XX_RETRY_MS = 1_000;

export interface CallContext {
  engine: EngineId;
  apiKey: string;
  fetch: FetchLike;
  model: string;
  timeoutMs: number;
}

/* ---------- loose JSON readers ---------- */

export type Json = Record<string, unknown>;
export const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/* ---------- secrets ---------- */

const KEY_PATTERNS = [/\bsk-[A-Za-z0-9_-]{8,}/g, /\bpplx-[A-Za-z0-9_-]{8,}/g, /\bAIza[0-9A-Za-z_-]{20,}/g];

/** Removes the key, and anything shaped like a provider key, from text. */
export function scrubKeys(text: string, apiKey: string): string {
  let out = apiKey.length >= 4 ? text.split(apiKey).join('[redacted]') : text;
  for (const p of KEY_PATTERNS) out = out.replace(p, '[redacted]');
  return out;
}

/** Removes the key, and anything shaped like a provider key, from text that may reach output. */
export function redact(text: string, apiKey: string): string {
  const out = scrubKeys(text, apiKey);
  return out.length > 240 ? `${out.slice(0, 237)}...` : out;
}

/** The start of an engine's answer for display: keys scrubbed, whitespace collapsed, at most `max` characters. */
export function answerExcerpt(text: string, apiKey: string, max: number): string | undefined {
  const flat = scrubKeys(text, apiKey).replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/* ---------- error mapping ---------- */

const BILLING_CODES = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'insufficient_quota',
  'quota_exceeded',
  'billing_error',
  'payment_required',
]);
const BILLING_TEXT = /insufficient[_ ]quota|credit balance|out of credits?|billing|spend(ing)? limit|exceeded your (current )?quota|quota exceeded|payment required/i;

interface ProviderError {
  code?: string;
  message?: string;
}

function readProviderError(body: string): ProviderError {
  try {
    const parsed = obj(JSON.parse(body));
    const e = obj(parsed?.error);
    if (!e) return {};
    const code = str(e.code) ?? str(e.type) ?? str(e.status);
    return { code, message: str(e.message) };
  } catch {
    return {};
  }
}

export function mapHttpError(engine: EngineId, status: number, body: string, apiKey: string): EngineError {
  const pe = readProviderError(body);
  const detail = pe.message ? `: ${redact(pe.message, apiKey)}` : '';
  const billing = (pe.code !== undefined && BILLING_CODES.has(pe.code)) || BILLING_TEXT.test(pe.message ?? '');
  let kind: EngineErrorKind;
  let message: string;
  if (status === 401 || status === 403) {
    kind = 'invalid_key';
    message = `key rejected (HTTP ${status})`;
  } else if (status === 402 || billing) {
    kind = 'out_of_credit';
    message = `out of credit or quota (HTTP ${status})${detail}`;
  } else if (status === 429) {
    kind = 'rate_limited';
    message = `rate limit (HTTP 429)`;
  } else if (status >= 500) {
    kind = 'provider_error';
    message = `provider error (HTTP ${status})`;
  } else if (status === 400 && /web search is not enabled/i.test(pe.message ?? '')) {
    kind = 'provider_error';
    message = 'web search is disabled for this key\'s organization (HTTP 400)';
  } else {
    kind = 'provider_error';
    message = `request refused (HTTP ${status})${detail}`;
  }
  return new EngineError(engine, kind, message, status);
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One POST; the timeout covers the headers and the whole body. */
async function once(ctx: CallContext, url: string, headers: Record<string, string>, body: unknown): Promise<{ res: Response; text: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EngineError(ctx.engine, 'timeout', `no answer after ${Math.round(ctx.timeoutMs / 1000)} s`));
    }, ctx.timeoutMs);
  });
  try {
    const work = (async () => {
      const res = await ctx.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      return { res, text: await res.text() };
    })();
    work.catch(() => undefined);
    return await Promise.race([work, timeout]);
  } catch (err) {
    if (err instanceof EngineError) throw err;
    if (controller.signal.aborted) {
      throw new EngineError(ctx.engine, 'timeout', `no answer after ${Math.round(ctx.timeoutMs / 1000)} s`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new EngineError(ctx.engine, 'provider_error', `network error: ${redact(reason, ctx.apiKey)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POSTs JSON and returns the parsed body. Retries once on 5xx/529, or on a rate-limit 429 that carries
 * Retry-After of 30 s or less. Throws EngineError.
 */
export async function postJson(ctx: CallContext, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let { res, text } = await once(ctx, url, headers, body);
  let tries = 1;
  if (!res.ok) {
    const first = mapHttpError(ctx.engine, res.status, text, ctx.apiKey);
    const wait = retryAfterMs(res);
    const retry =
      (first.kind === 'provider_error' && res.status >= 500) ||
      (first.kind === 'rate_limited' && wait !== undefined && wait <= MAX_RETRY_AFTER_MS);
    if (!retry) throw first;
    await sleep(Math.min(wait ?? DEFAULT_5XX_RETRY_MS, MAX_RETRY_AFTER_MS));
    ({ res, text } = await once(ctx, url, headers, body));
    tries = 2;
  }
  if (!res.ok) {
    const e = mapHttpError(ctx.engine, res.status, text, ctx.apiKey);
    throw new EngineError(ctx.engine, e.kind, tries > 1 ? `${e.message} after ${tries} tries` : e.message, res.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EngineError(ctx.engine, 'bad_response', 'response was not JSON', res.status);
  }
}

export function badResponse(engine: EngineId, what: string): EngineError {
  return new EngineError(engine, 'bad_response', `unexpected response: ${what}`);
}

/** Token cost plus search fees at the model's listed price; undefined for models without a price. */
export function costFor(model: string, usage: TokenUsage | undefined, searches: number): UsdMicros | undefined {
  const price = ENGINE_PRICES[model];
  if (!price) return undefined;
  const tokens = usage ? estimateCost(usage, price.tokens) : 0;
  return tokens + usdToMicros(searches * price.searchUsd);
}
