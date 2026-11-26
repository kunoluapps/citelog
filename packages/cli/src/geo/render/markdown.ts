// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { GEO_TOOL, MEASURE_COPY } from '@morningdesk/core';
import { NO_SEARCH_NOTE, SCORE_BAND_LABEL } from '@morningdesk/geo';
import type { AiBot, CheckOutcome, EngineId, LogSummary, PageReport, PromptResult, PromptRun, SiteReport } from '@morningdesk/geo';
import {
  TOOL_FOOTER,
  VERDICT_WORD,
  consideredEngines,
  consideredNotCited,
  consideredPlace,
  countVerdicts,
  engineLabel,
  enginesInRun,
  failedChecks,
  formatCounts,
  groupIssues,
  logLinesText,
  lowerFirst,
  notCollectedText,
  pageCountParts,
  pagePath,
  pageVerdict,
  perceptionLine,
  plural,
  sentence,
  shortLabel,
  siteName,
  sortWorstFirst,
  type IssueGroup,
} from './model.js';
import { LOG_FORMAT_NAME, costText, logsSourceTag, noSearchEngines } from './text.js';

/**
 * Markdown for PR comments, job summaries and `--md`. Words only for status (Fail, Warn, Pass): no emoji, no colour.
 */

/**
 * Make text safe for GitHub-flavoured Markdown, in a table cell or a line: page-controlled values (titles, paths,
 * details quoting the page) must never become links, images, HTML, formatting, @mentions or #references in a PR.
 * Markdown punctuation is backslash-escaped, `<` and `>` become entities, and a zero-width space after `@` and `#`
 * stops GitHub's mention and reference matching while the text reads the same.
 */
