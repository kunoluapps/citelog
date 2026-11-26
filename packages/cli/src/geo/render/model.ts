// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { DESK_NAME, GEO_TOOL, JUDGE_MODEL_LABEL, MEASURE_COPY, PERCEPTIONS, PERCEPTION_JUDGES, SOURCES, formatSourceTag, formatUsd, type Perception } from '@morningdesk/core';
import { CHECK_COPY, ENGINES, ENGINE_IDS } from '@morningdesk/geo';
import type { CheckId, CheckOutcome, EngineId, LogSummary, PageReport, PromptResult, PromptRun, ScoreBand, SiteReport } from '@morningdesk/geo';

/** A page's result in tables: its worst check, or 'error' when it could not be loaded. */
export type PageVerdict = 'fail' | 'warn' | 'pass' | 'error';

export function pageVerdict(page: PageReport): PageVerdict {
  if (page.error || page.score === null) return 'error';
  if (page.checks.some((c) => c.result === 'fail')) return 'fail';
  if (page.checks.some((c) => c.result === 'warn')) return 'warn';
  return 'pass';
}

export const VERDICT_WORD: Record<PageVerdict, string> = { fail: 'Fail', warn: 'Warn', pass: 'Pass', error: "Couldn't load" };

export const BAND_RANGE: Record<ScoreBand, string> = { ready: '90–100', needs_work: '50–89', not_ready: '0–49', no_score: '' };

const VERDICT_ORDER: Record<PageVerdict, number> = { error: 0, fail: 1, warn: 2, pass: 3 };

/** Errors first, then fails, warns, passes; lower score first inside each group except passes, which keep their order. */
export function sortWorstFirst(pages: readonly PageReport[]): PageReport[] {
  return pages
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const v = VERDICT_ORDER[pageVerdict(a.p)] - VERDICT_ORDER[pageVerdict(b.p)];
      if (v !== 0) return v;
      if (pageVerdict(a.p) === 'pass') return a.i - b.i;
      const s = (a.p.score ?? -1) - (b.p.score ?? -1);
      return s !== 0 ? s : a.i - b.i;
    })
    .map((x) => x.p);
}

export interface VerdictCounts {
  fail: number;
  warn: number;
  pass: number;
  error: number;
}

export function countVerdicts(pages: readonly PageReport[]): VerdictCounts {
  const out: VerdictCounts = { fail: 0, warn: 0, pass: 0, error: 0 };
  for (const p of pages) out[pageVerdict(p)] += 1;
  return out;
}

/** "11 fail, 9 warn, 18 pass" (zero parts left out). */
export function formatCounts(c: VerdictCounts): string {
  const parts: string[] = [];
  if (c.error) parts.push(`${c.error} couldn't load`);
  if (c.fail) parts.push(`${c.fail} fail`);
  if (c.warn) parts.push(`${c.warn} warn`);
  if (c.pass) parts.push(`${c.pass} pass`);
  return parts.join(', ');
}

