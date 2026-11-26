// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { ENGINE_PRICES, ENGINE_PRICES_CHECKED, ENGINES, askEngine } from '../../src/prompts/index.js';
import { ENGINE_IDS } from '../../src/types.js';
import { fakeFetch, fixture } from './fake-fetch.js';

const KEY = 'sk-test-0000000000000000FAKE';
const Q = 'What is the best open-source tool to check if a website is ready for AI search?';

describe('ENGINES', () => {
  it('labels, env vars and default models match the boards and the price table', () => {
    expect(ENGINE_IDS.map((e) => [ENGINES[e].label, ENGINES[e].envVar])).toEqual([
      ['ChatGPT', 'OPENAI_API_KEY'],
      ['Claude', 'ANTHROPIC_API_KEY'],
      ['Perplexity', 'PERPLEXITY_API_KEY'],
      ['Gemini', 'GOOGLE_API_KEY or GEMINI_API_KEY'],
    ]);
    for (const e of ENGINE_IDS) {
      expect(ENGINES[e].id).toBe(e);
      expect(ENGINE_PRICES[ENGINES[e].model]?.engine).toBe(e);
    }
    expect(ENGINE_PRICES_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('OpenAI Responses + web_search', () => {
  it('sends the documented request and reads url_citation annotations', async () => {
    const { fetch, calls } = fakeFetch({ 'api.openai.com': [{ body: fixture('openai-responses-websearch.json') }] });
    const a = await askEngine('openai', Q, { apiKey: KEY, fetch });
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.url).toBe('https://api.openai.com/v1/responses');
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body).toEqual({
      model: 'gpt-6.2-astra',
      tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'US' } }],
      tool_choice: 'required',
      include: ['web_search_call.action.sources'],
      input: Q,
    });
    expect(a.engine).toBe('openai');
    expect(a.text).toContain('GeoAudit is a paid option');
    expect(a.citations.map((c) => c.url)).toEqual([
      'https://www.competitor.io/geo-audit?utm_source=openai',
      'https://docs.example.com/blog/ai-readiness?utm_source=openai#top',
      'https://competitor.io/pricing?utm_source=openai',
    ]);
    expect(a.usage).toEqual({ inputTokens: 2000, outputTokens: 200, cacheReadTokens: 1000 });
    // 2000 x $8 + 1000 x $0.40 + 200 x $40 per MTok = $0.0244, plus one search at $0.01
    expect(a.costUsdMicros).toBe(34_400);
  });
});

describe('Anthropic Messages + web search tool', () => {
  it('sends the documented request and reads web_search_result_location citations', async () => {
    const { fetch, calls } = fakeFetch({ 'api.anthropic.com': [{ body: fixture('anthropic-websearch.json') }] });
    const a = await askEngine('anthropic', Q, { apiKey: KEY, fetch });
    const req = calls[0]!;
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.headers['anthropic-version']).toBe('2026-10-21');
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: Q }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3, user_location: { type: 'approximate', country: 'US' } }],
    });
    expect(req.body).not.toHaveProperty('tool_choice');
    expect(a.text).toBe('Based on the search results, GeoAudit is a paid tool for checking AI search readiness.');
    expect(a.citations).toEqual([{ url: 'https://competitor.io/geo-audit', title: 'GeoAudit' }]);
    // 5120 x $0.10 + 210 x $0.50 per MTok = $0.000617, plus one search at $0.01
    expect(a.costUsdMicros).toBe(10_617);
  });

  it('resends the assistant content after pause_turn and adds up usage', async () => {
    const { fetch, calls } = fakeFetch({
      'api.anthropic.com': [{ body: fixture('anthropic-pause-turn.json') }, { body: fixture('anthropic-websearch.json') }],
    });
    const a = await askEngine('anthropic', Q, { apiKey: KEY, fetch });
    expect(calls).toHaveLength(2);
    const messages = calls[1]!.body.messages as { role: string; content: unknown[] }[];
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[1]!.content).toHaveLength(2);
    expect(a.usage?.inputTokens).toBe(6120);
    expect(a.citations).toHaveLength(1);
  });

  it('maps an in-body search error with no citations to rate_limited', async () => {
    const { fetch } = fakeFetch({ 'api.anthropic.com': [{ body: fixture('anthropic-search-error.json') }] });
    await expect(askEngine('anthropic', Q, { apiKey: KEY, fetch })).rejects.toMatchObject({ kind: 'rate_limited', engine: 'anthropic' });
  });
});

