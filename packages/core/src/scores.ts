// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu

/** Readiness score bands, one definition for geo, CLI, Action, API and web (DESIGN decision 6). */
export type ScoreBand = 'ready' | 'needs_work' | 'not_ready' | 'no_score';

export const SCORE_BANDS = {
  ready: { min: 90, max: 100 },
  needs_work: { min: 50, max: 89 },
  not_ready: { min: 0, max: 49 },
} as const;

/** 90-100 Ready, 50-89 Needs work, 0-49 Not ready, null No score. */
export function scoreBand(score: number | null | undefined): ScoreBand {
  if (score === null || score === undefined || Number.isNaN(score)) return 'no_score';
  if (score >= SCORE_BANDS.ready.min) return 'ready';
  if (score >= SCORE_BANDS.needs_work.min) return 'needs_work';
  return 'not_ready';
}

export const SCORE_BAND_LABEL: Record<ScoreBand, string> = {
  ready: 'Ready',
  needs_work: 'Needs work',
  not_ready: 'Not ready',
  no_score: 'No score',
};

/** Mean of the scores that exist, rounded; null when none. The one site-score rule. */
export function meanScore(scores: readonly (number | null | undefined)[]): number | null {
  const s = scores.filter((x): x is number => typeof x === 'number' && !Number.isNaN(x));
  return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
}
