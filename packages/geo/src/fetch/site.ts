// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { gunzipSync } from 'node:zlib';
import { parseRobots } from '../bots/robots.js';
import { isHtmlBody, type FetchResult, type PoliteFetcher } from './polite.js';

export interface RobotsFile {
  /** Body to evaluate: the file, null when there is none (4xx), or a disallow-all stand-in when it couldn't be read. */
  body: string | null;
  /** HTTP status, null when unreachable. */
  status: number | null;
  /** True when the file couldn't be read (5xx or unreachable) and RFC 9309 §2.3.1.4 says to assume complete disallow. */
  unreachable: boolean;
  /** Why it couldn't be read ("HTTP 503", "timeout after 10 s"). */
  reason?: string;
  /** sitemap: lines. */
  sitemaps: string[];
}

export const DISALLOW_ALL = 'User-agent: *\nDisallow: /\n';

export function robotsFromResult(r: FetchResult): RobotsFile {
  if (r.status !== null && r.status >= 200 && r.status < 300) {
    if (isHtmlBody(r.text, r.headers)) return { body: null, status: r.status, unreachable: false, sitemaps: [] };
    return { body: r.text, status: r.status, unreachable: false, sitemaps: parseRobots(r.text).sitemaps };
  }
  if (r.status !== null && r.status >= 400 && r.status < 500) return { body: null, status: r.status, unreachable: false, sitemaps: [] };
  // RFC 9309 §2.3.1.2: a robots.txt we can't follow redirects for is "unavailable", like a 4xx (FIX-P1 M5: off-site).
  if (r.status !== null && r.status >= 300 && r.status < 400) return { body: null, status: r.status, unreachable: false, reason: r.error, sitemaps: [] };
  const reason = r.error ?? `HTTP ${r.status}`;
  return { body: DISALLOW_ALL, status: r.status, unreachable: true, reason, sitemaps: [] };
}

/** Per-origin robots.txt and llms.txt, fetched once each. */
export class SiteResources {
  private readonly robotsCache = new Map<string, Promise<RobotsFile>>();
  private readonly llmsCache = new Map<string, Promise<boolean | null>>();

  constructor(private readonly fetcher: PoliteFetcher) {}

  robots(origin: string): Promise<RobotsFile> {
    let p = this.robotsCache.get(origin);
    if (!p) {
      p = this.fetcher.get(`${origin}/robots.txt`, 'text/plain,*/*;q=0.5').then(robotsFromResult);
      this.robotsCache.set(origin, p);
    }
    return p;
  }

  /** true = /llms.txt exists (2xx, not an HTML fallback page); false = 4xx; null = couldn't tell. */
  llms(origin: string): Promise<boolean | null> {
    let p = this.llmsCache.get(origin);
    if (!p) {
      p = this.fetcher.get(`${origin}/llms.txt`, 'text/plain,text/markdown,*/*;q=0.5').then((r) => {
        if (r.status === null || r.status >= 500) return null;
        if (r.status >= 200 && r.status < 300) return r.text.trim().length > 0 && !isHtmlBody(r.text, r.headers);
        return false;
      });
      this.llmsCache.set(origin, p);
    }
    return p;
  }
}

/* ---------- sitemaps ---------- */

const MAX_SITEMAP_FILES = 50;
const MAX_SITEMAP_DEPTH = 3;

export interface SitemapResult {
  /** Page URLs in sitemap order, deduplicated, limited to the site's host. */
  urls: string[];
  /** Set when the first sitemap couldn't be read: "HTTP 503", "timeout after 10 s", "not a sitemap". */
  error?: string;
  /** Sitemap and page URLs on another host, left out (we only check the site asked for). */
  skippedOffSite: number;
}

/** A numeric character reference, or the reference as written when it names no Unicode code point (&#99999999;). */
function codePoint(n: number, raw: string): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw;
}

export function decodeXml(s: string): string {
  return s
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n: string) => codePoint(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, n: string) => codePoint(parseInt(n, 16), m))
    .replace(/&amp;/g, '&')
    .trim();
}

/** Largest unpacked .xml.gz sitemap we read (the sitemaps.org limit is 50 MB uncompressed). Stops gzip bombs. */
export const MAX_SITEMAP_UNZIPPED_BYTES = 50 * 1024 * 1024;

export function sitemapText(r: FetchResult, maxBytes = MAX_SITEMAP_UNZIPPED_BYTES): string {
  const b = r.bytes;
  if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) {
    try {
      return new TextDecoder('utf-8').decode(gunzipSync(b, { maxOutputLength: maxBytes }));
    } catch {
      return '';
    }
  }
  return r.text;
}

export function parseSitemap(xml: string): { kind: 'index' | 'urlset' | 'unknown'; locs: string[] } {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? 'index' : /<urlset[\s>]/i.test(xml) ? 'urlset' : 'unknown';
  const locs = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => decodeXml(m[1] ?? '')).filter((u) => /^https?:\/\//i.test(u));
  return { kind, locs };
}

export function sameSite(a: string, b: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');
  try {
    return strip(new URL(a).hostname) === strip(new URL(b).hostname);
  } catch {
    return false;
  }
}

/** Read one or more sitemaps, following sitemap indexes, and return the site's page URLs. */
export async function readSitemaps(fetcher: PoliteFetcher, sitemapUrls: string[], siteUrl: string): Promise<SitemapResult> {
  const urls: string[] = [];
  const seenUrls = new Set<string>();
  const seenMaps = new Set<string>();
  let skippedOffSite = sitemapUrls.filter((u) => !sameSite(u, siteUrl)).length;
  let queue = sitemapUrls.filter((u) => sameSite(u, siteUrl)).map((u) => ({ url: u, depth: 0 }));
  let firstError: string | undefined;
  let anyRead = false;
  let files = 0;
  while (queue.length && files < MAX_SITEMAP_FILES) {
    const next: typeof queue = [];
    const batch = queue.filter((q) => !seenMaps.has(q.url)).slice(0, MAX_SITEMAP_FILES - files);
    batch.forEach((q) => seenMaps.add(q.url));
    files += batch.length;
    const results = await Promise.all(batch.map((q) => fetcher.get(q.url, 'application/xml,text/xml,*/*;q=0.5')));
    results.forEach((r, i) => {
      const item = batch[i] as { url: string; depth: number };
      if (r.status === null || r.status < 200 || r.status >= 300) {
        firstError ??= r.error ?? `HTTP ${r.status}`;
        return;
      }
      const parsed = parseSitemap(sitemapText(r));
      if (parsed.kind === 'unknown') {
        firstError ??= 'not a sitemap';
        return;
      }
      anyRead = true;
      if (parsed.kind === 'index') {
        if (item.depth < MAX_SITEMAP_DEPTH) {
          for (const loc of parsed.locs) {
            if (sameSite(loc, siteUrl)) next.push({ url: loc, depth: item.depth + 1 });
            else skippedOffSite++;
          }
        }
        return;
      }
      for (const loc of parsed.locs) {
        if (!sameSite(loc, siteUrl)) {
          skippedOffSite++;
          continue;
        }
        if (seenUrls.has(loc)) continue;
        seenUrls.add(loc);
        urls.push(loc);
      }
    });
    queue = next;
  }
  return anyRead ? { urls, skippedOffSite } : { urls, skippedOffSite, error: firstError ?? 'no sitemap' };
}