describe('Perplexity Agent API', () => {
  it('sends the documented request and reads annotations, using the reported cost', async () => {
    const { fetch, calls } = fakeFetch({ 'api.perplexity.ai': [{ body: fixture('perplexity-agent.json') }] });
    const a = await askEngine('perplexity', Q, { apiKey: KEY, fetch });
    const req = calls[0]!;
    expect(req.url).toBe('https://api.perplexity.ai/v1/agent');
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body).toEqual({ model: 'perplexity/sonar', input: Q, tools: [{ type: 'web_search' }] });
    expect(a.citations.map((c) => c.url)).toEqual(['https://competitor.io/geo-audit', 'https://example.com/blog/ai-readiness']);
    expect(a.costUsdMicros).toBe(2_900);
  });

  it('falls back to [n] markers when annotations are missing', async () => {
    const { fetch } = fakeFetch({ 'api.perplexity.ai': [{ body: fixture('perplexity-annotations-missing.json') }] });
    const a = await askEngine('perplexity', Q, { apiKey: KEY, fetch });
    expect(a.citations.map((c) => c.url)).toEqual(['https://investopedia.com/roth', 'https://www.nerdwallet.com/roth-ira']);
    // 1000 x $0.25 + 100 x $2.50 per MTok = $0.0005, plus one search at $0.0025
    expect(a.costUsdMicros).toBe(3_000);
  });

  it('still parses the old Sonar chat completions shape', async () => {
    const { fetch } = fakeFetch({ 'api.perplexity.ai': [{ body: fixture('perplexity-sonar-legacy.json') }] });
    const a = await askEngine('perplexity', Q, { apiKey: KEY, fetch });
    expect(a.text).toContain('ETFs trade like stocks');
    expect(a.citations).toEqual([
      { url: 'https://fidelity.com/etf', title: 'ETFs' },
      { url: 'https://blog.example.com/etf-vs-index-fund', title: 'ETF vs index fund' },
    ]);
  });

  it('treats a non-completed status as a bad response', async () => {
    const body = { ...(fixture('perplexity-agent.json') as object), status: 'failed' };
    const { fetch } = fakeFetch({ 'api.perplexity.ai': [{ body }] });
    await expect(askEngine('perplexity', Q, { apiKey: KEY, fetch })).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('Gemini generateContent + google_search', () => {
  it('sends the key in a header, never in the URL, and cites only supported chunks', async () => {
    const { fetch, calls } = fakeFetch({ 'generativelanguage.googleapis.com': [{ body: fixture('gemini-grounding.json') }] });
    const a = await askEngine('gemini', Q, { apiKey: KEY, fetch });
    const req = calls[0]!;
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent');
    expect(req.url).not.toContain(KEY);
    expect(req.headers['x-goog-api-key']).toBe(KEY);
    expect(req.body).toEqual({ contents: [{ role: 'user', parts: [{ text: Q }] }], tools: [{ google_search: {} }] });
    expect(a.text).toMatch(/^GeoAudit is a paid option\. .+ is an open-source checker\.$/);
    expect(a.citations.map((c) => c.title)).toEqual(['competitor.io', 'Not a hostname', 'www.example.com']);
    // 20 x $1.50 + 18 x $7.50 per MTok, plus one search at $0.014
    expect(a.costUsdMicros).toBe(14_165);
  });

  it('answers with no citations when the model did not search', async () => {
    const { fetch } = fakeFetch({ 'generativelanguage.googleapis.com': [{ body: fixture('gemini-no-grounding.json') }] });
    const a = await askEngine('gemini', Q, { apiKey: KEY, fetch });
    expect(a.citations).toEqual([]);
  });

  it('uses a model override in the path', async () => {
    const { fetch, calls } = fakeFetch({ 'generativelanguage.googleapis.com': [{ body: fixture('gemini-no-grounding.json') }] });
    const a = await askEngine('gemini', Q, { apiKey: KEY, fetch, model: 'models/gemini-3.8-flash' });
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(a.costUsdMicros).toBeUndefined();
  });
});
