// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { GEO_TOOL } from '@morningdesk/core';
import { scoreBand, SCORE_BAND_LABEL, type ScoreBand } from '@morningdesk/geo';

/**
 * README badge (board CReadme): the tool mark and wordmark on ink, then a status pill with the score and the band word.
 * Pill colours are the light status tokens in docs/brand/tokens.json (a test keeps them in sync). Never highlighter.
 */
export const BADGE_PILL: Record<ScoreBand, string> = {
  ready: '#1E7A46',
  needs_work: '#8F5400',
  not_ready: '#B4261A',
  no_score: '#6B6960',
};

const INK = '#16161A';
/** Edge stroke so the ink badge keeps its shape on a dark README as well as a light one (one SVG for both). */
const EDGE = '#46443E';
const PAPER = '#F4F2EA';
const HIGHLIGHTER = '#D4F25A';

const MARK_AND_WORDMARK =
  `<g transform="translate(4 1) scale(0.28)"><circle cx="20.66" cy="23.80" r="7.56" fill="${PAPER}"/>` +
  `<path d="M27.38 24.85C27.38 32.20 22.76 36.40 16.46 37.98" fill="none" stroke="${PAPER}" stroke-width="6.30" stroke-linecap="round"/>` +
  `<circle cx="43.34" cy="23.80" r="7.56" fill="${HIGHLIGHTER}"/>` +
  `<path d="M50.06 24.85C50.06 32.20 45.44 36.40 39.14 37.98" fill="none" stroke="${HIGHLIGHTER}" stroke-width="6.30" stroke-linecap="round"/>` +
  `<path d="M7.85 43.75H56.15" stroke="${PAPER}" stroke-width="7.5" stroke-linecap="round"/></g>` +
  `<g transform="translate(24 4.6) scale(0.165)"><g fill="none" stroke="${PAPER}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M27.6 31.6C25.2 28 21 26 15 26C6 26 0 32 0 40.5C0 49 6 55 15 55C21 55 25.2 53 27.6 49.4"/>` +
  `<path transform="translate(45.90 0)" d="M0 55V26"/><circle cx="45.90" cy="8.5" r="6.6" stroke="none" fill="${PAPER}"/>` +
  `<path transform="translate(63.80 0)" d="M7 11V47C7 52.5 10 55 15.2 55C17 55 18.6 54.6 19.8 54M0 26.5H18.5"/>` +
  `<path transform="translate(100.90 0)" d="M1 41H28.5C28.5 31.5 23 26 14.8 26C6 26 0 32 0 40.5C0 49.5 6.2 55 15 55C21 55 25 53 27.8 49.2"/>` +
  `<path transform="translate(147.90 0)" d="M0 6V46.5C0 52.4 3 55 8.4 55"/>` +
  `<path transform="translate(173.80 0)" d="M14.5 26C23 26 29 32 29 40.5C29 49 23 55 14.5 55C6 55 0 49 0 40.5C0 32 6 26 14.5 26Z"/>` +
  `<path transform="translate(220.70 0)" d="M28 40.5C28 32 22.5 26 14.2 26C6 26 0 32 0 40.5C0 49 6 54.5 14.2 54.5C22.5 54.5 28 49 28 40.5M28 26V66C28 75.5 22 80 13.5 80C7.5 80 3 78 0.5 74.5"/>` +
  `</g></g>`;

/** "96 · ready", "no score". */
export function badgeText(score: number | null): string {
  const band = scoreBand(score);
  return band === 'no_score' || score === null ? 'no score' : `${score} · ${SCORE_BAND_LABEL[band].toLowerCase()}`;
}

export function badgeLabel(score: number | null): string {
  const band = scoreBand(score);
  return band === 'no_score' || score === null
    ? `${GEO_TOOL.name}: no score, last check couldn't run`
    : `${GEO_TOOL.name} score ${score}, ${SCORE_BAND_LABEL[band].toLowerCase()}`;
}

export function renderBadgeSvg(score: number | null): string {
  const band = scoreBand(score);
  const label = badgeLabel(score);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 170 20" width="170" height="20" role="img" aria-label="${label}">` +
    `<title>${label}</title>` +
    `<rect x="0.5" y="0.5" width="169" height="19" rx="3.5" fill="${INK}" stroke="${EDGE}" stroke-width="1"/>` +
    MARK_AND_WORDMARK +
    `<rect x="70" y="3" width="96" height="14" rx="3" fill="${BADGE_PILL[band]}"/>` +
    `<text x="118" y="13.4" text-anchor="middle" font-family="Geist Mono, ui-monospace, monospace" font-size="9" fill="#FFFFFF">${badgeText(score)}</text>` +
    `</svg>\n`
  );
}

/** Score in a badge written earlier, read back from its label (for "was 74 last run"). */
export function scoreFromBadge(svg: string): number | null {
  const m = /aria-label="[^"]*? score (\d{1,3}),/.exec(svg);
  return m?.[1] ? Number(m[1]) : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "AI answer readiness of bywell.org, 41 pages, checked Nov 17, 2026" (the line under the badge). */
export function badgeSiteLine(site: string, pages: number, checkedAt: string): string {
  const [y, m, d] = checkedAt.slice(0, 10).split('-');
  return `AI answer readiness of ${site}, ${pages} ${pages === 1 ? 'page' : 'pages'}, checked ${MONTHS[Number(m) - 1] ?? ''} ${Number(d)}, ${y}`;
}
