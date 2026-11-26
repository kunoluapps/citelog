// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { AI_BOTS, WARN_IF_BLOCKED } from '../bots/catalog.js';
import { parseRobots, robotsMatch, type RobotsMatch } from '../bots/robots.js';
import type { AiBot, CheckId, CheckOutcome, CheckResult, PageInput } from '../types.js';
import { CHECK_COPY, listNames } from './copy.js';
import { countWords, isArticleType, jsonLdTypes, normText, parseLooseDate, type DateParts, type ParsedPage } from './html.js';
import { CHECK_WEIGHTS } from './weights.js';

/** Under this many words of visible text, the page is treated as an app shell (no server-rendered content). */
export const MIN_SERVER_WORDS = 50;
/** An empty app mount point with fewer words than this means the main content is rendered by JavaScript. */
export const APP_SHELL_WORDS = 150;
/** Pages shorter than this have no "answer" to look for. */
export const MIN_ANSWER_PAGE_WORDS = 150;
export const ANSWER_MAX_WORDS = 60;
export const ANSWER_WARN_WORDS = 100;
/** The answer paragraph must start within this many words after the title. */
export const ANSWER_NEAR_TOP_WORDS = 150;
/** Pages with at least this many words are treated as articles for the JSON-LD check. */
export const ARTICLE_WORDS = 300;
export const TITLE_MAX_CHARS = 65;
export const DESCRIPTION_MAX_CHARS = 160;

export interface PageContext {
  input: PageInput;
  url: URL;
  /** True when the page is known only by its path (folder mode); canonical compares paths. */
  pathOnly: boolean;
  page: ParsedPage;
}

interface Partial {
  result: CheckResult;
  detail: string;
  fix?: string;
}

export function outcome(id: CheckId, p: Partial): CheckOutcome {
  const copy = CHECK_COPY[id];
  const out: CheckOutcome = { id, label: copy.label, result: p.result, weight: CHECK_WEIGHTS[id], detail: p.detail, why: copy.why };
  if ((p.result === 'warn' || p.result === 'fail') && p.fix) out.fix = p.fix;
  return out;
}

const skip = (detail: string): Partial => ({ result: 'skip', detail });

/* ---------- indexable ---------- */

export function checkIndexable(ctx: PageContext): Partial {
  const status = ctx.input.status;
  if (status === null || status < 200 || status >= 300) {
    return { result: 'fail', detail: `The page returned HTTP ${status ?? 'no response'}.`, fix: 'Serve the page with HTTP 200, or take it out of the sitemap.' };
  }
  const header = (ctx.input.headers['x-robots-tag'] ?? '').toLowerCase();
  const headerNoindex = /(^|[\s,:])(noindex|none)\b/.test(header);
  const metaNoindex = ctx.page.robotsMeta.some((d) => d === 'noindex' || d === 'none');
  if (metaNoindex || headerNoindex) {
    const where = metaNoindex ? 'a robots meta tag' : 'the X-Robots-Tag header';
    return { result: 'fail', detail: `HTTP ${status}, but ${where} says noindex.`, fix: `Remove noindex from ${where} if this page should appear in answers.` };
  }
  return { result: 'pass', detail: `HTTP ${status}, no noindex.` };
}

/* ---------- robots_ai ---------- */

export interface BotBlock {
  bot: AiBot;
  match: RobotsMatch;
}

export function blockedBotsFor(robotsTxt: string | null, path: string, bots: readonly AiBot[] = AI_BOTS): BotBlock[] {
  if (robotsTxt === null) return [];
  const parsed = parseRobots(robotsTxt);
  return bots.map((bot) => ({ bot, match: robotsMatch(parsed, bot.robotsToken, path) })).filter((b) => !b.match.allowed);
}

function ruleText(b: BotBlock): string {
  const rule = b.match.rule;
  if (!rule) return '';
  return `"${b.match.agentLine} / ${rule.allow ? 'Allow' : 'Disallow'}: ${rule.pattern}" (line ${rule.line})`;
}

