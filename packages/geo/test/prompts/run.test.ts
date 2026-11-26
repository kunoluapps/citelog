// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { engineApiKey, runPrompts } from '../../src/prompts/index.js';
import { scoreCitations, siteDomain } from '../../src/prompts/cited.js';
import { errorBody, fakeFetch, fixture } from './fake-fetch.js';
import type { FetchLike } from '../../src/types.js';

const now = () => new Date('2026-11-16T12:00:00Z');
const ALL_KEYS = {
  OPENAI_API_KEY: 'sk-openai-FAKEFAKEFAKE',
  ANTHROPIC_API_KEY: 'sk-ant-FAKEFAKEFAKE',
  PERPLEXITY_API_KEY: 'pplx-FAKEFAKEFAKE',
  GEMINI_API_KEY: 'AIzaFAKEFAKEFAKEFAKEFAKEFAKE',
};
const OK = {
  'api.openai.com': [{ body: fixture('openai-responses-websearch.json') }],
  'api.anthropic.com': [{ body: fixture('anthropic-websearch.json') }],
  'api.perplexity.ai': [{ body: fixture('perplexity-agent.json') }],
  'generativelanguage.googleapis.com': [{ body: fixture('gemini-grounding.json') }],
};

describe('AC 5: no engine keys', () => {
  it('skips every engine, names the env var for each and calls nothing', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('no network expected');
    };
    const run = await runPrompts('example.com', ['a', 'b'], { env: { OPENAI_API_KEY: '  ' }, fetch, now });
    expect(run.skipped).toEqual([
      { engine: 'openai', envVar: 'OPENAI_API_KEY' },
      { engine: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
      { engine: 'perplexity', envVar: 'PERPLEXITY_API_KEY' },
      { engine: 'gemini', envVar: 'GOOGLE_API_KEY or GEMINI_API_KEY' },
    ]);
    expect(run.results).toHaveLength(8);
    expect(run.results.every((r) => r.status === 'skipped' && r.cited === null)).toBe(true);
    expect(run.costUsdMicros).toBe(0);
  });

  it('runs only engines with keys and lists the rest', async () => {
    const { fetch, calls } = fakeFetch(OK);
    const run = await runPrompts('example.com', ['a'], { env: { ANTHROPIC_API_KEY: ALL_KEYS.ANTHROPIC_API_KEY }, fetch, now });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['api.anthropic.com']);
    expect(run.skipped.map((s) => s.engine)).toEqual(['openai', 'perplexity', 'gemini']);
    expect(run.results.find((r) => r.engine === 'anthropic')?.status).toBe('checked');
  });

  it('reads GOOGLE_API_KEY before GEMINI_API_KEY', () => {
    expect(engineApiKey('gemini', { GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'G' })).toBe('G');
    expect(engineApiKey('gemini', { GEMINI_API_KEY: 'g' })).toBe('g');
    expect(engineApiKey('gemini', {})).toBeUndefined();
  });
});

