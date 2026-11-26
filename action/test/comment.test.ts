// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { encodeState, parseState, renderPrComment } from '../src/comment.js';
import { routeSlug, selectChangedPages } from '../src/changed.js';
import { findStickyComment } from '../src/github.js';
import { annotation } from '../src/io.js';
import { GEO_TOOL } from '@morningdesk/core';
import { page, site } from '../../packages/cli/test/helpers.js';

const O = 'https://bywell-git-roth.vercel.app';
const base = { where: `the preview \`bywell-git-roth.vercel.app\``, localTarget: './out', changedOnly: true };

describe('PR comment (board CActionPR)', () => {
  it('state 1: first run', () => {
    const r = site([page('/learn/roth-ira', 64, { direct_answer: 'fail' }, O), page('/learn/ira-basics', 86, { question_headings: 'warn' }, O), page('/learn/x', 86, { question_headings: 'warn' }, O), page('/learn/y', 93, {}, O)], { target: O });
    expect(renderPrComment({ ...base, report: r, pages: r.pages, sha: 'a81d3e2', firstRun: true }).body).toMatchSnapshot();
  });
  it('state 2: all pass', () => {
    const r = site([page('/a', 95, {}, O), page('/b', 96, {}, O), page('/c', 94, {}, O)], { target: O });
    const body = renderPrComment({ ...base, report: r, pages: r.pages, sha: '4f1a2c0', baseline: { ref: 'main', score: 93, failing: new Set() } }).body;
    expect(body).toContain('**Pass.** All 3 changed pages pass every check. Score 95, Ready (was 93 on main).');
    expect(body).toMatchSnapshot();
  });
  it('state 3: new failures listed first', () => {
    const r = site([page('/pricing', 55, { no_js_content: 'fail' }, O), page('/learn/roth-ira', 64, { json_ld: 'fail' }, O), page('/learn/a', 85, { question_headings: 'warn' }, O)], { target: O });
    const body = renderPrComment({ ...base, report: r, pages: r.pages, sha: 'a81d3e2', failUnder: 75, baseline: { ref: 'main', score: 81, failing: new Set() } }).body;
    expect(body.indexOf('#### New failures')).toBeLessThan(body.indexOf('Warnings (1)'));
    expect(body).toMatchSnapshot();
  });
  it('state 5: updated after a push', () => {
    const r = site([page('/pricing', 90, {}, O), page('/learn/roth-ira', 68, { json_ld: 'fail' }, O)], { target: O });
    const previous = { v: 1 as const, pushes: [{ sha: '1111111', score: 81 }, { sha: '2222222', score: 68 }], failing: ['/pricing|no_js_content', '/learn/roth-ira|json_ld'] };
    const body = renderPrComment({ ...base, report: r, pages: r.pages, sha: '9f2c1e4', failUnder: 75, previous }).body;
    expect(body).toContain('**Updated for 9f2c1e4** (push 3 of this PR). **Score 79, Needs work**, was 68 on the last push. Above your threshold of 75.');
    expect(body).toContain('/pricing: content present without JavaScript. Pass now.');
    expect(body).toContain('/learn/roth-ira: valid JSON-LD. Use an ISO date in datePublished.');
    expect(body).not.toContain('Run locally');
    expect(body).toMatchSnapshot();
  });
  it('words only: no emoji, the marker first, state last and round-trips', () => {
    const r = site([page('/a', 40, { json_ld: 'fail' }, O)], { target: O });
    const { body, state } = renderPrComment({ ...base, report: r, pages: r.pages, sha: 'abc' });
    expect(body.startsWith(GEO_TOOL.commentMarker)).toBe(true);
    expect(body).not.toMatch(/[\u{1F300}-\u{1FAFF}✅❌⚠]/u);
    expect(parseState(body)).toEqual(state);
    expect(parseState(encodeState({ v: 1, pushes: [], failing: ['/a-->b|x'] }))?.failing).toEqual(['/a-->b|x']);
  });
});

