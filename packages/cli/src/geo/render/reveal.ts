// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/**
 * "What AI sees": the block `npx citelog <url>` prints before the page-by-page checks (board 10b, CLI block).
 * Every result is said in words; colour only repeats them on a terminal.
 */
import { AI_VIEW_COPY, GEO_TOOL, type AiViewSummary } from '@morningdesk/core';
import { aiViewVerdict } from '@morningdesk/geo';
import { DEFAULT_COLUMNS } from './text.js';
import { padEnd, wrap, type Style } from './style.js';

/** Widest line the block prints, like the board, narrower on a narrow terminal. */
const REVEAL_WIDTH = 60;
/** Fix text wraps like the check details (DETAIL_WIDTH in text.ts). */
const FIX_WIDTH = 50;
/** Label column: "Words of text" plus room. */
const LABEL_WIDTH = 14;
/** "FAIL  ", "Fix   ": the verdict, fix and "See it" lines indent their text this far. */
const VERDICT_INDENT = 6;

export const RENDER_NOTE = "(uses Chrome if you have it; the page's own scripts load as usual, nothing is sent to us)";

/** The shared copy starts with a capital; the terminal's value column reads in lower case (board). */
function cell(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function shortVersion(v: string): string {
  return v.split('.').slice(0, 2).join('.');
}

/** "Citelog 0.1 · thelewisapp.com" */
export function revealHeader(domain: string): string {
  return `${GEO_TOOL.name} ${shortVersion(GEO_TOOL.version)} · ${domain}`;
}

export function revealDomain(s: Pick<AiViewSummary, 'url'>): string {
  try {
    return new URL(s.url).hostname.replace(/^www\./, '');
  } catch {
    return s.url;
  }
}

/** "div#root" -> `<div id="root">` */
function rootTag(root: string): string {
  const [tag = 'div', id] = root.split('#');
  return id ? `<${tag} id="${id}">` : `<${tag}>`;
}

function crawlerStatus(s: AiViewSummary): string {
  return `${s.fetch.botStatus ?? ''} · ${s.fetch.botError === 'challenge page' ? 'challenge page' : 'blocked'}`;
}

function robotsLines(s: AiViewSummary): string[] {
  const r = s.robots;
  const lines = [
    !r.found
      ? AI_VIEW_COPY.robotsNotFound
      : r.mainBlocked.length
        ? AI_VIEW_COPY.robotsBlocks([...new Set(r.mainBlocked.map((b) => b.bot))])
        : AI_VIEW_COPY.robotsAllowsAll,
  ];
  if (r.trainingBlocked.length) lines.push(AI_VIEW_COPY.trainingNote(r.trainingBlocked));
  if (r.groundingBlocked.length) lines.push(AI_VIEW_COPY.groundingNote(r.groundingBlocked));
  return lines.map(cell);
}

type Row = { label: string; values: string[]; paint?: (s: string) => string };

/** The label rows, in board order. */
export function revealRows(s: AiViewSummary, style: Style): Row[] {
  const needsJs = s.result === 'js_only' || s.result === 'thin';
  const rows: Row[] = [
    { label: 'Words of text', values: [s.words.toLocaleString('en-US')], paint: needsJs ? (t) => style.fail(style.bold(t)) : undefined },
    { label: 'Headline', values: [s.headline ?? 'none'] },
  ];
  if (needsJs) rows.push({ label: 'Title', values: [s.title ?? 'none'] });
  if (s.emptyAppRoot) rows.push({ label: 'App root', values: [`${rootTag(s.emptyAppRoot)} is empty`] });
  const faq = AI_VIEW_COPY.faq(s.faq);
  if (faq) rows.push({ label: 'FAQ', values: [faq] });
  if (s.blockedBy === 'firewall') {
    rows.push({ label: 'As a browser', values: [`${s.fetch.plainStatus} · page loads`] });
    rows.push({ label: 'As an AI crawler', values: [crawlerStatus(s)], paint: (t) => style.fail(t) });
  }
  rows.push({ label: 'robots.txt', values: robotsLines(s), paint: s.robots.mainBlocked.length ? (t) => style.fail(t) : undefined });
  return rows;
}

export interface RevealTextOptions {
  style: Style;
  /** Terminal width (default 80). */
  columns?: number;
  /** What to put after `npx citelog` on the "See it" line, e.g. "thelewisapp.com". Omit to leave the line out. */
  seeIt?: string;
  /** With --render: what takes the place of "See it" ("Chrome" label for a rendered count, none for a note). */
  rendered?: { label?: string; text: string };
}

/** The reveal block, ending with a blank line so the checks follow it. */
export function renderAiViewText(s: AiViewSummary, opts: RevealTextOptions): string {
  const { style } = opts;
  const width = Math.min(REVEAL_WIDTH, Math.max(40, opts.columns ?? DEFAULT_COLUMNS));
  const out: string[] = [style.dim(revealHeader(revealDomain(s))), ''];
  out.push(`What AI crawlers see on ${s.path === '/' ? 'your home page' : s.path}`);

  const rows = revealRows(s, style);
  const labelWidth = Math.max(LABEL_WIDTH, ...rows.map((r) => r.label.length + 1)) + 2;
  const valueIndent = ' '.repeat(2 + labelWidth);
  for (const row of rows) {
    const lines = row.values.flatMap((v) => wrap(v, width - valueIndent.length));
    lines.forEach((l, i) => {
      const value = row.paint ? row.paint(l) : l;
      out.push(i === 0 ? `  ${padEnd(style.dim(row.label), labelWidth)}${value}` : `${valueIndent}${value}`);
    });
  }
  out.push('');

  const indent = ' '.repeat(VERDICT_INDENT);
  const labelled = (label: string, text: string, textWidth: number): string[] => {
    const [first = '', ...more] = wrap(text, textWidth);
    return [`${padEnd(label, VERDICT_INDENT - 1)} ${first}`, ...more.map((l) => `${indent}${l}`)];
  };
  const v = aiViewVerdict(s);
  const word = v.word === 'PASS' ? style.pass(style.bold(v.word)) : v.word === 'FAIL' ? style.fail(style.bold(v.word)) : style.warn(style.bold(v.word));
  const sentences = v.line.split(/(?<=\.)\s+/).flatMap((t) => wrap(t, width - VERDICT_INDENT));
  out.push(`${padEnd(word, VERDICT_INDENT)}${sentences[0] ?? ''}`, ...sentences.slice(1).map((l) => `${indent}${l}`));
  if (s.fix) out.push(...labelled(style.dim('Fix'), s.fix, Math.min(FIX_WIDTH, width - VERDICT_INDENT)));
  const needsJs = s.result === 'js_only' || s.result === 'thin';
  if (opts.rendered?.label) out.push(...labelled(style.dim(opts.rendered.label), opts.rendered.text, width - VERDICT_INDENT));
  else if (opts.rendered) out.push(...wrap(opts.rendered.text, width));
  else if (needsJs && opts.seeIt) {
    out.push(`${style.dim('See it')} npx ${GEO_TOOL.bin} ${opts.seeIt} --render`);
    for (const l of wrap(RENDER_NOTE, width - VERDICT_INDENT)) out.push(style.dim(`${indent}${l}`));
  }
  out.push('');
  return `${out.join('\n')}\n`;
}

/** The --render sentence: what people see after JavaScript against what AI crawlers get. */
export function renderedLine(peopleWords: number, crawlerWords: number): string {
  const n = (w: number) => w.toLocaleString('en-US');
  if (peopleWords <= crawlerWords) {
    return `People see ${n(peopleWords)} ${peopleWords === 1 ? 'word' : 'words'} after JavaScript runs too, the same as AI crawlers.`;
  }
  return `People see ${n(peopleWords)} ${peopleWords === 1 ? 'word' : 'words'} after JavaScript runs; AI crawlers see ${n(crawlerWords)}.`;
}
