// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/** AI search measures (2026-11-19): considered sources per engine (SCOPE AC 1, PLAN docs table). */
import { describe, expect, it } from 'vitest';
import { askEngine, runPrompts, scoreSources } from '../../src/prompts/index.js';
import type { EngineId, PromptResult } from '../../src/types.js';
import { fakeFetch, fixture } from './fake-fetch.js';

const KEY = 'sk-test-0000000000000000FAKE';
const now = () => new Date('2026-11-19T12:00:00Z');
const HOST: Record<EngineId, string> = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  perplexity: 'api.perplexity.ai',
  gemini: 'generativelanguage.googleapis.com',
};
const ENV: Record<EngineId, Record<string, string>> = {
  openai: { OPENAI_API_KEY: KEY },
  anthropic: { ANTHROPIC_API_KEY: KEY },
  perplexity: { PERPLEXITY_API_KEY: KEY },
  gemini: { GEMINI_API_KEY: KEY },
};

async function answer(engine: EngineId, name: string) {
  const { fetch } = fakeFetch({ [HOST[engine]]: [{ body: fixture(name) }] });
  return askEngine(engine, 'q', { apiKey: KEY, fetch });
}

async function result(engine: EngineId, name: string): Promise<PromptResult> {
  const { fetch } = fakeFetch({ [HOST[engine]]: [{ body: fixture(name) }] });
  const run = await runPrompts('example.com', ['roth ira app for beginners'], { env: ENV[engine], fetch, now, engines: [engine] });
  return run.results[0]!;
}

/** AC 1: every cited on-site source is in considered, marked cited. */
function expectCitedInConsidered(r: PromptResult) {
  const considered = r.considered ?? [];
  if (r.citedUrl) expect(considered).toContainEqual(expect.objectContaining({ url: r.citedUrl, cited: true }));
  if (r.cited) expect(considered.some((c) => c.cited)).toBe(true);
}

describe('adapters return the sources each engine considered', () => {
  it('OpenAI: action.sources entries of type url only (the include is requested)', async () => {
    const { fetch, calls } = fakeFetch({ 'api.openai.com': [{ body: fixture('openai-considered.json') }] });
    const a = await askEngine('openai', 'q', { apiKey: KEY, fetch });
    expect(calls[0]!.body.include).toEqual(['web_search_call.action.sources']);
    expect(a.sources?.map((s) => s.url)).toEqual([
      'https://example.com/learn/roth-ira',
      'https://www.example.com/pricing',
      'https://www.nerdwallet.com/roth-ira',
    ]);
    expect(a.sourcesBy).toBe('page');
  });

  it('OpenAI: a search without the sources array is not collected (null), never []', async () => {
    const body = fixture('openai-considered.json') as { output: { type: string; action?: Record<string, unknown> }[] };
    delete body.output[0]!.action!.sources;
    const { fetch } = fakeFetch({ 'api.openai.com': [{ body }] });
    const a = await askEngine('openai', 'q', { apiKey: KEY, fetch });
    expect(a.sources).toBeNull();
  });

  it('Anthropic: opens the web_search_result array (the obj→array fix)', async () => {
    const a = await answer('anthropic', 'anthropic-websearch.json');
    expect(a.sources).toEqual([
      { url: 'https://example.com/blog/ai-readiness', title: 'AI readiness checks' },
      { url: 'https://competitor.io/geo-audit', title: 'GeoAudit' },
    ]);
  });

  it('Anthropic: merges sources across a paused turn, once per URL', async () => {
    const { fetch } = fakeFetch({ 'api.anthropic.com': [{ body: fixture('anthropic-pause-turn.json') }, { body: fixture('anthropic-websearch.json') }] });
    const a = await askEngine('anthropic', 'q', { apiKey: KEY, fetch });
    expect(a.sources?.map((s) => s.url)).toEqual(['https://example.com/', 'https://example.com/blog/ai-readiness', 'https://competitor.io/geo-audit']);
  });

  it('Perplexity: search_results count only when they show a URL beyond the citations', async () => {
    expect((await answer('perplexity', 'perplexity-agent.json')).sources).toBeNull();
    expect((await answer('perplexity', 'perplexity-sonar-legacy.json')).sources).toBeNull();
    expect((await answer('perplexity', 'perplexity-annotations-missing.json')).sources?.map((s) => s.url)).toContain('https://example.com/learn/roth-ira');
    const a = await answer('perplexity', 'perplexity-considered.json');
    expect(a.sources?.map((s) => s.url)).toEqual([
      'https://www.nerdwallet.com/roth-ira',
      'https://example.com/learn/roth-ira',
      'https://investopedia.com/roth',
    ]);
  });

  it('Gemini: every chunk by host; null when no chunk is unreferenced', async () => {
    const a = await answer('gemini', 'gemini-considered.json');
    expect(a.sourcesBy).toBe('host');
    expect(a.sources?.map((s) => s.title)).toEqual(['nerdwallet.com', 'blog.example.com', 'example.com', 'investopedia.com']);
    expect((await answer('gemini', 'gemini-all-cited.json')).sources).toBeNull();
    expect((await answer('gemini', 'gemini-no-grounding.json')).sources).toBeNull();
    expect((await answer('gemini', 'gemini-grounding.json')).sources).toHaveLength(4);
  });
});

