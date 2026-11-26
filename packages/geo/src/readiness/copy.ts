// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { CheckId } from '../types.js';

/**
 * Check names and the one-line "why", as on the AI search Pages and CLI boards (CPages, CCli). `short` is the name in
 * tight places (the job summary's "Failed checks" column, the CLI's "Failed checks:" line), lower-case so it reads in a
 * list: "short answer; JSON-LD".
 */
export const CHECK_COPY: Readonly<Record<CheckId, { label: string; short: string; why: string }>> = {
  indexable: {
    label: 'Page indexable (200, no noindex)',
    short: 'indexable',
    why: "Engines leave out pages that don't load or ask not to be indexed.",
  },
  robots_ai: {
    label: 'robots.txt allows the main AI crawlers',
    short: 'AI crawlers blocked',
    why: 'AI answers can only cite pages their crawlers are allowed to read.',
  },
  canonical: {
    label: 'Canonical points to itself',
    short: 'canonical',
    why: 'A canonical tells engines which URL to cite when the same page has several addresses.',
  },
  title_meta: {
    label: 'Title and meta description',
    short: 'title and description',
    why: 'Engines use the title and description to understand the page and label it in answers.',
  },
  direct_answer: {
    label: 'A short direct answer near the top',
    short: 'short answer',
    why: 'Engines quote a plain answer they can lift whole.',
  },
  question_headings: {
    label: 'Question-style subheadings',
    short: 'question headings',
    why: 'Questions match how people ask AI.',
  },
  updated_date: {
    label: 'Visible "updated" date matches structured data',
    short: 'updated date',
    why: 'When the dates disagree, engines may treat the page as stale.',
  },
  json_ld: {
    label: 'Valid JSON-LD',
    short: 'JSON-LD',
    why: 'Structured data tells engines what the page is, who wrote it and when.',
  },
  no_js_content: {
    label: 'Content present without JavaScript',
    short: 'content without JavaScript',
    why: 'AI crawlers mostly read the HTML as sent and don\'t run JavaScript.',
  },
  llms_txt: {
    label: 'llms.txt present',
    short: 'llms.txt',
    why: 'Not scored: evidence that engines use it is thin.',
  },
};

export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
