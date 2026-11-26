// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { parseDocument } from 'htmlparser2';
import { isTag, isText, type AnyNode, type Element } from 'domhandler';

/** Elements whose text a reader never sees as page content. */
const HIDDEN = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'object']);
/** Common mount points of client-rendered apps. */
const APP_ROOT_IDS = new Set(['root', 'app', '__next', '__nuxt', '___gatsby', 'svelte', 'main-app']);
/** Question <summary> elements that make an accordion an FAQ section (Ansa: "Fair questions. Straight answers."). */
const FAQ_MIN_QUESTIONS = 3;
const ARTICLE_TYPES = new Set(['article', 'blogposting', 'newsarticle', 'techarticle', 'scholarlyarticle', 'report']);

export interface DateParts {
  y?: number;
  m: number;
  d: number;
}

export interface JsonLdBlock {
  /** 1-based position on the page. */
  index: number;
  data?: unknown;
  error?: string;
}

export interface ParsedPage {
  title: string | null;
  metaDescription: string | null;
  /** Lower-cased directives from meta robots / googlebot tags. */
  robotsMeta: string[];
  canonicals: string[];
  h1: string | null;
  /** h2 and h3 text, in order. */
  subheadings: string[];
  bodyText: string;
  wordCount: number;
  /** First substantial paragraph after the h1 (or at the top of the content when there is no h1). */
  firstParagraph: string | null;
  /** Words of content between the h1 and that paragraph. */
  wordsBeforeFirstParagraph: number;
  hasArticleElement: boolean;
  jsonLd: JsonLdBlock[];
  /** Flattened JSON-LD objects (arrays and @graph expanded). */
  jsonLdItems: Record<string, unknown>[];
  /** e.g. 'div#root' when a client-app mount point is empty in the HTML. */
  emptyAppRoot: string | null;
  /** The visible "updated" text found, e.g. "Updated Oct 2". */
  visibleUpdated: string | null;
  visibleUpdatedDate: DateParts | null;
  /** True when a heading names an FAQ section, or the page has an accordion of questions (<details><summary>…?). */
  hasFaqSection: boolean;
}

