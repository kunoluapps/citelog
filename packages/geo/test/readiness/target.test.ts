// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { GEO_TOOL_USER_AGENT } from '@morningdesk/core';
import { afterAll, describe, expect, it } from 'vitest';
import { PoliteFetcher } from '../../src/fetch/index.js';
import { fileToUrlPath } from '../../src/fetch/folder.js';
import { checkTarget } from '../../src/readiness/index.js';
import { fakeFetch, html, sitemapIndex, text, urlset, xml } from './fake-fetch.js';

const GOOD = readFileSync(new URL('../fixtures/pages/good-article.html', import.meta.url), 'utf8');
const SPA = readFileSync(new URL('../fixtures/pages/spa-shell.html', import.meta.url), 'utf8');
const O = 'https://example.com';
const fast = { delayMs: 0, timeoutMs: 2000 };

function pages(n: number, prefix = '/p/'): string[] {
  return Array.from({ length: n }, (_, i) => `${O}${prefix}${i + 1}`);
}

function routesFor(urls: string[], body = GOOD) {
  return Object.fromEntries(urls.map((u) => [u, html(body)]));
}

describe('checkTarget: site URL with sitemap (AC 1)', () => {
  it('reads up to 50 sitemap pages, says it truncated, and scores the site', async () => {
    const urls = pages(60);
    const f = fakeFetch({ [`${O}/sitemap.xml`]: xml(urlset(urls)), ...routesFor(urls) });
    const r = await checkTarget(`${O}/`, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.kind).toBe('sitemap');
    expect(r.pages).toHaveLength(50);
    expect(r.truncated).toEqual({ limit: 50, total: 60 });
    expect(r.pages[0]?.url).toBe(`${O}/p/1`);
    expect(r.score).toBeGreaterThan(0);
    expect(r.band).toBe('ready');
    expect(f.calls.some((c) => c.url === `${O}/p/51`)).toBe(false);
  });

  it('discovers sitemaps from robots.txt and follows a sitemap index (gzip child too)', async () => {
    const a = pages(3, '/a/');
    const b = pages(2, '/b/');
    const f = fakeFetch({
      [`${O}/robots.txt`]: text(`User-agent: *\nAllow: /\nSitemap: ${O}/sitemap_index.xml\n`),
      [`${O}/sitemap_index.xml`]: xml(sitemapIndex([`${O}/sitemap-a.xml`, `${O}/sitemap-b.xml.gz`, 'https://other.example/sitemap.xml'])),
      [`${O}/sitemap-a.xml`]: xml(urlset([...a, 'https://other.example/x'])),
      [`${O}/sitemap-b.xml.gz`]: { body: gzipSync(urlset([...b, a[0] as string])), headers: { 'content-type': 'application/gzip' } },
      ...routesFor([...a, ...b]),
    });
    const r = await checkTarget(O, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.kind).toBe('sitemap');
    expect(r.pages.map((p) => p.url).sort()).toEqual([...a, ...b].sort());
    expect(r.truncated).toBeUndefined();
    expect(f.calls.every((c) => c.url.startsWith(O))).toBe(true);
    expect(f.calls.filter((c) => c.url === `${O}/robots.txt`)).toHaveLength(1);
  });

  it('checks the URL itself when there is no sitemap', async () => {
    const f = fakeFetch({ [`${O}/`]: html(GOOD) });
    const r = await checkTarget(`${O}/`, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.kind).toBe('url');
    expect(r.pages.map((p) => p.url)).toEqual([`${O}/`]);
  });

  it('checks a sitemap URL target and truncates at maxPages', async () => {
    const urls = pages(5);
    const f = fakeFetch({ [`${O}/sitemap.xml`]: xml(urlset(urls)), ...routesFor(urls) });
    const r = await checkTarget(`${O}/sitemap.xml`, { maxPages: 2, fetch: f.fetch, ...fast });
    expect(r.kind).toBe('sitemap');
    expect(r.pages).toHaveLength(2);
    expect(r.truncated).toEqual({ limit: 2, total: 5 });
  });

  it('reports an unreadable sitemap target as a page error with no score', async () => {
    const f = fakeFetch({ [`${O}/sitemap.xml`]: { status: 503 } });
    const r = await checkTarget(`${O}/sitemap.xml`, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.score).toBeNull();
    expect(r.band).toBe('no_score');
    expect(r.pages[0]?.error).toBe(`We couldn't load ${O}/sitemap.xml: HTTP 503`);
  });
});