/** A page's path for display: "/learn/roth-ira" for URLs, the path inside the folder for built HTML. */
export function pagePath(url: string, report?: Pick<SiteReport, 'target' | 'kind'>): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.pathname}${u.search}` || '/';
    if (u.protocol === 'file:') return folderRelative(decodeURIComponent(u.pathname), report);
  } catch {
    // not a URL: a file path
  }
  return folderRelative(url, report);
}

function folderRelative(path: string, report?: Pick<SiteReport, 'target' | 'kind'>): string {
  let p = path.replace(/\\/g, '/');
  if (report?.kind === 'folder') {
    const root = report.target.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (root && (p.startsWith(`${root}/`) || p.startsWith(`./${root}/`))) p = p.slice(p.indexOf(root) + root.length);
  }
  p = p.replace(/(^|\/)index\.html?$/, '/').replace(/\.html?$/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.replace(/\/{2,}/g, '/');
}

/** "Content present without JavaScript" -> "content present without JavaScript"; "JSON-LD ..." stays. */
export function lowerFirst(s: string): string {
  if (s.length > 1 && s[1] === s[1]?.toUpperCase() && /[A-Z]/.test(s[1] ?? '')) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export interface IssueGroup {
  id: CheckId;
  label: string;
  result: 'fail' | 'warn';
  /** Pages where this check failed (or warned). */
  pages: PageReport[];
  weight: number;
  detail: string;
  fix?: string;
  why: string;
}

/** Failed and warned checks across pages, fails first, then by pages affected, then weight. */
export function groupIssues(pages: readonly PageReport[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const page of pages) {
    for (const c of page.checks) {
      if (c.result !== 'fail' && c.result !== 'warn') continue;
      const key = `${c.result}:${c.id}`;
      const g = groups.get(key);
      if (g) g.pages.push(page);
      else groups.set(key, { id: c.id, label: c.label, result: c.result, pages: [page], weight: c.weight, detail: c.detail, fix: c.fix, why: c.why });
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.result !== b.result) return a.result === 'fail' ? -1 : 1;
    if (a.pages.length !== b.pages.length) return b.pages.length - a.pages.length;
    return b.weight - a.weight;
  });
}

/** Failed checks of a page, highest weight first. */
export function failedChecks(page: PageReport, result: 'fail' | 'warn' = 'fail'): CheckOutcome[] {
  return page.checks.filter((c) => c.result === result).sort((a, b) => b.weight - a.weight);
}

/** The scored check list (for "what we check and why"). */
export function checkCatalog(report: SiteReport): CheckOutcome[] {
  const first = report.pages.find((p) => p.checks.length > 0);
  return first ? first.checks : [];
}

/**
 * The one threshold rule (CLI and Action): with a threshold set, a score under it misses, and so does no score at all
 * (nothing could be checked, so nothing passed). Without a threshold nothing misses.
 */
export function belowThreshold(score: number | null, failUnder: number | undefined): boolean {
  return failUnder !== undefined && (score === null || score < failUnder);
}

/** Short check name for tight places: "short answer", "JSON-LD" (readiness CHECK_COPY). */
export function shortLabel(id: CheckId): string {
  return CHECK_COPY[id].short;
}

/** "Fail" or "Pass" for the run as a whole: follows the threshold when one is set, else the page results. */
export function runVerdict(report: Pick<SiteReport, 'score' | 'pages'>, failUnder: number | undefined): 'Fail' | 'Pass' | 'No score' {
  if (report.score === null) return failUnder !== undefined ? 'Fail' : 'No score';
  if (failUnder !== undefined) return report.score < failUnder ? 'Fail' : 'Pass';
  return report.pages.some((p) => pageVerdict(p) === 'fail') ? 'Fail' : 'Pass';
}

/** "12 with failures · 3 with warnings · 35 passing": page counts said as pages, not check counts. */
export function pageCountParts(c: VerdictCounts): string[] {
  const parts = [`${c.fail} with failures`, `${c.warn} with warnings`, `${c.pass} passing`];
  if (c.error) parts.push(`${c.error} couldn't load`);
  return parts;
}

/** "content without JavaScript (2 pages), JSON-LD (1 page)": what a missed threshold names, top `limit` (all by default). */
export function failedCheckNames(pages: readonly PageReport[], limit = Number.POSITIVE_INFINITY): string {
  const fails = groupIssues(pages).filter((g) => g.result === 'fail');
  const named = fails.slice(0, limit).map((g) => `${shortLabel(g.id)} (${plural(g.pages.length, 'page')})`);
  if (fails.length > limit) named.push(`${fails.length - limit} more`);
  return named.join(', ');
}

/** "1,204 lines" or "3 lines (480 requests)" when lines hold JSON arrays of requests. */
export function logLinesText(s: Pick<LogSummary, 'linesRead' | 'linesSkipped' | 'requests'>): string {
  const lines = `${s.linesRead.toLocaleString('en-US')} ${s.linesRead === 1 ? 'line' : 'lines'}`;
  const parsed = s.linesRead - s.linesSkipped;
  if (s.requests === undefined || s.requests === parsed) return lines;
  return `${lines} (${s.requests.toLocaleString('en-US')} ${s.requests === 1 ? 'request' : 'requests'})`;
}

export function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

export function scoreSourceTag(checkedAt: string): string {
  return formatSourceTag({ source: 'readiness', asOf: checkedAt });
}

/** Engine display names (ChatGPT, Claude, Perplexity, Gemini) from the shared source names. */
export function engineLabel(id: EngineId): string {
  return SOURCES[id];
}

/** Engines that were asked (had a key), in result order. */
export function enginesInRun(run: PromptRun): EngineId[] {
  const seen: EngineId[] = [];
  for (const r of run.results) if (r.status !== 'skipped' && !seen.includes(r.engine)) seen.push(r.engine);
  return seen;
}

/** Domains cited instead of the site, with how many answers cited each, most first. */
export function othersCited(run: PromptRun): { domain: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of run.results) {
    if (r.status !== 'checked' || r.cited) continue;
    for (const d of r.others) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count);
}

/** An answer's mark: cited (linked a site page), named (says a brand term), or neither. Not measured (old JSON) = neither. */
export type AnswerMark = 'cited' | 'named' | 'none';

export function answerMark(r: Pick<PromptResult, 'cited' | 'mentioned'>): AnswerMark {
  if (r.cited) return 'cited';
  return r.mentioned ? 'named' : 'none';
}

export interface ConsideredRow {
  /** Page path; null when the engine gives the site only (Gemini: "a bywell.org page"). */
  path: string | null;
  host: string;
  /** Engines whose answers considered the page without citing it, with how many answers. */
  engines: { engine: EngineId; count: number }[];
}