describe('AC 1: considered ⊇ cited, with a retrieved-but-uncited site page', () => {
  it('OpenAI: union with a cited URL the sources list leaves out', async () => {
    const r = await result('openai', 'openai-considered.json');
    expect(r.cited).toBe(true);
    expect(r.considered).toEqual([
      { url: 'https://example.com/learn/roth-ira', host: 'example.com', cited: false },
      { url: 'https://www.example.com/pricing', host: 'example.com', cited: true },
    ]);
    // nerdwallet.com (source) and investopedia.com (cited only)
    expect(r.consideredOffsite).toBe(2);
    expectCitedInConsidered(r);
  });

  it('Anthropic', async () => {
    const r = await result('anthropic', 'anthropic-considered.json');
    expect(r.cited).toBe(false);
    expect(r.considered).toEqual([{ url: 'https://example.com/learn/roth-ira', host: 'example.com', cited: false }]);
    expect(r.consideredOffsite).toBe(2);
  });

  it('Perplexity: keeps results with a non-numeric id', async () => {
    const r = await result('perplexity', 'perplexity-considered.json');
    expect(r.considered).toEqual([
      { url: 'https://example.com/learn/roth-ira', host: 'example.com', cited: false },
      { url: 'https://example.com/pricing', host: 'example.com', cited: true },
    ]);
    expect(r.consideredOffsite).toBe(2);
    expectCitedInConsidered(r);
  });

  it('Gemini: by domain, never a redirect URL', async () => {
    const r = await result('gemini', 'gemini-considered.json');
    expect(r.cited).toBe(true);
    expect(r.considered).toEqual([
      { host: 'blog.example.com', cited: true },
      { host: 'example.com', cited: false },
    ]);
    expect(r.consideredOffsite).toBe(2);
    expect(JSON.stringify(r.considered)).not.toContain('vertexaisearch');
  });

  it('not collected stays null on both fields, never [] or 0', async () => {
    for (const [engine, name] of [['perplexity', 'perplexity-agent.json'], ['gemini', 'gemini-all-cited.json']] as const) {
      const r = await result(engine, name);
      expect(r.status).toBe('checked');
      expect(r.considered).toBeNull();
      expect(r.consideredOffsite).toBeNull();
    }
  });

  it('an engine that fails has nothing considered (null)', async () => {
    const { fetch } = fakeFetch({ 'api.openai.com': [{ status: 401, body: { error: { message: 'bad key' } } }] });
    const run = await runPrompts('example.com', ['q'], { env: ENV.openai, fetch, now, engines: ['openai'] });
    expect(run.results[0]).toMatchObject({ status: 'not_checked', considered: null, consideredOffsite: null, mentioned: null, perceptionStatus: 'not_checked' });
  });

  it('scoreSources dedupes www, utm and fragments, and skips look-alike domains', () => {
    const out = scoreSources(
      'openai',
      'example.com',
      [{ url: 'https://www.example.com/a#x' }, { url: 'https://example.com.evil.io/a' }, { url: 'mailto:hi@example.com' }],
      [{ url: 'https://example.com/a?utm_source=openai' }],
    );
    expect(out).toEqual({ considered: [{ url: 'https://www.example.com/a', host: 'example.com', cited: true }], consideredOffsite: 1 });
    expect(scoreSources('openai', 'example.com', null, [{ url: 'https://example.com/a' }])).toEqual({ considered: null, consideredOffsite: null });
  });
});
