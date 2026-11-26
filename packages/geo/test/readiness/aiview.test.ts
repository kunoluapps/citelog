// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_VIEW_USER_AGENT, toStoredAiView } from '@morningdesk/core';
import { aiView, aiViewRobots, aiViewVerdict, checkPage, fetchAsAiCrawler, isChallengePage, readAiView } from '../../src/index.js';
import { fakeFetch } from './fake-fetch.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/pages/${name}.html`, import.meta.url), 'utf8');
const LEWIS = fixture('lewis-spa-home');
const SSR = fixture('ssr-home');
const NOW = new Date('2026-11-19T14:14:00Z');
const ALLOW_ALL = 'User-agent: *\nAllow: /\n';
const OK_CRAWLER = { status: 200, headers: { 'content-type': 'text/html' }, html: '' };

describe('aiView', () => {
  it('a JS-only SPA (Lewis): 0 words, title, empty div#root, the no_js fix', () => {
    const s = aiView({ url: 'https://www.thelewisapp.com/', status: 200, html: LEWIS, robotsTxt: ALLOW_ALL, crawler: { ...OK_CRAWLER, html: LEWIS }, sitemapPages: 121, now: NOW });
    expect(s.result).toBe('js_only');
    expect(s.blockedBy).toBeNull();
    expect(s.words).toBe(0);
    expect(s.headline).toBeNull();
    expect(s.title).toBe('Lewis: AI Car Diagnostics | OBD2 Codes and Live Data');
    expect(s.description).toMatch(/^Lewis reads your car's trouble codes/);
    expect(s.emptyAppRoot).toBe('div#root');
    expect(s.faq).toEqual({ section: false, faqPage: false });
    expect(s.robots).toEqual({ found: true, mainBlocked: [], trainingBlocked: [], groundingBlocked: [] });
    expect(s.sitemapPages).toBe(121);
    expect(s.heading).toBe('This is what ChatGPT, Perplexity and Claude see on thelewisapp.com');
    expect(s.lead).toMatch(/^Your home page sends no text until JavaScript runs/);
    expect(s.fix).toBe('Render the main text on the server (SSR or a static build) so it is in the HTML.');
    expect(aiViewVerdict(s).word).toBe('FAIL');
  });

  it('agrees with the readiness no_js_content check on the same HTML (one engine)', () => {
    const report = checkPage({ url: 'https://www.thelewisapp.com/', status: 200, headers: {}, html: LEWIS, robotsTxt: ALLOW_ALL, llmsTxt: null });
    expect(report.checks.find((c) => c.id === 'no_js_content')?.result).toBe('fail');
    expect(report.checks.find((c) => c.id === 'no_js_content')?.fix).toBe(aiView({ url: 'https://www.thelewisapp.com/', status: 200, html: LEWIS, robotsTxt: ALLOW_ALL }).fix);
  });

  it('a full SSR page: words, headline, FAQ section with FAQPage data, nothing to fix', () => {
    const s = aiView({ url: 'https://ansa.chat/', status: 200, html: SSR, robotsTxt: ALLOW_ALL, crawler: OK_CRAWLER, now: NOW });
    expect(s.result).toBe('ok');
    expect(s.words).toBeGreaterThan(300);
    expect(s.headline).toBe('AI customer support for small businesses.');
    expect(s.faq).toEqual({ section: true, faqPage: true });
    expect(s.structuredData).toEqual(['FAQPage', 'Organization', 'WebSite']);
    expect(s.fix).toBeNull();
    expect(s.lead).toMatch(/^Good news/);
    expect(aiViewVerdict(s)).toEqual({ word: 'PASS', line: 'AI crawlers read the same text people do.' });
  });

  it('a robots.txt block on a main crawler: blocked, bot, rule and line named; GPTBot only a note', () => {
    const robots = ['User-agent: *', 'Allow: /', '', 'User-agent: GPTBot', 'Disallow: /', '', 'User-agent: OAI-SearchBot', 'Disallow: /', '', 'User-agent: PerplexityBot', 'Disallow: /'].join('\n');
    const s = aiView({ url: 'https://yoursite.com/', status: 200, html: SSR, robotsTxt: robots, crawler: OK_CRAWLER, now: NOW });
    expect(s.result).toBe('blocked');
    expect(s.blockedBy).toBe('robots');
    expect(s.robots.mainBlocked).toEqual([
      { botId: 'oai-searchbot', bot: 'OAI-SearchBot', agentLine: 'User-agent: OAI-SearchBot', rule: 'Disallow: /', line: 8 },
      { botId: 'perplexitybot', bot: 'PerplexityBot', agentLine: 'User-agent: PerplexityBot', rule: 'Disallow: /', line: 11 },
    ]);
    expect(s.robots.trainingBlocked).toEqual(['GPTBot']);
    expect(s.lead).toBe('Your page has text, but your robots.txt tells ChatGPT search and Perplexity to stay out. They can’t read it, so they can’t cite it.');
    expect(s.fix).toBe('Remove the Disallow for OAI-SearchBot and PerplexityBot in robots.txt. Keep GPTBot blocked if you don’t want training.');
  });

  it('an accordion of three or more questions is an FAQ section without an FAQ heading (Ansa)', () => {
    const q = (t: string) => `<details><summary>${t}</summary><p>Answer.</p></details>`;
    const html = `<html><body><h2>Fair questions. Straight answers.</h2>${q('What is Ansa?')}${q('Does it make things up?')}${q('Do I need a developer?')}</body></html>`;
    expect(aiView({ url: 'https://ansa.chat/', status: 200, html, robotsTxt: null }).faq.section).toBe(true);
    const two = `<html><body>${q('What is it?')}${q('Why?')}<details><summary>Details</summary></details></body></html>`;
    expect(aiView({ url: 'https://ansa.chat/', status: 200, html: two, robotsTxt: null }).faq.section).toBe(false);
  });

  it('blocking only GPTBot is a note, not a block', () => {
    const s = aiView({ url: 'https://yoursite.com/', status: 200, html: SSR, robotsTxt: 'User-agent: GPTBot\nDisallow: /\n', now: NOW });
    expect(s.result).toBe('ok');
    expect(s.robots.mainBlocked).toEqual([]);
    expect(s.robots.trainingBlocked).toEqual(['GPTBot']);
  });

  it('a firewall 403 on the AI-crawler request while people get 200: blocked by a firewall', () => {
    const s = aiView({ url: 'https://yoursite.com/', status: 200, html: SSR, robotsTxt: ALLOW_ALL, crawler: { status: 403, headers: {}, html: 'Forbidden' }, now: NOW });
    expect(s.result).toBe('blocked');
    expect(s.blockedBy).toBe('firewall');
    expect(s.fetch).toMatchObject({ plainStatus: 200, botStatus: 403, userAgent: AI_VIEW_USER_AGENT });
    expect(s.heading).toBe('AI crawlers get turned away from yoursite.com');
    expect(s.lead).toBe('People get your page (200). Our request as an AI crawler got 403. Your firewall or CDN blocks AI crawlers, or bots claiming to be them.');
    expect(s.fix).toMatch(/^Check your CDN/);
  });

  it('a challenge page is the firewall state; no answer or a 5xx is not a block', () => {
    const challenge = aiView({ url: 'https://yoursite.com/', status: 200, html: SSR, robotsTxt: null, crawler: { status: 200, headers: {}, html: '<html><head><title>Just a moment...</title></head></html>' } });
    expect(challenge.blockedBy).toBe('firewall');
    expect(challenge.fetch.botError).toBe('challenge page');
    const none = aiView({ url: 'https://yoursite.com/', status: 200, html: SSR, robotsTxt: null, crawler: { status: null, headers: {}, html: '', error: 'timeout after 10 s' } });
    expect(none.result).toBe('ok');
    expect(none.fetch.botStatus).toBeNull();
    const err = aiView({ url: 'https://yoursite.com/', status: 200, html: SSR, robotsTxt: null, crawler: { status: 503, headers: {}, html: '' } });
    expect(err.result).toBe('ok');
    for (const status of [401, 403, 429]) {
      expect(aiView({ url: 'https://yoursite.com/', status: 200, html: SSR, robotsTxt: null, crawler: { status, headers: {}, html: '' } }).blockedBy).toBe('firewall');
    }
    expect(isChallengePage(403, { 'cf-mitigated': 'challenge' }, '')).toBe(true);
  });

  it('unreachable: unavailable, no fix', () => {
    const s = aiView({ url: 'https://yoursite.com/', status: 503, html: 'Service unavailable', robotsTxt: null });
    expect(s.result).toBe('unavailable');
    expect(s.fix).toBeNull();
  });

  it('thin: text under the no_js threshold with no app root', () => {
    const s = aiView({ url: 'https://yoursite.com/', status: 200, html: '<html><body><h1>Hello there</h1><p>Short intro.</p></body></html>', robotsTxt: null });
    expect(s.result).toBe('thin');
    expect(s.lead).toBe('Your home page sends only 4 words before JavaScript runs. AI crawlers don’t run it, so that’s all they can quote.');
  });

  it('stores only the summary, never page text', () => {
    const stored = toStoredAiView(aiView({ url: 'https://www.thelewisapp.com/', status: 200, html: LEWIS, robotsTxt: ALLOW_ALL, now: NOW }));
    expect(stored).toEqual({ result: 'js_only', blockedBy: null, words: 0, headline: false, mainBlocked: [], checkedAt: NOW.toISOString() });
    expect(JSON.stringify(stored)).not.toContain('Lewis');
  });

  it('robots split matches robots_ai: training and Google-Extended are notes, main bots fail', () => {
    const r = aiViewRobots('User-agent: Google-Extended\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n', '/');
    expect(r.mainBlocked).toEqual([]);
    expect(r.trainingBlocked).toEqual(['ClaudeBot']);
    expect(r.groundingBlocked).toEqual(['Google-Extended']);
  });
});

describe('fetching', () => {
  it('the AI-crawler request sends the honest "as GPTBot" token, never OpenAI’s own string', async () => {
    const f = fakeFetch({ 'https://yoursite.com/': { status: 200, body: SSR, headers: { 'content-type': 'text/html' } } });
    const r = await fetchAsAiCrawler(f.fetch, 'https://yoursite.com/');
    expect(r.status).toBe(200);
    expect(f.calls[0]?.headers['user-agent']).toBe(AI_VIEW_USER_AGENT);
    expect(AI_VIEW_USER_AGENT).toMatch(/^Mozilla\/5\.0 \(compatible; Citelog\/[\d.]+; \+https:\/\/\S+; as GPTBot\)$/);
    expect(AI_VIEW_USER_AGENT).not.toMatch(/GPTBot\/\d/);
  });

  it('readAiView: plain page, robots.txt, then the page as an AI crawler; a UA-based 403 is the firewall state', async () => {
    const f = fakeFetch({
      'https://yoursite.com/': (_url, init) => {
        const ua = new Headers(init?.headers).get('user-agent') ?? '';
        return new Response(ua.includes('GPTBot') ? 'Forbidden' : SSR, { status: ua.includes('GPTBot') ? 403 : 200, headers: { 'content-type': 'text/html' } });
      },
      'https://yoursite.com/robots.txt': { status: 200, body: ALLOW_ALL, headers: { 'content-type': 'text/plain' } },
    });
    const r = await readAiView('https://yoursite.com/', { fetch: f.fetch, now: NOW });
    expect('summary' in r && r.summary.blockedBy).toBe('firewall');
    expect(f.calls.map((c) => c.url).sort()).toEqual(['https://yoursite.com/', 'https://yoursite.com/', 'https://yoursite.com/robots.txt']);
  });

  it('readAiView: unreachable returns the error, no reveal', async () => {
    const f = fakeFetch({ 'https://down.example/': () => Promise.reject(new TypeError('fetch failed')) });
    const r = await readAiView('https://down.example/', { fetch: f.fetch });
    expect(r).toEqual({ error: expect.stringMatching(/network error/) });
  });
});