describe('PR comment hardening (FIX-P1)', () => {
  it('first run says so; a later run without state does not', () => {
    const r = site([page('/a', 40, { json_ld: 'fail' }, O)], { target: O });
    expect(renderPrComment({ ...base, report: r, pages: r.pages, sha: 'abc1234', firstRun: true }).body).toContain(`First ${GEO_TOOL.name} run on this repo. It checked **the 1 page this PR changes**`);
    expect(renderPrComment({ ...base, report: r, pages: r.pages, sha: 'abc1234', firstRun: false }).body).not.toContain('First ');
  });

  it('omits "on the last push" when the last push had no score, and counts a re-run of one SHA once', () => {
    const r = site([page('/a', 80, {}, O)], { target: O });
    const previous = { v: 1 as const, pushes: [{ sha: '1111111', score: null }], failing: [] };
    const body = renderPrComment({ ...base, report: r, pages: r.pages, sha: '2222222', previous }).body;
    expect(body).toContain('**Score 80, Needs work**.');
    expect(body).not.toContain('on the last push');
    const again = renderPrComment({ ...base, report: r, pages: r.pages, sha: '2222222', previous: { ...previous, pushes: [...previous.pushes, { sha: '2222222', score: 80 }] } });
    expect(again.state.pushes.map((p) => p.sha)).toEqual(['1111111', '2222222']);
  });

  it('a missed threshold lists every failed check, not only the top fix (M8)', () => {
    const r = site([page('/a', 40, { json_ld: 'fail', direct_answer: 'fail' }, O), page('/b', 60, { no_js_content: 'fail' }, O)], { target: O });
    const body = renderPrComment({ ...base, report: r, pages: r.pages, sha: 'abc1234', failUnder: 90 }).body;
    expect(body).toContain('#### Failed checks');
    const table = body.slice(body.indexOf('#### Failed checks'));
    for (const id of ['json_ld', 'direct_answer', 'no_js_content'] as const) expect(table).toContain(r.pages.flatMap((p) => p.checks).find((c) => c.id === id)!.label);
  });

  it('rejects malformed or hostile state', () => {
    const wrap = (json: string) => `<!-- ${GEO_TOOL.bin}:state ${json} -->`;
    expect(parseState(wrap('{"v":1,"pushes":[{"sha":"[x](y)","score":5}],"failing":[]}'))).toBeNull();
    expect(parseState(wrap('{"v":1,"pushes":[{"sha":"abc1234","score":"9"}],"failing":[]}'))).toBeNull();
    expect(parseState(wrap('{"v":1,"pushes":[],"failing":[42]}'))).toBeNull();
    expect(parseState(wrap('{"v":1,"pushes":[{"sha":"abc1234","score":81}],"failing":["/a|json_ld"]}'))).toEqual({ v: 1, pushes: [{ sha: 'abc1234', score: 81 }], failing: ['/a|json_ld'] });
  });
});

describe('changed pages', () => {
  it.each([
    ['app/learn/roth-ira/page.tsx', 'roth-ira'],
    ['content/learn/roth-ira.mdx', 'roth-ira'],
    ['src/pages/pricing.astro', 'pricing'],
    ['src/pages/index.astro', ''],
    ['app/page.tsx', ''],
    ['src/routes/blog/+page.svelte', 'blog'],
    ['package.json', 'package'],
    ['logo.png', null],
  ])('%s -> %s', (file, slug) => expect(routeSlug(file)).toBe(slug));

  it('falls back to every page when nothing maps', () => {
    const r = site([page('/learn/roth-ira', 64), page('/', 90)]);
    expect(selectChangedPages(r, [{ filename: 'content/learn/roth-ira.md', status: 'modified' }]).pages.map((p) => p.url)).toEqual(['https://bywell.org/learn/roth-ira']);
    expect(selectChangedPages(r, [{ filename: 'styles.css', status: 'modified' }])).toMatchObject({ matched: false });
    expect(selectChangedPages(r, null).matched).toBe(false);
  });
});

describe('github helpers', () => {
  it("takes only a marked comment we wrote (the Actions bot or the token's login)", () => {
    const comments = [
      { id: 1, body: `quote: ${GEO_TOOL.commentMarker}`, user: { login: 'human' } },
      { id: 2, body: `${GEO_TOOL.commentMarker} x`, user: { login: 'github-actions[bot]' } },
      { id: 3, body: `${GEO_TOOL.commentMarker} y`, user: { login: 'kunolu-bot' } },
    ];
    expect(findStickyComment(comments)?.id).toBe(2);
    expect(findStickyComment([comments[0]!])).toBeUndefined();
    expect(findStickyComment([comments[0]!, comments[2]!], ['github-actions[bot]', 'kunolu-bot'])?.id).toBe(3);
  });
  it('escapes annotations', () => {
    expect(annotation('error', 'a\nb 100%', 'T: x')).toBe('::error title=T%3A x::a%0Ab 100%25\n');
  });
});
