// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { GEO_TOOL, MEASURE_COPY, SCORE_BANDS, formatSourceTag, formatUsd } from '@morningdesk/core';
import { NO_SEARCH_NOTE, SCORE_BAND_LABEL, scoreBand } from '@morningdesk/geo';
import type { AiBot, CheckOutcome, EngineId, LogFormat, LogSummary, PageReport, PromptResult, PromptRun, SiteReport } from '@morningdesk/geo';
import {
  BAND_RANGE,
  TOOL_LINE,
  answerMark,
  consideredEngines,
  consideredNotCited,
  consideredPlace,
  notCollectedText,
  perceptionLine,
  type AnswerMark,
  belowThreshold,
  countVerdicts,
  engineLabel,
  enginesInRun,
  failedChecks,
  formatCounts,
  groupIssues,
  logLinesText,
  lowerFirst,
  othersCited,
  pageCountParts,
  pagePath,
  pageVerdict,
  plural,
  scoreSourceTag,
  shortLabel,
  sentence,
  sortWorstFirst,
  type PageVerdict,
} from './model.js';
import { clip, padEnd, padStart, wrap, type Style } from './style.js';

const PAGE_COL = 30;
const ROWS_SHOWN = 3;
const DETAIL_BLOCKS = 2;
const DETAIL_INDENT = '       ';
const DETAIL_WIDTH = 50;
/** Terminal width when the output isn't a terminal (pipes, CI logs). */
export const DEFAULT_COLUMNS = 80;
/** Failed checks named on the "Failed checks:" line (D2); the rest are counted. */
const FAILED_NAMES_SHOWN = 3;

export function toolLine(style: Style): string {
  return style.dim(TOOL_LINE);
}

function verdictWord(v: PageVerdict, style: Style): string {
  if (v === 'fail') return style.fail('FAIL');
  if (v === 'warn') return style.warn('WARN');
  if (v === 'pass') return style.pass('PASS');
  return style.fail("COULDN'T LOAD");
}

function bandWord(report: Pick<SiteReport, 'band'>, style: Style): string {
  const word = SCORE_BAND_LABEL[report.band];
  if (report.band === 'ready') return style.pass(word);
  if (report.band === 'needs_work') return style.warn(word);
  if (report.band === 'not_ready') return style.fail(word);
  return style.dim(word);
}

/** "Read sitemap.xml: 12 pages", "Read ./out: 41 HTML files". */
export function readLine(report: SiteReport): string {
  const n = report.pages.length;
  const t = report.truncated;
  const count = t ? `first ${t.limit} of ${t.total} pages (--max-pages to change)` : plural(n, 'page');
  const off = report.skippedOffSite ? `; left out ${plural(report.skippedOffSite, 'URL')} on other hosts` : '';
  if (report.kind === 'folder') return `Read ${report.target}: ${t ? count : plural(n, 'HTML file')}`;
  if (report.kind === 'sitemap') {
    const file = /\.xml(\.gz)?(\?|$)/i.test(report.target) ? report.target.split('?')[0]?.split('/').pop() : undefined;
    return `Read ${file ?? "the site's sitemap"}: ${count}${off}`;
  }
  return `Read ${report.target}: ${count}`;
}

export interface CheckTextOptions {
  style: Style;
  verbose?: boolean;
  failUnder?: number;
  durationMs?: number;
  /** Print the one-line hint to create a config file (first run, no config). */
  configHint?: boolean;
  /** Terminal width for wrapping (default 80). */
  columns?: number;
  /** Print the tool line first (default true; the "What AI sees" block has its own). */
  toolLine?: boolean;
}

function detailBlock(title: string, verdict: 'fail' | 'warn', lines: string[], fix: string | undefined, style: Style, columns = DEFAULT_COLUMNS): string[] {
  const word = verdict === 'fail' ? style.fail('FAIL') : style.warn('WARN');
  const titleWidth = Math.max(DETAIL_WIDTH, columns - DETAIL_INDENT.length);
  const [firstTitle = '', ...moreTitle] = wrap(title, titleWidth - 4);
  const out = [`  ${word} ${firstTitle}`, ...moreTitle.map((t) => `${DETAIL_INDENT}${t}`)];
  for (const l of lines) for (const w of wrap(l, DETAIL_WIDTH)) out.push(`${DETAIL_INDENT}${w}`);
  if (fix) {
    const [first, ...rest] = wrap(`Fix: ${lowerFirst(fix)}`, DETAIL_WIDTH);
    out.push(`${DETAIL_INDENT}${style.bold('Fix:')}${(first ?? '').slice(4)}`);
    for (const w of rest) out.push(`${DETAIL_INDENT}${w}`);
  }
  return out;
}

