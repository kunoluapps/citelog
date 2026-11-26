// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu

/**
 * Source tag and freshness: every number Morningdesk shows carries where it came from and the dates it covers
 * (ORG.md rule "every number shows its source and date"; concept map row "Source tag and freshness").
 */

import { GEO_TOOL } from './brand.js';

export const SOURCES = {
  gsc: 'GSC',
  ga4: 'GA4',
  readiness: GEO_TOOL.name,
  logs: 'Logs',
  bing: 'Bing',
  openai: 'ChatGPT',
  anthropic: 'Claude',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  dataforseo: 'DataForSEO',
  google_ads: 'Google Ads',
  github: 'GitHub',
  wordpress: 'WordPress',
  ledger: 'Usage',
  prompts: 'Prompt checks',
  site: 'Site',
} as const;

export type SourceId = keyof typeof SOURCES;

/** ISO calendar date, YYYY-MM-DD, in the site's time zone unless stated. */
export type IsoDate = string;
/** ISO timestamp with offset or Z. */
export type IsoDateTime = string;

export interface DateRange {
  start: IsoDate;
  end: IsoDate;
}

/**
 * How to read an Evidence value. One fixed list so the same number reads the same everywhere (no 'usd_micros' next to
 * 'usd'). Money in Evidence is always whole or decimal USD ('usd'); micro-USD stays inside the ledger.
 */
export const UNITS = [
  'clicks',
  'impressions',
  'ctr',
  'position',
  'percent',
  'ratio',
  'score',
  'usd',
  'visits',
  'sessions',
  'conversions',
  'count',
  'pages',
  'queries',
  'prompts',
  'answers',
  'citations',
  'keywords',
  'checks',
  'articles',
  'days',
  'status',
  'time',
  'pull request',
  'post',
] as const;
export type EvidenceUnit = (typeof UNITS)[number];

export interface Evidence {
  /** The one number (or short value) behind a claim. */
  value: number | string;
  /** How to read the value (UNITS). */
  unit: EvidenceUnit;
  source: SourceId;
  /** The data window the number covers; omit for point-in-time values (then asOf is required). */
  range?: DateRange;
  /** When the number was measured or fetched. */
  asOf: IsoDateTime;
  /** Optional comparison, e.g. previous period value. */
  previous?: number;
  /** True when the number came from a sync that is older than expected (stale data). */
  stale?: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 15" from "2026-11-15" (no time-zone shifting: the date is already a calendar date). */
export function shortDate(date: IsoDate): string {
  const [, m, d] = date.split('-');
  const month = MONTHS[Number(m) - 1];
  if (!month || !d) throw new Error(`Not an ISO date: ${date}`);
  return `${month} ${Number(d)}`;
}

/** Number of calendar days in a range, inclusive. */
export function daysInRange(range: DateRange): number {
  const ms = Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * The source tag shown under every number, e.g. "GSC · 28 days · to Nov 15" or "Citelog · checked Nov 18".
 * One formatter for web, CLI, PR comments and Today so the wording never drifts.
 */
export function formatSourceTag(e: Pick<Evidence, 'source' | 'range' | 'asOf'>): string {
  const name = SOURCES[e.source];
  if (e.range) {
    const days = daysInRange(e.range);
    return `${name} · ${days} ${days === 1 ? 'day' : 'days'} · to ${shortDate(e.range.end)}`;
  }
  return `${name} · checked ${shortDate(e.asOf.slice(0, 10))}`;
}
