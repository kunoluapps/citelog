// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/**
 * llms.txt: read a site's /llms.txt and compare it with the llmstxt.org format (an H1 name, an optional blockquote
 * summary, optional text, then H2 sections that list links as `- [name](url): notes`, "## Optional" for the
 * skippable ones). Informational, like the readiness check: evidence that engines use the file is thin, so nothing
 * here is scored.
 */
import { isHtmlBody, PoliteFetcher } from '../fetch/polite.js';
import type { FetchLike } from '../types.js';

export const LLMS_TXT_SPEC_URL = 'https://llmstxt.org/';
export const LLMS_TXT_NOTE = 'Informational, not scored: evidence that AI engines read llms.txt is thin.';

export interface LlmsTxtLink {
  title: string;
  url: string;
  notes?: string;
  line: number;
}

export interface LlmsTxtSection {
  name: string;
  /** "## Optional": links an engine may skip when it needs a shorter context. */
  optional: boolean;
  links: LlmsTxtLink[];
}

export interface LlmsTxtIssue {
  level: 'error' | 'warn';
  message: string;
  line?: number;
}

export interface LlmsTxtReport {
  /** The H1: the site or project name (the one required part). */
  title: string | null;
  /** The blockquote under the H1. */
  summary: string | null;
  sections: LlmsTxtSection[];
  /** Links across all sections. */
  links: number;
  /** No errors (warnings allowed). */
  valid: boolean;
  issues: LlmsTxtIssue[];
}

const H1 = /^#\s+(.+?)\s*#*\s*$/;
const H2 = /^##\s+(.+?)\s*#*\s*$/;
const H3_PLUS = /^#{3,6}\s+/;
const LIST_ITEM = /^\s*[-*+]\s+(.*)$/;
const LINK_ITEM = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*(?::\s*(.*))?$/;

function urlProblem(url: string): string | null {
  if (/^https?:\/\//i.test(url)) {
    try {
      new URL(url);
      return null;
    } catch {
      return `"${url}" isn't a valid URL`;
    }
  }
  if (url.startsWith('/')) return null;
  return `"${url}" isn't an absolute URL or a site path`;
}

