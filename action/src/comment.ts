// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { GEO_TOOL } from '@morningdesk/core';
import { SCORE_BAND_LABEL, scoreBand } from '@morningdesk/geo';
import type { PageReport, SiteReport } from '@morningdesk/geo';
import {
  TOOL_FOOTER,
  belowThreshold,
  countVerdicts,
  failedChecks,
  lowerFirst,
  mdCell,
  mdCode,
  mdDetails,
  mdTable,
  pageCountParts,
  pagePath,
  pageVerdict,
  plural,
  renderChecksAbout,
  runVerdict,
  sentence,
  topFixOf,
  verdictScoreCell,
  checkCatalog,
} from './cli.js';
import { pagesScore } from './changed.js';

/** "Score 72, Needs work" or "No score" (DESIGN decision 6: the band word always goes with the number). */
export function scoreWords(score: number | null): string {
  return score === null ? SCORE_BAND_LABEL.no_score : `Score ${score}, ${SCORE_BAND_LABEL[scoreBand(score)]}`;
}

/** Kept in the comment so the next push can say what changed. */
export interface CommentState {
  v: 1;
  pushes: { sha: string; score: number | null }[];
  /** "path|check_id" for every failed check on the last push. */
  failing: string[];
}

const STATE_OPEN = `<!-- ${GEO_TOOL.bin}:state `;
const STATE_CLOSE = ' -->';
const MAX_ROWS = 50;

export function failingKeys(pages: readonly PageReport[], report: Pick<SiteReport, 'target' | 'kind'>): string[] {
  const out: string[] = [];
  for (const p of pages) for (const c of failedChecks(p, 'fail')) out.push(`${pagePath(p.url, report)}|${c.id}`);
  return out;
}

export function encodeState(s: CommentState): string {
  const json = JSON.stringify(s).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/--/g, '-\\u002d');
  return `${STATE_OPEN}${json}${STATE_CLOSE}`;
}

const MAX_PUSHES = 20;
const MAX_FAILING = 2000;
const SHA = /^(?:[0-9a-f]{1,40}|this commit)$/i;

function validState(raw: unknown): CommentState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (s.v !== 1 || !Array.isArray(s.pushes) || !Array.isArray(s.failing)) return null;
  if (s.pushes.length > MAX_PUSHES || s.failing.length > MAX_FAILING) return null;
  const pushes: CommentState['pushes'] = [];
  for (const p of s.pushes) {
    if (!p || typeof p !== 'object') return null;
    const { sha, score } = p as Record<string, unknown>;
    if (typeof sha !== 'string' || !SHA.test(sha)) return null;
    if (score !== null && !(typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 100)) return null;
    pushes.push({ sha, score });
  }
  if (!s.failing.every((k) => typeof k === 'string' && k.length <= 500 && k.includes('|'))) return null;
  return { v: 1, pushes, failing: s.failing as string[] };
}

/** The state embedded in our own comment, checked field by field; null when missing or malformed. */
export function parseState(body: string | undefined): CommentState | null {
  if (!body) return null;
  const at = body.indexOf(STATE_OPEN);
  if (at < 0) return null;
  const end = body.indexOf(STATE_CLOSE, at + STATE_OPEN.length);
  if (end < 0) return null;
  try {
    return validState(JSON.parse(body.slice(at + STATE_OPEN.length, end)));
  } catch {
    return null;
  }
}

export interface Baseline {
  /** Branch the PR merges into, e.g. "main". */
  ref: string;
  score: number | null;
  failing: Set<string>;
}

export interface CommentInput {
  report: SiteReport;
  /** Pages the comment is about (the changed pages, or all when the change didn't map to pages). */
  pages: PageReport[];
  changedOnly: boolean;
  /** "the preview `x.vercel.app`" or "the build in `./out`" */
  where: string;
  /** Short head SHA. */
  sha: string;
  baseline?: Baseline;
  previous?: CommentState | null;
  /** True when this PR has no comment of ours yet (the first run's wording). */
  firstRun?: boolean;
  failUnder?: number;
  /** Folder or URL to suggest for a local run. */
  localTarget: string;
}

function thresholdText(score: number | null, failUnder: number | undefined, capital: boolean): string {
  if (failUnder === undefined || score === null) return '';
  const word = score < failUnder ? 'below' : 'above';
  return `${capital ? word.charAt(0).toUpperCase() + word.slice(1) : word} your threshold of ${failUnder}`;
}

function pagesPhrase(input: CommentInput): string {
  const n = input.pages.length;
  return input.changedOnly ? `the ${plural(n, 'page')} this PR changes` : `${plural(n, 'page')} (the changed files didn't map to pages, so every page up to max-pages)`;
}

