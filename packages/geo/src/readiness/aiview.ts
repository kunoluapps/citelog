// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/**
 * "What AI sees" (initiatives/2026-11-19-ai-view-onboarding): one summary of a page as AI crawlers get it, built from
 * the same parser and checks as readiness (parsePage, no_js_content, robots_ai). Onboarding step 1 and the CLI both call
 * `aiView`, so they give the same words and blocked result for the same HTML. The HTML is parsed in memory and dropped.
 */
import { AI_VIEW_FIREWALL_STATUSES, AI_VIEW_USER_AGENT, GEO_TOOL_USER_AGENT, type AiViewResult, type AiViewRobotsBlock, type AiViewSummary } from '@morningdesk/core';
import { WARN_IF_BLOCKED } from '../bots/catalog.js';
import { PoliteFetcher, type FetchResult } from '../fetch/polite.js';
import { robotsFromResult } from '../fetch/site.js';
import type { FetchLike } from '../types.js';
import { blockedBotsFor, checkNoJsContent, type BotBlock } from './checks.js';
import { listNames } from './copy.js';
import { jsonLdTypes, parsePage, type ParsedPage } from './html.js';

export { AI_VIEW_USER_AGENT };

/** What came back for the request sent as an AI crawler. */
export interface AiCrawlerFetch {
  /** Null when nothing came back. */
  status: number | null;
  headers: Record<string, string>;
  /** Used only to spot a challenge page; dropped after. */
  html: string;
  error?: string;
}

export interface AiViewInput {
  /** Final URL of the page (after redirects). */
  url: string;
  /** Status and body of the plain request. */
  status: number;
  html: string;
  /** robots.txt body for the origin, null when there is none. */
  robotsTxt: string | null;
  /** The request sent as an AI crawler; omit when it wasn't sent (no firewall check). */
  crawler?: AiCrawlerFetch;
  /** URLs in the sitemap, when the caller read it. */
  sitemapPages?: number | null;
  now?: Date;
}

/** robots.txt as the reveal reads it: main crawlers blocked (fail) and training-only crawlers blocked (a note). */
export interface AiViewRobots {
  found: boolean;
  mainBlocked: AiViewRobotsBlock[];
  trainingBlocked: string[];
  groundingBlocked: string[];
}

/** Product names people know, per main crawler, for the reveal's sentences ("ChatGPT search can't read your site"). */
const PRODUCT_OF: Record<string, string> = {
  'oai-searchbot': 'ChatGPT search',
  'chatgpt-user': 'ChatGPT',
  'claude-searchbot': 'Claude',
  'claude-user': 'Claude',
  perplexitybot: 'Perplexity',
  'perplexity-user': 'Perplexity',
  googlebot: 'Google',
  bingbot: 'Bing',
};

const FIREWALL_FIX =
  'Check your CDN’s bot settings (for example “Block AI bots”). Allow verified search crawlers like OAI-SearchBot and PerplexityBot.';

function blockOf(b: BotBlock): AiViewRobotsBlock {
  const rule = b.match.rule;
  return {
    botId: b.bot.id,
    bot: b.bot.name,
    agentLine: b.match.agentLine ?? '',
    rule: rule ? `${rule.allow ? 'Allow' : 'Disallow'}: ${rule.pattern}` : '',
    line: rule?.line ?? 0,
  };
}

/** The robots_ai split (checks.ts checkRobots): main = fail, training-only (Google-Extended too) = note. */
export function aiViewRobots(robotsTxt: string | null, path = '/'): AiViewRobots {
  const blocked = blockedBotsFor(robotsTxt, path);
  return {
    found: robotsTxt !== null,
    mainBlocked: blocked.filter((b) => b.bot.main).map(blockOf),
    trainingBlocked: blocked.filter((b) => !b.bot.main && b.bot.purpose === 'training' && !WARN_IF_BLOCKED.has(b.bot.id)).map((b) => b.bot.name),
    groundingBlocked: blocked.filter((b) => !b.bot.main && WARN_IF_BLOCKED.has(b.bot.id)).map((b) => b.bot.name),
  };
}

const CHALLENGE_TITLE = /<title>\s*(just a moment|attention required|access denied|checking your browser|ddos-guard|verifying you are human)/i;

/** A bot challenge or block page served with any status (Cloudflare "Just a moment...", cf-mitigated, Akamai "Access Denied"). */
export function isChallengePage(status: number | null, headers: Record<string, string>, html: string): boolean {
  if ((headers['cf-mitigated'] ?? '').toLowerCase() === 'challenge') return true;
  if (status !== null && status >= 200 && status < 300 && CHALLENGE_TITLE.test(html.slice(0, 4000))) return true;
  return false;
}

