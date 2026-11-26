// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/** AI search measures (2026-11-19): Named (SCOPE AC 2, decision 1; REVIEW-engine finding 3 on link chips). */
import { MEASURES } from '@morningdesk/core';
import { describe, expect, it } from 'vitest';
import { mentionOf, runPrompts, stripLinks } from '../../src/prompts/index.js';
import { fakeFetch, fixture } from './fake-fetch.js';

const KEY = 'sk-test-0000000000000000FAKE';
const TERMS = ['Example', 'example.com'];
const now = () => new Date('2026-11-19T12:00:00Z');

describe('AC 2: Mentioned and Cited are separate', () => {
  it('named with no site link = Mentioned yes, Cited no', async () => {
    const { fetch } = fakeFetch({ 'api.anthropic.com': [{ body: fixture('anthropic-considered.json') }] });
    const run = await runPrompts('example.com', ['q'], { env: { ANTHROPIC_API_KEY: KEY }, fetch, now, brandTerms: TERMS });
    const r = run.results.find((x) => x.engine === 'anthropic')!;
    expect(r).toMatchObject({ cited: false, mentioned: true });
    expect(r.mentionSnippet).toContain('Example is great for beginners');
  });

  it('a site link without the name (an "(example.com)" chip) = Cited yes, Mentioned no', async () => {
    const { fetch } = fakeFetch({ 'api.openai.com': [{ body: fixture('openai-responses-websearch.json') }] });
    const run = await runPrompts('example.com', ['q'], { env: { OPENAI_API_KEY: KEY }, fetch, now, brandTerms: TERMS });
    const r = run.results.find((x) => x.engine === 'openai')!;
    expect(r).toMatchObject({ cited: true, mentioned: false });
    expect(r.mentionSnippet).toBeUndefined();
  });

  it('defaults the brand terms to the domain', async () => {
    const { fetch } = fakeFetch({ 'api.openai.com': [{ body: fixture('openai-responses-websearch.json') }] });
    const run = await runPrompts('www.example.com', ['q'], { env: { OPENAI_API_KEY: KEY }, fetch, now });
    expect(run.results[0]!.mentioned).toBe(false);
  });

  it('is null when the engine was not checked', async () => {
    const run = await runPrompts('example.com', ['q'], { env: {}, fetch: async () => new Response('{}'), now, brandTerms: TERMS });
    expect(run.results.every((r) => r.mentioned === null && r.status === 'skipped')).toBe(true);
  });
});

describe('link stripping before the match', () => {
  const named = (text: string) => mentionOf(text, TERMS, KEY).mentioned;

  it('drops Markdown link chips, bare URLs and parenthesised domains', () => {
    expect(named('A free plan ([example.com](https://www.example.com/pricing?utm_source=openai)).')).toBe(false);
    expect(named('See https://example.com/learn for more.')).toBe(false);
    expect(named('See www.example.com/learn for more.')).toBe(false);
    expect(named('Checks pages for readiness (example.com).')).toBe(false);
    expect(named('Checks pages for readiness (www.example.com).')).toBe(false);
    expect(named('[https://example.com](https://example.com)')).toBe(false);
    expect(stripLinks('One ([a.io](https://a.io)) two (b.org) three')).toBe('One  two  three');
  });

  it('keeps a word label and a domain written in a sentence (that is naming the site)', () => {
    expect(named('Try [Example](https://example.com/start) today.')).toBe(true);
    expect(named('Sign up at example.com to start.')).toBe(true);
    expect(named('Examples are (not) the brand.')).toBe(false);
  });

  it('matches whole words only, case-insensitive, Unicode-aware', () => {
    expect(named("example's lessons are short")).toBe(true);
    expect(named('EXAMPLE is good')).toBe(true);
    expect(named('Counterexample apps')).toBe(false);
    expect(named('Exampleness')).toBe(false);
    expect(mentionOf('Café Bywell ist gut', ['Bywell'], KEY).mentioned).toBe(true);
    expect(mentionOf('Bywellé', ['Bywell'], KEY).mentioned).toBe(false);
    expect(mentionOf('anything', [' ', ''], KEY).mentioned).toBe(false);
  });

  it('keeps the snippet within the limit, around the match, with keys scrubbed', () => {
    const text = `${'Lead in words. '.repeat(30)}Your key ${KEY} shows Example is the pick. ${'Trailing words. '.repeat(30)}`;
    const out = mentionOf(text, TERMS, KEY);
    expect(out.mentioned).toBe(true);
    expect(out.mentionSnippet!.length).toBeLessThanOrEqual(MEASURES.mentionSnippetMaxChars);
    expect(out.mentionSnippet).toContain('Example is the pick');
    expect(out.mentionSnippet).not.toContain(KEY);
    expect(out.mentionSnippet!.startsWith('…')).toBe(true);
    expect(out.mentionSnippet!.endsWith('…')).toBe(true);
  });

  it('never stores the full answer: the snippet is at most 200 characters on a long answer', async () => {
    const long = `Example ${'word '.repeat(400)}`;
    const body = { output: [{ type: 'message', content: [{ type: 'output_text', text: long, annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 5 } };
    const { fetch } = fakeFetch({ 'api.openai.com': [{ body }] });
    const run = await runPrompts('example.com', ['q'], { env: { OPENAI_API_KEY: KEY }, fetch, now, brandTerms: TERMS });
    expect(run.results[0]!.mentionSnippet!.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(run)).not.toContain('word '.repeat(150));
  });
});
