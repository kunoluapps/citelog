// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { ENGINE_IDS, EngineError, PROMPT_ANSWER_EXCERPT_MAX } from '../types.js';
import type { EngineAnswer, EngineId, FetchLike, JudgeRun, PromptInput, PromptResult, PromptRun, RunPromptsOptions } from '../types.js';
import { askAnthropic } from './anthropic.js';
import { scoreCitations, scoreSources, siteDomain } from './cited.js';
import { ENGINES, engineApiKey } from './engines.js';
import { askGemini } from './gemini.js';
import { DEFAULT_TIMEOUT_MS, answerExcerpt, costFor, redact, scrubKeys } from './http.js';
import type { CallContext } from './http.js';
import { judgeAnswer, judgeFor } from './judge.js';
import type { JudgeChoice } from './judge.js';
import { mentionOf } from './mention.js';
import { JUDGE_TYPICAL_USAGE } from './prices.js';
import { askOpenai } from './openai.js';
import { askPerplexity } from './perplexity.js';

export { ENGINES, engineApiKey } from './engines.js';
export { ENGINE_PRICES, ENGINE_PRICES_CHECKED, JUDGE_PRICES_CHECKED, JUDGE_TYPICAL_USAGE, TYPICAL_ANSWER } from './prices.js';
export type { EngineModelPrice } from './prices.js';
export { answerWindow, escapeAnswer, judgeFor, judgeRequest, parseVerdict, JUDGE_ANSWER_MAX } from './judge.js';
export type { JudgeChoice } from './judge.js';
export { mentionOf, stripLinks } from './mention.js';
export type { MentionOutcome } from './mention.js';
export { scoreSources } from './cited.js';
export type { ConsideredOutcome } from './cited.js';
export { estimatePlan, DEFAULT_JUDGED_SHARE } from './plan.js';
export type { PlanEstimate, PlanEngineEstimate, PlanHistoryAnswer, PlanInput } from './plan.js';

const ASK: Record<EngineId, (prompt: string, ctx: CallContext) => Promise<EngineAnswer>> = {
  openai: askOpenai,
  anthropic: askAnthropic,
  perplexity: askPerplexity,
  gemini: askGemini,
};

