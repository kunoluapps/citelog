// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { GEO_TOOL } from '@morningdesk/core';
import { pagesScore } from './changed.js';
import type { AiBot, LogSummary, PageReport, PromptRun, SiteReport } from '@morningdesk/geo';
import {
  TOOL_FOOTER,
  belowThreshold,
  countVerdicts,
  failedChecks,
  mdCell,
  mdCode,
  mdTable,
  pagePath,
  pageCountParts,
  pageVerdict,
  plural,
  renderCheckMarkdown,
  renderLogsMarkdown,
  renderPagesTable,
  renderPromptsMarkdown,
  siteName,
} from './cli.js';
import type { Baseline } from './comment.js';
import { failingKeys, scoreWords } from './comment.js';

/** Job summary for the scheduled / default-branch run (board CJobSummary state 1). */
export function renderSiteSummary(input: {
  report: SiteReport;
  previousScore?: number | null;
  badgePath?: string;
  failUnder?: number;
  prompts?: { run: PromptRun; prompts: string[]; perception?: boolean } | { skipped: string };
  logs?: { summary: LogSummary; bots: readonly AiBot[] } | { skipped: string };
  files: string[];
}): string {
  const extra = input.badgePath ? [`badge written to ${mdCode(input.badgePath)}`] : [];
  const out = [renderCheckMarkdown(input.report, { previousScore: input.previousScore, extra, failUnder: input.failUnder })];
  if (input.prompts) {
    out.push('', 'run' in input.prompts ? renderPromptsMarkdown(input.prompts.run, input.prompts.prompts, { perception: input.prompts.perception }) : input.prompts.skipped);
  }
  if (input.logs) out.push('', 'summary' in input.logs ? renderLogsMarkdown(input.logs.summary, input.logs.bots) : input.logs.skipped);
  if (input.files.length) out.push('', `Files: ${input.files.map(mdCode).join(', ')} (run artifacts)`);
  const reach = /^https?:\/\//i.test(input.report.target) ? `called only ${siteName(input.report.target)} and the engines whose keys are set` : `read ${input.report.target} and called only the engines whose keys are set`;
  out.push('', `${TOOL_FOOTER} No telemetry: this run ${reach}.`);
  return out.join('\n');
}

/** Job summary for a pull request; on a fork it is the only place results go (board CJobSummary state 2). */
export function renderPrSummary(input: {
  report: SiteReport;
  pages: PageReport[];
  changedOnly: boolean;
  fork: boolean;
  /** Why no comment was posted when it wasn't (permissions, comment: false). */
  commentNote?: string;
  baseline?: Baseline;
  failUnder?: number;
}): string {
  const { report, pages } = input;
  const score = input.changedOnly ? pagesScore(pages) : (report.score ?? pagesScore(pages));
  const c = countVerdicts(pages);
  const title = input.changedOnly ? plural(pages.length, 'changed page') : `${siteName(report.target)}, ${plural(pages.length, 'page')}`;
  const out = [`## ${GEO_TOOL.name}: ${title}`, ''];
  if (input.fork) {
    out.push(
      `> This pull request comes from a fork, so ${GEO_TOOL.name} can't comment on it and has no engine keys. Results are here only. Prompts were skipped. The job didn't fail for missing permissions.`,
      '',
    );
  } else if (input.commentNote) out.push(`> ${input.commentNote}`, '');

  const byPages = c.fail ? 'Fail' : c.warn ? 'Warn' : c.error ? "Couldn't load" : 'Pass';
  const word = input.failUnder !== undefined ? (belowThreshold(score, input.failUnder) ? 'Fail' : 'Pass') : byPages;
  const scoreText = scoreWords(score);
  const failing = failingKeys(pages, report);
  const base = input.baseline;
  const newKeys = base ? failing.filter((k) => !base.failing.has(k)) : failing;
  const parts = [`**${word}. ${scoreText}** on ${input.changedOnly ? 'changed pages' : 'these pages'}${base && base.score !== null ? ` (${base.ref}: ${base.score})` : ''}`];
  if (base) parts.push(plural(newKeys.length, 'new failure'));
  else parts.push(...pageCountParts(c));
  if (input.failUnder !== undefined && score !== null) parts.push(`${score < input.failUnder ? 'below' : 'above'} your threshold of ${input.failUnder}`);
  out.push(parts.join(' · '));

  if (newKeys.length) {
    const rows = newKeys.map((k) => {
      const [pth = '', id = ''] = k.split('|');
      const page = pages.find((p) => pagePath(p.url, report) === pth);
      return [mdCell(pth), mdCell(page?.checks.find((x) => x.id === id)?.label ?? id)];
    });
    out.push('', mdTable(['Page', base ? 'New failure' : 'Failed check'], rows.slice(0, 200)));
  }
  const sub: SiteReport = { ...report, pages };
  out.push('', `### Pages (${pages.length})`, '', renderPagesTable(sub));
  if (input.fork) out.push('', 'Maintainers: re-run from a branch in this repo to get the PR comment.');
  out.push('', TOOL_FOOTER);
  return out.join('\n');
}

/** "Content present without JavaScript (/pricing), Valid JSON-LD (/learn/roth-ira)": for the failed-threshold error. */
export function namedFailures(pages: readonly PageReport[], report: Pick<SiteReport, 'target' | 'kind'>): string {
  const byLabel = new Map<string, string[]>();
  for (const p of pages) {
    if (pageVerdict(p) !== 'fail') continue;
    for (const ch of failedChecks(p, 'fail')) byLabel.set(ch.label, [...(byLabel.get(ch.label) ?? []), pagePath(p.url, report)]);
  }
  return [...byLabel.entries()]
    .map(([label, paths]) => `${label} (${paths.length > 3 ? `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more` : paths.join(', ')})`)
    .join('; ');
}
