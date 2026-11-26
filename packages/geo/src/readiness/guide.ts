// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/**
 * What each readiness check tests and how to pass it, for explanations (the MCP explain_check tool, docs pages). The
 * thresholds come from checks.ts and weights.ts, so the words can't drift from the rules; a test pins the wording to
 * the constants.
 */
import type { CheckId } from '../types.js';
import {
  ANSWER_MAX_WORDS,
  ANSWER_NEAR_TOP_WORDS,
  ANSWER_WARN_WORDS,
  APP_SHELL_WORDS,
  ARTICLE_WORDS,
  DESCRIPTION_MAX_CHARS,
  MIN_ANSWER_PAGE_WORDS,
  MIN_SERVER_WORDS,
  TITLE_MAX_CHARS,
} from './checks.js';
import { AI_BOTS, WARN_IF_BLOCKED } from '../bots/catalog.js';
import { CHECK_COPY, listNames } from './copy.js';
import { CHECK_WEIGHTS, WARN_CREDIT } from './weights.js';

export interface CheckGuide {
  id: CheckId;
  label: string;
  why: string;
  /** Points in the score (0 = informational). */
  weight: number;
  tests: string;
  pass: string;
  warn?: string;
  fail?: string;
  /** Not applied to this page (left out of the score). */
  skip?: string;
  fix: string;
}

const MAIN_BOTS = AI_BOTS.filter((b) => b.main).map((b) => b.name).join(', ');
const TRAINING_BOTS = listNames(AI_BOTS.filter((b) => b.purpose === 'training' && !WARN_IF_BLOCKED.has(b.id)).map((b) => b.name));

type GuideText = Omit<CheckGuide, 'id' | 'label' | 'why' | 'weight'>;

