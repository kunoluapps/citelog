// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { GEO_TOOL, PROMPT_STAGES, formatUsd, microsToUsd, type GeoApi, type PromptStage, type StageSource } from '@morningdesk/core';
import { ENGINES, ENGINE_IDS, engineApiKey, estimatePlan, judgeFor, type EngineId, type PlanEstimate } from '@morningdesk/geo';
import { promptStage, type PromptSpec } from '../config.js';
import { mdCell, mdCode, mdTable } from './markdown.js';
import { engineLabel, judgeLabel, plural } from './model.js';
import { clip, padEnd, padStart, type Style } from './style.js';

/**
 * `citelog prompts --plan`: what a run would ask and roughly cost, built from the config and which keys are set.
 * Pure: no fetch, so nothing can reach an engine (AC 8).
 */
export interface CliPlan {
  site: string;
  prompts: (PromptSpec & { stage: PromptStage; stageSource: StageSource })[];
  estimate: PlanEstimate;
  /** Engines in the config with no key: they would be skipped. */
  notAsked: { engine: EngineId; envVar: string }[];
  /** --perception was passed. */
  perception: boolean;
}

export function buildPlan(site: string, specs: readonly PromptSpec[], opts: { engines?: readonly EngineId[]; env: Record<string, string | undefined>; perception: boolean }): CliPlan {
  const wanted = ENGINE_IDS.filter((e) => !opts.engines || opts.engines.includes(e));
  const asked = wanted.filter((e) => engineApiKey(e, opts.env));
  const estimate = estimatePlan({ prompts: specs, engines: asked, judge: opts.perception ? judgeFor(opts.env) : null });
  return {
    site,
    prompts: specs.map((p) => ({ ...p, ...promptStage(p) })),
    estimate,
    notAsked: wanted.filter((e) => !asked.includes(e)).map((engine) => ({ engine, envVar: ENGINES[engine].envVar })),
    perception: opts.perception,
  };
}

/** `--plan --json`: the desk API's PromptPlanResponse fields (no version or spend: those live on the desk), plus the model per engine and the engines not asked. */
export type PlanJson = Omit<GeoApi.PromptPlanResponse, 'version' | 'spend' | 'engines'> & {
  engines: (GeoApi.PromptPlanResponse['engines'][number] & { model: string })[];
  notAsked: { engine: EngineId; envVar: string }[];
};

const usd = (m: number | null): number | null => (m === null ? null : microsToUsd(m));

export function planJson(plan: CliPlan): PlanJson {
  const e = plan.estimate;
  const judge: PlanJson['judge'] = !plan.perception ? { state: 'off' } : e.judge ? { provider: e.judge.provider, model: e.judge.model, estimateUsd: microsToUsd(e.judge.estimateUsdMicros) } : { state: 'no_key' };
  return {
    prompts: e.prompts,
    byTopic: e.byTopic,
    engines: e.engines.map((x) => ({ engine: x.engine, model: x.model, answers: x.answers, estimateUsd: usd(x.estimateUsdMicros) })),
    judge,
    totalUsd: microsToUsd(e.totalUsdMicros),
    basis: e.basis,
    notAsked: plan.notAsked,
  };
}

const BASIS_TEXT: Record<PlanEstimate['basis'], string> = {
  history: 'median cost per answer over your last runs',
  list_prices: 'first run, rough estimate from list prices',
};

function stagesText(stages: Record<PromptStage, number>): string {
  return PROMPT_STAGES.filter((s) => stages[s] > 0)
    .map((s) => `${stages[s]} ${s}`)
    .join(', ');
}

function judgeText(plan: CliPlan): { estimate: string; note: string } {
  const j = plan.estimate.judge;
  if (!plan.perception) return { estimate: 'off', note: '--perception turns it on' };
  if (!j) return { estimate: '$0.00', note: `needs ${ENGINES.anthropic.envVar} or ${ENGINES.openai.envVar}` };
  const share = j.shareBasis === 'history' ? `${Math.round(j.share * 100)}% of answers` : 'about half the answers';
  return { estimate: formatUsd(j.estimateUsdMicros), note: `${judgeLabel(j.model)} on ${ENGINES[j.provider].envVar}, ${share} (those that name or cite you)` };
}

const PROMPT_COL = 34;