/**
 * Tech lead decision (FIX-P1): a blocked main crawler (search or user fetcher) fails; a blocked training-only crawler
 * or Google-Extended warns, naming the bot; other blocked crawlers are a note. Every group is named in the detail, so a
 * fail never hides a warning.
 */
export function checkRobots(ctx: PageContext): Partial {
  if (ctx.input.robotsTxt === null) return { result: 'pass', detail: 'No robots.txt, so every crawler may read this page.' };
  const path = ctx.url.pathname + ctx.url.search;
  const blocked = blockedBotsFor(ctx.input.robotsTxt, path);
  const main = blocked.filter((b) => b.bot.main);
  const grounding = blocked.filter((b) => !b.bot.main && WARN_IF_BLOCKED.has(b.bot.id));
  const training = blocked.filter((b) => !b.bot.main && b.bot.purpose === 'training' && !WARN_IF_BLOCKED.has(b.bot.id));
  const other = blocked.filter((b) => !b.bot.main && b.bot.purpose !== 'training' && !WARN_IF_BLOCKED.has(b.bot.id));
  const names = (list: BotBlock[]) => listNames(list.map((b) => b.bot.name));
  const groundingNote = grounding.length ? `It also blocks ${names(grounding)}, which controls grounding in Gemini answers.` : '';
  const trainingNote = training.length
    ? `Training-only crawlers blocked: ${names(training)}. That doesn't stop AI answers citing you; it stops training.`
    : '';
  const otherNote = other.length ? `Also blocked: ${names(other)}.` : '';
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ');
  if (main.length) {
    const rule = ruleText(main[0] as BotBlock);
    return {
      result: 'fail',
      detail: join(`robots.txt blocks ${names(main)}${rule ? ` ${rule}` : ''}.`, groundingNote, trainingNote, otherNote),
      fix: `Allow ${names(main)} in robots.txt, unless you mean to keep this page out of AI answers.`,
    };
  }
  if (grounding.length) {
    return {
      result: 'warn',
      detail: join(`robots.txt blocks ${names(grounding)}, which also controls grounding in Gemini answers.`, trainingNote, otherNote),
      fix: `Allow ${names(grounding)} in robots.txt, unless you mean to keep this page out of Gemini answers.`,
    };
  }
  if (training.length) {
    return {
      result: 'warn',
      detail: join(`robots.txt blocks ${names(training)}. That doesn't stop AI answers citing you; it stops training.`, otherNote),
      fix: `Nothing to change if you mean to opt out of AI training; otherwise allow ${names(training)} in robots.txt.`,
    };
  }
  return { result: 'pass', detail: join('The main AI crawlers may read this page.', otherNote) };
}

/* ---------- canonical ---------- */

function samePage(a: URL, b: URL, pathOnly: boolean): boolean {
  const path = (u: URL) => (u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : u.pathname) + u.search;
  if (pathOnly) return path(a) === path(b);
  const host = (u: URL) => u.host.toLowerCase().replace(/^www\./, '');
  return a.protocol === b.protocol && host(a) === host(b) && path(a) === path(b);
}

export function checkCanonical(ctx: PageContext): Partial {
  const canonicals = [...new Set(ctx.page.canonicals)];
  const self = ctx.pathOnly ? ctx.url.pathname : ctx.url.toString();
  if (canonicals.length === 0) {
    return { result: 'warn', detail: 'No canonical link.', fix: `Add <link rel="canonical" href="${self}"> to the head.` };
  }
  if (canonicals.length > 1) {
    return { result: 'fail', detail: `${canonicals.length} different canonical links: ${canonicals.join(', ')}.`, fix: 'Keep one canonical link, pointing to this URL.' };
  }
  const href = canonicals[0] as string;
  let target: URL;
  try {
    target = new URL(href, ctx.url);
  } catch {
    return { result: 'fail', detail: `The canonical "${href}" isn't a valid URL.`, fix: `Set the canonical to ${self}.` };
  }
  if (samePage(target, ctx.url, ctx.pathOnly)) return { result: 'pass', detail: `Canonical is ${href}.` };
  return {
    result: 'warn',
    detail: `Canonical points to another URL: ${target.toString()}.`,
    fix: 'Point the canonical to this URL, unless the other page is the one you want cited.',
  };
}

