// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu

/** Money is stored as integer micro-dollars (1 USD = 1,000,000) so ledger sums never drift. */
export type UsdMicros = number;

export const usdToMicros = (usd: number): UsdMicros => Math.round(usd * 1_000_000);
export const microsToUsd = (m: UsdMicros): number => m / 1_000_000;

/** "$1.15" (two decimals; under one cent shows "<$0.01"). */
export function formatUsd(m: UsdMicros): string {
  if (m > 0 && m < 10_000) return '<$0.01';
  return `$${microsToUsd(m).toFixed(2)}`;
}

/** Price per million tokens in USD, per model. Values are set by the ai line from the provider's pricing page. */
export interface TokenPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  /** Batch discount multiplier, e.g. 0.5. */
  batchMultiplier?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function estimateCost(usage: TokenUsage, price: TokenPrice, opts: { batch?: boolean } = {}): UsdMicros {
  const mult = opts.batch ? (price.batchMultiplier ?? 1) : 1;
  const usd =
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      (usage.cacheReadTokens ?? 0) * (price.cacheReadPerMTok ?? price.inputPerMTok) +
      (usage.cacheWriteTokens ?? 0) * (price.cacheWritePerMTok ?? price.inputPerMTok)) /
    1_000_000;
  return usdToMicros(usd * mult);
}
