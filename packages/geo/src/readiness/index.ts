// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { readFileSync } from 'node:fs';
import { RULES } from '@morningdesk/core';
import { blockedBotsFor, CHECKS, outcome, type PageContext } from './checks.js';
import { parsePage } from './html.js';
import { WARN_CREDIT } from './weights.js';
import { CHECK_IDS, meanScore, scoreBand } from '../types.js';
import type { CheckOutcome, CrawlOptions, CrawlProgress, PageInput, PageReport, SiteReport } from '../types.js';
import { MAX_REDIRECTS, PoliteFetcher, isHtmlBody, refuseRedirect, type FetchResult } from '../fetch/polite.js';
import { SiteResources, readSitemaps, type RobotsFile } from '../fetch/site.js';
import { isFolder, listFolderPages, readFolderFile } from '../fetch/folder.js';

export { CHECK_WEIGHTS, WARN_CREDIT } from './weights.js';
export { CHECK_COPY } from './copy.js';
export { aiCrawlerRefused, aiView, aiViewRobots, aiViewVerdict, fetchAsAiCrawler, isChallengePage, readAiView, AI_VIEW_USER_AGENT } from './aiview.js';
export type { AiCrawlerFetch, AiViewInput, AiViewRobots } from './aiview.js';
export { DEFAULT_USER_AGENT } from '../fetch/polite.js';

/** Base used to resolve path-only page URLs (folder mode). Never fetched. */
const PATH_BASE = 'http://folder.invalid';

/** Score = round(100 × (pass weight + half of warn weight) / applicable weight); null when nothing applicable. */
export function scoreChecks(checks: CheckOutcome[]): number | null {
  let total = 0;
  let earned = 0;
  for (const c of checks) {
    if (c.weight <= 0 || c.result === 'skip' || c.result === 'info') continue;
    total += c.weight;
    if (c.result === 'pass') earned += c.weight;
    else if (c.result === 'warn') earned += c.weight * WARN_CREDIT;
  }
  return total > 0 ? Math.round((100 * earned) / total) : null;
}

/** The fix from the highest-weight failed check; when nothing failed, from the highest-weight warning. */
export function topFixOf(checks: CheckOutcome[]): string | undefined {
  for (const result of ['fail', 'warn'] as const) {
    const best = checks.filter((c) => c.result === result && c.fix).sort((a, b) => b.weight - a.weight)[0];
    if (best) return best.fix;
  }
  return undefined;
}

function unreachableReport(url: string, status: number | null, error: string): PageReport {
  return { url, status, score: null, band: 'no_score', checks: [], error: `We couldn't load ${url}: ${error}` };
}

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