/** The request sent as an AI crawler (honest token, "as GPTBot"): a retry on timeouts and 5xx, same-site redirects only, 10 s. */
export async function fetchAsAiCrawler(fetch: FetchLike, url: string, opts: { timeoutMs?: number } = {}): Promise<AiCrawlerFetch> {
  const fetcher = new PoliteFetcher({ fetch, userAgent: AI_VIEW_USER_AGENT, timeoutMs: opts.timeoutMs, tries: 2, delayMs: 0 });
  const r = await fetcher.get(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
  const out: AiCrawlerFetch = { status: r.status, headers: r.headers, html: r.text };
  if (r.error) out.error = r.error;
  return out;
}

const ok = (s: number | null) => s !== null && s >= 200 && s < 300;

/**
 * True when people get the page and the AI-crawler request is refused: 401, 403 or 429, or a challenge page (SCOPE
 * decision 2). A timeout, network error or 5xx on that request says nothing about AI crawlers, so it isn't a block.
 */
function firewallBlocks(plainStatus: number, crawler: AiCrawlerFetch | undefined): boolean {
  if (!crawler || !ok(plainStatus)) return false;
  if (crawler.status !== null && AI_VIEW_FIREWALL_STATUSES.includes(crawler.status)) return true;
  return isChallengePage(crawler.status, crawler.headers, crawler.html);
}

/** True when people get the page (plain 2xx) and the AI-crawler request is refused (401/403/429 or a challenge page). */
export function aiCrawlerRefused(crawler: AiCrawlerFetch | undefined, plainStatus: number): boolean {
  return firewallBlocks(plainStatus, crawler);
}

function hasDates(page: ParsedPage): boolean {
  if (page.visibleUpdated) return true;
  return page.jsonLdItems.some((i) => typeof i.datePublished === 'string' || typeof i.dateModified === 'string');
}

function products(blocks: AiViewRobotsBlock[]): string[] {
  return [...new Set(blocks.map((b) => PRODUCT_OF[b.botId] ?? b.bot))];
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return '/';
  }
}

/** Pure: the reveal for one fetched page. Same HTML and robots.txt in, same result out, wherever it runs. */
export function aiView(input: AiViewInput): AiViewSummary {
  const now = (input.now ?? new Date()).toISOString();
  const path = pathOf(input.url);
  const domain = domainOf(input.url);
  const loaded = ok(input.status);
  const page = parsePage(loaded ? input.html : '');
  const robots = aiViewRobots(input.robotsTxt, path);
  const firewall = firewallBlocks(input.status, input.crawler);
  const noJs = checkNoJsContent({ input: { url: input.url, status: input.status, headers: {}, html: input.html, robotsTxt: input.robotsTxt, llmsTxt: null }, url: new URL(input.url), pathOnly: false, page });

  let result: AiViewResult;
  let blockedBy: AiViewSummary['blockedBy'] = null;
  if (!loaded) result = 'unavailable';
  else if (firewall) {
    result = 'blocked';
    blockedBy = 'firewall';
  } else if (robots.mainBlocked.length) {
    result = 'blocked';
    blockedBy = 'robots';
  } else if (noJs.result === 'fail') result = page.emptyAppRoot || page.wordCount === 0 ? 'js_only' : 'thin';
  else result = 'ok';

  const names = listNames(products(robots.mainBlocked));
  const botNames = listNames(robots.mainBlocked.map((b) => b.bot));
  const crawlerGot = input.crawler?.status != null ? String(input.crawler.status) : 'no answer';
  const heading =
    blockedBy === 'firewall' ? `AI crawlers get turned away from ${domain}` : `This is what ChatGPT, Perplexity and Claude see on ${domain}`;
  const lead: Record<AiViewResult, string> = {
    js_only:
      'Your home page sends no text until JavaScript runs. AI crawlers don’t run it, so they get a title and an empty box. They can’t quote what they can’t read.',
    thin: `Your home page sends only ${page.wordCount.toLocaleString('en-US')} ${page.wordCount === 1 ? 'word' : 'words'} before JavaScript runs. AI crawlers don’t run it, so that’s all they can quote.`,
    ok: 'Good news: your home page text is in the HTML, so AI crawlers read the same words people do. We’ll still check every page in your first edition.',
    blocked:
      blockedBy === 'firewall'
        ? `People get your page (${input.status}). Our request as an AI crawler got ${crawlerGot}. Your firewall or CDN blocks AI crawlers, or bots claiming to be them.`
        : `${page.wordCount >= 50 ? 'Your page has text, but your' : 'Your'} robots.txt tells ${names} to stay out. They can’t read it, so they can’t cite it.`,
    unavailable: `We couldn’t read ${domain} the way AI crawlers do.`,
  };
  const training = robots.trainingBlocked.length
    ? ` Keep ${listNames(robots.trainingBlocked)} blocked if you don’t want training.`
    : '';
  const fix: Record<AiViewResult, string | null> = {
    js_only: noJs.fix ?? null,
    thin: noJs.fix ?? null,
    ok: null,
    blocked: blockedBy === 'firewall' ? FIREWALL_FIX : `Remove the Disallow for ${botNames} in robots.txt.${training}`,
    unavailable: null,
  };

  const types = [...new Set(page.jsonLdItems.flatMap(jsonLdTypes))];
  const ogDescription = loaded ? /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i.exec(input.html)?.[1]?.trim() : undefined;
  const summary: AiViewSummary = {
    result,
    blockedBy,
    url: input.url,
    path,
    words: page.wordCount,
    headline: page.h1,
    title: page.title,
    description: page.metaDescription ?? (ogDescription ? parsePage(`<p>${ogDescription}</p>`).bodyText || null : null),
    emptyAppRoot: page.emptyAppRoot,
    faq: { section: page.hasFaqSection, faqPage: types.some((t) => t.toLowerCase() === 'faqpage') },
    dates: hasDates(page),
    structuredData: types.slice(0, 5),
    robots,
    fetch: { plainStatus: input.status, botStatus: input.crawler?.status ?? null, userAgent: AI_VIEW_USER_AGENT },
    sitemapPages: input.sitemapPages ?? null,
    heading,
    lead: lead[result],
    fix: fix[result],
    checkedAt: now,
  };
  if (input.crawler) {
    const why = input.crawler.error ?? (isChallengePage(input.crawler.status, input.crawler.headers, input.crawler.html) ? 'challenge page' : undefined);
    if (why && firewall) summary.fetch.botError = why;
  }
  return summary;
}

