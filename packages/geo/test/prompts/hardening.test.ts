// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/** FIX-P1 findings turned into checks: body-read timeout, "answered without searching", unknown prices, engine labels. */
import { SOURCES } from '@morningdesk/core';
import { describe, expect, it } from 'vitest';
import { askEngine, ENGINES, NO_SEARCH_NOTE, runPrompts } from '../../src/prompts/index.js';
import { ENGINE_IDS, PROMPT_ANSWER_EXCERPT_MAX } from '../../src/types.js';
import type { FetchLike } from '../../src/types.js';
import { fakeFetch } from './fake-fetch.js';

const now = () => new Date('2026-11-16T12:00:00Z');

describe('engine labels', () => {
  it('read the core source names, so the CLI, Action and desk say the same thing', () => {
    for (const id of ENGINE_IDS) expect(ENGINES[id].label).toBe(SOURCES[id]);
  });
});

describe('engine timeout', () => {
  it('covers a body that never finishes, not just the headers', async () => {
    const stalled: FetchLike = async () =>
      new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"output":')) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const started = Date.now();
    const err = await askEngine('openai', 'q', { apiKey: 'sk-test-FAKEFAKEFAKE', fetch: stalled, timeoutMs: 30 }).catch((x: unknown) => x);
    expect(err).toMatchObject({ kind: 'timeout', engine: 'openai' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('answers', () => {
  const noSearch = {
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'From memory.', annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  it('notes an answer given without a web search', async () => {
    const { fetch } = fakeFetch({ 'api.openai.com': [{ body: noSearch }] });
    const run = await runPrompts('example.com', ['q'], { env: { OPENAI_API_KEY: 'sk-test-FAKEFAKEFAKE' }, fetch, now });
    const r = run.results.find((x) => x.engine === 'openai');
    expect(r?.status).toBe('checked');
    expect(r?.cited).toBe(false);
    expect(r?.note).toBe(NO_SEARCH_NOTE);
    expect(r?.answerExcerpt).toBe('From memory.');
  });

  it('keeps at most 600 characters of the answer and never a key', async () => {
    const long = `Your key sk-test-FAKEFAKEFAKE and sk-other-ABCDEFGHIJ leaked. ${'word '.repeat(300)}`;
    const body = { ...noSearch, output: [{ type: 'message', content: [{ type: 'output_text', text: long, annotations: [] }] }] };
    const { fetch } = fakeFetch({ 'api.openai.com': [{ body }] });
    const run = await runPrompts('example.com', ['q'], { env: { OPENAI_API_KEY: 'sk-test-FAKEFAKEFAKE' }, fetch, now });
    const excerpt = run.results.find((x) => x.engine === 'openai')?.answerExcerpt ?? '';
    expect(excerpt.length).toBeLessThanOrEqual(PROMPT_ANSWER_EXCERPT_MAX);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).not.toContain('sk-test');
    expect(excerpt).not.toContain('sk-other');
    expect(excerpt.startsWith('Your key [redacted] and [redacted] leaked.')).toBe(true);
  });

  it('says the cost is unknown for a model without a price, instead of counting $0', async () => {
    const { fetch } = fakeFetch({ 'api.openai.com': [{ body: { ...noSearch, model: 'gpt-unlisted' } }] });
    const run = await runPrompts('example.com', ['q'], {
      env: { OPENAI_API_KEY: 'sk-test-FAKEFAKEFAKE' },
      fetch,
      now,
      models: { openai: 'gpt-unlisted' },
    });
    expect(run.results.find((x) => x.engine === 'openai')?.costUsdMicros).toBeUndefined();
    expect(run.unpricedModels).toEqual(['gpt-unlisted']);
  });
});
