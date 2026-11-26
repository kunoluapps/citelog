// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHECK_WEIGHTS, checkPage, scoreChecks, topFixOf } from '../../src/readiness/index.js';
import { CHECK_IDS, type CheckId, type CheckOutcome, type PageInput } from '../../src/types.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/pages/${name}.html`, import.meta.url), 'utf8');
const GOOD = fixture('good-article');
const STORY = fixture('story-article');
const SPA = fixture('spa-shell');

const URL_ = 'https://example.com/learn/roth-ira';

function input(over: Partial<PageInput> = {}): PageInput {
  return { url: URL_, status: 200, headers: { 'content-type': 'text/html' }, html: GOOD, robotsTxt: null, llmsTxt: false, ...over };
}

function check(id: CheckId, over: Partial<PageInput> = {}): CheckOutcome {
  const c = checkPage(input(over)).checks.find((x) => x.id === id);
  if (!c) throw new Error(`no ${id}`);
  return c;
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

function page(body: string, head = '<title>T</title><meta name="description" content="D">'): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

describe('checkPage', () => {
  it('returns all ten checks in contract order with labels, why and weights', () => {
    const r = checkPage(input());
    expect(r.checks.map((c) => c.id)).toEqual([...CHECK_IDS]);
    for (const c of r.checks) {
      expect(c.label).toBeTruthy();
      expect(c.why).toBeTruthy();
      expect(c.weight).toBe(CHECK_WEIGHTS[c.id]);
    }
  });

  it('scores a well-built article 100, Ready, with no top fix', () => {
    const r = checkPage(input());
    expect(r.checks.filter((c) => c.result !== 'pass').map((c) => c.id)).toEqual(['llms_txt']);
    expect(r.score).toBe(100);
    expect(r.band).toBe('ready');
    expect(r.topFix).toBeUndefined();
  });

  it('gives a fix on every warn and fail, never on pass', () => {
    for (const html of [GOOD, STORY, SPA]) {
      for (const c of checkPage(input({ html })).checks) {
        if (c.result === 'warn' || c.result === 'fail') expect(c.fix, c.id).toBeTruthy();
        else expect(c.fix, c.id).toBeUndefined();
      }
    }
  });

  it('marks an unreachable page with no score', () => {
    const r = checkPage(input({ status: null, html: '' }));
    expect(r.score).toBeNull();
    expect(r.band).toBe('no_score');
    expect(r.error).toContain(URL_);
  });
});

describe('score', () => {
  const c = (result: CheckOutcome['result'], weight: number): CheckOutcome => ({ id: 'canonical', label: '', result, weight, detail: '', why: '', fix: `fix-${result}-${weight}` });

  it('is the weighted share passed, warn counts half, skip and info left out', () => {
    expect(scoreChecks([c('pass', 3), c('fail', 1)])).toBe(75);
    expect(scoreChecks([c('pass', 2), c('warn', 2)])).toBe(75);
    expect(scoreChecks([c('pass', 1), c('skip', 5), c('info', 0)])).toBe(100);
    expect(scoreChecks([c('skip', 1)])).toBeNull();
    expect(scoreChecks([c('pass', 2), c('fail', 1)])).toBe(67);
  });

  it('takes the top fix from the highest-weight failure, then warnings', () => {
    expect(topFixOf([c('fail', 1), c('fail', 3), c('warn', 5)])).toBe('fix-fail-3');
    expect(topFixOf([c('pass', 3), c('warn', 1), c('warn', 2)])).toBe('fix-warn-2');
  });

  it('scores the story page in Needs work with the answer fix on top', () => {
    const r = checkPage(input({ html: STORY }));
    expect(r.band).toBe('needs_work');
    expect(r.topFix).toMatch(/^Under the title, answer/);
  });
});

describe('indexable', () => {
  it('passes on 200 without noindex', () => expect(check('indexable').result).toBe('pass'));
  it('fails on a noindex meta tag', () => {
    const c = check('indexable', { html: GOOD.replace('<head>', '<head><meta name="robots" content="noindex, follow">') });
    expect(c.result).toBe('fail');
    expect(c.detail).toContain('noindex');
  });
  it('fails on an X-Robots-Tag noindex header', () => {
    expect(check('indexable', { headers: { 'x-robots-tag': 'noindex' } }).result).toBe('fail');
  });
  it('fails on 404 and skips the content checks', () => {
    const r = checkPage(input({ status: 404 }));
    expect(r.checks.find((c) => c.id === 'indexable')?.detail).toContain('HTTP 404');
    expect(r.checks.find((c) => c.id === 'json_ld')?.result).toBe('skip');
    expect(r.score).toBe(50);
  });
});

describe('robots_ai', () => {
  it('passes with no robots.txt', () => expect(check('robots_ai').result).toBe('pass'));

  it('fails naming the blocked main bots and the rule (AC 3)', () => {
    const robotsTxt = 'User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nUser-agent: Claude-SearchBot\nDisallow: /learn/\n';
    const c = check('robots_ai', { robotsTxt });
    expect(c.result).toBe('fail');
    expect(c.detail).toContain('robots.txt blocks OAI-SearchBot and Claude-SearchBot');
    expect(c.detail).toContain('"User-agent: OAI-SearchBot / Disallow: /learn/" (line 6)');
    expect(c.fix).toContain('Allow OAI-SearchBot and Claude-SearchBot');
  });

  it('fails when a user fetcher is blocked', () => {
    expect(check('robots_ai', { robotsTxt: 'User-agent: ChatGPT-User\nDisallow: /\n' }).result).toBe('fail');
  });

  it('warns when only Google-Extended is blocked', () => {
    const c = check('robots_ai', { robotsTxt: 'User-agent: Google-Extended\nDisallow: /\n' });
    expect(c.result).toBe('warn');
    expect(c.detail).toContain('Google-Extended');
  });

  it('warns naming the bots when only training crawlers are blocked (tech lead decision)', () => {
    const c = check('robots_ai', { robotsTxt: 'User-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: CCBot\nDisallow: /\n' });
    expect(c.result).toBe('warn');
    expect(c.detail).toContain('robots.txt blocks GPTBot, ClaudeBot and CCBot');
    expect(c.detail).toContain("doesn't stop AI answers citing you; it stops training");
  });

  it('keeps the Google-Extended and training notes when a main bot also fails', () => {
    const robotsTxt = 'User-agent: OAI-SearchBot\nUser-agent: Google-Extended\nUser-agent: GPTBot\nDisallow: /\n';
    const c = check('robots_ai', { robotsTxt });
    expect(c.result).toBe('fail');
    expect(c.detail).toContain('robots.txt blocks OAI-SearchBot');
    expect(c.detail).toContain('It also blocks Google-Extended, which controls grounding in Gemini answers.');
    expect(c.detail).toContain('Training-only crawlers blocked: GPTBot.');
  });

  it('evaluates the page path, not just the root', () => {
    const robotsTxt = 'User-agent: PerplexityBot\nDisallow: /private/\n';
    expect(check('robots_ai', { robotsTxt }).result).toBe('pass');
    expect(check('robots_ai', { robotsTxt, url: 'https://example.com/private/a' }).result).toBe('fail');
  });
});

describe('canonical', () => {
  it('passes when it points to itself (trailing slash and www ignored)', () => {
    expect(check('canonical').result).toBe('pass');
    expect(check('canonical', { url: 'https://www.example.com/learn/roth-ira/' }).result).toBe('pass');
  });
  it('warns when missing', () => {
    const c = check('canonical', { html: GOOD.replace(/<link rel="canonical"[^>]*>/, '') });
    expect(c.result).toBe('warn');
    expect(c.fix).toContain(`href="${URL_}"`);
  });
  it('warns when it points elsewhere', () => {
    expect(check('canonical', { url: 'https://example.com/learn/roth-ira-2' }).result).toBe('warn');
  });
  it('fails with two different canonicals', () => {
    const html = GOOD.replace('<head>', '<head><link rel="canonical" href="https://example.com/other">');
    expect(check('canonical', { html }).result).toBe('fail');
  });
  it('compares paths in folder mode', () => {
    expect(check('canonical', { url: '/learn/roth-ira' }).result).toBe('pass');
  });
});

describe('title_meta', () => {
  it('passes with both', () => expect(check('title_meta').result).toBe('pass'));
  it('warns without a description', () => expect(check('title_meta', { html: STORY }).result).toBe('warn'));
  it('warns on a long title', () => {
    expect(check('title_meta', { html: page('<p>x</p>', `<title>${'Long title '.repeat(8)}</title><meta name="description" content="D">`) }).result).toBe('warn');
  });
  it('fails without a title', () => expect(check('title_meta', { html: page('<p>x</p>', '') }).result).toBe('fail'));
});

describe('direct_answer', () => {
  it('passes with a short answer under the h1', () => expect(check('direct_answer').result).toBe('pass'));
  it('fails when the page opens with a long story', () => {
    const c = check('direct_answer', { html: STORY });
    expect(c.result).toBe('fail');
    expect(c.detail).toMatch(/opening paragraph is \d+ words/);
  });
  it('warns on a 61-100 word opening', () => {
    const html = page(`<h1>What is an ETF?</h1><p>${words(80)}</p><h2>More</h2><p>${words(200)}</p>`);
    const c = check('direct_answer', { html });
    expect(c.result).toBe('warn');
    expect(c.fix).toContain('answer "What is an ETF?"');
  });
  it('fails when a section starts before any paragraph', () => {
    expect(check('direct_answer', { html: page(`<h1>ETFs</h1><h2>Intro</h2><p>${words(200)}</p>`) }).result).toBe('fail');
  });
  it('skips short pages', () => expect(check('direct_answer', { html: page(`<h1>Hi</h1><p>${words(60)}</p>`) }).result).toBe('skip'));
});

describe('question_headings', () => {
  it('passes when a third or more are questions', () => expect(check('question_headings').result).toBe('pass'));
  it('warns with 1 of 6 and names a heading to rename', () => {
    const c = check('question_headings', { html: STORY });
    expect(c.result).toBe('warn');
    expect(c.detail).toBe('1 of 6 subheadings is a question.');
    expect(c.fix).toBe('Rename "Basics" as the question a reader would ask.');
  });
  it('skips with fewer than two subheadings', () => expect(check('question_headings', { html: page('<h2>One</h2>') }).result).toBe('skip'));
});

describe('updated_date', () => {
  it('passes when the visible date matches dateModified', () => expect(check('updated_date').result).toBe('pass'));
  it('fails when they disagree', () => {
    const c = check('updated_date', { html: STORY });
    expect(c.result).toBe('fail');
    expect(c.detail).toBe('The page says "Updated Oct 2" but dateModified is 2026-03-14.');
  });
  it('warns when only the visible date exists', () => {
    const html = page(`<article><h1>A</h1><p>Last updated: November 2, 2026</p><p>${words(100)}</p></article>`);
    expect(check('updated_date', { html }).result).toBe('warn');
  });
  it('warns when only dateModified exists', () => {
    const html = page('<h1>A</h1>', '<script type="application/ld+json">{"@type":"Article","dateModified":"2026-11-02"}</script>');
    expect(check('updated_date', { html }).result).toBe('warn');
  });
  it('skips non-article pages with no dates', () => expect(check('updated_date', { html: SPA }).result).toBe('skip'));
});

describe('json_ld', () => {
  it('passes with Article and a matching FAQPage', () => {
    const c = check('json_ld');
    expect(c.result).toBe('pass');
    expect(c.detail).toBe('Valid JSON-LD (Article, FAQPage).');
  });
  it('fails when the FAQ schema lists questions not on the page', () => expect(check('json_ld', { html: STORY }).result).toBe('fail'));
  it('fails on invalid JSON', () => {
    const html = GOOD.replace('"@type":"Article",', '"@type":"Article",,');
    const c = check('json_ld', { html });
    expect(c.result).toBe('fail');
    expect(c.detail).toMatch(/^JSON-LD block 1 isn't valid JSON/);
  });
  it('fails when an article page has none', () => {
    expect(check('json_ld', { html: page(`<article><h1>A</h1><p>${words(400)}</p></article>`) }).result).toBe('fail');
  });
  it('warns when a short page has none', () => expect(check('json_ld', { html: SPA }).result).toBe('warn'));
  it('warns when the page has an FAQ but no FAQPage', () => {
    const html = page(`<h1>A</h1><h2>FAQ</h2><p>${words(40)}</p>`, '<script type="application/ld+json">{"@type":"WebPage"}</script>');
    const c = check('json_ld', { html });
    expect(c.result).toBe('warn');
    expect(c.fix).toBe('Add FAQPage schema for the FAQ.');
  });
  it("doesn't ask the home page for an Article (Organization or WebSite is enough)", () => {
    const html = page(`<h1>A</h1><p>${words(400)}</p>`, '<script type="application/ld+json">{"@type":"Organization"}</script>');
    expect(check('json_ld', { html, url: 'https://example.com/' }).result).toBe('pass');
    const none = check('json_ld', { html: page(`<h1>A</h1><p>${words(400)}</p>`), url: 'https://example.com/' });
    expect(none.result).toBe('warn');
    expect(none.fix).toContain('Organization or WebSite');
  });
  it('warns when an article page has no Article type', () => {
    const html = page(`<h1>A</h1><p>${words(400)}</p>`, '<script type="application/ld+json">{"@type":"WebPage"}</script>');
    expect(check('json_ld', { html }).result).toBe('warn');
  });
});

describe('no_js_content (AC 4)', () => {
  it('passes when the main text is in the HTML', () => expect(check('no_js_content').result).toBe('pass'));
  it('fails an SPA shell and explains why', () => {
    const r = checkPage(input({ url: 'https://example.com/pricing', html: SPA }));
    const c = r.checks.find((x) => x.id === 'no_js_content');
    expect(c?.result).toBe('fail');
    expect(c?.detail).toContain('<div id="root"> is empty');
    expect(c?.detail).toContain('only after JavaScript runs');
    expect(c?.fix).toContain('server');
  });
  it('fails an empty app root with only navigation text around it', () => {
    const html = page(`<nav>${words(80)}</nav><div id="__next"></div>`);
    const c = check('no_js_content', { html });
    expect(c.result).toBe('fail');
    expect(c.detail).toContain('<div id="__next"> is empty');
  });
  it('ignores text inside scripts and styles', () => {
    const html = page(`<script>var t = "${words(300)}";</script><style>.a{}</style><p>Hello there</p>`);
    expect(check('no_js_content', { html }).result).toBe('fail');
  });
});

describe('llms_txt', () => {
  it('is info, weight 0, whether or not the file exists', () => {
    for (const llmsTxt of [true, false, null]) {
      const c = check('llms_txt', { llmsTxt });
      expect(c.result).toBe('info');
      expect(c.weight).toBe(0);
    }
    expect(check('llms_txt', { llmsTxt: true }).detail).toBe('Found at example.com/llms.txt. Not scored: evidence that engines use it is thin.');
  });
  it('does not change the score', () => {
    expect(checkPage(input({ llmsTxt: true })).score).toBe(checkPage(input({ llmsTxt: false })).score);
  });
});