/** Ask one engine one question with web search on. Throws EngineError. */
export async function askEngine(
  engine: EngineId,
  prompt: string,
  opts: { apiKey: string; fetch: FetchLike; model?: string; timeoutMs?: number },
): Promise<EngineAnswer> {
  const ctx: CallContext = {
    engine,
    apiKey: opts.apiKey,
    fetch: opts.fetch,
    model: opts.model ?? ENGINES[engine].model,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  try {
    return await ASK[engine](prompt, ctx);
  } catch (err) {
    if (err instanceof EngineError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new EngineError(engine, 'bad_response', `unexpected failure: ${redact(reason, opts.apiKey)}`);
  }
}

/** Requests in flight per engine; Perplexity's tier 0 allows 1 request a second per org. */
const ENGINE_CONCURRENCY: Record<EngineId, number> = { openai: 2, anthropic: 2, perplexity: 1, gemini: 2 };
const ENGINE_SPACING_MS: Record<EngineId, number> = { openai: 0, anthropic: 0, perplexity: 1000, gemini: 0 };
const STOP_ENGINE: ReadonlySet<string> = new Set(['invalid_key', 'out_of_credit']);

/** Shown with a result when the engine answered from memory: no web search, so it couldn't cite anyone. */
export const NO_SEARCH_NOTE = 'Answered without searching the web';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const JUDGE_CONCURRENCY = 2;

const textOf = (p: PromptInput) => (typeof p === 'string' ? p : p.text);

const unanswered = (prompt: string, engine: EngineId, status: 'not_checked' | 'skipped', checkedAt: string): PromptResult => ({
  prompt,
  engine,
  status,
  cited: null,
  others: [],
  checkedAt,
  mentioned: null,
  considered: null,
  consideredOffsite: null,
  perceptionStatus: 'not_checked',
});

/**
 * Run prompts on every engine with a key; one engine failing never stops the others (AC 6).
 * Results are ordered prompt by prompt, engines in ENGINE_IDS order. Engines without a key get
 * 'skipped' rows and are listed in `skipped` with the env var that enables them (AC 5).
 * After a rejected key or exhausted credit the engine's remaining prompts are marked not checked without a call.
 *
 * Only the prompt text reaches an engine; a prompt's topic and stage, and the steer, never do (SCOPE decision 8).
 * Each answer is scored here, the only place its full text exists: Cited, Named (brand terms, links stripped),
 * considered sources. With `perception.mode: 'auto'`, a judge phase follows once every engine has answered: it uses
 * the first PERCEPTION_JUDGES key in `env` and judges only answers that name or cite the site.
 *
 * `onResult` gets a copy of each answer as it is scored. An answer still waiting for the judge has perceptionStatus
 * 'not_checked' there; the returned run holds every answer's final perception.
 */
export async function runPrompts(site: string, prompts: readonly PromptInput[], opts: RunPromptsOptions): Promise<PromptRun> {
  const now = opts.now ?? (() => new Date());
  const domain = siteDomain(site);
  const texts = prompts.map(textOf);
  const terms = opts.brandTerms?.length ? opts.brandTerms : [domain];
  const mode = opts.perception?.mode ?? 'off';
  const judge = mode === 'auto' ? judgeFor(opts.env) : null;
  const wanted = ENGINE_IDS.filter((e) => !opts.engines || opts.engines.includes(e));
  const skipped: PromptRun['skipped'] = [];
  const active: { engine: EngineId; apiKey: string }[] = [];
  for (const engine of wanted) {
    const apiKey = engineApiKey(engine, opts.env);
    if (apiKey) active.push({ engine, apiKey });
    else skipped.push({ engine, envVar: ENGINES[engine].envVar });
  }

  const grid = new Map<string, PromptResult>();
  /** Full answers waiting for the judge; never put on the run. */
  const toJudge: { result: PromptResult; answer: string }[] = [];
  const unpriced = new Set<string>();
  const at = (p: number, e: EngineId) => `${p}:${e}`;
  const emit = (r: PromptResult) => {
    try {
      opts.onResult?.(structuredClone(r));
    } catch {
      /* a failing callback never stops the run */
    }
  };

  async function runEngine(engine: EngineId, apiKey: string): Promise<void> {
    let next = 0;
    let lastStart = 0;
    let stopped: EngineError | undefined;
    const worker = async () => {
      while (next < texts.length) {
        const i = next++;
        const prompt = texts[i] ?? '';
        if (!stopped) {
          const wait = lastStart + ENGINE_SPACING_MS[engine] - Date.now();
          if (lastStart > 0 && wait > 0) await sleep(wait);
          lastStart = Date.now();
        }
        let result: PromptResult;
        try {
          if (stopped) throw stopped;
          const answer = await askEngine(engine, prompt, {
            apiKey,
            fetch: opts.fetch,
            model: opts.models?.[engine],
            timeoutMs: opts.timeoutMs,
          });
          if (answer.costUsdMicros === undefined) unpriced.add(answer.model);
          const excerpt = answerExcerpt(answer.text, apiKey, PROMPT_ANSWER_EXCERPT_MAX);
          const citedOutcome = scoreCitations(engine, domain, answer.citations);
          const mention = mentionOf(answer.text, terms, apiKey);
          const aboutYou = mention.mentioned || citedOutcome.cited;
          result = {
            prompt,
            engine,
            status: 'checked',
            ...citedOutcome,
            checkedAt: now().toISOString(),
            ...(answer.costUsdMicros !== undefined ? { costUsdMicros: answer.costUsdMicros } : {}),
            ...(answer.citations.length === 0 && answer.searches === 0 ? { note: NO_SEARCH_NOTE } : {}),
            ...(excerpt ? { answerExcerpt: excerpt } : {}),
            mentioned: mention.mentioned,
            ...(mention.mentionSnippet ? { mentionSnippet: mention.mentionSnippet } : {}),
            ...scoreSources(engine, domain, answer.sources, answer.citations, answer.sourcesBy),
            perceptionStatus: mode !== 'auto' ? 'off' : !aboutYou ? 'not_about_you' : judge ? 'not_checked' : 'no_key',
          };
          if (judge && aboutYou) toJudge.push({ result, answer: scrubKeys(answer.text, apiKey) });
        } catch (err) {
          const e = err instanceof EngineError ? err : new EngineError(engine, 'bad_response', `unexpected failure: ${String(err)}`);
          if (STOP_ENGINE.has(e.kind)) stopped = e;
          result = { ...unanswered(prompt, engine, 'not_checked', now().toISOString()), error: { kind: e.kind, message: redact(e.message, apiKey) } };
        }
        grid.set(at(i, engine), result);
        emit(result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(ENGINE_CONCURRENCY[engine], texts.length) }, worker));
  }

  await Promise.all(active.map(({ engine, apiKey }) => runEngine(engine, apiKey)));

  let judgeRun: JudgeRun | null = null;
  if (judge && toJudge.length) {
    const engineCost = [...grid.values()].reduce((sum, r) => sum + (r.costUsdMicros ?? 0), 0);
    judgeRun = await runJudge(judge, toJudge, terms, opts, engineCost, unpriced);
  }

  const results: PromptResult[] = [];
  let costUsdMicros = 0;
  texts.forEach((prompt, i) => {
    for (const engine of wanted) {
      const r = grid.get(at(i, engine));
      if (r) {
        costUsdMicros += r.costUsdMicros ?? 0;
        results.push(r);
      } else {
        results.push(unanswered(prompt, engine, 'skipped', now().toISOString()));
      }
    }
  });
  const run: PromptRun = { site: domain, results, skipped, costUsdMicros, judge: judgeRun };
  if (unpriced.size) run.unpricedModels = [...unpriced].sort();
  return run;
}

/**
 * The judge phase: two judgements in flight; with a budget, each call's JUDGE_TYPICAL_USAGE estimate is reserved
 * before it is sent and the phase stops (stoppedAtLimit) rather than go past it; an unpriced judge call makes the
 * judge's cost unknown and lists its model in unpricedModels; a failed call or an unreadable verdict marks that
 * answer 'failed' (never a guessed perception); after a rejected key or exhausted credit the rest are marked failed
 * without a call.
 */
async function runJudge(
  choice: JudgeChoice,
  queue: { result: PromptResult; answer: string }[],
  brandTerms: string[],
  opts: RunPromptsOptions,
  engineCostUsdMicros: number,
  unpricedModels: Set<string>,
): Promise<JudgeRun> {
  const apiKey = engineApiKey(choice.provider, opts.env) ?? '';
  const ctx: CallContext = {
    engine: choice.provider,
    apiKey,
    fetch: opts.fetch,
    model: choice.model,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const steer = opts.perception?.steer?.trim() || undefined;
  const budget = opts.perception?.budgetUsdMicros;
  /** What one judgement is expected to cost; with a budget and no price, nothing can be checked against it. */
  const perCall = costFor(choice.model, JUDGE_TYPICAL_USAGE, 0);
  const run: JudgeRun = { provider: choice.provider, model: choice.model, judged: 0, failed: 0, stoppedAtLimit: false };
  let cost = 0;
  let unpriced = false;
  let inFlight = 0;
  let next = 0;
  let stopped = false;
  const fail = (r: PromptResult) => {
    r.perceptionStatus = 'failed';
    run.failed++;
  };
  const worker = async () => {
    while (next < queue.length) {
      const item = queue[next++]!;
      if (stopped || run.stoppedAtLimit) {
        fail(item.result);
        continue;
      }
      if (budget !== undefined) {
        if (perCall === undefined || engineCostUsdMicros + cost + inFlight + perCall > budget) {
          run.stoppedAtLimit = true;
          fail(item.result);
          continue;
        }
      }
      const reserved = perCall ?? 0;
      inFlight += reserved;
      try {
        const out = await judgeAnswer({ prompt: item.result.prompt, answer: item.answer, brandTerms, ...(steer ? { steer } : {}) }, ctx);
        if (out.costUsdMicros !== undefined) cost += out.costUsdMicros;
        else unpriced = true;
        if (out.verdict) {
          item.result.perceptionStatus = 'judged';
          item.result.perception = out.verdict;
          run.judged++;
        } else {
          fail(item.result);
        }
      } catch (err) {
        if (err instanceof EngineError && STOP_ENGINE.has(err.kind)) stopped = true;
        fail(item.result);
      } finally {
        inFlight -= reserved;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(JUDGE_CONCURRENCY, queue.length) }, worker));
  if (unpriced) unpricedModels.add(choice.model);
  else run.costUsdMicros = cost;
  return run;
}