const TEXT: Record<CheckId, GuideText> = {
  indexable: {
    tests: 'The page answers HTTP 200 and has no noindex in a robots meta tag or the X-Robots-Tag header.',
    pass: 'HTTP 2xx and no noindex.',
    fail: 'Any other status, or noindex (or "none") in the meta tag or header.',
    fix: 'Serve the page with HTTP 200, or take it out of the sitemap; remove noindex if the page should appear in answers.',
  },
  robots_ai: {
    tests:
      'robots.txt rules for the AI crawlers in the catalog, for this page\'s path (RFC 9309: the bot\'s own group, else "*"; longest match wins; Allow wins ties). A missing robots.txt (4xx) allows everything; a 5xx or unreachable robots.txt counts as "disallow all".',
    pass: `The main AI crawlers (search indexers and user-triggered fetchers: ${MAIN_BOTS}) may read the page.`,
    warn: `Only Google-Extended (it also controls grounding in Gemini answers) or training-only crawlers (${TRAINING_BOTS}) are blocked. Blocking training doesn't stop AI answers citing you.`,
    fail: 'At least one main AI crawler is blocked for this path.',
    fix: 'Allow the blocked search and user crawlers in robots.txt (their own "User-agent" group with "Allow: /"), unless you mean to keep the page out of AI answers. Keep blocking training crawlers if you want to opt out of training.',
  },
  no_js_content: {
    tests: 'Words of visible text in the HTML as sent, before any JavaScript runs (scripts, styles, noscript and template are left out), and empty app mount points (#root, #app, #__next, #__nuxt, ___gatsby).',
    pass: `At least ${MIN_SERVER_WORDS} words in the HTML, and no empty app root unless the page has ${APP_SHELL_WORDS}+ words outside it.`,
    fail: `Under ${MIN_SERVER_WORDS} words, or an empty app root with under ${APP_SHELL_WORDS} words: most AI crawlers read the HTML as sent and don't run JavaScript.`,
    fix: 'Render the main text on the server (SSR or a static build/prerender) so it is in the HTML.',
  },
  direct_answer: {
    tests: `The first paragraph of at least 8 words after the h1 (bylines and "Updated" lines skipped), before the first h2, and how far down it starts.`,
    pass: `A first paragraph of ${ANSWER_MAX_WORDS} words or fewer, starting within ${ANSWER_NEAR_TOP_WORDS} words of the title.`,
    warn: `A first paragraph of ${ANSWER_MAX_WORDS + 1}-${ANSWER_WARN_WORDS} words.`,
    fail: `No text in the HTML, no opening paragraph before the first section, one longer than ${ANSWER_WARN_WORDS} words, or one starting more than ${ANSWER_NEAR_TOP_WORDS} words below the title.`,
    skip: `Pages with ${MIN_SERVER_WORDS}-${MIN_ANSWER_PAGE_WORDS - 1} words (too short to need an answer paragraph).`,
    fix: `Under the title, answer the page's main question in 1-2 sentences (under ${ANSWER_MAX_WORDS} words), then go into detail.`,
  },
  json_ld: {
    tests: 'JSON-LD blocks: valid JSON, an @type, FAQPage questions that appear on the page, an Article on article pages (an <article> element or ' + `${ARTICLE_WORDS}+ words, not the home page).`,
    pass: 'Valid, typed JSON-LD that matches the page.',
    warn: 'No JSON-LD on a page that isn\'t an article, an FAQ on the page with no FAQPage schema, or an article page without an Article item.',
    fail: 'No JSON-LD on an article page, a block that isn\'t valid JSON, JSON-LD with no @type, or FAQPage questions that aren\'t on the page.',
    fix: 'Add JSON-LD that says what the page is: Article (headline, author, datePublished, dateModified) for articles, Organization or WebSite on the home page, FAQPage only for questions shown on the page.',
  },
  canonical: {
    tests: 'The <link rel="canonical"> tags in the head.',
    pass: 'One canonical, pointing to this URL (trailing slash and www ignored).',
    warn: 'No canonical, or one pointing to another URL.',
    fail: 'Several different canonicals, or one that isn\'t a valid URL.',
    fix: 'Keep exactly one <link rel="canonical" href="…"> pointing to this URL, unless another page is the one you want cited.',
  },
  title_meta: {
    tests: 'The <title> and <meta name="description">.',
    pass: `A title of ${TITLE_MAX_CHARS} characters or fewer and a description of ${DESCRIPTION_MAX_CHARS} or fewer.`,
    warn: `No meta description, a title over ${TITLE_MAX_CHARS} characters or a description over ${DESCRIPTION_MAX_CHARS} (cut off).`,
    fail: 'No <title>.',
    fix: `Add a <title> that says what the page answers (under ${TITLE_MAX_CHARS} characters) and a one or two sentence meta description (under ${DESCRIPTION_MAX_CHARS}).`,
  },
  question_headings: {
    tests: 'h2 and h3 subheadings: how many are questions (end in "?" or start with how, what, why, when, can, does, is, should and similar).',
    pass: 'At least a third of the subheadings are questions.',
    warn: 'Fewer than a third are questions.',
    skip: 'Pages with fewer than two subheadings.',
    fix: 'Rename some subheadings as the questions a reader would ask an AI, e.g. "How much does it cost?".',
  },
  updated_date: {
    tests: 'A visible "Updated <date>" on the page (itemprop dateModified, a <time> after "updated", or text) against JSON-LD dateModified (an Article item first).',
    pass: 'Both are there and name the same date (a visible date without a year compares month and day).',
    warn: 'Only one of them is there, or an article page has neither.',
    fail: 'The two dates disagree.',
    skip: 'Pages that aren\'t articles and show no dates.',
    fix: 'Show an "Updated <date>" line near the title and set the same date as dateModified in the JSON-LD; change both when you change the content.',
  },
  llms_txt: {
    tests: 'Whether /llms.txt exists on the site (the llmstxt.org proposal).',
    pass: 'Never scored: shown as information only.',
    fix: 'Optional. If you add one, start with "# Site name", a "> summary" line, then "## Section" lists of "- [Page](https://…): notes". Evidence that engines use it is thin, so don\'t expect it to change citations.',
  },
};

export const CHECK_GUIDE: Readonly<Record<CheckId, CheckGuide>> = Object.fromEntries(
  (Object.keys(TEXT) as CheckId[]).map((id) => [id, { id, label: CHECK_COPY[id].label, why: CHECK_COPY[id].why, weight: CHECK_WEIGHTS[id], ...TEXT[id] }]),
) as Record<CheckId, CheckGuide>;

/** How the 0-100 score is made, in one sentence. */
export const SCORE_RULE = `Score = 100 × (weight of passed checks + ${WARN_CREDIT} × weight of warnings) / weight of the checks that apply; skipped and informational checks are left out. The site score is the mean of page scores.`;