export function normText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function countWords(s: string): number {
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function textOf(node: AnyNode): string {
  const parts: string[] = [];
  const visit = (n: AnyNode) => {
    if (isText(n)) parts.push(n.data);
    else if (isTag(n)) {
      if (HIDDEN.has(n.name)) return;
      for (const c of n.children) visit(c);
    }
  };
  visit(node);
  return normText(parts.join(' '));
}

function findAll(root: AnyNode[], test: (el: Element) => boolean): Element[] {
  const out: Element[] = [];
  const visit = (n: AnyNode) => {
    if (!isTag(n)) return;
    if (test(n)) out.push(n);
    for (const c of n.children) visit(c);
  };
  root.forEach(visit);
  return out;
}

function attr(el: Element, name: string): string | undefined {
  return el.attribs[name];
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse "2026-11-02", "2026-11-02T10:00:00Z", "Nov 2, 2026", "November 2 2026", "2 November 2026" or "Oct 2". */
export function parseLooseDate(input: string): DateParts | null {
  const s = input.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/.exec(s);
  if (m) {
    const month = MONTHS[(m[1] as string).slice(0, 4).toLowerCase()] ?? MONTHS[(m[1] as string).slice(0, 3).toLowerCase()];
    if (month) return { y: m[3] ? Number(m[3]) : undefined, m: month, d: Number(m[2]) };
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s);
  if (m) {
    const month = MONTHS[(m[2] as string).slice(0, 3).toLowerCase()];
    if (month) return { y: Number(m[3]), m: month, d: Number(m[1]) };
  }
  return null;
}

const DATE_TEXT = String.raw`(\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}\s+[A-Z][a-z]{2,8}\.?,?\s+\d{4})`;
const UPDATED_RE = new RegExp(String.raw`\b(?:last\s+)?(?:updated|modified)(?:\s+on)?\s*:?\s*` + DATE_TEXT, 'i');

function flattenJsonLd(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach((v) => flattenJsonLd(v, out));
    return;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    out.push(obj);
    if (Array.isArray(obj['@graph'])) flattenJsonLd(obj['@graph'], out);
  }
}

export function jsonLdTypes(item: Record<string, unknown>): string[] {
  const t = item['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

export function isArticleType(type: string): boolean {
  return ARTICLE_TYPES.has(type.toLowerCase());
}

function findVisibleUpdated(body: Element[], bodyText: string): { text: string; date: DateParts } | null {
  for (const el of findAll(body, (e) => attr(e, 'itemprop') === 'dateModified')) {
    const raw = attr(el, 'datetime') ?? attr(el, 'content') ?? textOf(el);
    const date = parseLooseDate(raw);
    if (date && textOf(el)) return { text: textOf(el), date };
  }
  for (const el of findAll(body, (e) => e.name === 'time')) {
    const parent = el.parent && isTag(el.parent) ? el.parent : null;
    const context = parent ? textOf(parent) : '';
    const own = textOf(el);
    const before = context.slice(0, Math.max(0, context.indexOf(own)));
    if (!/\b(updated|modified)\b/i.test(before) && !/\b(updated|modified)\b/i.test(own)) continue;
    const date = parseLooseDate(attr(el, 'datetime') ?? own) ?? parseLooseDate(own.replace(/^.*?(updated|modified)\s*(on)?\s*:?\s*/i, ''));
    if (date) return { text: normText(`${before.split(/[.|·•]/).pop() ?? ''} ${own}`), date };
  }
  const m = UPDATED_RE.exec(bodyText);
  if (m) {
    const date = parseLooseDate(m[1] ?? '');
    if (date) return { text: m[0], date };
  }
  return null;
}

export function parsePage(html: string): ParsedPage {
  const doc = parseDocument(html, { lowerCaseTags: true, lowerCaseAttributeNames: true, decodeEntities: true });
  const all = doc.children;
  const titleEl = findAll(all, (e) => e.name === 'title')[0];
  const metas = findAll(all, (e) => e.name === 'meta');
  const metaDescription = metas.find((m) => attr(m, 'name')?.toLowerCase() === 'description');
  const robotsMeta = metas
    .filter((m) => ['robots', 'googlebot'].includes(attr(m, 'name')?.toLowerCase() ?? ''))
    .flatMap((m) => (attr(m, 'content') ?? '').toLowerCase().split(',').map((s) => s.trim()))
    .filter(Boolean);
  const canonicals = findAll(all, (e) => e.name === 'link' && (attr(e, 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'))
    .map((e) => (attr(e, 'href') ?? '').trim())
    .filter(Boolean);

  const bodyEl = findAll(all, (e) => e.name === 'body')[0];
  const body: AnyNode[] = bodyEl ? [bodyEl] : all.filter((n) => !(isTag(n) && n.name === 'head'));
  const bodyText = normText(body.map((n) => textOf(n)).join(' '));
  const bodyElements = body.filter(isTag);

  const h1El = findAll(bodyElements, (e) => e.name === 'h1')[0];
  const subheadings = findAll(bodyElements, (e) => e.name === 'h2' || e.name === 'h3').map(textOf).filter(Boolean);
  const allHeadings = findAll(bodyElements, (e) => /^h[1-6]$/.test(e.name)).map(textOf);

  let firstParagraph: string | null = null;
  let wordsBefore = 0;
  {
    let started = !h1El;
    let done = false;
    const skip = new Set(['nav', 'header', 'footer', 'aside', 'form', 'button']);
    const visit = (n: AnyNode) => {
      if (done) return;
      if (isText(n)) {
        if (started) wordsBefore += countWords(n.data);
        return;
      }
      if (!isTag(n) || HIDDEN.has(n.name)) return;
      if (n === h1El) {
        started = true;
        return;
      }
      if (started && skip.has(n.name)) return;
      if (started && n.name === 'h2') {
        done = true;
        return;
      }
      if (started && n.name === 'p') {
        const t = textOf(n);
        if (countWords(t) >= 8 && !/^(by|updated|last updated|published|posted|written by)\b/i.test(t)) {
          firstParagraph = t;
          done = true;
          return;
        }
        wordsBefore += countWords(t);
        return;
      }
      for (const c of n.children) visit(c);
    };
    body.forEach(visit);
    if (!firstParagraph) wordsBefore = 0;
  }

  const jsonLd: JsonLdBlock[] = [];
  const jsonLdItems: Record<string, unknown>[] = [];
  findAll(all, (e) => e.name === 'script' && (attr(e, 'type') ?? '').toLowerCase().trim() === 'application/ld+json').forEach((el, i) => {
    const raw = el.children.map((c) => (isText(c) ? c.data : '')).join('').trim();
    try {
      const data: unknown = JSON.parse(raw);
      jsonLd.push({ index: i + 1, data });
      flattenJsonLd(data, jsonLdItems);
    } catch (err) {
      jsonLd.push({ index: i + 1, error: err instanceof Error ? err.message : 'invalid JSON' });
    }
  });

  const emptyRootEl = findAll(bodyElements, (e) => APP_ROOT_IDS.has(attr(e, 'id') ?? '') && countWords(textOf(e)) < 5)[0];
  const updated = findVisibleUpdated(bodyElements, bodyText);

  return {
    title: titleEl ? normText(textOfRaw(titleEl)) || null : null,
    metaDescription: metaDescription ? normText(attr(metaDescription, 'content') ?? '') || null : null,
    robotsMeta,
    canonicals,
    h1: h1El ? textOf(h1El) || null : null,
    subheadings,
    bodyText,
    wordCount: countWords(bodyText),
    firstParagraph,
    wordsBeforeFirstParagraph: wordsBefore,
    hasArticleElement: findAll(bodyElements, (e) => e.name === 'article').length > 0,
    jsonLd,
    jsonLdItems,
    emptyAppRoot: emptyRootEl ? `${emptyRootEl.name}#${attr(emptyRootEl, 'id')}` : null,
    visibleUpdated: updated?.text ?? null,
    visibleUpdatedDate: updated?.date ?? null,
    hasFaqSection:
      allHeadings.some((h) => /\bfaqs?\b|frequently asked/i.test(h)) ||
      findAll(bodyElements, (e) => e.name === 'summary').filter((e) => /\?\s*$/.test(textOf(e))).length >= FAQ_MIN_QUESTIONS,
  };
}

function textOfRaw(el: Element): string {
  return el.children.map((c) => (isText(c) ? c.data : '')).join('');
}
