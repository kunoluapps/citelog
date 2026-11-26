// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { MEASURES } from '@morningdesk/core';
import { scrubKeys } from './http.js';

const HOSTNAME = /^(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;
const MARKDOWN_LINK = /\[([^\]\n]*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/g;
const BARE_URL = /\b(?:https?:\/\/|www\.)[^\s<>()[\]]+/gi;
const PAREN_CHIP = /\(\s*([^()\s]+)\s*\)/g;

/**
 * The answer as a reader sees its words, without links: Markdown link targets go (a label that is a domain or URL goes
 * with them, so "([example.com](https://example.com))" leaves nothing), bare URLs go, and "(example.com)" chips go.
 * A domain written in a sentence stays: that is naming the site, not linking it.
 */
export function stripLinks(text: string): string {
  return text
    .replace(MARKDOWN_LINK, (_, label: string) => (HOSTNAME.test(label.trim()) || /^\s*https?:\/\//i.test(label) ? '' : label))
    .replace(BARE_URL, '')
    .replace(PAREN_CHIP, (all, inner: string) => (HOSTNAME.test(inner) ? '' : all))
    .replace(/\(\s*\)/g, '');
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole word, case-insensitive, Unicode-aware ("Bywell's" matches, "Bywellness" doesn't). */
export function termPattern(terms: string[]): RegExp | undefined {
  const parts = terms
    .map((t) => t.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  return parts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'iu') : undefined;
}

export interface MentionOutcome {
  mentioned: boolean;
  /** At most MEASURES.mentionSnippetMaxChars around the first match, keys scrubbed; set when mentioned. */
  mentionSnippet?: string;
}

/** Mentioned = a brand term appears as a whole word once links are stripped (SCOPE decision 1, REVIEW-engine 2). */
export function mentionOf(text: string, terms: string[], apiKey: string): MentionOutcome {
  const pattern = termPattern(terms);
  if (!pattern) return { mentioned: false };
  const flat = scrubKeys(stripLinks(text), apiKey).replace(/\s+/g, ' ').trim();
  const m = pattern.exec(flat);
  if (!m) return { mentioned: false };
  return { mentioned: true, mentionSnippet: snippetAround(flat, m.index, m[0].length, MEASURES.mentionSnippetMaxChars) };
}

/** A window of at most `max` characters around [start, start+len), cut at spaces, with "…" where text was cut. */
export function snippetAround(text: string, start: number, len: number, max: number): string {
  if (text.length <= max) return text;
  const room = max - 2;
  let from = Math.max(0, start - Math.floor((room - len) / 2));
  let to = Math.min(text.length, from + room);
  from = Math.max(0, to - room);
  if (from > 0) {
    const space = text.indexOf(' ', from);
    if (space !== -1 && space < start) from = space + 1;
  }
  if (to < text.length) {
    const space = text.lastIndexOf(' ', to);
    if (space > start + len) to = space;
  }
  const out = `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
  return out.length <= max ? out : out.slice(0, max);
}