export function mdText(s: string): string {
  return s
    .replace(/\r?\n/g, ' ')
    .replace(/[\\`*_[\]()!~|]/g, (c) => `\\${c}`)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([@#])/g, '$1\u200b')
    .trim();
}

/** Escape a value for a GitHub-flavoured Markdown table cell (see mdText). */
export function mdCell(s: string): string {
  return mdText(s);
}

/** A code span that can't be broken out of: a backtick fence longer than any run inside, pipes escaped for tables. */
export function mdCode(s: string): string {
  const flat = s.replace(/\r?\n/g, ' ');
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat.replace(/\|/g, '\\|')}${pad}${fence}`;
}

export function mdTable(head: string[], rows: string[][]): string {
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of rows) lines.push(`| ${r.join(' | ')} |`);
  return lines.join('\n');
}

export function mdDetails(summary: string, body: string): string {
  return `<details><summary>${summary}</summary>\n\n${body.trim()}\n\n</details>`;
}

export function verdictCell(p: PageReport): string {
  const v = pageVerdict(p);
  return v === 'fail' ? `**${VERDICT_WORD.fail}**` : VERDICT_WORD[v];
}

/** "Fail 64" style result for comment tables. */
export function verdictScoreCell(p: PageReport): string {
  return `${verdictCell(p)}${p.score === null ? '' : ` ${p.score}`}`;
}

export function topFixOf(p: PageReport): string {
  const c = failedChecks(p, 'fail')[0] ?? failedChecks(p, 'warn')[0];
  return c?.fix ?? p.topFix ?? (p.error ? p.error : '');
}

function issueFix(g: IssueGroup): string {
  if (g.id === 'robots_ai') return `${sentence(g.detail)} ${g.fix ?? ''}`.trim();
  return g.fix ?? g.detail;
}

/** Fix-first table: the top failing checks with how many pages each one affects ("all" when every page). */
export function renderFixFirst(pages: readonly PageReport[], limit = 3): string {
  // One row per check (board CJobSummary): a check that fails on some pages and warns on others is one row, counting both.
  const byId = new Map<string, IssueGroup>();
  for (const g of groupIssues(pages)) {
    const seen = byId.get(g.id);
    if (seen) seen.pages = [...seen.pages, ...g.pages];
    else byId.set(g.id, { ...g, pages: [...g.pages] });
  }
  const groups = [...byId.values()].slice(0, limit);
  if (!groups.length) return '';
  const total = pages.length;
  return mdTable(
    ['Check', 'Pages', 'Fix'],
    groups.map((g) => [mdCell(g.label), g.pages.length === total && total > 1 ? 'all' : String(g.pages.length), mdCell(issueFix(g))]),
  );
}

/** Page table (score, result, failed checks), worst first; rows past `shown` fold into a details block. */
export function renderPagesTable(report: SiteReport, opts: { shown?: number; max?: number } = {}): string {
  const shown = opts.shown ?? 3;
  const max = opts.max ?? 200;
  const sorted = sortWorstFirst(report.pages);
  const row = (p: PageReport): string[] => [
    mdCell(pagePath(p.url, report)),
    p.score === null ? '–' : String(p.score),
    verdictCell(p),
    mdCell(p.error ?? failedChecks(p, 'fail').map((c) => shortLabel(c.id)).join('; ')),
  ];
  const head = ['Page', 'Score', 'Result', 'Failed checks'];
  const first = sorted.slice(0, shown);
  const rest = sorted.slice(shown, max);
  let out = mdTable(head, first.map(row));
  if (rest.length) {
    const restAll = sorted.slice(shown);
    out += `\n\n${mdDetails(`${restAll.length} more pages (${formatCounts(countVerdicts(restAll))})`, mdTable(head, rest.map(row)))}`;
  }
  if (sorted.length > max) out += `\n\nShowing ${max} of ${sorted.length} pages. The JSON report has every page.`;
  return out;
}

export interface CheckMarkdownOptions {
  /** Heading level for the title ("##" in the job summary). */
  heading?: '#' | '##' | '###';
  /** Score from the previous run, for "(was 74 last run)". */
  previousScore?: number | null;
  /** Extra parts for the score line, e.g. "badge written to `.github/citelog-badge.svg`". */
  extra?: string[];
  failUnder?: number;
}

/** The full readiness report (board CJobSummary state 1; also `--md`). */
export function renderCheckMarkdown(report: SiteReport, opts: CheckMarkdownOptions = {}): string {
  const h = opts.heading ?? '##';
  const c = countVerdicts(report.pages);
  const out: string[] = [`${h} ${GEO_TOOL.name}: ${siteName(report.target)}`, ''];
  const score = report.score === null ? `**${SCORE_BAND_LABEL.no_score}**` : `**Score ${report.score}, ${SCORE_BAND_LABEL[report.band]}**`;
  const was = opts.previousScore !== undefined && opts.previousScore !== null ? ` (was ${opts.previousScore} last run)` : '';
  const parts = [`${score}${was}`, plural(report.pages.length, 'page'), ...pageCountParts(c)];
  if (opts.failUnder !== undefined && report.score !== null && report.score < opts.failUnder) parts.push(`below your threshold of ${opts.failUnder}`);
  out.push([...parts, ...(opts.extra ?? [])].join(' · '));
  if (report.truncated) out.push('', `Read the first ${report.truncated.limit} of ${report.truncated.total} pages (\`--max-pages\` to change).`);
  if (report.skippedOffSite) out.push('', `Left out ${plural(report.skippedOffSite, 'sitemap URL')} on other hosts.`);
  const fixFirst = renderFixFirst(report.pages);
  if (fixFirst) out.push('', `${h}# Fix first`, '', fixFirst);
  out.push('', `${h}# Pages (${report.pages.length})`, '', renderPagesTable(report));
  return out.join('\n');
}

/** "What Citelog checks and why (10 checks)". */
export function renderChecksAbout(checks: readonly CheckOutcome[]): string {
  if (!checks.length) return '';
  const rows = checks.map((c) => [mdCell(c.label), mdCell(c.why), c.weight ? String(c.weight) : 'info']);
  return mdDetails(`What ${GEO_TOOL.name} checks and why (${checks.length} checks)`, mdTable(['Check', 'Why it matters', 'Weight'], rows));
}

function promptCell(r: PromptResult | undefined, site: string): string {
  if (!r || r.status === 'skipped') return 'Skipped';
  if (r.status === 'not_checked') return 'Not checked';
  if (r.cited) return `Cited ${r.citedUrl ? mdCell(pagePath(r.citedUrl)) : site}`;
  if (r.mentioned) return MEASURE_COPY.namedNotLinked;
  return r.others[0] ? `Not cited: ${mdCell(r.others[0])}` : 'Not cited';
}

/** "2 of 3": answers that name the site out of answers measured for the prompt; N/C when none was measured (never 0). */
function namedCell(rs: PromptResult[]): string {
  const measured = rs.filter((r) => r.status === 'checked' && typeof r.mentioned === 'boolean');
  return measured.length ? `${measured.filter((r) => r.mentioned).length} of ${measured.length}` : MEASURE_COPY.notMeasured;
}

/** "Considered, not cited:" list (job summary and `prompts --md`); empty when no engine answered. */
export function renderConsideredMarkdown(run: PromptRun): string {
  const { rows, notCollected } = consideredNotCited(run);
  const answered = enginesInRun(run).filter((e) => run.results.some((r) => r.engine === e && r.status === 'checked'));
  if (!answered.length) return '';
  const missing = notCollectedText(notCollected);
  if (!rows.length) return `**${MEASURE_COPY.consideredNotCited}:** ${notCollected.length === answered.length ? lowerFirst(missing) : `none reported.${missing ? ` ${missing}` : ''}`}`;
  const list = rows.map((row) => `- ${row.path === null ? mdCell(consideredPlace(row, run.site)) : mdCode(consideredPlace(row, run.site))}: ${consideredEngines(row)}`);
  return [`**${MEASURE_COPY.consideredNotCited}:**`, '', ...list, ...(missing ? ['', missing] : [])].join('\n');
}

/** Prompt results table (board CJobSummary state 1, "Prompts"). */
export function renderPromptsMarkdown(run: PromptRun, prompts: readonly string[], opts: { heading?: string; perception?: boolean } = {}): string {
  const h = opts.heading ?? '###';
  const engines = enginesInRun(run);
  if (!engines.length) {
    const keys = run.skipped.map((s) => `${engineLabel(s.engine)} ${mdCode(s.envVar)}`).join(', ');
    return `${h} Prompts\n\nSkipped: no engine keys found, so no prompts were asked. Set one or more: ${keys}.`;
  }
  const ok = engines.filter((e) => run.results.some((r) => r.engine === e && r.status === 'checked'));
  const out = [`${h} Prompts (${ok.length} of ${plural(engines.length, 'engine')})`, ''];
  const find = (p: string, e: EngineId) => run.results.find((r) => r.prompt === p && r.engine === e);
  out.push(
    mdTable(
      ['Prompt', ...engines.map(engineLabel), MEASURE_COPY.named],
      prompts.map((p) => [mdCell(p), ...engines.map((e) => promptCell(find(p, e), run.site)), namedCell(run.results.filter((r) => r.prompt === p))]),
    ),
  );
  const considered = renderConsideredMarkdown(run);
  if (considered) out.push('', considered);
  const notes: string[] = [];
  for (const e of engines.filter((x) => !ok.includes(x) || run.results.some((r) => r.engine === x && r.status === 'not_checked'))) {
    const err = run.results.find((r) => r.engine === e && r.status === 'not_checked')?.error;
    if (err) notes.push(`${engineLabel(e)} not checked: ${sentence(err.message)}`);
  }
  if (run.skipped.length) notes.push(`Not asked (no key): ${run.skipped.map((s) => `${engineLabel(s.engine)} (${mdCode(s.envVar)})`).join(', ')}.`);
  const noSearch = noSearchEngines(run);
  if (noSearch.length) notes.push(`${NO_SEARCH_NOTE}: ${noSearch.map((n) => `${engineLabel(n.engine)} (${n.count})`).join(', ')}.`);
  notes.push('API answers can differ from what a person sees in ChatGPT and the other apps.');
  notes.push(`Estimated engine cost: ${costText(run)} on your keys.`);
  const perception = perceptionLine(run, opts.perception ?? false);
  if (perception) notes.push(`${perception}.`);
  out.push('', notes.join(' '));
  return out.join('\n');
}

/** AI crawler visits table (job summary and `logs --md`). */
export function renderLogsMarkdown(s: LogSummary, bots: readonly AiBot[], opts: { heading?: string } = {}): string {
  const h = opts.heading ?? '###';
  const name = (id: string): AiBot | undefined => bots.find((b) => b.id === id);
  const out = [`${h} AI crawler visits`, ''];
  out.push(`${logLinesText(s)}, ${LOG_FORMAT_NAME[s.format]}${s.linesSkipped ? `, ${s.linesSkipped.toLocaleString('en-US')} skipped` : ''}.`, '');
  if (!s.bots.length) {
    out.push('No AI crawler visits found.');
  } else {
    out.push(
      mdTable(
        ['Bot', 'Vendor', 'Hits', 'Pages', 'IP check'],
        s.bots.map((b) => [
          mdCell(name(b.botId)?.name ?? b.botId),
          mdCell(name(b.botId)?.vendor ?? ''),
          String(b.hits),
          String(b.pages),
          b.unknownHits === b.hits ? 'No IP list' : b.unverifiedHits === 0 ? 'Verified' : `Unverified ${b.unverifiedHits} of ${b.hits}`,
        ]),
      ),
    );
  }
  const tag = logsSourceTag(s);
  out.push('', `Verified = the request came from the vendor's published IP ranges (snapshot of ${s.ipRangesAsOf}).${tag ? ` ${tag}.` : ''}`);
  return out.join('\n');
}

export function renderFooterMarkdown(note?: string): string {
  return note ? `${TOOL_FOOTER} ${note}` : TOOL_FOOTER;
}