describe('AC 6: one engine failing', () => {
  it('marks only that engine not checked; the others are checked', async () => {
    const { fetch } = fakeFetch({
      ...OK,
      'generativelanguage.googleapis.com': [{ status: 500, body: errorBody('internal'), headers: { 'retry-after': '0' } }],
    });
    const run = await runPrompts('example.com', ['p1', 'p2'], { env: ALL_KEYS, fetch, now });
    expect(run.skipped).toEqual([]);
    expect(run.results).toHaveLength(8);
    for (const r of run.results) {
      if (r.engine === 'gemini') {
        expect(r.status).toBe('not_checked');
        expect(r.cited).toBeNull();
        expect(r.error?.kind).toBe('provider_error');
        expect(r.error?.message).toBe('provider error (HTTP 500) after 2 tries');
      } else {
        expect(r.status).toBe('checked');
        expect(r.error).toBeUndefined();
      }
    }
    expect(run.results.map((r) => `${r.prompt}:${r.engine}`)).toEqual([
      'p1:openai', 'p1:anthropic', 'p1:perplexity', 'p1:gemini',
      'p2:openai', 'p2:anthropic', 'p2:perplexity', 'p2:gemini',
    ]);
    expect(run.costUsdMicros).toBe(2 * (34_400 + 10_617 + 2_900));
  });

  it('stops calling an engine after its key is rejected (two already in flight), and never returns the key', async () => {
    const { fetch, calls } = fakeFetch({ 'api.openai.com': [{ status: 401, body: errorBody(`Incorrect API key ${ALL_KEYS.OPENAI_API_KEY}`) }] });
    const run = await runPrompts('example.com', ['a', 'b', 'c'], { env: { OPENAI_API_KEY: ALL_KEYS.OPENAI_API_KEY }, fetch, now });
    expect(calls).toHaveLength(2);
    const openai = run.results.filter((r) => r.engine === 'openai');
    expect(openai.map((r) => r.error?.kind)).toEqual(['invalid_key', 'invalid_key', 'invalid_key']);
    expect(JSON.stringify(run)).not.toContain(ALL_KEYS.OPENAI_API_KEY);
  });

  it('asks Perplexity one request at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetch: FetchLike = async (input) => {
      expect(new URL(input).host).toBe('api.perplexity.ai');
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify(fixture('perplexity-agent.json')), { status: 200 });
    };
    const run = await runPrompts('example.com', ['a', 'b'], { env: { PERPLEXITY_API_KEY: 'pplx-x' }, fetch, now, engines: ['perplexity'] });
    expect(peak).toBe(1);
    expect(run.results.every((r) => r.status === 'checked')).toBe(true);
  });
});

describe('cited and others', () => {
  it('per engine on the fixtures', async () => {
    const { fetch } = fakeFetch(OK);
    const run = await runPrompts('https://www.example.com/', ['p'], { env: ALL_KEYS, fetch, now });
    expect(run.site).toBe('example.com');
    const by = Object.fromEntries(run.results.map((r) => [r.engine, r]));
    expect(by.openai).toMatchObject({ cited: true, citedUrl: 'https://docs.example.com/blog/ai-readiness', others: ['competitor.io'] });
    expect(by.anthropic).toMatchObject({ cited: false, others: ['competitor.io'] });
    expect(by.anthropic?.citedUrl).toBeUndefined();
    expect(by.perplexity).toMatchObject({ cited: true, citedUrl: 'https://example.com/blog/ai-readiness', others: ['competitor.io'] });
    expect(by.gemini).toMatchObject({ cited: true, others: ['competitor.io'] });
    expect(by.gemini?.citedUrl).toBeUndefined();
    expect(by.openai?.checkedAt).toBe('2026-11-16T12:00:00.000Z');
  });

  it('does not count a look-alike domain, and skips non-http links', () => {
    const out = scoreCitations('openai', 'example.com', [
      { url: 'https://notexample.com/a' },
      { url: 'https://example.com.evil.io/a' },
      { url: 'mailto:hi@example.com' },
      { url: 'https://WWW.NerdWallet.com/x' },
      { url: 'https://nerdwallet.com/y' },
    ]);
    expect(out).toEqual({ cited: false, others: ['notexample.com', 'example.com.evil.io', 'nerdwallet.com'] });
  });

  it('Gemini uses the chunk title and never the redirect host', () => {
    const out = scoreCitations('gemini', 'example.com', [
      { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/X', title: 'Some Article Title' },
      { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/Y', title: 'blog.example.com' },
    ]);
    expect(out).toEqual({ cited: true, others: [] });
  });

  it('normalises the site', () => {
    expect(siteDomain('https://WWW.Bywell.org/learn')).toBe('bywell.org');
    expect(siteDomain('bywell.org')).toBe('bywell.org');
  });
});