/** The plan in the terminal. Ends with what to run next; says plainly that nothing was sent. */
export function renderPlanText(plan: CliPlan, opts: { style: Style; configLine?: string; note?: string }): string {
  const { style } = opts;
  const e = plan.estimate;
  const out: string[] = [];
  if (opts.configLine) out.push(opts.configLine);
  if (opts.note) out.push(style.dim(opts.note));
  out.push(`Plan for ${plan.site}: ${plural(e.prompts, 'prompt')} on ${plural(e.engines.length, 'engine')}. Nothing was sent.`, '');
  for (const t of e.byTopic) {
    out.push(`  ${t.topic ?? 'No topic'} · ${plural(t.prompts, 'prompt')}: ${stagesText(t.stages)}`);
    for (const p of plan.prompts.filter((x) => x.topic === t.topic)) {
      out.push(`    ${padEnd(clip(p.text, PROMPT_COL), PROMPT_COL + 2)}${p.stage}${p.stageSource === 'auto' ? style.dim(' (auto)') : ''}`);
    }
  }
  out.push('');
  if (e.engines.length) {
    out.push(`  ${padEnd('Engine', 14)}${padStart('Answers', 8)}${padStart('Estimate', 10)}`);
    for (const x of e.engines) {
      const cost = x.estimateUsdMicros === null ? 'unknown' : formatUsd(x.estimateUsdMicros);
      out.push(`  ${padEnd(engineLabel(x.engine), 14)}${padStart(String(x.answers), 8)}${padStart(cost, 10)}${x.estimateUsdMicros === null ? style.dim(`  no listed price for ${x.model}`) : ''}`);
    }
    const j = judgeText(plan);
    out.push(`  ${padEnd('Perception', 14)}${padStart(plan.perception && e.judge ? String(e.judge.answers) : '', 8)}${padStart(j.estimate, 10)}  ${style.dim(j.note)}`);
    out.push(`  ${padEnd('Total', 14)}${padStart('', 8)}${padStart(formatUsd(e.totalUsdMicros), 10)}  ${style.dim(BASIS_TEXT[e.basis])}`, '');
  } else {
    out.push(`${style.warn('NO KEYS')} No engine would be asked, so a run would cost $0.00.`, '');
  }
  if (plan.notAsked.length) out.push(style.dim(`Not asked (no key): ${plan.notAsked.map((s) => `${engineLabel(s.engine)} (${s.envVar})`).join(', ')}.`), '');
  out.push(style.dim('Only the prompt text goes to engines; topic and stage stay here.'));
  out.push(`Run it: npx ${GEO_TOOL.bin} prompts${plan.perception ? ' --perception' : ''}`);
  return `${out.join('\n')}\n`;
}

/** The plan as Markdown (`--plan --md`, for a job summary or a PR). */
export function renderPlanMarkdown(plan: CliPlan, opts: { heading?: string } = {}): string {
  const h = opts.heading ?? '###';
  const e = plan.estimate;
  const out = [`${h} Prompt plan (${plural(e.prompts, 'prompt')}, ${plural(e.engines.length, 'engine')})`, '', 'Nothing was sent.', ''];
  out.push(
    mdTable(
      ['Prompt', 'Topic', 'Stage'],
      plan.prompts.map((p) => [mdCell(p.text), p.topic ? mdCell(p.topic) : 'No topic', p.stageSource === 'auto' ? `${p.stage} (auto)` : p.stage]),
    ),
  );
  if (e.engines.length) {
    const j = judgeText(plan);
    const rows = e.engines.map((x) => [engineLabel(x.engine), String(x.answers), x.estimateUsdMicros === null ? `Unknown (no listed price for ${mdCode(x.model)})` : formatUsd(x.estimateUsdMicros)]);
    rows.push(['Perception', plan.perception && e.judge ? String(e.judge.answers) : '', `${j.estimate}: ${mdCell(j.note)}`]);
    rows.push(['Total', '', `${formatUsd(e.totalUsdMicros)} (${BASIS_TEXT[e.basis]})`]);
    out.push('', mdTable(['Engine', 'Answers', 'Estimate'], rows));
  } else {
    out.push('', 'No engine keys found, so no engine would be asked.');
  }
  if (plan.notAsked.length) out.push('', `Not asked (no key): ${plan.notAsked.map((s) => `${engineLabel(s.engine)} (${mdCode(s.envVar)})`).join(', ')}.`);
  return out.join('\n');
}