describe('checkTarget: robots.txt and AI crawlers (AC 3)', () => {
  it('shows a blocked main crawler as a failed check naming the bot, not an error', async () => {
    const url = `${O}/learn/roth-ira`;
    const f = fakeFetch({ [`${O}/robots.txt`]: text('User-agent: ClaudeBot\nUser-agent: Claude-SearchBot\nDisallow: /\n'), [url]: html(GOOD) });
    const r = await checkTarget(url, { maxPages: 50, fetch: f.fetch, ...fast });
    const p = r.pages[0];
    expect(p?.error).toBeUndefined();
    const robots = p?.checks.find((c) => c.id === 'robots_ai');
    expect(robots?.result).toBe('fail');
    expect(robots?.detail).toContain('robots.txt blocks Claude-SearchBot');
    expect(robots?.detail).toContain('Training-only crawlers blocked: ClaudeBot');
    expect(r.blockedBots.sort()).toEqual(['claude-searchbot', 'claudebot']);
  });

  it('treats a robots.txt 5xx as disallow-all and says why', async () => {
    const url = `${O}/learn/roth-ira`;
    const f = fakeFetch({ [`${O}/robots.txt`]: { status: 503 }, [url]: html(GOOD) });
    const r = await checkTarget(url, { maxPages: 50, fetch: f.fetch, ...fast });
    const robots = r.pages[0]?.checks.find((c) => c.id === 'robots_ai');
    expect(robots?.result).toBe('fail');
    expect(robots?.detail).toBe("robots.txt couldn't be read (HTTP 503), so crawlers treat the whole site as blocked (RFC 9309).");
    expect(r.blockedBots).toContain('oai-searchbot');
  });

  it('ignores an HTML page served at /robots.txt and /llms.txt (SPA fallback)', async () => {
    const url = `${O}/learn/roth-ira`;
    const f = fakeFetch({ [`${O}/robots.txt`]: html(SPA), [`${O}/llms.txt`]: html(SPA), [url]: html(GOOD) });
    const r = await checkTarget(url, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.pages[0]?.checks.find((c) => c.id === 'robots_ai')?.result).toBe('pass');
    expect(r.pages[0]?.checks.find((c) => c.id === 'llms_txt')?.detail).toMatch(/^No example.com\/llms.txt/);
  });
});

describe('checkTarget: JS-only page (AC 4)', () => {
  it('fails "content present without JavaScript"', async () => {
    const url = `${O}/pricing`;
    const f = fakeFetch({ [url]: html(SPA) });
    const r = await checkTarget(url, { maxPages: 50, fetch: f.fetch, ...fast });
    const c = r.pages[0]?.checks.find((x) => x.id === 'no_js_content');
    expect(c?.result).toBe('fail');
    expect(c?.label).toBe('Content present without JavaScript');
    expect(r.pages[0]?.topFix).toContain('Render the main text on the server');
  });
});

describe('checkTarget: unreachable pages', () => {
  it('says which URL timed out', async () => {
    const url = `${O}/slow`;
    const f = fakeFetch({ [url]: () => new Promise<Response>(() => undefined) });
    const r = await checkTarget(url, { maxPages: 50, fetch: f.fetch, delayMs: 0, timeoutMs: 30 });
    expect(r.pages[0]?.error).toBe(`We couldn't load ${url}: timeout after 0.03 s`);
    expect(r.pages[0]?.score).toBeNull();
    expect(r.score).toBeNull();
    expect(f.calls.filter((c) => c.url === url)).toHaveLength(2);
  });

  it('says which URL returned 503, after one retry', async () => {
    const url = `${O}/down`;
    const f = fakeFetch({ [url]: { status: 503 } });
    const r = await checkTarget(url, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.pages[0]?.error).toBe(`We couldn't load ${url}: HTTP 503`);
    expect(r.pages[0]?.status).toBe(503);
    expect(f.calls.filter((c) => c.url === url)).toHaveLength(2);
  });

  it('scores the reachable pages and leaves the unreachable one out of the mean', async () => {
    const urls = pages(2);
    const f = fakeFetch({ [`${O}/sitemap.xml`]: xml(urlset(urls)), [urls[0] as string]: html(GOOD), [urls[1] as string]: { status: 500 } });
    const r = await checkTarget(`${O}/sitemap.xml`, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.pages[1]?.error).toContain('HTTP 500');
    expect(r.score).toBe(r.pages[0]?.score);
  });
});