/* ---------- title_meta ---------- */

export function checkTitleMeta(ctx: PageContext): Partial {
  const { title, metaDescription } = ctx.page;
  if (!title) {
    return {
      result: 'fail',
      detail: metaDescription ? 'No <title>.' : 'No <title> and no meta description.',
      fix: 'Add a <title> that says what the page answers, and a one or two sentence meta description.',
    };
  }
  if (!metaDescription) return { result: 'warn', detail: `Title "${title}", but no meta description.`, fix: `Add a meta description of one or two sentences (under ${DESCRIPTION_MAX_CHARS} characters).` };
  if (title.length > TITLE_MAX_CHARS) {
    return { result: 'warn', detail: `The title is ${title.length} characters, so it gets cut off.`, fix: `Shorten the title to under ${TITLE_MAX_CHARS} characters.` };
  }
  if (metaDescription.length > DESCRIPTION_MAX_CHARS) {
    return { result: 'warn', detail: `The meta description is ${metaDescription.length} characters, so it gets cut off.`, fix: `Shorten the meta description to under ${DESCRIPTION_MAX_CHARS} characters.` };
  }
  return { result: 'pass', detail: `Title "${title}" and a meta description.` };
}

/* ---------- direct_answer ---------- */

function answerFix(h1: string | null): string {
  if (h1 && h1.endsWith('?')) return `Under the title, answer "${h1}" in 1–2 sentences (under ${ANSWER_MAX_WORDS} words).`;
  return `Under the title, answer the page's main question in 1–2 sentences (under ${ANSWER_MAX_WORDS} words).`;
}

export function checkDirectAnswer(ctx: PageContext): Partial {
  const { page } = ctx;
  if (page.wordCount < MIN_SERVER_WORDS) {
    return { result: 'fail', detail: 'No text in the HTML as sent, so there is no answer to quote.', fix: answerFix(page.h1) };
  }
  if (page.wordCount < MIN_ANSWER_PAGE_WORDS) return skip(`Short page (${page.wordCount} words), so there's no answer to look for.`);
  const fix = answerFix(page.h1);
  if (!page.firstParagraph) {
    return { result: 'fail', detail: 'No opening paragraph under the title before the first section.', fix };
  }
  const words = countWords(page.firstParagraph);
  if (page.wordsBeforeFirstParagraph > ANSWER_NEAR_TOP_WORDS) {
    return { result: 'fail', detail: `The first paragraph starts ${page.wordsBeforeFirstParagraph} words below the title.`, fix };
  }
  if (words <= ANSWER_MAX_WORDS) return { result: 'pass', detail: `The page opens with a ${words}-word answer.` };
  if (words <= ANSWER_WARN_WORDS) return { result: 'warn', detail: `The opening paragraph is ${words} words; a quotable answer is under ${ANSWER_MAX_WORDS}.`, fix };
  return { result: 'fail', detail: `The opening paragraph is ${words} words, too long to quote as an answer.`, fix };
}

/* ---------- question_headings ---------- */

const QUESTION_START = /^(how|what|why|when|where|who|which|can|could|does|do|did|is|are|should|will|would|was|were)\b/i;

export function isQuestion(heading: string): boolean {
  return heading.trim().endsWith('?') || QUESTION_START.test(heading.trim());
}

export function checkQuestionHeadings(ctx: PageContext): Partial {
  const headings = ctx.page.subheadings;
  if (headings.length < 2) return skip(headings.length ? 'Only one subheading.' : 'No subheadings.');
  const questions = headings.filter(isQuestion);
  const firstPlain = headings.find((h) => !isQuestion(h));
  const fix = firstPlain ? `Rename "${firstPlain}" as the question a reader would ask.` : undefined;
  if (questions.length * 3 >= headings.length) return { result: 'pass', detail: `${questions.length} of ${headings.length} subheadings are questions.` };
  return { result: 'warn', detail: `${questions.length} of ${headings.length} subheadings ${questions.length === 1 ? 'is a question' : 'are questions'}.`, fix };
}

