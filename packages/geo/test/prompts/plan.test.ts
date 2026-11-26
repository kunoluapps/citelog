// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/** AI search measures (2026-11-19): the plan estimate (SCOPE AC 4, PLAN decision 6). */
import { describe, expect, it } from 'vitest';
import { DEFAULT_JUDGED_SHARE, estimatePlan, runPrompts } from '../../src/prompts/index.js';
import type { PlanHistoryAnswer } from '../../src/prompts/index.js';
import { ENGINE_IDS } from '../../src/types.js';
import type { EngineId } from '../../src/types.js';
import { fakeFetch, fixture } from './fake-fetch.js';

const now = () => new Date('2026-11-19T12:00:00Z');
const KEYS = {
  OPENAI_API_KEY: 'sk-openai-FAKEFAKEFAKE',
  ANTHROPIC_API_KEY: 'sk-ant-FAKEFAKEFAKE',
  PERPLEXITY_API_KEY: 'pplx-FAKEFAKEFAKE',
  GEMINI_API_KEY: 'AIzaFAKEFAKEFAKEFAKEFAKEFAKE',
};
const HOST: Record<EngineId, string> = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  perplexity: 'api.perplexity.ai',
  gemini: 'generativelanguage.googleapis.com',
};
const FIXTURES: Record<EngineId, string[]> = {
  openai: ['openai-responses-websearch.json', 'openai-considered.json'],
  anthropic: ['anthropic-websearch.json', 'anthropic-considered.json'],
  perplexity: ['perplexity-agent.json', 'perplexity-annotations-missing.json', 'perplexity-considered.json'],
  gemini: ['gemini-grounding.json', 'gemini-considered.json', 'gemini-all-cited.json'],
};

async function actualPerAnswer(engine: EngineId, name: string): Promise<number> {
  const { fetch } = fakeFetch({ [HOST[engine]]: [{ body: fixture(name) }] });
  const run = await runPrompts('example.com', ['q'], { env: KEYS, fetch, now, engines: [engine] });
  return run.costUsdMicros;
}