function capRows(rows: string[][]): { rows: string[][]; note: string } {
  if (rows.length <= MAX_ROWS) return { rows, note: '' };
  return { rows: rows.slice(0, MAX_ROWS), note: `\n\nShowing ${MAX_ROWS} of ${rows.length}. The job summary has the rest.` };
}

function table(head: string[], rows: string[][]): string {
  const c = capRows(rows);
  return mdTable(head, c.rows) + c.note;
}

function checkLabel(pages: readonly PageReport[], id: string): string {
  for (const p of pages) {
    const c = p.checks.find((x) => x.id === id);
    if (c) return c.label;
  }
  return id;
}

function footerLine(input: CommentInput, extra = ''): string {
  return `${extra}Checked ${input.where} at ${mdCell(input.sha)}. ${TOOL_FOOTER}`;
}

/** Every failed check on these pages (a missed threshold lists them all, not only the top fix). */
function failedChecksTable(pages: readonly PageReport[], path: (p: PageReport) => string): string {
  const rows: string[][] = [];
  for (const p of pages) for (const c of failedChecks(p, 'fail')) rows.push([mdCell(path(p)), mdCell(c.label), mdCell(c.fix ?? c.detail)]);
  return rows.length ? table(['Page', 'Check', 'Fix'], rows) : '';
}

