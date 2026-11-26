// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu

/**
 * "What AI sees": the reveal shown in onboarding step 1 and at the top of `npx citelog <url>`
 * (initiatives/2026-11-19-ai-view-onboarding). One engine computes it: `aiView` in packages/geo. These are the shapes
 * the server, the web app and the CLI share.
 */
import { GEO_TOOL } from './brand.js';

/**
 * The worst finding, in order: blocked (robots.txt blocks a main AI crawler, or a firewall/CDN turns the AI-crawler
 * request away), js_only (no_js_content fails and an empty app root or 0 words), thin (no_js_content fails without an
 * app root), ok. `unavailable` = the reveal couldn't run (the page didn't load as HTML).
 */
export const AI_VIEW_RESULTS = ['js_only', 'thin', 'ok', 'blocked', 'unavailable'] as const;
export type AiViewResult = (typeof AI_VIEW_RESULTS)[number];

/** Results that put the home page first in the first Today edition. */
export const AI_VIEW_FAILING: readonly AiViewResult[] = ['js_only', 'thin', 'blocked'];

/** Word-count buckets for analytics (never the exact count). */
export const AI_VIEW_WORD_BUCKETS = ['0', '1-49', '50-299', '300-999', '1000+'] as const;
export type AiViewWordsBucket = (typeof AI_VIEW_WORD_BUCKETS)[number];

export function aiViewWordsBucket(words: number): AiViewWordsBucket {
  if (words <= 0) return '0';
  if (words < 50) return '1-49';
  if (words < 300) return '50-299';
  if (words < 1000) return '300-999';
  return '1000+';
}

/**
 * The AI-crawler request's User-Agent: our honest token with the crawler named, so firewall rules that match "GPTBot"
 * fire, without sending OpenAI's own string (SCOPE decision 2).
 */
export const AI_VIEW_USER_AGENT = `Mozilla/5.0 (compatible; ${GEO_TOOL.name}/${GEO_TOOL.version}; +${GEO_TOOL.docsUrl}; as GPTBot)`;

/** A main AI crawler blocked by robots.txt, with the deciding rule. */
export interface AiViewRobotsBlock {
  /** Catalog id, e.g. "oai-searchbot". */
  botId: string;
  /** Display name, e.g. "OAI-SearchBot". */
  bot: string;
  /** "User-agent: OAI-SearchBot" as written. */
  agentLine: string;
  /** "Disallow: /" as written. */
  rule: string;
  /** 1-based robots.txt line of the rule. */
  line: number;
}

/** The full reveal, computed in memory from the fetched HTML and robots.txt. Never stored (see AiViewStored). */
export interface AiViewSummary {
  result: AiViewResult;
  /** Why `blocked`: a robots.txt rule or a firewall/CDN refusing the AI-crawler request. Null otherwise. */
  blockedBy: 'robots' | 'firewall' | null;
  /** URL checked (final URL after redirects). */
  url: string;
  /** Path checked, "/" for the home page. */
  path: string;
  /** Words of visible text in the HTML as sent (no JavaScript). */
  words: number;
  /** The h1, or null. */
  headline: string | null;
  /** <title>, or null. */
  title: string | null;
  /** Meta description, else og:description, or null. */
  description: string | null;
  /** e.g. "div#root" when a client-app mount point is empty in the HTML. */
  emptyAppRoot: string | null;
  /** A heading names an FAQ section / FAQPage JSON-LD is present. */
  faq: { section: boolean; faqPage: boolean };
  /** A visible "updated" date or datePublished/dateModified in JSON-LD. */
  dates: boolean;
  /** JSON-LD @types found, de-duplicated, at most 5. */
  structuredData: string[];
  robots: {
    /** robots.txt exists. */
    found: boolean;
    /** Main AI crawlers (catalog `main`) blocked for this path. */
    mainBlocked: AiViewRobotsBlock[];
    /** Training-only crawlers blocked (names), e.g. ["GPTBot"]: a note, "blocks training, not answers". */
    trainingBlocked: string[];
    /** Google-Extended when blocked: it also controls grounding in Gemini answers (robots_ai warns). */
    groundingBlocked: string[];
  };
  fetch: {
    /** Status of the plain request (the page as people's browsers get it). */
    plainStatus: number;
    /** Status of the AI-crawler request; null when nothing came back or it wasn't sent. */
    botStatus: number | null;
    /** Why the AI-crawler request failed ("timeout after 10 s", "challenge page"), when it did. */
    botError?: string;
    /** User-Agent of the AI-crawler request. */
    userAgent: string;
  };
  /** URLs in the sitemap when the caller read it, else null. */
  sitemapPages: number | null;
  /** The card's heading for this result, e.g. "This is what ChatGPT, Perplexity and Claude see on ansa.chat". */
  heading: string;
  /** The card's lead paragraph (desk) for this result. */
  lead: string;
  /** One-line fix, or null when nothing needs fixing. */
  fix: string | null;
  checkedAt: string;
}

/** What the desk keeps on the site row (SCOPE decision 7: never the HTML, never page text). */
export interface AiViewStored {
  result: AiViewResult;
  blockedBy: 'robots' | 'firewall' | null;
  words: number;
  headline: boolean;
  /** Catalog ids of blocked main crawlers. */
  mainBlocked: string[];
  checkedAt: string;
}

export function toStoredAiView(s: AiViewSummary): AiViewStored {
  return {
    result: s.result,
    blockedBy: s.blockedBy,
    words: s.words,
    headline: s.headline !== null,
    mainBlocked: s.robots.mainBlocked.map((b) => b.botId),
    checkedAt: s.checkedAt,
  };
}

/** Bot names as "A, B and C". */
export function aiViewList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The reveal's row wording, shared by onboarding step 1 and the CLI so both say the same thing about the same page
 * (cross-review 2026-11-19). Notes match readiness robots_ai: training stops training, not answers; Google-Extended
 * also controls Gemini grounding.
 */
export const AI_VIEW_COPY = {
  robotsAllowsAll: 'Allows all main AI crawlers',
  robotsNotFound: 'Not found, so AI crawlers are allowed by default',
  robotsBlocks: (names: readonly string[]) => `Blocks ${aiViewList(names)}`,
  trainingNote: (names: readonly string[]) => `Blocks ${aiViewList(names)}. That stops training, not answers.`,
  groundingNote: (names: readonly string[]) => `Blocks ${aiViewList(names)}, which also controls grounding in Gemini answers.`,
  faq: (faq: { section: boolean; faqPage: boolean }): string | null =>
    faq.section && faq.faqPage
      ? 'FAQ section with FAQPage data'
      : faq.faqPage
        ? 'FAQPage data, no FAQ heading'
        : faq.section
          ? 'FAQ section, no FAQPage data'
          : null,
  /** Desk-only suffix to the no-JS fix (board 10b). */
  firstEditionSuffix: 'Your first edition puts this at the top.',
} as const;

/** A 401, 403 or 429 to the AI-crawler request (or a challenge page) means a firewall or CDN turns AI crawlers away. */
export const AI_VIEW_FIREWALL_STATUSES: readonly number[] = [401, 403, 429];