/**
 * Site pages engines considered but didn't cite, most answers first, and the engines that report no considered sources
 * for any answer this run ("not collected for Perplexity"), which is never the same as none.
 */
export function consideredNotCited(run: PromptRun): { rows: ConsideredRow[]; notCollected: EngineId[] } {
  const rows = new Map<string, ConsideredRow>();
  const collected = new Set<EngineId>();
  const checked = new Set<EngineId>();
  for (const r of run.results) {
    if (r.status !== 'checked') continue;
    checked.add(r.engine);
    if (!r.considered) continue;
    collected.add(r.engine);
    const seen = new Set<string>();
    for (const s of r.considered) {
      if (s.cited) continue;
      const path = s.url ? pagePath(s.url) : null;
      const key = `${s.host}|${path ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = rows.get(key) ?? { path, host: s.host, engines: [] };
      const e = row.engines.find((x) => x.engine === r.engine);
      if (e) e.count++;
      else row.engines.push({ engine: r.engine, count: 1 });
      rows.set(key, row);
    }
  }
  const total = (row: ConsideredRow) => row.engines.reduce((a, e) => a + e.count, 0);
  for (const row of rows.values()) row.engines.sort((a, b) => ENGINE_IDS.indexOf(a.engine) - ENGINE_IDS.indexOf(b.engine));
  return {
    rows: [...rows.values()].sort((a, b) => total(b) - total(a)),
    notCollected: [...checked].filter((e) => !collected.has(e)),
  };
}

/** "/learn/roth-ira", "blog.bywell.org/x" for another host on the site, "a bywell.org page" for a site-only row. */
export function consideredPlace(row: Pick<ConsideredRow, 'path' | 'host'>, site: string): string {
  if (row.path === null) return `a ${row.host} page`;
  return row.host === site || row.host === `www.${site}` ? row.path : `${row.host}${row.path}`;
}

/** "ChatGPT (2), Claude". */
export function consideredEngines(row: ConsideredRow): string {
  return row.engines.map((e) => (e.count > 1 ? `${engineLabel(e.engine)} (${e.count})` : engineLabel(e.engine))).join(', ');
}

/** "Claude Haiku 5.5" for a judge model id (core JUDGE_MODEL_LABEL); an unknown id as given. */
export function judgeLabel(model: string): string {
  return (JUDGE_MODEL_LABEL as Record<string, string>)[model] ?? model;
}

/** "Not collected for Perplexity, Gemini." (core MEASURE_COPY). */
export function notCollectedText(engines: readonly EngineId[]): string {
  return engines.length ? `${MEASURE_COPY.notCollected(engines.map(engineLabel).join(', '))}.` : '';
}

/** Perception counts over judged answers; null when nothing was judged. */
export function perceptionCounts(run: PromptRun): Record<Perception, number> | null {
  const judged = run.results.filter((r) => r.perceptionStatus === 'judged' && r.perception);
  if (!judged.length) return null;
  const out = Object.fromEntries(PERCEPTIONS.map((p) => [p, 0])) as Record<Perception, number>;
  for (const r of judged) if (r.perception) out[r.perception.value]++;
  return out;
}

/**
 * The perception line after a run (no closing period), or null when it wasn't asked for:
 * "Perception (claude-haiku-5-5, 6 answers about you): 4 positive · 1 neutral · 1 negative. Cost: <$0.01".
 */
export function perceptionLine(run: PromptRun, asked: boolean): string | null {
  if (!asked) return null;
  if (run.results.some((r) => r.perceptionStatus === 'no_key')) {
    return `${MEASURE_COPY.perceptionNeedsKey} (${PERCEPTION_JUDGES.map((j) => ENGINES[j.provider].envVar).join(' or ')}); nothing was judged, $0`;
  }
  const j = run.judge;
  if (!j) return 'Perception: no answer named or cited you, so nothing was judged, $0';
  const counts = perceptionCounts(run);
  const parts = counts ? PERCEPTIONS.map((p) => `${counts[p]} ${p}`).join(' · ') : 'none judged';
  const failed = j.failed ? `, ${j.failed} failed` : '';
  const cost = j.costUsdMicros === undefined ? `cost unknown (no listed price for ${judgeLabel(j.model)})` : formatUsd(j.costUsdMicros);
  return `Perception (${judgeLabel(j.model)} on ${ENGINES[j.provider].envVar}, ${plural(j.judged, 'answer')} about you${failed}): ${parts}. Cost: ${cost}`;
}

/** "bywell.org" for a URL target, the folder as typed otherwise. */
export function siteName(target: string): string {
  try {
    const u = new URL(target);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host;
  } catch {
    // folder
  }
  return target;
}

export const TOOL_LINE = `${GEO_TOOL.bin} ${GEO_TOOL.version} · part of ${DESK_NAME}`;
export const TOOL_FOOTER = `${GEO_TOOL.name} ${GEO_TOOL.version}, part of ${DESK_NAME}.`;
