// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { askEngine } from '../../src/prompts/index.js';
import { EngineError, ENGINE_IDS } from '../../src/types.js';
import type { EngineErrorKind, EngineId, FetchLike } from '../../src/types.js';
import { errorBody, fakeFetch } from './fake-fetch.js';
import type { Reply } from './fake-fetch.js';

const KEY = 'sk-proj-SECRETSECRETSECRET1234';
const HOST: Record<EngineId, string> = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  perplexity: 'api.perplexity.ai',
  gemini: 'generativelanguage.googleapis.com',
};

async function failWith(engine: EngineId, replies: Reply[], timeoutMs?: number) {
  const { fetch, calls } = fakeFetch({ [HOST[engine]]: replies });
  const err = await askEngine(engine, 'q', { apiKey: KEY, fetch, timeoutMs }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EngineError);
  const e = err as EngineError;
  expect(e.engine).toBe(engine);
  expect(e.message).not.toContain(KEY);
  expect(e.message).not.toContain('SECRETSECRET');
  return { e, calls };
}

const cases: [string, Reply, EngineErrorKind][] = [
  ['401', { status: 401, body: errorBody(`Incorrect API key provided: ${KEY}.`, 'invalid_api_key') }, 'invalid_key'],
  ['403', { status: 403, body: errorBody('Permission denied', 'permission_denied') }, 'invalid_key'],
  ['402', { status: 402, body: errorBody('Payment required', 'payment_required') }, 'out_of_credit'],
  ['429 billing code', { status: 429, body: errorBody('You exceeded your current quota', 'insufficient_quota') }, 'out_of_credit'],
  ['429 rate limit, no Retry-After', { status: 429, body: errorBody('Too many requests', 'rate_limit_error') }, 'rate_limited'],
  ['400 credit balance text', { status: 400, body: errorBody('Your credit balance is too low to access the API.') }, 'out_of_credit'],
  ['400 other', { status: 400, body: errorBody(`bad input for key ${KEY}`) }, 'provider_error'],
  ['500', { status: 500, body: errorBody('internal'), headers: { 'retry-after': '0' } }, 'provider_error'],
  ['529', { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, headers: { 'retry-after': '0' } }, 'provider_error'],
  ['200 not JSON', { status: 200, body: '<html>oops</html>' }, 'bad_response'],
  ['200 wrong shape', { status: 200, body: { hello: 'world' } }, 'bad_response'],
];

describe.each(ENGINE_IDS)('%s error mapping', (engine) => {
  it.each(cases)('%s', async (_name, reply, kind) => {
    const { e } = await failWith(engine, [reply]);
    expect(e.kind).toBe(kind);
  });

  it('times out without leaking the key', async () => {
    const neverFetch: FetchLike = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const err = await askEngine(engine, 'q', { apiKey: KEY, fetch: neverFetch, timeoutMs: 20 }).catch((x: unknown) => x);
    expect(err).toMatchObject({ kind: 'timeout', engine });
    expect((err as Error).message).not.toContain(KEY);
  });
});

describe('retries', () => {
  it('retries a 5xx once, then succeeds', async () => {
    const { fetch, calls } = fakeFetch({
      'api.perplexity.ai': [
        { status: 503, body: errorBody('busy'), headers: { 'retry-after': '0' } },
        { body: { status: 'completed', output: [] } },
      ],
    });
    const a = await askEngine('perplexity', 'q', { apiKey: KEY, fetch });
    expect(calls).toHaveLength(2);
    expect(a.citations).toEqual([]);
  });

  it('retries a 429 with a short Retry-After once and says how many tries', async () => {
    const { e, calls } = await failWith('gemini', [
      { status: 429, body: { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } }, headers: { 'retry-after': '0' } },
    ]);
    expect(calls).toHaveLength(2);
    expect(e.kind).toBe('rate_limited');
    expect(e.message).toBe('rate limit (HTTP 429) after 2 tries');
  });

  it('does not retry a 401', async () => {
    const { calls } = await failWith('openai', [{ status: 401, body: errorBody('nope') }]);
    expect(calls).toHaveLength(1);
  });

  it('names Anthropic web search being disabled for the org', async () => {
    const { e } = await failWith('anthropic', [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'web search is not enabled for this organization' } } }]);
    expect(e.message).toMatch(/web search is disabled/);
  });
});

describe('key redaction', () => {
  it('never puts a key-shaped string from a provider message into the error', async () => {
    const other = 'AIzaSyD-0123456789abcdefghijklmnop';
    const { e } = await failWith('gemini', [{ status: 400, body: errorBody(`API key ${other} not valid for ${KEY}`) }]);
    expect(e.message).not.toContain(other);
    expect(e.message).toContain('[redacted]');
  });

  it('turns a network failure into provider_error without the key', async () => {
    const boom: FetchLike = async () => {
      throw new TypeError(`connect failed with header ${KEY}`);
    };
    const err = (await askEngine('openai', 'q', { apiKey: KEY, fetch: boom }).catch((x: unknown) => x)) as EngineError;
    expect(err.kind).toBe('provider_error');
    expect(err.message).not.toContain(KEY);
  });
});
