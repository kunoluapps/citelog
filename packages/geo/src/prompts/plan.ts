// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { autoStage, PROMPT_STAGES } from '@morningdesk/core';
import type { PromptStage, UsdMicros } from '@morningdesk/core';
import type { EngineId, PromptInput } from '../types.js';
import { ENGINES } from './engines.js';
import { costFor } from './http.js';
import type { JudgeChoice } from './judge.js';
import { JUDGE_TYPICAL_USAGE, TYPICAL_ANSWER } from './prices.js';

/** Judged share used when there is no history: about half the answers name or cite the site. */
export const DEFAULT_JUDGED_SHARE = 0.5;

/** One answer from an earlier run (checked answers of the site's last MEASURES.estimateRuns ok runs). */
export interface PlanHistoryAnswer {
  engine: EngineId;
  /** Undefined or null when the model had no price; left out of the median. */
  costUsdMicros?: UsdMicros | null;
  mentioned?: boolean | null;
  cited?: boolean | null;
}

export interface PlanInput {
  prompts: readonly PromptInput[];
  engines: readonly EngineId[];
  /** Per-engine model override; list prices use these. */
  models?: Partial<Record<EngineId, string>>;
  history?: readonly PlanHistoryAnswer[];
  /** The judge that would run (judgeFor(env)); null or absent = no judge line. */
  judge?: JudgeChoice | null;
}

export interface PlanEngineEstimate {
  engine: EngineId;
  model: string;
  answers: number;
  perAnswerUsdMicros: UsdMicros | null;
  /** answers × per answer; null when the model has no price and no history. */
  estimateUsdMicros: UsdMicros | null;
  basis: 'history' | 'list_prices';
}

export interface PlanEstimate {
  prompts: number;
  byTopic: { topic: string | null; prompts: number; stages: Record<PromptStage, number> }[];
  engines: PlanEngineEstimate[];
  judge: (JudgeChoice & { answers: number; share: number; shareBasis: 'history' | 'default'; estimateUsdMicros: UsdMicros }) | null;
  /** Engines plus judge, leaving out engines with no estimate. */
  totalUsdMicros: UsdMicros;
  /** 'history' only when every engine's figure comes from history; otherwise "first run, rough estimate". */
  basis: 'history' | 'list_prices';
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

const textOf = (p: PromptInput) => (typeof p === 'string' ? p : p.text);

/**
 * The plan before a run, with no network: answers per engine × the median cost per answer over the given history,
 * else list prices for a typical answer (TYPICAL_ANSWER); the judge line = judged share (history, else 0.5) × answers ×
 * one judgement (1,200 in, 30 out tokens) at the judge's price. Shared by the desk's plan preview and `citelog prompts --plan`.
 */
export function estimatePlan(input: PlanInput): PlanEstimate {
  const n = input.prompts.length;
  const history = input.history ?? [];

  const topics = new Map<string | null, { topic: string | null; prompts: number; stages: Record<PromptStage, number> }>();
  for (const p of input.prompts) {
    const topic = typeof p === 'string' ? null : (p.topic?.trim() || null);
    const stage = (typeof p === 'string' ? null : p.stage) ?? autoStage(textOf(p));
    let row = topics.get(topic);
    if (!row) {
      row = { topic, prompts: 0, stages: Object.fromEntries(PROMPT_STAGES.map((s) => [s, 0])) as Record<PromptStage, number> };
      topics.set(topic, row);
    }
    row.prompts++;
    row.stages[stage]++;
  }

  const engines: PlanEngineEstimate[] = input.engines.map((engine) => {
    const model = input.models?.[engine] ?? ENGINES[engine].model;
    const costs = history.filter((h) => h.engine === engine && typeof h.costUsdMicros === 'number').map((h) => h.costUsdMicros as number);
    if (costs.length) {
      const per = median(costs);
      return { engine, model, answers: n, perAnswerUsdMicros: per, estimateUsdMicros: per * n, basis: 'history' };
    }
    const typical = TYPICAL_ANSWER[engine];
    const per = costFor(model, typical.usage, typical.searches) ?? null;
    return { engine, model, answers: n, perAnswerUsdMicros: per, estimateUsdMicros: per === null ? null : per * n, basis: 'list_prices' };
  });

  let judge: PlanEstimate['judge'] = null;
  if (input.judge) {
    const checked = history.filter((h) => h.mentioned != null || h.cited != null);
    const share = checked.length ? checked.filter((h) => h.mentioned === true || h.cited === true).length / checked.length : DEFAULT_JUDGED_SHARE;
    const answers = Math.round(share * n * input.engines.length);
    const per = costFor(input.judge.model, JUDGE_TYPICAL_USAGE, 0) ?? 0;
    judge = { ...input.judge, answers, share, shareBasis: checked.length ? 'history' : 'default', estimateUsdMicros: Math.round(share * n * input.engines.length * per) };
  }

  const totalUsdMicros = engines.reduce((sum, e) => sum + (e.estimateUsdMicros ?? 0), 0) + (judge?.estimateUsdMicros ?? 0);
  const basis = engines.length > 0 && engines.every((e) => e.basis === 'history') ? 'history' : 'list_prices';
  return { prompts: n, byTopic: [...topics.values()], engines, judge, totalUsdMicros, basis };
}
