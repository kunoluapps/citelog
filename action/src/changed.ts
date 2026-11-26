// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { meanScore } from '@morningdesk/core';
import { pagePath } from './cli.js';
import type { PageReport, SiteReport } from '@morningdesk/geo';
import type { PrFile } from './github.js';

const ROUTE_ROOTS = new Set(['', 'app', 'pages', 'src', 'routes', 'content', 'public']);
const INDEX_STEMS = new Set(['index', 'page', '+page', '_index', 'readme']);
const PAGE_EXT = /\.(md|mdx|markdoc|html?|astro|svelte|vue|tsx|jsx|ts|js|njk|liquid|hbs|erb|rb|php|ya?ml|json)$/i;

/** The last route segment a changed source file most likely renders ("roth-ira" from app/learn/roth-ira/page.tsx; "" = home). */
export function routeSlug(file: string): string | null {
  if (!PAGE_EXT.test(file)) return null;
  const parts = file.replace(/\\/g, '/').split('/');
  const stem = (parts.pop() ?? '').replace(PAGE_EXT, '').replace(/\.[a-z]{2}(-[A-Z]{2})?$/, '');
  if (!INDEX_STEMS.has(stem.toLowerCase())) return stem.replace(/^\[.*\]$/, '') || null;
  const parent = parts.pop() ?? '';
  return ROUTE_ROOTS.has(parent.toLowerCase()) ? '' : parent;
}

function lastSegment(path: string): string {
  const clean = path.split('?')[0]?.replace(/\/+$/, '') ?? '';
  return clean.split('/').pop() ?? '';
}

/**
 * Pages this PR changes, matched by route slug. When no changed file maps to a checked page we can't tell which
 * pages changed, so every checked page counts (`matched: false`) and the comment says so.
 */
export function selectChangedPages(report: SiteReport, files: readonly PrFile[] | null): { pages: PageReport[]; matched: boolean } {
  if (!files) return { pages: report.pages, matched: false };
  const slugs = new Set<string>();
  for (const f of files) {
    if (f.status === 'removed') continue;
    const s = routeSlug(f.filename);
    if (s !== null) slugs.add(s.toLowerCase());
  }
  const pages = report.pages.filter((p) => slugs.has(lastSegment(pagePath(p.url, report)).toLowerCase()));
  return pages.length ? { pages, matched: true } : { pages: report.pages, matched: false };
}

/** Score of a set of pages: core meanScore, the one site-score rule. */
export function pagesScore(pages: readonly PageReport[]): number | null {
  return meanScore(pages.map((p) => p.score));
}
