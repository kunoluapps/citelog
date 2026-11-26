// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu

/**
 * AI search prompt measures (initiatives/2026-11-19-ai-search-measures): Named, Cited, Perception, considered sources,
 * buyer stages, topics, plan and versions. Shared by geo (engine), the server, the web app, the CLI and MCP.
 */

export const PROMPT_STAGES = ['discovery', 'evaluation', 'decision'] as const;
export type PromptStage = (typeof PROMPT_STAGES)[number];
export const PROMPT_STAGE_LABEL: Record<PromptStage, string> = { discovery: 'Discovery', evaluation: 'Evaluation', decision: 'Decision' };
export type StageSource = 'auto' | 'user';

export const PERCEPTIONS = ['positive', 'neutral', 'negative'] as const;
export type Perception = (typeof PERCEPTIONS)[number];

/**
 * Why an answer has no perception. judged = it has one; not_about_you = the answer neither names nor cites you;
 * off = the setting is off; no_key = no OpenAI or Anthropic key for AI search; failed = the judge call failed;
 * not_checked = the engine didn't answer.
 */
export const PERCEPTION_STATUSES = ['judged', 'not_about_you', 'off', 'no_key', 'failed', 'not_checked'] as const;
export type PerceptionStatus = (typeof PERCEPTION_STATUSES)[number];

export const PERCEPTION_MODES = ['auto', 'off'] as const;
export type PerceptionMode = (typeof PERCEPTION_MODES)[number];

/** Measure limits (SCOPE decisions 1, 5, 8). */
export const MEASURES = {
  brandTermsPerSite: 5,
  topicsPerSite: 12,
  steerMaxChars: 140,
  mentionSnippetMaxChars: 200,
  perceptionReasonMaxChars: 140,
  /** Runs the estimate's median looks back over. */
  estimateRuns: 3,
} as const;

/**
 * Judge models in order of preference (SCOPE decision 2), checked on the vendors' pages 2026-11-19:
 * claude-haiku-5-5 ($0.10 / $0.50 per MTok under 100k-token prompts, platform.claude.com pricing) and gpt-6-luna
 * ($0.10 / $0.50, developers.openai.com pricing). gpt-6-luna's Responses API support is not separately documented,
 * so a failed judge call records `failed`, never a made-up perception.
 */
export const PERCEPTION_JUDGES = [
  { provider: 'anthropic', model: 'claude-haiku-5-5' },
  { provider: 'openai', model: 'gpt-6-luna' },
] as const;
export type JudgeProvider = (typeof PERCEPTION_JUDGES)[number]['provider'];
export type JudgeModel = (typeof PERCEPTION_JUDGES)[number]['model'];
/** Display names for the judge models (board: "CLAUDE HAIKU 5.5"). */
export const JUDGE_MODEL_LABEL: Record<JudgeModel, string> = { 'claude-haiku-5-5': 'Claude Haiku 5.5', 'gpt-6-luna': 'GPT-6 Luna' };

/**
 * Word rule for the buyer stage (SCOPE decision 4). Decision words win over evaluation words, which win over discovery
 * ("best price" = decision; "best x vs y" = evaluation). Anything else = discovery. Whole words, case-insensitive.
 */
const STAGE_WORDS: { stage: PromptStage; words: RegExp }[] = [
  { stage: 'decision', words: /\b(price|prices|pricing|cost|costs|sign up|signup|worth it|buy|discount|coupon|free trial)\b/i },
  { stage: 'evaluation', words: /\b(vs\.?|versus|alternatives?|reviews?|compare|comparison|compared)\b/i },
];

export function autoStage(prompt: string): PromptStage {
  for (const { stage, words } of STAGE_WORDS) if (words.test(prompt)) return stage;
  return 'discovery';
}

/**
 * Default brand terms for a site: its name, the domain's own name for a two-label domain ("bywell.org" → "bywell"),
 * and the domain; de-duplicated case-insensitively, at most MEASURES.brandTermsPerSite. Desk and CLI share this.
 */
export function defaultBrandTerms(name: string | null, domain: string): string[] {
  const host = domain.replace(/^www\./, '').toLowerCase();
  const labels = host.split('.');
  const bare = labels.length === 2 ? labels[0] : undefined;
  const out: string[] = [];
  for (const t of [name?.trim(), bare, host]) {
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, MEASURES.brandTermsPerSite);
}

/** Measure wording shared by the web app, the CLI, the Action summary and MCP (cross-review 2026-11-19). */
export const MEASURE_COPY = {
  named: 'Named',
  cited: 'Cited',
  citedAndNamed: 'Cited · Named',
  namedNotLinked: 'Named, not linked',
  notNamed: 'Not named',
  consideredNotCited: 'Considered, not cited',
  notCollected: (engine: string) => `Not collected for ${engine}`,
  perceptionNeedsKey: 'Perception needs an OpenAI or Anthropic key',
  perceptionNotAboutYou: 'No perception: not about you',
  perceptionFailed: 'Perception check failed',
  /** Shares and counts leave out answers that weren't measured. */
  notMeasured: 'N/C',
  stopsAtLimit: 'Runs stop at your monthly spend limit, perception check included.',
} as const;