/** Compare a file's text with the llmstxt.org format. Pure. */
export function validateLlmsTxt(text: string): LlmsTxtReport {
  const issues: LlmsTxtIssue[] = [];
  const sections: LlmsTxtSection[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let title: string | null = null;
  let summary: string | null = null;
  let current: LlmsTxtSection | null = null;
  let sawContent = false;
  let inFence = false;
  const summaryLines: string[] = [];
  /** List items that aren't links, per section: one warning each, not one per line. */
  const plainItems = new Map<LlmsTxtSection, { count: number; line: number }>();
  let summaryOpen = false;

  if (isHtmlBody(text, {})) {
    return { title: null, summary: null, sections: [], links: 0, valid: false, issues: [{ level: 'error', message: 'The file is an HTML page (often an app\'s fallback page), not llms.txt Markdown.' }] };
  }

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return;
    if (!line.trim()) {
      if (summaryOpen && summaryLines.length) summaryOpen = false;
      return;
    }
    const h2 = H2.exec(line);
    const h1 = h2 ? null : H1.exec(line);
    if (h1) {
      if (title === null && !sawContent) title = (h1[1] as string).trim();
      else if (title === null) issues.push({ level: 'error', message: 'The H1 must be the first thing in the file.', line: n });
      else issues.push({ level: 'error', message: `A second H1 ("${(h1[1] as string).trim()}"): the file has one H1, the site or project name.`, line: n });
      sawContent = true;
      summaryOpen = title !== null && sections.length === 0 && summaryLines.length === 0;
      return;
    }
    if (!sawContent) {
      issues.push({ level: 'error', message: 'The file must start with an H1 ("# Site name").', line: n });
    }
    sawContent = true;
    if (h2) {
      summaryOpen = false;
      const name = (h2[1] as string).trim();
      current = { name, optional: name.toLowerCase() === 'optional', links: [] };
      sections.push(current);
      return;
    }
    if (H3_PLUS.test(line)) {
      if (!current) issues.push({ level: 'warn', message: 'Headings below H1 and above the first H2 section: the format has only text there.', line: n });
      return;
    }
    if (/^\s*>/.test(line)) {
      if (summaryOpen && !current) {
        summaryLines.push(line.replace(/^\s*>\s?/, '').trim());
        return;
      }
      return;
    }
    summaryOpen = false;
    const item = LIST_ITEM.exec(line);
    if (!current) return;
    if (!item) return;
    const body = (item[1] as string).trim();
    const link = LINK_ITEM.exec(body);
    if (!link) {
      const seen = plainItems.get(current);
      if (seen) seen.count += 1;
      else plainItems.set(current, { count: 1, line: n });
      return;
    }
    const url = link[2] as string;
    const problem = urlProblem(url);
    if (problem) issues.push({ level: 'warn', message: `${problem} in "${current.name}".`, line: n });
    const entry: LlmsTxtLink = { title: (link[1] as string).trim(), url, line: n };
    if (link[3]?.trim()) entry.notes = link[3].trim();
    current.links.push(entry);
  });

  for (const [section, { count, line }] of plainItems) {
    const what = count === 1 ? 'A list item' : `${count} list items`;
    issues.push({ level: 'warn', message: `${what} in "${section.name}" ${count === 1 ? "isn't a link" : "aren't links"} like "- [Name](https://…): notes" (first at line ${line}).`, line });
  }
  if (summaryLines.length) summary = summaryLines.join(' ').trim() || null;
  if (title === null && !issues.some((x) => x.level === 'error')) issues.push({ level: 'error', message: 'No H1: the file must start with "# Site name".' });
  if (title !== null && summary === null) issues.push({ level: 'warn', message: 'No summary: add a "> one-line description" under the H1.' });
  const links = sections.reduce((a, s) => a + s.links.length, 0);
  if (title !== null && sections.length === 0) issues.push({ level: 'warn', message: 'No "## Section" with links: list your key pages as "- [Name](https://…): notes".' });
  for (const s of sections) if (s.links.length === 0) issues.push({ level: 'warn', message: `"## ${s.name}" has no links.` });
  return { title, summary, sections, links, valid: !issues.some((x) => x.level === 'error'), issues };
}

export interface LlmsTxtFetch {
  /** The /llms.txt URL that was read. */
  url: string;
  status: number | null;
  /** true = the file is there (2xx, not an HTML fallback page); false = no file; null = couldn't tell. */
  found: boolean | null;
  /** Why it couldn't be read ("HTTP 503", "timeout after 10 s"), when found is null. */
  error?: string;
  /** Set when the file is there. */
  report?: LlmsTxtReport;
  /** /llms-full.txt (the optional single-file version): true, false or null as above. */
  fullFound: boolean | null;
  note: string;
}

/** Fetch `<origin>/llms.txt` (and check for /llms-full.txt) and validate it. Never throws for HTTP problems. */
export async function readLlmsTxt(siteUrl: string, opts: { fetch: FetchLike; userAgent?: string; timeoutMs?: number }): Promise<LlmsTxtFetch> {
  const base = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
  const url = `${base.origin}/llms.txt`;
  const fetcher = new PoliteFetcher({ fetch: opts.fetch, userAgent: opts.userAgent, timeoutMs: opts.timeoutMs });
  const accept = 'text/plain,text/markdown,*/*;q=0.5';
  const [res, full] = await Promise.all([fetcher.get(url, accept), fetcher.get(`${base.origin}/llms-full.txt`, accept)]);
  const fullFound = full.status === null || full.status >= 500 ? null : full.status >= 200 && full.status < 300 && full.text.trim().length > 0 && !isHtmlBody(full.text, full.headers);
  if (res.status === null || res.status >= 500) {
    return { url, status: res.status, found: null, error: res.error ?? `HTTP ${res.status}`, fullFound, note: LLMS_TXT_NOTE };
  }
  if (res.status < 200 || res.status >= 300) return { url, status: res.status, found: false, fullFound, note: LLMS_TXT_NOTE };
  if (!res.text.trim() || isHtmlBody(res.text, res.headers)) return { url, status: res.status, found: false, fullFound, note: LLMS_TXT_NOTE };
  return { url, status: res.status, found: true, report: validateLlmsTxt(res.text), fullFound, note: LLMS_TXT_NOTE };
}
