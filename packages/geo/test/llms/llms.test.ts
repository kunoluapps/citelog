// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { readLlmsTxt, validateLlmsTxt } from '../../src/index.js';
import { fakeFetch, html, text } from '../readiness/fake-fetch.js';

const GOOD = `# Bywell

> Investing lessons for beginners, five minutes a day.

Bywell teaches the basics with practice money.

## Lessons

- [What is an index fund?](https://bywell.org/learn/index-fund): the one-paragraph answer
- [Roth IRA](https://bywell.org/learn/roth-ira)

## Optional

- [Changelog](/changelog)
`;

describe('validateLlmsTxt', () => {
  it('reads the llmstxt.org shape: H1, summary, sections, links, Optional', () => {
    const r = validateLlmsTxt(GOOD);
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.title).toBe('Bywell');
    expect(r.summary).toBe('Investing lessons for beginners, five minutes a day.');
    expect(r.sections.map((s) => [s.name, s.optional, s.links.length])).toEqual([
      ['Lessons', false, 2],
      ['Optional', true, 1],
    ]);
    expect(r.sections[0]?.links[0]).toEqual({ title: 'What is an index fund?', url: 'https://bywell.org/learn/index-fund', notes: 'the one-paragraph answer', line: 9 });
    expect(r.links).toBe(3);
  });

  it('an H1 that is not first, or a second H1, is an error', () => {
    expect(validateLlmsTxt('Some intro\n# Title\n').valid).toBe(false);
    const two = validateLlmsTxt('# One\n> s\n# Two\n## A\n- [x](https://a.example/)\n');
    expect(two.valid).toBe(false);
    expect(two.issues[0]).toMatchObject({ level: 'error', line: 3 });
  });

  it('no H1 at all is an error; an empty file too', () => {
    expect(validateLlmsTxt('## Docs\n- [a](https://a.example)\n').valid).toBe(false);
    expect(validateLlmsTxt('').issues[0]?.message).toMatch(/No H1/);
  });

  it('warns on a missing summary, non-link list items, bad URLs, empty sections and no sections', () => {
    const r = validateLlmsTxt('# Site\n\n## Docs\n- just text\n- [bad](ftp:x)\n## Empty\n');
    expect(r.valid).toBe(true);
    const messages = r.issues.map((i) => i.message).join('\n');
    expect(messages).toMatch(/No summary/);
    expect(messages).toMatch(/A list item in "Docs" isn't a link/);
    const many = validateLlmsTxt('# Site\n> s\n## Plans\n- Free\n- Pro\n- Team\n- [Pricing](https://a.example/pricing)\n');
    expect(many.issues.map((i) => i.message)).toEqual(['3 list items in "Plans" aren\'t links like "- [Name](https://…): notes" (first at line 4).']);
    expect(messages).toMatch(/"ftp:x" isn't an absolute URL/);
    expect(messages).toMatch(/"## Empty" has no links/);
    expect(validateLlmsTxt('# Site\n> s\n').issues.map((i) => i.message)).toEqual([expect.stringMatching(/No "## Section"/)]);
  });

  it('ignores headings and links inside code fences; flags H3 before the first section', () => {
    const r = validateLlmsTxt('# Site\n> s\n```\n# not a title\n```\n### Sub\n## Docs\n- [a](https://a.example)\n');
    expect(r.valid).toBe(true);
    expect(r.issues.map((i) => i.message)).toEqual([expect.stringMatching(/Headings below H1/)]);
  });

  it('an HTML page (SPA fallback) is not llms.txt', () => {
    const r = validateLlmsTxt('<!doctype html><html><body>app</body></html>');
    expect(r.valid).toBe(false);
    expect(r.issues[0]?.message).toMatch(/HTML page/);
  });
});

describe('readLlmsTxt', () => {
  it('fetches /llms.txt and /llms-full.txt on the origin only', async () => {
    const f = fakeFetch({ 'https://bywell.org/llms.txt': text(GOOD) });
    const r = await readLlmsTxt('bywell.org/learn/roth-ira', { fetch: f.fetch });
    expect(r).toMatchObject({ url: 'https://bywell.org/llms.txt', status: 200, found: true, fullFound: false });
    expect(r.report?.valid).toBe(true);
    expect(f.calls.map((c) => c.url).sort()).toEqual(['https://bywell.org/llms-full.txt', 'https://bywell.org/llms.txt']);
  });

  it('404 and an HTML fallback are "not found"; 5xx is "couldn\'t tell"', async () => {
    expect((await readLlmsTxt('https://a.example', { fetch: fakeFetch({}).fetch })).found).toBe(false);
    const spa = fakeFetch({ 'https://a.example/llms.txt': html('<!doctype html><div id="root"></div>') });
    expect((await readLlmsTxt('https://a.example', { fetch: spa.fetch })).found).toBe(false);
    const down = fakeFetch({ 'https://a.example/llms.txt': { status: 503 } });
    const r = await readLlmsTxt('https://a.example', { fetch: down.fetch });
    expect(r).toMatchObject({ found: null, error: 'HTTP 503' });
  });
});