describe('checkTarget: folder mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-folder-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('walks built HTML, maps files to URL paths, and reads robots.txt and llms.txt from the folder', async () => {
    mkdirSync(join(dir, 'learn', 'etf'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), GOOD);
    writeFileSync(join(dir, 'pricing.html'), SPA);
    writeFileSync(join(dir, 'learn', 'etf', 'index.html'), GOOD);
    writeFileSync(join(dir, 'learn', 'roth-ira.html'), GOOD);
    writeFileSync(join(dir, '404.html'), SPA);
    writeFileSync(join(dir, 'node_modules', 'x', 'a.html'), SPA);
    writeFileSync(join(dir, 'robots.txt'), 'User-agent: GPTBot\nDisallow: /\n');
    writeFileSync(join(dir, 'llms.txt'), '# Example\n');
    const noNetwork = fakeFetch({});
    const r = await checkTarget(dir, { maxPages: 3, fetch: noNetwork.fetch });
    expect(r.kind).toBe('folder');
    expect(r.pages.map((p) => p.url)).toEqual(['/', '/learn/etf/', '/learn/roth-ira']);
    expect(r.truncated).toEqual({ limit: 3, total: 4 });
    expect(r.blockedBots).toEqual(['gptbot']);
    expect(r.pages[0]?.checks.find((c) => c.id === 'llms_txt')?.detail).toMatch(/^Found at llms.txt in the folder/);
    expect(noNetwork.calls).toHaveLength(0);
  });

  it('maps file paths to clean URLs', () => {
    expect(fileToUrlPath('index.html')).toBe('/');
    expect(fileToUrlPath(join('blog', 'index.html'))).toBe('/blog/');
    expect(fileToUrlPath(join('blog', 'post.html'))).toBe('/blog/post');
  });

  it('rejects a target that is neither a URL nor a folder', async () => {
    await expect(checkTarget(join(dir, 'missing'), { maxPages: 5, fetch: fakeFetch({}).fetch })).rejects.toThrow(/isn't a URL/);
  });
});

describe('PoliteFetcher', () => {
  it('sends the tool User-Agent and caps requests per host', async () => {
    const urls = pages(6);
    const f = fakeFetch(routesFor(urls), 20);
    const fetcher = new PoliteFetcher({ fetch: f.fetch, delayMs: 0 });
    await Promise.all(urls.map((u) => fetcher.get(u)));
    expect(f.maxInFlight()).toBe(2);
    expect(f.calls[0]?.headers['user-agent']).toBe(GEO_TOOL_USER_AGENT);
  });

  it('keeps a minimum gap between request starts to one host', async () => {
    const urls = pages(4);
    const f = fakeFetch(routesFor(urls));
    const fetcher = new PoliteFetcher({ fetch: f.fetch, delayMs: 40, concurrency: 4 });
    await Promise.all(urls.map((u) => fetcher.get(u)));
    const starts = f.calls.map((c) => c.at).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(35);
  });

  it('follows redirects up to five hops and reports the final URL', async () => {
    const f = fakeFetch({
      [`${O}/a`]: { status: 301, headers: { location: '/b' } },
      [`${O}/b`]: { status: 302, headers: { location: `${O}/c` } },
      [`${O}/c`]: html('<p>done</p>'),
    });
    const r = await new PoliteFetcher({ fetch: f.fetch, delayMs: 0 }).get(`${O}/a`);
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(`${O}/c`);
    const loop = fakeFetch({ [`${O}/loop`]: { status: 301, headers: { location: '/loop' } } });
    const l = await new PoliteFetcher({ fetch: loop.fetch, delayMs: 0 }).get(`${O}/loop`);
    expect(l.status).toBeNull();
    expect(l.error).toBe('more than 5 redirects');
  });

  it('caps the body size', async () => {
    const f = fakeFetch({ [`${O}/big`]: text('x'.repeat(5000)) });
    const r = await new PoliteFetcher({ fetch: f.fetch, delayMs: 0, maxBytes: 1000 }).get(`${O}/big`);
    expect(r.bytes.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it('reports network errors without throwing', async () => {
    const f = fakeFetch({ [`${O}/x`]: () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })) });
    const r = await new PoliteFetcher({ fetch: f.fetch, delayMs: 0 }).get(`${O}/x`);
    expect(r.status).toBeNull();
    expect(r.error).toBe('network error (ENOTFOUND)');
  });
});

describe('checkTarget: onProgress', () => {
  it('reports the page total first, then each finished page, and survives a throwing listener', async () => {
    const urls = pages(4);
    const f = fakeFetch({ [`${O}/sitemap.xml`]: xml(urlset(urls)), ...routesFor(urls) });
    const seen: { total: number; done: number; current: string | null }[] = [];
    const r = await checkTarget(`${O}/sitemap.xml`, {
      maxPages: 3,
      fetch: f.fetch,
      ...fast,
      onProgress: (p) => {
        seen.push(p);
        if (p.done === 2) throw new Error('listener broke');
      },
    });
    expect(r.pages).toHaveLength(3);
    expect(seen[0]).toEqual({ total: 3, done: 0, current: null });
    expect(seen.map((p) => p.done)).toEqual([0, 1, 2, 3]);
    expect(seen.every((p) => p.total === 3)).toBe(true);
    expect(seen.slice(1).every((p) => p.current !== null && urls.includes(p.current))).toBe(true);
  });

  it('works without a listener (backwards compatible)', async () => {
    const f = fakeFetch({ [`${O}/`]: html(GOOD) });
    const r = await checkTarget(`${O}/`, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.pages).toHaveLength(1);
  });
});
