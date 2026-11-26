// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { CheckId } from '../types.js';

/**
 * Weight of each readiness check in the 0-100 score. Score = round(100 × (pass weight + WARN_CREDIT × warn weight) /
 * weight of applicable checks). 'skip' and 'info' results are left out. llms.txt is informational (weight 0, PRD 4.3).
 */
export const CHECK_WEIGHTS: Readonly<Record<CheckId, number>> = {
  indexable: 3,
  robots_ai: 3,
  no_js_content: 3,
  direct_answer: 2,
  json_ld: 2,
  canonical: 1,
  title_meta: 1,
  question_headings: 1,
  updated_date: 1,
  llms_txt: 0,
};

/** A warning earns half the check's weight. */
export const WARN_CREDIT = 0.5;