/* ---------- updated_date ---------- */

function structuredModified(ctx: PageContext): { raw: string; date: DateParts } | null {
  const items = ctx.page.jsonLdItems;
  const ordered = [...items.filter((i) => jsonLdTypes(i).some(isArticleType)), ...items];
  for (const item of ordered) {
    const v = item['dateModified'];
    if (typeof v === 'string') {
      const date = parseLooseDate(v);
      if (date) return { raw: v.slice(0, 10), date };
    }
  }
  return null;
}

function sameDate(visible: DateParts, structured: DateParts): boolean {
  if (visible.m !== structured.m || visible.d !== structured.d) return false;
  return visible.y === undefined || structured.y === undefined || visible.y === structured.y;
}

export function checkUpdatedDate(ctx: PageContext): Partial {
  const visible = ctx.page.visibleUpdatedDate;
  const structured = structuredModified(ctx);
  const isArticle = ctx.page.jsonLdItems.some((i) => jsonLdTypes(i).some(isArticleType)) || ctx.page.hasArticleElement;
  if (!visible && !structured) {
    if (!isArticle) return skip('No dates on this page, and it isn\'t an article.');
    return { result: 'warn', detail: 'No visible "updated" date and no dateModified.', fix: 'Show an "Updated <date>" line near the title and set the same date as dateModified.' };
  }
  if (visible && !structured) {
    return { result: 'warn', detail: `The page says "${ctx.page.visibleUpdated}" but has no dateModified.`, fix: 'Add dateModified to the page\'s JSON-LD with the same date.' };
  }
  if (!visible && structured) {
    return { result: 'warn', detail: `dateModified is ${structured.raw} but no "updated" date is visible.`, fix: 'Show an "Updated <date>" line near the title that matches dateModified.' };
  }
  const v = visible as DateParts;
  const s = structured as { raw: string; date: DateParts };
  if (sameDate(v, s.date)) return { result: 'pass', detail: `"${ctx.page.visibleUpdated}" matches dateModified ${s.raw}.` };
  return {
    result: 'fail',
    detail: `The page says "${ctx.page.visibleUpdated}" but dateModified is ${s.raw}.`,
    fix: 'Set dateModified to the date you last changed the content.',
  };
}

/* ---------- json_ld ---------- */

function normForMatch(s: string): string {
  return normText(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '));
}

function faqQuestions(items: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (!jsonLdTypes(item).some((t) => t.toLowerCase() === 'faqpage')) continue;
    const entities = Array.isArray(item['mainEntity']) ? item['mainEntity'] : item['mainEntity'] ? [item['mainEntity']] : [];
    for (const e of entities) {
      if (e && typeof e === 'object' && typeof (e as Record<string, unknown>)['name'] === 'string') out.push((e as Record<string, unknown>)['name'] as string);
    }
  }
  return out;
}