function contentType(headers: Record<string, string>): string {
  return (headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** A PDF, image or feed in the sitemap: listed, not scored (FIX-P1 M6). */
function notHtmlReport(url: string, status: number, type: string): PageReport {
  return { url, status, score: null, band: 'no_score', checks: [], error: `Not an HTML page (${type}), so it has no score.` };
}

/** Pure: run every readiness check on one fetched page. */
export function checkPage(input: PageInput): PageReport {
  if (input.status === null) return unreachableReport(input.url, null, 'no response');
  const pathOnly = input.url.startsWith('/');
  const url = new URL(input.url, PATH_BASE);
  const ctx: PageContext = { input, url, pathOnly, page: parsePage(input.html) };
  const ok = input.status >= 200 && input.status < 300;
  const always = new Set(['indexable', 'robots_ai', 'llms_txt']);
  const checks = CHECK_IDS.map((id) => {
    if (!ok && !always.has(id)) return outcome(id, { result: 'skip', detail: `Not checked: the page returned HTTP ${input.status}.` });
    return outcome(id, CHECKS[id](ctx));
  });
  const score = scoreChecks(checks);
  const report: PageReport = { url: input.url, status: input.status, score, band: scoreBand(score), checks };
  const topFix = topFixOf(checks);
  if (topFix) report.topFix = topFix;
  return report;
}

function siteScore(pages: PageReport[]): number | null {
  return meanScore(pages.map((p) => p.score));
}

function blockedIds(robotsTxt: string | null): string[] {
  return blockedBotsFor(robotsTxt, '/').map((b) => b.bot.id);
}

function withRobotsReason(report: PageReport, robots: RobotsFile): PageReport {
  if (!robots.unreachable) return report;
  const check = report.checks.find((c) => c.id === 'robots_ai');
  if (check && check.result === 'fail') {
    check.detail = `robots.txt couldn't be read (${robots.reason}), so crawlers treat the whole site as blocked (RFC 9309).`;
    check.fix = 'Serve robots.txt with HTTP 200 (or 404 if you have none); a 5xx or timeout blocks every crawler.';
    report.topFix = topFixOf(report.checks);
  }
  return report;
}

const META_REFRESH = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/i;
const REFRESH_CONTENT = /content\s*=\s*(["'])\s*\d*\s*[;,]?\s*(?:url\s*=\s*)?['"]?([^"'>]+?)['"]?\s*\1/i;

/**
 * The target of a page that only redirects with `<meta http-equiv="refresh" content="0; url=…">`: the tag is there and
 * the page has next to no readable text of its own. Null for a normal page (a refresh tag on a real page is left to
 * the checks). Exported for tests.
 */
export function metaRefreshTarget(html: string, base: string): string | null {
  const tag = META_REFRESH.exec(html);
  if (!tag) return null;
  const target = REFRESH_CONTENT.exec(tag[0])?.[2]?.trim();
  if (!target) return null;
  const text = html
    .replace(/<(script|style|noscript|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 200) return null;
  try {
    return new URL(target, base).toString();
  } catch {
    return null;
  }
}

/** A meta-refresh page we didn't follow: listed with where it goes, not scored and not counted as failing. */
function redirectPageReport(url: string, status: number, why: string): PageReport {
  return { url, status, score: null, band: 'no_score', checks: [], error: `Redirect page, not scored: ${why}.` };
}

async function checkFetchedPage(fetcher: PoliteFetcher, site: SiteResources, url: string, fetched?: FetchResult, hops = 0): Promise<PageReport> {
  const res = fetched ?? (await fetcher.get(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'));
  if (res.status === null || res.error) return unreachableReport(url, res.status, res.error ?? 'no response');
  if (res.status >= 400 || res.status < 200) return unreachableReport(url, res.status, `HTTP ${res.status}`);
  const type = contentType(res.headers);
  if (type && !HTML_TYPES.has(type) && !isHtmlBody(res.text, {})) return notHtmlReport(url, res.status, type);
  // A meta-refresh redirect page is a redirect, not a failing page: follow it within the site like an HTTP redirect.
  const refresh = metaRefreshTarget(res.text, res.finalUrl);
  if (refresh) {
    const refused = refuseRedirect(url, new URL(refresh));
    if (refused) return redirectPageReport(url, res.status, refused);
    if (hops >= MAX_REDIRECTS) return redirectPageReport(url, res.status, `more than ${MAX_REDIRECTS} redirects`);
    const next = await checkFetchedPage(fetcher, site, refresh, undefined, hops + 1);
    return { ...next, url };
  }
  const origin = new URL(res.finalUrl).origin;
  const [robots, llms] = await Promise.all([site.robots(origin), site.llms(origin)]);
  const report = checkPage({ url, status: res.status, headers: res.headers, html: res.text, robotsTxt: robots.body, llmsTxt: llms });
  return withRobotsReason(report, robots);
}

type ProgressFn = CrawlOptions['onProgress'];

function notifyProgress(onProgress: ProgressFn, progress: CrawlProgress): void {
  if (!onProgress) return;
  try {
    onProgress(progress);
  } catch {
    // A progress listener never stops the crawl.
  }
}

function truncate<T>(items: T[], limit: number): { items: T[]; truncated?: { limit: number; total: number } } {
  if (items.length <= limit) return { items };
  return { items: items.slice(0, limit), truncated: { limit, total: items.length } };
}

function isSitemapUrl(u: URL): boolean {
  return /\.xml(\.gz)?$/i.test(u.pathname) || /sitemap/i.test(u.pathname);
}

async function checkFolder(target: string, maxPages: number, onProgress: ProgressFn): Promise<SiteReport> {
  const all = listFolderPages(target);
  const { items, truncated } = truncate(all, maxPages);
  const robotsTxt = readFolderFile(target, 'robots.txt');
  const llmsTxt = readFolderFile(target, 'llms.txt') !== null;
  notifyProgress(onProgress, { total: items.length, done: 0, current: null });
  const pages = items.map((p, i) => {
    const page = checkPage({ url: p.path, status: 200, headers: {}, html: readFileSync(p.file, 'utf8'), robotsTxt, llmsTxt });
    notifyProgress(onProgress, { total: items.length, done: i + 1, current: p.path });
    return page;
  });
  const score = siteScore(pages);
  const report: SiteReport = { target, kind: 'folder', pages, score, band: scoreBand(score), blockedBots: blockedIds(robotsTxt), checkedAt: new Date().toISOString() };
  if (truncated) report.truncated = truncated;
  return report;
}

/** "bywell.org" or "bywell.org/learn": a host name with a dot and no scheme, checked over https. */
const BARE_HOST = /^(?:localhost|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::\d+)?(?:[/?#]|$)/i;

/** Fetch and check a URL, a sitemap URL (or a site URL whose sitemap we discover), or a folder of built HTML. */
export async function checkTarget(target: string, opts: CrawlOptions): Promise<SiteReport> {
  const maxPages = Math.max(1, opts.maxPages || RULES.geoDefaultMaxPages);
  if (!/^https?:\/\//i.test(target)) {
    if (isFolder(target)) return checkFolder(target, maxPages, opts.onProgress);
    if (!BARE_HOST.test(target)) throw new Error(`"${target}" isn't a URL (http:// or https://) or a folder.`);
    target = new URL(`https://${target}`).toString();
  }

  const fetcher = PoliteFetcher.fromCrawlOptions(opts);
  const site = new SiteResources(fetcher);
  const targetUrl = new URL(target);
  const origin = targetUrl.origin;
  const isRoot = targetUrl.pathname === '/' && !targetUrl.search;

  let kind: SiteReport['kind'] = 'url';
  let pageUrls: string[] = [target];
  let truncated: SiteReport['truncated'];
  let robots: RobotsFile | null = null;
  let skippedOffSite = 0;

  if (isSitemapUrl(targetUrl)) {
    kind = 'sitemap';
    const sm = await readSitemaps(fetcher, [target], target);
    if (sm.error) {
      const pages = [unreachableReport(target, null, sm.error)];
      return { target, kind, pages, score: null, band: 'no_score', blockedBots: [], checkedAt: new Date().toISOString() };
    }
    pageUrls = sm.urls;
    skippedOffSite = sm.skippedOffSite;
  } else if (isRoot) {
    robots = await site.robots(origin);
    const candidates = robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`];
    const sm = await readSitemaps(fetcher, candidates, target);
    if (!sm.error && sm.urls.length) {
      kind = 'sitemap';
      pageUrls = sm.urls;
      skippedOffSite = sm.skippedOffSite;
    }
  }

  const t = truncate(pageUrls, maxPages);
  if (t.truncated) truncated = t.truncated;
  const total = t.items.length;
  let done = 0;
  notifyProgress(opts.onProgress, { total, done, current: null });
  const pages = await Promise.all(
    t.items.map(async (u) => {
      const page = await checkFetchedPage(fetcher, site, u);
      done += 1;
      notifyProgress(opts.onProgress, { total, done, current: u });
      return page;
    }),
  );
  robots ??= await site.robots(origin);
  const score = siteScore(pages);
  const report: SiteReport = {
    target,
    kind,
    pages,
    score,
    band: scoreBand(score),
    blockedBots: blockedIds(robots.body),
    checkedAt: new Date().toISOString(),
  };
  if (truncated) report.truncated = truncated;
  if (skippedOffSite) report.skippedOffSite = skippedOffSite;
  return report;
}