/** The one-line verdict the CLI prints under the reveal (board: CLI block). */
export function aiViewVerdict(s: AiViewSummary): { word: 'PASS' | 'FAIL' | 'WARN'; line: string } {
  switch (s.result) {
    case 'ok':
      return { word: 'PASS', line: 'AI crawlers read the same text people do.' };
    case 'js_only':
      return { word: 'FAIL', line: 'ChatGPT, Perplexity and Claude get no text to quote. People see text only after JavaScript runs.' };
    case 'thin':
      return { word: 'FAIL', line: `AI crawlers get only ${s.words.toLocaleString('en-US')} ${s.words === 1 ? 'word' : 'words'} to quote. People see the rest after JavaScript runs.` };
    case 'blocked':
      return s.blockedBy === 'firewall'
        ? { word: 'FAIL', line: 'Your firewall or CDN turns AI crawlers away (or bots claiming to be them).' }
        : { word: 'FAIL', line: `robots.txt blocks ${listNames(s.robots.mainBlocked.map((b) => b.bot))}, so they can’t read or cite the page.` };
    case 'unavailable':
      return { word: 'WARN', line: s.lead };
  }
}

/** For the CLI: fetch a page plainly, its robots.txt and the page again as an AI crawler, then `aiView`. Never throws. */
export async function readAiView(
  url: string,
  opts: { fetch: FetchLike; timeoutMs?: number; userAgent?: string; now?: Date },
): Promise<{ summary: AiViewSummary } | { error: string }> {
  const plain = new PoliteFetcher({ fetch: opts.fetch, userAgent: opts.userAgent ?? GEO_TOOL_USER_AGENT, timeoutMs: opts.timeoutMs, tries: 2, delayMs: 0 });
  const page: FetchResult = await plain.get(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
  if (page.status === null || !ok(page.status)) return { error: page.error ?? `HTTP ${page.status}` };
  const origin = new URL(page.finalUrl).origin;
  const [robots, crawler] = await Promise.all([
    plain.get(`${origin}/robots.txt`, 'text/plain,*/*;q=0.5').then(robotsFromResult),
    fetchAsAiCrawler(opts.fetch, page.finalUrl, { timeoutMs: opts.timeoutMs }),
  ]);
  return { summary: aiView({ url: page.finalUrl, status: page.status, html: page.text, robotsTxt: robots.body, crawler, now: opts.now }) };
}