/** The PR comment Markdown (board CActionPR). Words only for status. Returns the body and the state it embeds. */
export function renderPrComment(input: CommentInput): { body: string; state: CommentState } {
  const { report, pages } = input;
  const score = input.changedOnly ? pagesScore(pages) : (report.score ?? pagesScore(pages));
  const failing = failingKeys(pages, report);
  const earlier = (input.previous?.pushes ?? []).filter((p) => p.sha !== input.sha);
  const pushes = [...earlier, { sha: input.sha, score }].slice(-MAX_PUSHES);
  const state: CommentState = { v: 1, pushes, failing };
  const counts = countVerdicts(pages);
  const out: string[] = [GEO_TOOL.commentMarker, `### ${GEO_TOOL.name}: AI answer readiness`, ''];
  const path = (p: PageReport): string => pagePath(p.url, report);
  const allPass = counts.fail === 0 && counts.warn === 0 && counts.error === 0;
  const threshold = thresholdText(score, input.failUnder, false);
  const scoreText = scoreWords(score);
  const missed = belowThreshold(score, input.failUnder);

  if (input.previous) {
    const prev = input.previous;
    const prevPush = [...prev.pushes].reverse().find((p) => p.sha !== input.sha);
    const prevScore = prevPush?.score ?? null;
    const pushNo = pushes.length;
    const was = prevScore === null ? '.' : `, was ${prevScore} on the last push.`;
    const thr = thresholdText(score, input.failUnder, true);
    out.push(`**Updated for ${mdCell(input.sha)}** (push ${pushNo} of this PR). **${scoreText}**${was}${thr ? ` ${thr}.` : ''}`);
    const before = new Set(prev.failing);
    const now = new Set(failing);
    const fixed = prev.failing.filter((k) => !now.has(k));
    const added = failing.filter((k) => !before.has(k));
    const still = failing.filter((k) => before.has(k));
    const line = (k: string, tail: (p: PageReport | undefined, id: string) => string): string => {
      const [pth = '', id = ''] = k.split('|');
      const page = pages.find((p) => path(p) === pth);
      return `${mdCell(pth)}: ${lowerFirst(checkLabel(pages, id))}. ${tail(page, id)}`.trim();
    };
    const fixOf = (p: PageReport | undefined, id: string): string => sentence(p?.checks.find((c) => c.id === id)?.fix ?? '');
    if (fixed.length) out.push('', `#### Fixed since the last push (${fixed.length})`, '', fixed.slice(0, MAX_ROWS).map((k) => line(k, () => 'Pass now.')).join('\n\n'));
    if (added.length) out.push('', `#### New since the last push (${added.length})`, '', added.slice(0, MAX_ROWS).map((k) => line(k, fixOf)).join('\n\n'));
    if (still.length) out.push('', `#### Still failing (${still.length})`, '', still.slice(0, MAX_ROWS).map((k) => line(k, fixOf)).join('\n\n'));
    if (!fixed.length && !added.length && !still.length) out.push('', allPass ? `All ${plural(pages.length, 'page')} pass every check.` : `No failures. ${plural(counts.warn, 'page')} with warnings.`);
    const history = pushes.map((p, i) => `push ${i + 1} score ${p.score ?? '–'}`).join(', ');
    out.push('', mdDetails(`History: ${history}`, pushes.map((p, i) => `- Push ${i + 1} (${mdCell(p.sha)}): ${p.score ?? 'no score'}`).join('\n')));
    out.push('', footerLine(input));
  } else if (allPass) {
    const was = input.baseline?.score !== undefined && input.baseline.score !== null ? ` (was ${input.baseline.score} on ${input.baseline.ref})` : '';
    const subject = input.changedOnly ? `All ${pages.length} changed ${pages.length === 1 ? 'page passes' : 'pages pass'}` : `All ${pages.length} ${pages.length === 1 ? 'page passes' : 'pages pass'}`;
    out.push(`**Pass.** ${subject} every check. ${scoreText}${was}.${threshold ? ` ${threshold.charAt(0).toUpperCase()}${threshold.slice(1)}.` : ''}`);
    out.push('', mdDetails(`Pages checked (${pages.length})`, table(['Page', 'Score'], pages.map((p) => [mdCell(path(p)), String(p.score ?? '–')]))));
    out.push('', footerLine(input));
  } else if (input.baseline && counts.fail > 0) {
    const base = input.baseline;
    const newKeys = failing.filter((k) => !base.failing.has(k));
    const oldKeys = failing.filter((k) => base.failing.has(k));
    const was = base.score === null ? '' : `, was ${base.score} on ${mdCell(base.ref)}`;
    const where = input.changedOnly ? `${plural(pages.length, 'changed page')}` : plural(pages.length, 'page');
    const verdict = runVerdict({ score, pages }, input.failUnder);
    out.push(
      `**${verdict}. ${scoreText}${was}**${threshold ? `, ${threshold}` : ''}. This PR adds ${newKeys.length ? `**${plural(newKeys.length, 'new failure')}**` : 'no new failures'} on ${where}.`,
    );
    const rowOf = (k: string): string[] => {
      const [pth = '', id = ''] = k.split('|');
      const page = pages.find((p) => path(p) === pth);
      const c = page?.checks.find((x) => x.id === id);
      return [mdCell(pth), mdCell(c?.label ?? id), mdCell(c?.fix ?? c?.detail ?? '')];
    };
    if (newKeys.length) out.push('', '#### New failures', '', table(['Page', 'Check', 'Fix'], newKeys.map(rowOf)));
    const folds: string[] = [];
    if (oldKeys.length) folds.push(mdDetails(`Already failing on ${base.ref} (${oldKeys.length})`, table(['Page', 'Check', 'Fix'], oldKeys.map(rowOf))));
    const warnPages = pages.filter((p) => pageVerdict(p) === 'warn');
    if (warnPages.length) folds.push(mdDetails(`Warnings (${warnPages.length})`, table(['Page', 'Result', 'Top fix'], warnPages.map((p) => [mdCell(path(p)), verdictScoreCell(p), mdCell(topFixOf(p))]))));
    const passPages = pages.filter((p) => pageVerdict(p) === 'pass');
    if (passPages.length) folds.push(mdDetails(`Passing (${passPages.length})`, table(['Page', 'Score'], passPages.map((p) => [mdCell(path(p)), String(p.score ?? '–')]))));
    if (folds.length) out.push('', folds.join('\n\n'));
    out.push('', footerLine(input, `Run locally: ${mdCode(`npx ${GEO_TOOL.bin} check ${input.localTarget}`)}. `));
  } else {
    const phrase = pagesPhrase(input).replace(/^the (\d+ pages?) this PR changes$/, '**the $1 this PR changes**');
    const lead = input.firstRun ? `First ${GEO_TOOL.name} run on this repo. It checked ${phrase}` : `${GEO_TOOL.name} checked ${phrase}`;
    out.push(`${lead} on ${input.where}. This comment updates on each push instead of posting again.`);
    const parts = [`**${scoreText}** for these pages`, ...pageCountParts(counts)];
    out.push('', `${parts.join(' · ')}${threshold ? ` · ${threshold}` : ''}`);
    const issues = pages.filter((p) => pageVerdict(p) !== 'pass');
    out.push('', table(['Page', 'Result', 'Top fix'], issues.map((p) => [mdCell(path(p)), verdictScoreCell(p), mdCell(topFixOf(p))])));
    const all = missed ? failedChecksTable(pages, path) : '';
    if (all) out.push('', `#### Failed checks`, '', all);
    const about = renderChecksAbout(checkCatalog(report));
    if (about) out.push('', about);
    out.push('', `Prompts aren't asked in pull requests; they run on the schedule. ${footerLine(input)}`);
  }
  out.push('', encodeState(state));
  return { body: out.join('\n'), state };
}