function pageIssueBlocks(page: PageReport, report: SiteReport, style: Style, columns: number): string[][] {
  const path = pagePath(page.url, report);
  const issues: CheckOutcome[] = [...failedChecks(page, 'fail'), ...failedChecks(page, 'warn')].filter((c) => c.id !== 'robots_ai');
  if (issues.length === 1 && issues[0]) {
    const c = issues[0];
    return [detailBlock(path, c.result as 'fail' | 'warn', [c.label, c.detail], c.fix, style, columns)];
  }
  return issues.map((c) => detailBlock(`${path}: ${lowerFirst(c.label)}`, c.result as 'fail' | 'warn', [c.detail], c.fix, style, columns));
}

/** The readiness report as the terminal shows it (board CCli states 1-3). */
export function renderCheckText(report: SiteReport, opts: CheckTextOptions): string {
  const { style } = opts;
  const columns = Math.max(40, opts.columns ?? DEFAULT_COLUMNS);
  const out: string[] = [...(opts.toolLine === false ? [] : [toolLine(style)]), readLine(report), ''];
  const sorted = sortWorstFirst(report.pages);
  const shown = opts.verbose ? sorted : sorted.slice(0, ROWS_SHOWN);
  const rest = sorted.slice(shown.length);

  out.push(`  ${padEnd('Page', PAGE_COL)}${padStart('Score', 5)}  Result`);
  for (const p of shown) {
    const v = pageVerdict(p);
    const n = v === 'fail' ? failedChecks(p, 'fail').length : v === 'warn' ? failedChecks(p, 'warn').length : 0;
    const score = p.score === null ? '–' : String(p.score);
    out.push(`  ${padEnd(clip(pagePath(p.url, report), PAGE_COL), PAGE_COL)}${padStart(score, 5)}  ${verdictWord(v, style)}${n ? `  ${n}` : ''}`.trimEnd());
  }
  if (rest.length) {
    const c = countVerdicts(rest);
    const allReady = rest.every((p) => pageVerdict(p) === 'pass' && scoreBand(p.score) === 'ready');
    const readyMin = SCORE_BANDS.ready.min;
    out.push(`  ${style.dim(allReady ? `… ${rest.length} more ${rest.length === 1 ? 'page' : 'pages'}, all ${readyMin} or above` : `… ${rest.length} more (${formatCounts(c)})`)}`);
  }
  out.push('');

  const blocks: string[][] = [];
  const robots = groupIssues(report.pages).find((g) => g.id === 'robots_ai');
  if (robots) {
    const [title = robots.detail, ...more] = robots.detail.split(/(?<=\.)\s+/);
    blocks.push(detailBlock(title.replace(/\.$/, ''), robots.result, more, robots.fix, style, columns));
  }
  const pagesWithIssues = sorted.filter((p) => {
    const v = pageVerdict(p);
    return v === 'fail' || v === 'warn';
  });
  for (const p of opts.verbose ? pagesWithIssues : pagesWithIssues.slice(0, 1)) blocks.push(...pageIssueBlocks(p, report, style, columns));
  for (const p of sorted.filter((x) => pageVerdict(x) === 'error')) {
    const lines = wrap(p.error ?? 'No response.', columns - DETAIL_INDENT.length).map((l) => `${DETAIL_INDENT}${l}`);
    blocks.push([`  ${style.fail("COULDN'T LOAD")} ${pagePath(p.url, report)}`, ...lines]);
  }
  const visible = opts.verbose ? blocks : blocks.slice(0, DETAIL_BLOCKS);
  for (const b of visible) out.push(...b);
  if (visible.length) out.push('');

  const counts = countVerdicts(report.pages);
  const below = belowThreshold(report.score, opts.failUnder);
  const scoreText = style.bold(report.score === null ? '–' : String(report.score));
  if (below) {
    out.push(`  Site score ${scoreText}  ${style.fail(`below --fail-under ${opts.failUnder}`)}`);
  } else {
    const range = BAND_RANGE[report.band];
    out.push(`  Site score ${scoreText}  ${bandWord(report, style)}${range ? ` (${range})` : ''}`);
    const hidden = !opts.verbose && (rest.some((p) => pageVerdict(p) !== 'pass') || blocks.length > visible.length);
    const parts = [plural(report.pages.length, 'page'), ...pageCountParts(counts).slice(0, 2)];
    out.push(`  ${parts.join(' · ')}${hidden ? `  ${style.dim('(--verbose lists all)')}` : ''}`);
  }
  const indentWrap = (label: string, text: string): string[] => {
    const pad = ' '.repeat(2 + label.length);
    const [first = '', ...more] = wrap(text, columns - pad.length);
    return [`  ${label}${first}`, ...more.map((l) => `${pad}${l}`)];
  };
  const top = groupIssues(report.pages).find((g) => g.result === 'fail' && g.fix && g.id !== 'robots_ai');
  if (top?.fix) out.push(...indentWrap('Top fix: ', `${shortFix(top.fix)} (${plural(top.pages.length, 'page')})`));
  if (below) {
    const fails = groupIssues(report.pages).filter((g) => g.result === 'fail');
    const names = fails.slice(0, FAILED_NAMES_SHOWN).map((g) => `${shortLabel(g.id)} (${g.pages.length})`);
    if (fails.length > FAILED_NAMES_SHOWN) names.push(`${fails.length - FAILED_NAMES_SHOWN} more`);
    if (names.length) out.push(...indentWrap('Failed checks: ', names.join(', ')));
  }
  const llms = report.pages.flatMap((p) => p.checks).find((c) => c.id === 'llms_txt');
  if (llms) out.push(`  llms.txt  ${/^found/i.test(llms.detail) ? 'found' : /^no\b/i.test(llms.detail) ? 'not found' : 'unknown'} ${style.dim('(info, not scored)')}`);
  out.push(`  ${style.dim(scoreSourceTag(report.checkedAt))}`);
  out.push('');

  const done: string[] = [];
  if (opts.durationMs !== undefined) done.push(`Done in ${(opts.durationMs / 1000).toFixed(1)} s.`);
  if (opts.configHint) done.push(`Track prompts too: npx ${GEO_TOOL.bin} init`);
  if (done.length) out.push(style.dim(done.join(' ')));
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/** The first clause of a fix, for the one-line "Top fix". */
export function shortFix(fix: string): string {
  const first = fix.split(/(?<=\.)\s/)[0] ?? fix;
  return lowerFirst(first.split(/ \(|; /)[0]?.replace(/[.:,]$/, '') ?? first);
}

export interface CouldntRun {
  /** What we tried to read (URL, file or folder). */
  what: string;
  /** What happened, one or two lines. */
  lines: string[];
  /** Ways to fix it, one per line. */
  tries?: string[];
  /** Print the tool line first (check and logs do). */
  header?: boolean;
}

/** The "couldn't run" block (board CCli state 6). Always exit 2. */
export function renderCouldntRunText(c: CouldntRun, style: Style): string {
  const out: string[] = [];
  if (c.header) out.push(toolLine(style), '');
  out.push(`${style.fail("COULDN'T RUN")} ${c.what}`);
  for (const l of c.lines) out.push(`  ${l}`);
  if (c.tries?.length) {
    out.push('', '  Try:');
    for (const t of c.tries) out.push(`  · ${t}`);
  }
  return `${out.join('\n')}\n`;
}

/* ---------- prompts ---------- */

const PROMPT_COL = 22;
const SHORT_LABEL: Partial<Record<EngineId, string>> = { perplexity: 'Perplx' };

const MARK_TEXT: Record<AnswerMark, string> = { cited: MEASURE_COPY.cited.toLowerCase(), named: MEASURE_COPY.named.toLowerCase(), none: '-' };

function cell(r: PromptResult | undefined, style: Style): string {
  if (!r || r.status === 'skipped') return style.dim('skip');
  if (r.status === 'not_checked') return style.dim('n/c');
  const mark = answerMark(r);
  return mark === 'cited' ? style.pass(MARK_TEXT.cited) : MARK_TEXT[mark];
}

export interface PromptsTextOptions {
  style: Style;
  /** "Read citelog.config.json: 5 prompts for lovestruck.app" */
  configLine?: string;
  /** A dim line under it, e.g. more topics than the desk keeps. */
  note?: string;
  /** --perception was passed: print the perception line (or why nothing was judged). */
  perception?: boolean;
}

/** The "Considered, not cited:" block: site pages engines read but didn't link, and engines that don't report them. */
export function renderConsideredText(run: PromptRun, style: Style): string[] {
  const { rows, notCollected } = consideredNotCited(run);
  const engines = enginesInRun(run).filter((e) => run.results.some((r) => r.engine === e && r.status === 'checked'));
  if (!engines.length) return [];
  const missing = notCollectedText(notCollected);
  if (!rows.length) {
    const none = notCollected.length === engines.length ? lowerFirst(missing) : `none reported.${missing ? ` ${missing}` : ''}`;
    return [`  ${MEASURE_COPY.consideredNotCited}: ${none}`, ''];
  }
  const out = [`  ${MEASURE_COPY.consideredNotCited}:`];
  for (const row of rows.slice(0, 5)) out.push(`    ${padEnd(clip(consideredPlace(row, run.site), PROMPT_COL), PROMPT_COL + 2)}${consideredEngines(row)}`);
  if (rows.length > 5) out.push(`    ${style.dim(`… ${rows.length - 5} more (--json lists all)`)}`);
  if (missing) out.push(`    ${style.dim(missing)}`);
  out.push('');
  return out;
}

/** Engines and the env var that enables each, for the "no keys" state. */
export function renderNoKeysText(skipped: PromptRun['skipped'], opts: PromptsTextOptions): string {
  const { style } = opts;
  const out: string[] = [];
  if (opts.configLine) out.push(opts.configLine, '');
  out.push(`${style.warn('SKIPPED')} No engine keys found, so no prompts were asked.`, 'Set one or more, then run again:', '');
  for (const s of skipped) out.push(`  ${padEnd(engineLabel(s.engine), 13)}${s.envVar}`);
  out.push('', style.dim(`Keys stay on your machine. ${GEO_TOOL.name} calls only the`), style.dim('engines whose keys are set, and sends no telemetry.'));
  return `${out.join('\n')}\n`;
}

/** Prompt results (board CCli states 4-5). */
export function renderPromptsText(run: PromptRun, prompts: readonly string[], opts: PromptsTextOptions): string {
  const { style } = opts;
  const engines = enginesInRun(run);
  if (engines.length === 0) return renderNoKeysText(run.skipped, opts);

  const out: string[] = [];
  if (opts.configLine) out.push(opts.configLine);
  if (opts.note) out.push(style.dim(opts.note));
  out.push(`Asking ${plural(prompts.length, 'prompt')} on ${plural(engines.length, 'engine')}…`, '');
  const widths = engines.map((e) => Math.max((SHORT_LABEL[e] ?? engineLabel(e)).length, 5) + 2);
  out.push(`  ${padEnd('Prompt', PROMPT_COL + 2)}${engines.map((e, i) => padEnd(SHORT_LABEL[e] ?? engineLabel(e), widths[i] ?? 0)).join('')}`.trimEnd());
  for (const p of prompts) {
    const cells = engines.map((e, i) => padEnd(cell(run.results.find((r) => r.prompt === p && r.engine === e), style), widths[i] ?? 0));
    out.push(`  ${padEnd(clip(p, PROMPT_COL), PROMPT_COL + 2)}${cells.join('')}`.trimEnd());
  }
  out.push('');
  out.push(`  ${style.dim('cited = linked your site · named = says your name, no link · - = neither')}`, '');
  const others = othersCited(run).slice(0, 3);
  if (others.length) out.push(`  Instead of you: ${others.map((o) => `${o.domain} (${o.count})`).join(', ')}`, '');
  out.push(...renderConsideredText(run, style));
  const perception = perceptionLine(run, opts.perception ?? false);
  if (perception) out.push(`  ${perception}`, '');

  const failed = engines.filter((e) => run.results.some((r) => r.engine === e && r.status === 'not_checked'));
  for (const e of failed) {
    const err = run.results.find((r) => r.engine === e && r.status === 'not_checked')?.error;
    out.push(`${style.warn('NOT CHECKED')} ${engineLabel(e)}: ${sentence(err?.message ?? 'the engine returned an error')}`);
  }
  if (failed.length) {
    const finished = engines.length - failed.length;
    out.push(`  The other ${plural(finished, 'engine')} finished. n/c = not checked.`, '');
  }
  if (run.skipped.length) {
    out.push(style.dim(`Not asked (no key): ${run.skipped.map((s) => `${engineLabel(s.engine)} (${s.envVar})`).join(', ')}.`), '');
  }
  const noSearch = noSearchEngines(run);
  if (noSearch.length) out.push(`  ${NO_SEARCH_NOTE}: ${noSearch.map((n) => `${engineLabel(n.engine)} (${n.count})`).join(', ')}.`, '');
  out.push(style.dim('API answers can differ from what a person sees in'));
  out.push(style.dim(`ChatGPT and the other apps. Est. cost: ${costText(run)}`));
  const at = run.results[0]?.checkedAt;
  if (at) out.push(style.dim(scoreSourceTag(at)));
  return `${out.join('\n')}\n`;
}

/** "$0.41", "$0.41, plus unknown for gpt-unlisted (no listed price)", "unknown (no listed price for gpt-unlisted)". */
export function costText(run: PromptRun): string {
  const unpriced = run.unpricedModels ?? [];
  if (!unpriced.length) return formatUsd(run.costUsdMicros);
  const models = unpriced.join(', ');
  const priced = run.results.some((r) => r.costUsdMicros !== undefined);
  return priced ? `${formatUsd(run.costUsdMicros)}, plus cost unknown for ${models} (no listed price)` : `cost unknown (no listed price for ${models})`;
}

/** Engines that answered without a web search, with how many answers. */
export function noSearchEngines(run: PromptRun): { engine: EngineId; count: number }[] {
  const counts = new Map<EngineId, number>();
  for (const r of run.results) if (r.note === NO_SEARCH_NOTE) counts.set(r.engine, (counts.get(r.engine) ?? 0) + 1);
  return [...counts.entries()].map(([engine, count]) => ({ engine, count }));
}

/* ---------- logs ---------- */

export const LOG_FORMAT_NAME: Record<LogFormat, string> = {
  combined: 'nginx or Apache combined',
  cloudflare: 'Cloudflare Logpush JSON (http_requests)',
  vercel: 'Vercel log drain JSON',
};

function botName(id: string, bots: readonly AiBot[]): { name: string; vendor: string } {
  const b = bots.find((x) => x.id === id);
  return { name: b?.name ?? id, vendor: b?.vendor ?? '' };
}

function ipWord(b: LogSummary['bots'][number], style: Style): string {
  if (b.unknownHits === b.hits) return style.dim('no IP list');
  if (b.unverifiedHits === 0) return style.pass('verified');
  return style.warn(`UNVERIFIED ${b.unverifiedHits} of ${b.hits}`);
}

export interface LogsTextOptions {
  style: Style;
  file: string;
  bots: readonly AiBot[];
  verbose?: boolean;
}

/** "Logs · 7 days · to Nov 15" for the range the log covers, or null when it has no dated lines. */
export function logsSourceTag(s: LogSummary): string | null {
  if (!s.from || !s.to) return null;
  return formatSourceTag({ source: 'logs', range: { start: s.from.slice(0, 10), end: s.to.slice(0, 10) }, asOf: s.to });
}

/** AI crawler visits by bot and page, each bot marked verified or unverified by IP (AC 7). */
export function renderLogsText(s: LogSummary, opts: LogsTextOptions): string {
  const { style } = opts;
  const out: string[] = [toolLine(style)];
  out.push(`Read ${opts.file}: ${logLinesText(s)}, ${LOG_FORMAT_NAME[s.format]}${s.linesSkipped ? ` (${s.linesSkipped.toLocaleString('en-US')} skipped)` : ''}`, '');
  if (s.bots.length === 0) {
    out.push('  No AI crawler visits found.');
  } else {
    out.push(`  ${padEnd('Bot', 20)}${padEnd('Vendor', 12)}${padStart('Hits', 7)}${padStart('Pages', 7)}  IP check`);
    for (const b of s.bots) {
      const { name, vendor } = botName(b.botId, opts.bots);
      out.push(`  ${padEnd(clip(name, 19), 20)}${padEnd(clip(vendor, 11), 12)}${padStart(String(b.hits), 7)}${padStart(String(b.pages), 7)}  ${ipWord(b, style)}`);
    }
    const rows = [...s.rows].sort((a, b) => b.hits - a.hits);
    const shown = opts.verbose ? rows : rows.slice(0, 5);
    if (shown.length) {
      out.push('', `  ${padEnd('Most read pages', PAGE_COL + 2)}${padEnd('Bot', 20)}${padStart('Hits', 5)}`);
      for (const r of shown) {
        out.push(`  ${padEnd(clip(r.path, PAGE_COL), PAGE_COL + 2)}${padEnd(clip(botName(r.botId, opts.bots).name, 19), 20)}${padStart(String(r.hits), 5)}`);
      }
      if (rows.length > shown.length) out.push(`  ${style.dim(`… ${rows.length - shown.length} more  (--verbose lists all)`)}`);
    }
  }
  out.push('');
  out.push(`  ${style.dim('Verified = the request came from the vendor’s published IP ranges')}`);
  out.push(`  ${style.dim(`(snapshot of ${s.ipRangesAsOf}; no lookups at run time).`)}`);
  const tag = logsSourceTag(s);
  if (tag) out.push(`  ${style.dim(tag)}`);
  return `${out.join('\n')}\n`;
}
