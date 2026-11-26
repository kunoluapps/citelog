// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/** FIX-P1 findings turned into checks: symlinks in folder mode, gzip bombs, redirects, non-HTML and 4xx pages. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { PoliteFetcher } from '../../src/fetch/index.js';
import { listFolderPages, readFolderFile } from '../../src/fetch/folder.js';
import { decodeXml, parseSitemap, sitemapText } from '../../src/fetch/site.js';
import type { FetchResult } from '../../src/fetch/polite.js';
import { checkTarget, metaRefreshTarget } from '../../src/readiness/index.js';
import { fakeFetch, html, text, urlset, xml } from './fake-fetch.js';

const GOOD = readFileSync(new URL('../fixtures/pages/good-article.html', import.meta.url), 'utf8');
const O = 'https://example.com';
const fast = { delayMs: 0, timeoutMs: 2000 };

describe('folder mode never follows symbolic links (H2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'geo-links-'));
  const outside = mkdtempSync(join(tmpdir(), 'geo-outside-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('skips linked files and folders, including a loop back to the root', async () => {
    writeFileSync(join(outside, 'secret.html'), '<html><body>secret</body></html>');
    writeFileSync(join(outside, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
    mkdirSync(join(root, 'blog'));
    writeFileSync(join(root, 'index.html'), GOOD);
    writeFileSync(join(root, 'blog', 'post.html'), GOOD);
    symlinkSync(join(outside, 'secret.html'), join(root, 'leak.html'));
    symlinkSync(outside, join(root, 'outside'));
    symlinkSync(root, join(root, 'blog', 'loop'));
    symlinkSync(join(outside, 'robots.txt'), join(root, 'robots.txt'));
    expect(listFolderPages(root).map((p) => p.path)).toEqual(['/', '/blog/post']);
    expect(readFolderFile(root, 'robots.txt')).toBeNull();
    const r = await checkTarget(root, { maxPages: 50, fetch: fakeFetch({}).fetch });
    expect(r.pages.map((p) => p.url)).toEqual(['/', '/blog/post']);
    expect(r.blockedBots).toEqual([]);
  });
});

describe('sitemaps (M4, L)', () => {
  const asResult = (bytes: Uint8Array): FetchResult => ({ url: O, finalUrl: O, status: 200, headers: {}, bytes, text: '', truncated: false });

  it('stops unpacking a gzip sitemap past the cap (gzip bomb)', () => {
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x61));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(sitemapText(asResult(bomb), 1024 * 1024)).toBe('');
    const ok = gzipSync(urlset([`${O}/a`]));
    expect(parseSitemap(sitemapText(asResult(ok))).locs).toEqual([`${O}/a`]);
  });

  it('leaves out-of-range numeric entities as written instead of throwing', () => {
    expect(decodeXml('a&#99999999999;b&#x110000;c&#65;')).toBe('a&#99999999999;b&#x110000;cA');
  });

  it('counts sitemap entries on another host and says so on the report', async () => {
    const f = fakeFetch({
      [`${O}/sitemap.xml`]: xml(urlset([`${O}/a`, 'https://cdn.other.example/b', 'https://other.example/c'])),
      [`${O}/a`]: html(GOOD),
    });
    const r = await checkTarget(`${O}/sitemap.xml`, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.pages.map((p) => p.url)).toEqual([`${O}/a`]);
    expect(r.skippedOffSite).toBe(2);
  });
});

