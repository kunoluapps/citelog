// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { TokenPrice, TokenUsage } from '@morningdesk/core';
import type { EngineId } from '../types.js';

/** Date the prices below were read from each provider's pricing page. */
export const ENGINE_PRICES_CHECKED = '2026-11-18';

export interface EngineModelPrice {
  engine: EngineId;
  tokens: TokenPrice;
  /** USD charged per web search the engine runs. */
  searchUsd: number;
  source: string;
}

/**
 * Standard (non-batch, short-context) prices per model used for prompt checks.
 * Gemini's 5,000 free searches a month are not subtracted, so its estimate is an upper bound.
 * Perplexity publishes no per-search rate; 0.0025 is the tool_calls_cost in its documented sample response,
 * used only when a response carries no usage.cost.
 */
export const ENGINE_PRICES: Record<string, EngineModelPrice> = {
  'gpt-6.2-astra': {
    engine: 'openai',
    tokens: { inputPerMTok: 8, outputPerMTok: 40, cacheReadPerMTok: 0.4 },
    searchUsd: 0.01,
    source: 'https://developers.openai.com/api/docs/pricing',
  },
  /** Perception judge (2nd choice). Rechecked 2026-11-19 on https://developers.openai.com/api/docs/pricing. */
  'gpt-6-luna': {
    engine: 'openai',
    tokens: { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01 },
    searchUsd: 0.01,
    source: 'https://developers.openai.com/api/docs/pricing',
  },
  /**
   * Engine default and perception judge (1st choice). Rechecked 2026-11-19 on
   * https://platform.claude.com/docs/en/about-claude/pricing ($0.10 / $0.50 per MTok for prompts under 100k tokens).
   */
  'claude-haiku-5-5': {
    engine: 'anthropic',
    tokens: { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 },
    searchUsd: 0.01,
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  },
  'claude-sonnet-5-5': {
    engine: 'anthropic',
    tokens: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2.5 },
    searchUsd: 0.01,
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  },
  'perplexity/sonar': {
    engine: 'perplexity',
    tokens: { inputPerMTok: 0.25, outputPerMTok: 2.5, cacheReadPerMTok: 0.0625 },
    searchUsd: 0.0025,
    source: 'https://docs.perplexity.ai/docs/agent-api/models.md',
  },
  'gemini-4-hydrogen': {
    engine: 'gemini',
    tokens: { inputPerMTok: 1.5, outputPerMTok: 7.5 },
    searchUsd: 0.014,
    source: 'https://aistudio.google.com/docs/pricing',
  },
};

/** Date the judge models' prices (gpt-6-luna, claude-haiku-5-5 above) were rechecked for the perception judge. */
export const JUDGE_PRICES_CHECKED = '2026-11-19';

/** Tokens one perception judgement takes, for the plan estimate (SCOPE decision 2: answer + brand terms + focus in, a verdict out). */
export const JUDGE_TYPICAL_USAGE: TokenUsage = { inputTokens: 1200, outputTokens: 30 };

/**
 * A typical answer per engine for the first-run estimate (no history yet): sized from the doc-shaped fixtures in
 * packages/geo/test/fixtures/engines (OpenAI 34,400 µ$, Anthropic 10,617, Perplexity 2,900-3,000, Gemini 14,165), so
 * the list-price estimate lands within ±50% of them (SCOPE AC 4). Search fees dominate every engine but OpenAI.
 */
export const TYPICAL_ANSWER: Record<EngineId, { usage: TokenUsage; searches: number }> = {
  openai: { usage: { inputTokens: 2500, outputTokens: 200 }, searches: 1 },
  anthropic: { usage: { inputTokens: 5000, outputTokens: 200 }, searches: 1 },
  perplexity: { usage: { inputTokens: 1000, outputTokens: 100 }, searches: 1 },
  gemini: { usage: { inputTokens: 500, outputTokens: 300 }, searches: 1 },
};