export function checkJsonLd(ctx: PageContext): Partial {
  const { page } = ctx;
  const isHome = ctx.url.pathname === '/';
  const articleLike = !isHome && (page.hasArticleElement || page.wordCount >= ARTICLE_WORDS);
  if (page.jsonLd.length === 0) {
    const fix = articleLike
      ? 'Add JSON-LD with an Article (headline, author, datePublished, dateModified).'
      : isHome
        ? 'Add JSON-LD that says who runs the site (Organization or WebSite).'
        : 'Add JSON-LD that says what the page is (for example WebPage or Product).';
    return { result: articleLike ? 'fail' : 'warn', detail: 'No JSON-LD on the page.', fix };
  }
  const broken = page.jsonLd.find((b) => b.error);
  if (broken) {
    return { result: 'fail', detail: `JSON-LD block ${broken.index} isn't valid JSON (${broken.error}).`, fix: `Fix the JSON in JSON-LD block ${broken.index}; engines skip blocks they can't parse.` };
  }
  const topLevel = page.jsonLdItems.filter((i) => !('@graph' in i) || jsonLdTypes(i).length > 0);
  const untyped = topLevel.filter((i) => jsonLdTypes(i).length === 0 && !('@id' in i && Object.keys(i).length === 1));
  if (untyped.length && page.jsonLdItems.every((i) => jsonLdTypes(i).length === 0)) {
    return { result: 'fail', detail: 'The JSON-LD has no @type.', fix: 'Give each JSON-LD item an @type, such as Article or FAQPage.' };
  }
  const types = [...new Set(page.jsonLdItems.flatMap(jsonLdTypes))];
  const typeList = types.join(', ');
  const schemaQuestions = faqQuestions(page.jsonLdItems);
  const body = normForMatch(page.bodyText);
  const missing = schemaQuestions.filter((q) => !body.includes(normForMatch(q)));
  if (missing.length) {
    return {
      result: 'fail',
      detail: `FAQ schema lists ${missing.length === 1 ? 'a question' : `${missing.length} questions`} not on the page: "${missing[0]}".`,
      fix: 'Make the FAQPage schema list only questions shown on the page.',
    };
  }
  if (page.hasFaqSection && schemaQuestions.length === 0) {
    return { result: 'warn', detail: `The page has an FAQ but no FAQPage schema (found ${typeList || 'no types'}).`, fix: 'Add FAQPage schema for the FAQ.' };
  }
  const hasArticle = types.some(isArticleType);
  if (articleLike && !hasArticle) {
    return { result: 'warn', detail: `Valid JSON-LD (${typeList}), but no Article for this article page.`, fix: 'Add an Article item with headline, author, datePublished and dateModified.' };
  }
  return { result: 'pass', detail: `Valid JSON-LD (${typeList}).` };
}

/* ---------- no_js_content ---------- */

export function checkNoJsContent(ctx: PageContext): Partial {
  const { page } = ctx;
  const fix = 'Render the main text on the server (SSR or a static build) so it is in the HTML.';
  if (page.wordCount < MIN_SERVER_WORDS) {
    const root = page.emptyAppRoot ? ` and <${page.emptyAppRoot.replace('#', ' id="')}"> is empty` : '';
    return {
      result: 'fail',
      detail: `The HTML as sent has ${page.wordCount} words of text${root}, so the main text appears only after JavaScript runs.`,
      fix,
    };
  }
  if (page.emptyAppRoot && page.wordCount < APP_SHELL_WORDS) {
    return {
      result: 'fail',
      detail: `<${page.emptyAppRoot.replace('#', ' id="')}"> is empty in the HTML as sent and the page has only ${page.wordCount} words outside it, so the main text appears only after JavaScript runs.`,
      fix,
    };
  }
  return { result: 'pass', detail: `${page.wordCount} words of text in the HTML as sent.` };
}

/* ---------- llms_txt ---------- */

export function checkLlmsTxt(ctx: PageContext): Partial {
  const where = ctx.pathOnly ? 'llms.txt in the folder' : `${ctx.url.host}/llms.txt`;
  if (ctx.input.llmsTxt === true) return { result: 'info', detail: `Found at ${where}. Not scored: evidence that engines use it is thin.` };
  if (ctx.input.llmsTxt === false) return { result: 'info', detail: `No ${where}. Not scored: evidence that engines use it is thin.` };
  return { result: 'info', detail: `Couldn't tell whether ${where} exists. Not scored.` };
}

export const CHECKS: Record<CheckId, (ctx: PageContext) => Partial> = {
  indexable: checkIndexable,
  robots_ai: checkRobots,
  canonical: checkCanonical,
  title_meta: checkTitleMeta,
  direct_answer: checkDirectAnswer,
  question_headings: checkQuestionHeadings,
  updated_date: checkUpdatedDate,
  json_ld: checkJsonLd,
  no_js_content: checkNoJsContent,
  llms_txt: checkLlmsTxt,
};