describe('redirects stay on the site (M5)', () => {
  it('reports an off-site redirect instead of following it, without retrying', async () => {
    const f = fakeFetch({ [`${O}/go`]: { status: 302, headers: { location: 'https://evil.example/x' } } });
    const r = await checkTarget(`${O}/go`, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.pages[0]?.error).toBe(`We couldn't load ${O}/go: redirects to evil.example`);
    expect(r.pages[0]?.score).toBeNull();
    expect(f.calls.filter((c) => c.url === `${O}/go`)).toHaveLength(1);
    expect(f.calls.some((c) => c.url.startsWith('https://evil.example'))).toBe(false);
  });

  it('refuses a public page bouncing to a private address or another scheme', async () => {
    const f = fakeFetch({
      [`${O}/a`]: { status: 301, headers: { location: 'http://127.0.0.1:8080/admin' } },
      [`${O}/b`]: { status: 301, headers: { location: 'file:///etc/passwd' } },
    });
    const fetcher = new PoliteFetcher({ fetch: f.fetch, delayMs: 0 });
    expect((await fetcher.get(`${O}/a`)).error).toBe('redirects to 127.0.0.1:8080');
    expect((await fetcher.get(`${O}/b`)).error).toBe('redirects to a file: address');
    expect(f.calls.map((c) => c.url)).toEqual([`${O}/a`, `${O}/b`]);
  });

  it('follows http → https and apex → www on the same site, and lets a local target redirect locally', async () => {
    const f = fakeFetch({
      'http://example.com/a': { status: 301, headers: { location: 'https://www.example.com/a' } },
      'https://www.example.com/a': html('<p>ok</p>'),
      'http://localhost:3000/': { status: 302, headers: { location: '/home' } },
      'http://localhost:3000/home': html('<p>ok</p>'),
    });
    const fetcher = new PoliteFetcher({ fetch: f.fetch, delayMs: 0 });
    expect((await fetcher.get('http://example.com/a')).status).toBe(200);
    expect((await fetcher.get('http://localhost:3000/')).status).toBe(200);
  });

  it('treats an off-site robots.txt redirect as "no robots.txt" (RFC 9309 unavailable), not disallow-all', async () => {
    const url = `${O}/learn/roth-ira`;
    const f = fakeFetch({ [`${O}/robots.txt`]: { status: 301, headers: { location: 'https://cdn.example.net/robots.txt' } }, [url]: html(GOOD) });
    const r = await checkTarget(url, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.pages[0]?.checks.find((c) => c.id === 'robots_ai')?.result).toBe('pass');
    expect(r.blockedBots).toEqual([]);
  });
});

describe('pages that are not scored (M6, M7)', () => {
  it('skips a PDF in the sitemap with no score', async () => {
    const pdf = `${O}/guide.pdf`;
    const f = fakeFetch({ [`${O}/sitemap.xml`]: xml(urlset([`${O}/a`, pdf])), [`${O}/a`]: html(GOOD), [pdf]: { body: '%PDF-1.7', headers: { 'content-type': 'application/pdf' } } });
    const r = await checkTarget(`${O}/sitemap.xml`, { maxPages: 50, fetch: f.fetch, ...fast });
    const p = r.pages.find((x) => x.url === pdf);
    expect(p?.score).toBeNull();
    expect(p?.error).toBe('Not an HTML page (application/pdf), so it has no score.');
    expect(r.score).toBe(r.pages[0]?.score);
  });

  it("reports a 404 as couldn't load, with no score", async () => {
    const f = fakeFetch({ [`${O}/gone`]: { status: 404, body: 'nope', headers: { 'content-type': 'text/html' } } });
    const r = await checkTarget(`${O}/gone`, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.pages[0]?.error).toBe(`We couldn't load ${O}/gone: HTTP 404`);
    expect(r.pages[0]?.score).toBeNull();
    expect(r.score).toBeNull();
  });
});

describe('targets', () => {
  it('checks a bare host over https', async () => {
    const f = fakeFetch({ [`${O}/`]: html(GOOD), [`${O}/robots.txt`]: text('User-agent: *\nAllow: /\n') });
    const r = await checkTarget('example.com', { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.pages.map((p) => p.url)).toEqual([`${O}/`]);
    expect(f.calls[0]?.url.startsWith('https://example.com/')).toBe(true);
  });
});

describe('meta refresh redirect pages (site review)', () => {
  const refresh = (to: string) => `<!doctype html><html><head><meta http-equiv="refresh" content="0; url=${to}"><title>Moved</title></head><body><a href="${to}">Moved here</a></body></html>`;

  it('follows a same-site meta refresh like an HTTP redirect and scores the page it lands on', async () => {
    const f = fakeFetch({ [`${O}/old`]: html(refresh('/learn/new')), [`${O}/learn/new`]: html(GOOD) });
    const r = await checkTarget(`${O}/old`, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.pages[0]!.url).toBe(`${O}/old`);
    expect(r.pages[0]!.score).not.toBeNull();
    expect(r.pages[0]!.error).toBeUndefined();
    expect(f.calls.map((c) => c.url)).toContain(`${O}/learn/new`);
  });

  it('lists an off-site meta refresh as a redirect page, not scored and not failing', async () => {
    const f = fakeFetch({ [`${O}/go`]: html(refresh('https://other.example/x')) });
    const r = await checkTarget(`${O}/go`, { maxPages: 50, fetch: f.fetch, ...fast });
    expect(r.pages[0]).toMatchObject({ score: null, band: 'no_score', checks: [], error: 'Redirect page, not scored: redirects to other.example.' });
    expect(f.calls.map((c) => c.url)).not.toContain('https://other.example/x');
  });

  it('leaves a real page with a refresh tag to the checks', () => {
    expect(metaRefreshTarget(GOOD.replace('<head>', '<head><meta http-equiv="refresh" content="300">'), O)).toBeNull();
  });
});
