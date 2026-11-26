// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { Citation, ConsideredSource, EngineId } from '../types.js';

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const REDIRECT_HOSTS = ['vertexaisearch.cloud.google.com'];

const bareHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

/** "https://www.Bywell.org/x" or "bywell.org" -> "bywell.org". */
export function siteDomain(site: string): string {
  const s = site.trim();
  try {
    return bareHost(new URL(s.includes('://') ? s : `https://${s}`).hostname);
  } catch {
    return bareHost(s);
  }
}

function httpUrl(u: string): URL | undefined {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

const isRedirect = (host: string) => REDIRECT_HOSTS.some((r) => host === r || host.endsWith(`.${r}`));

/**
 * The cited domain, without www. Gemini chunks link through a Google redirect, so the chunk title
 * (which Gemini fills with the source domain) is used instead; redirect URLs are never fetched (D16).
 */
export function citationHost(engine: EngineId, c: Citation): string | undefined {
  const url = httpUrl(c.url);
  const host = url ? bareHost(url.hostname) : undefined;
  if (engine === 'gemini' && (!host || isRedirect(host))) {
    const title = c.title ? bareHost(c.title) : '';
    return HOSTNAME.test(title) ? title : undefined;
  }
  return host;
}

/** Strips utm_* parameters and the fragment. */
export function cleanUrl(u: string): string {
  const url = httpUrl(u);
  if (!url) return u;
  for (const k of [...url.searchParams.keys()]) if (k.toLowerCase().startsWith('utm_')) url.searchParams.delete(k);
  url.hash = '';
  return url.toString();
}

export const onSite = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export interface CitedOutcome {
  cited: boolean;
  citedUrl?: string;
  others: string[];
}

/** Cited = any citation link on the site's domain or a subdomain (linked only, design default 2). */
export function scoreCitations(engine: EngineId, site: string, citations: Citation[]): CitedOutcome {
  const domain = siteDomain(site);
  let citedUrl: string | undefined;
  let cited = false;
  const others: string[] = [];
  for (const c of citations) {
    const host = citationHost(engine, c);
    if (!host) continue;
    if (onSite(host, domain)) {
      if (!cited) {
        cited = true;
        const url = httpUrl(c.url);
        if (url && !isRedirect(bareHost(url.hostname))) citedUrl = cleanUrl(c.url);
      }
    } else if (!others.includes(host)) {
      others.push(host);
    }
  }
  return citedUrl ? { cited, citedUrl, others } : { cited, others };
}

export interface ConsideredOutcome {
  considered: ConsideredSource[] | null;
  consideredOffsite: number | null;
}

/** Same page whatever the www., utm_* parameters or fragment. */
function pageKey(u: string): string {
  const url = httpUrl(cleanUrl(u));
  if (!url) return u;
  url.hostname = bareHost(url.hostname);
  return url.toString();
}

/**
 * Considered = the sources the engine retrieved ∪ the ones it cited (an engine can cite a page its sources list leaves
 * out). On-site rows are listed with a cited flag; off-site sources are only counted. `by: 'host'` (Gemini) keys every
 * source by its site, with no URL. Null sources = not collected: both fields null, never an empty list.
 */
export function scoreSources(engine: EngineId, site: string, sources: Citation[] | null, citations: Citation[], by: 'page' | 'host' = 'page'): ConsideredOutcome {
  if (sources === null) return { considered: null, consideredOffsite: null };
  const domain = siteDomain(site);
  const keyOf = (c: Citation, host: string) => (by === 'host' ? host : pageKey(c.url));
  const cited = new Set<string>();
  for (const c of citations) {
    const host = citationHost(engine, c);
    if (host) cited.add(keyOf(c, host));
  }
  const considered: ConsideredSource[] = [];
  const seen = new Set<string>();
  const offsite = new Set<string>();
  for (const c of [...sources, ...citations]) {
    const host = citationHost(engine, c);
    if (!host) continue;
    const key = keyOf(c, host);
    if (!onSite(host, domain)) {
      offsite.add(key);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const url = by === 'page' ? httpUrl(c.url) : undefined;
    considered.push({ ...(url && !isRedirect(bareHost(url.hostname)) ? { url: cleanUrl(c.url) } : {}), host, cited: cited.has(key) });
  }
  return { considered, consideredOffsite: offsite.size };
}