describe('AC 4: estimate within ±50% of actual on the fixtures', () => {
  it('list prices (first run) per engine', async () => {
    const plan = estimatePlan({ prompts: ['q'], engines: [...ENGINE_IDS] });
    expect(plan.basis).toBe('list_prices');
    for (const e of plan.engines) {
      expect(e.basis).toBe('list_prices');
      for (const name of FIXTURES[e.engine]) {
        const actual = await actualPerAnswer(e.engine, name);
        const ratio = e.perAnswerUsdMicros! / actual;
        expect(ratio, `${e.engine} ${name}: estimate ${e.perAnswerUsdMicros} vs actual ${actual}`).toBeGreaterThanOrEqual(0.5);
        expect(ratio, `${e.engine} ${name}: estimate ${e.perAnswerUsdMicros} vs actual ${actual}`).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it('history: the median cost per answer per engine, and the whole run within ±50%', async () => {
    const { fetch } = fakeFetch(Object.fromEntries(ENGINE_IDS.map((e) => [HOST[e], FIXTURES[e].map((n) => ({ body: fixture(n) }))])));
    const prompts = ['p1', 'p2'];
    const first = await runPrompts('example.com', prompts, { env: KEYS, fetch, now });
    const history: PlanHistoryAnswer[] = first.results.map((r) => ({ engine: r.engine, costUsdMicros: r.costUsdMicros ?? null, mentioned: r.mentioned, cited: r.cited }));
    const plan = estimatePlan({ prompts, engines: [...ENGINE_IDS], history });
    expect(plan.basis).toBe('history');
    const openaiCosts = first.results.filter((r) => r.engine === 'openai').map((r) => r.costUsdMicros!);
    expect(plan.engines.find((e) => e.engine === 'openai')?.perAnswerUsdMicros).toBe(Math.round((openaiCosts[0]! + openaiCosts[1]!) / 2));
    const ratio = plan.totalUsdMicros / first.costUsdMicros;
    expect(ratio).toBeGreaterThanOrEqual(0.5);
    expect(ratio).toBeLessThanOrEqual(1.5);
  });

  it('the judge line is within ±50% of an actual judged run', async () => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const { fetch } = fakeFetch({
      'api.anthropic.com': [(req) => json(Array.isArray(req.body.tools) ? fixture('anthropic-considered.json') : fixture('judge-anthropic.json'))],
    });
    const run = await runPrompts('example.com', ['a', 'b'], { env: { ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY }, fetch, now, brandTerms: ['Example'], perception: { mode: 'auto' } });
    const plan = estimatePlan({
      prompts: ['a', 'b'],
      engines: ['anthropic'],
      judge: { provider: 'anthropic', model: 'claude-haiku-5-5' },
      history: run.results.map((r) => ({ engine: r.engine, costUsdMicros: r.costUsdMicros, mentioned: r.mentioned, cited: r.cited })),
    });
    expect(plan.judge).toMatchObject({ share: 1, shareBasis: 'history', answers: 2 });
    const ratio = plan.judge!.estimateUsdMicros / run.judge!.costUsdMicros!;
    expect(ratio).toBeGreaterThanOrEqual(0.5);
    expect(ratio).toBeLessThanOrEqual(1.5);
  });
});

describe('estimatePlan', () => {
  it('judge estimate = share (default 0.5) × answers × 1,200 in / 30 out at the judge price', () => {
    const plan = estimatePlan({ prompts: ['a', 'b', 'c', 'd'], engines: ['openai', 'gemini'], judge: { provider: 'anthropic', model: 'claude-haiku-5-5' } });
    // 1,200 x $0.10 + 30 x $0.50 per MTok = 135 µ$; 0.5 x 8 answers = 4 judged
    expect(plan.judge).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5', answers: 4, share: DEFAULT_JUDGED_SHARE, shareBasis: 'default', estimateUsdMicros: 540 });
    expect(plan.totalUsdMicros).toBe(plan.engines.reduce((s, e) => s + e.estimateUsdMicros!, 0) + 540);
  });

  it('uses the history share of answers that name or cite the site', () => {
    const history: PlanHistoryAnswer[] = [
      { engine: 'openai', costUsdMicros: 30_000, mentioned: true, cited: false },
      { engine: 'openai', costUsdMicros: 40_000, mentioned: false, cited: false },
      { engine: 'openai', costUsdMicros: 50_000, mentioned: false, cited: true },
      { engine: 'openai', costUsdMicros: null, mentioned: false, cited: false },
    ];
    const plan = estimatePlan({ prompts: ['a', 'b', 'c'], engines: ['openai'], history, judge: { provider: 'openai', model: 'gpt-6-luna' } });
    expect(plan.engines[0]).toMatchObject({ perAnswerUsdMicros: 40_000, estimateUsdMicros: 120_000, basis: 'history' });
    expect(plan.judge).toMatchObject({ share: 0.5, shareBasis: 'history', answers: 2, estimateUsdMicros: Math.round(0.5 * 3 * 135) });
  });

  it('mixes history and list prices, and then calls the basis rough', () => {
    const plan = estimatePlan({ prompts: ['a'], engines: ['openai', 'perplexity'], history: [{ engine: 'openai', costUsdMicros: 30_000 }] });
    expect(plan.engines.map((e) => e.basis)).toEqual(['history', 'list_prices']);
    expect(plan.basis).toBe('list_prices');
    expect(plan.judge).toBeNull();
  });

  it('an unpriced model override has no estimate and is left out of the total', () => {
    const plan = estimatePlan({ prompts: ['a'], engines: ['gemini'], models: { gemini: 'gemini-unlisted' } });
    expect(plan.engines[0]).toMatchObject({ model: 'gemini-unlisted', perAnswerUsdMicros: null, estimateUsdMicros: null });
    expect(plan.totalUsdMicros).toBe(0);
  });

  it('counts prompts by topic and stage, auto-tagging prompts without one', () => {
    const plan = estimatePlan({
      prompts: [
        'best roth ira app',
        { text: 'example vs acorns', topic: 'Apps' },
        { text: 'is example worth it', topic: 'Apps', stage: 'evaluation' },
        { text: 'example price', topic: ' ', stage: null },
      ],
      engines: [],
    });
    expect(plan.prompts).toBe(4);
    expect(plan.byTopic).toEqual([
      { topic: null, prompts: 2, stages: { discovery: 1, evaluation: 0, decision: 1 } },
      { topic: 'Apps', prompts: 2, stages: { discovery: 0, evaluation: 2, decision: 0 } },
    ]);
    expect(plan.totalUsdMicros).toBe(0);
  });
});
