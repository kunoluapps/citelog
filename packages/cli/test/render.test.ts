// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BADGE_PILL,
  TERMINAL_COLORS,
  badgeSiteLine,
  makeStyle,
  pagePath,
  renderBadgeSvg,
  renderCheckMarkdown,
  renderCheckText,
  renderCouldntRunText,
  renderLogsMarkdown,
  renderLogsText,
  renderNoKeysText,
  buildPlan,
  renderPlanMarkdown,
  renderPlanText,
  renderPromptsMarkdown,
  renderPromptsText,
  scoreFromBadge,
  stripAnsi,
  wantsColor,
} from '../src/index.js';
import { BOARD_PROMPTS, NO_KEYS_SKIPPED, boardFail, boardMeasures, boardOneEngineFailed, boardPass, boardWarn, fakeEngine, logSummary } from './helpers.js';

const plain = makeStyle(false);
const color = makeStyle(true);

describe('terminal text (board CCli)', () => {
  it('state 1: pass', () => {
    expect(renderCheckText(boardPass(), { style: plain, durationMs: 6100, configHint: true })).toMatchSnapshot();
  });
  it('state 2: warnings only, build folder', () => {
    expect(renderCheckText(boardWarn(), { style: plain })).toMatchSnapshot();
  });
  it('state 3: failures with fixes, below --fail-under', () => {
    const text = renderCheckText(boardFail(), { style: plain, failUnder: 80 });
    expect(text).toMatchSnapshot();
    expect(text).toContain('Site score 72  below --fail-under 80');
    expect(text).toContain('FAIL robots.txt blocks ClaudeBot');
    expect(text).toContain('Top fix: a short answer under the title (9 pages)');
    expect(text).toMatch(/Failed checks: short answer \(9\), question headings \(5\)/);
  });
  it('state 4: prompts skipped, no keys', () => {
    expect(renderNoKeysText(NO_KEYS_SKIPPED, { style: plain, configLine: 'Read citelog.config.json: 5 prompts for lovestruck.app' })).toMatchSnapshot();
  });
  it('state 5: one engine failed', () => {
    expect(renderPromptsText(boardOneEngineFailed(), BOARD_PROMPTS, { style: plain })).toMatchSnapshot();
  });
  it('measures: cited / named / -, considered not cited, perception (AI search measures)', () => {
    expect(renderPromptsText(boardMeasures(), BOARD_PROMPTS, { style: plain, perception: true })).toMatchSnapshot();
  });
  it('plan: prompts by topic and stage, estimate per engine, judge line (--plan)', () => {
    const specs = [
      { text: 'roth ira for beginners', topic: 'Retirement', stage: null },
      { text: 'roth ira vs 401k', topic: 'Retirement', stage: null },
      { text: 'bywell price', topic: null, stage: 'decision' as const },
    ];
    const keys = { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', PERPLEXITY_API_KEY: 'x' };
    const plan = buildPlan('bywell.org', specs, { env: keys, perception: true });
    expect(renderPlanText(plan, { style: plain, configLine: 'Read citelog.config.json: 3 prompts for bywell.org' })).toMatchSnapshot();
    expect(renderPlanMarkdown(plan)).toMatchSnapshot();
    expect(renderPlanText(buildPlan('bywell.org', specs, { env: keys, perception: false }), { style: plain })).toMatch(/Perception +off {2}--perception turns it on/);
    expect(renderPlanText(buildPlan('bywell.org', specs, { env: { PERPLEXITY_API_KEY: 'x' }, perception: true }), { style: plain })).toContain('needs ANTHROPIC_API_KEY or OPENAI_API_KEY');
  });
  it('state 6: couldn\'t run', () => {
    const text = renderCouldntRunText(
      {
        what: 'https://lovestruck.app/sitemap.xml',
        lines: ['HTTP 503 Service Unavailable, 2 tries, 10 s each.', "Nothing was checked, so there's no score."],
        tries: ['open the URL in a browser to see if the site is up', 'or check a build folder: npx citelog check ./dist'],
        header: true,
      },
      plain,
    );
    expect(text).toMatchSnapshot();
  });
  it('logs', () => {
    expect(renderLogsText(logSummary(), { style: plain, file: 'access.log', bots: fakeEngine().engine.bots })).toMatchSnapshot();
  });

  it('colour repeats words, never replaces them', () => {
    const c = renderCheckText(boardFail(), { style: color, failUnder: 80 });
    expect(c).toContain('\x1b[38;2;255;138;122mFAIL\x1b[39m');
    expect(stripAnsi(c)).toBe(renderCheckText(boardFail(), { style: plain, failUnder: 80 }));
  });

  it('colour only on a TTY, off with NO_COLOR or --no-color', () => {
    expect(wantsColor({ isTTY: true, noColorFlag: false, env: {} })).toBe(true);
    expect(wantsColor({ isTTY: false, noColorFlag: false, env: {} })).toBe(false);
    expect(wantsColor({ isTTY: true, noColorFlag: true, env: {} })).toBe(false);
    expect(wantsColor({ isTTY: true, noColorFlag: false, env: { NO_COLOR: '1' } })).toBe(false);
    expect(wantsColor({ isTTY: false, noColorFlag: false, env: { FORCE_COLOR: '1' } })).toBe(true);
  });
});

describe('markdown', () => {
  it('check report (job summary layout)', () => {
    const md = renderCheckMarkdown(boardFail(), { previousScore: 74, extra: ['badge written to `.github/citelog-badge.svg`'] });
    expect(md).toMatchSnapshot();
    expect(md).not.toMatch(/[\u{1F300}-\u{1FAFF}✅❌]/u);
  });
  it('prompts and logs', () => {
    expect(renderPromptsMarkdown(boardOneEngineFailed(), BOARD_PROMPTS)).toMatchSnapshot();
    expect(renderPromptsMarkdown(boardMeasures(), BOARD_PROMPTS, { perception: true })).toMatchSnapshot();
    expect(renderLogsMarkdown(logSummary(), fakeEngine().engine.bots)).toMatchSnapshot();
  });
  it('fix-first lists a check once when it fails on some pages and warns on others (QA C-1)', () => {
    const r = boardFail();
    for (const p of r.pages.slice(-4)) {
      const c = p.checks.find((x) => x.id === 'direct_answer');
      if (c) c.result = 'warn';
    }
    const table = renderCheckMarkdown(r).split('### Pages')[0]!;
    expect(table.split('\n').filter((l) => /direct answer/i.test(l))).toHaveLength(1);
  });
  it('escapes table cells', () => {
    const r = boardFail();
    r.pages[0]!.url = 'https://bywell.org/a|b';
    expect(renderCheckMarkdown(r)).toContain('/a\\|b');
  });
});

describe('badge (board CReadme)', () => {
  it.each([
    [96, '96 · ready', BADGE_PILL.ready],
    [78, '78 · needs work', BADGE_PILL.needs_work],
    [42, '42 · not ready', BADGE_PILL.not_ready],
    [null, 'no score', BADGE_PILL.no_score],
  ])('score %s', (score, text, fill) => {
    const svg = renderBadgeSvg(score);
    expect(svg).toContain(`>${text}</text>`);
    expect(svg).toContain(`fill="${fill}"`);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toContain('<use');
    expect(scoreFromBadge(svg)).toBe(score);
  });
  it('the pill is never highlighter', () => {
    expect(Object.values(BADGE_PILL)).not.toContain('#D4F25A');
  });
  it('site line', () => {
    expect(badgeSiteLine('bywell.org', 41, '2026-11-17T07:00:00Z')).toBe('AI answer readiness of bywell.org, 41 pages, checked Nov 17, 2026');
  });
  it('colours match docs/brand/tokens.json', () => {
    const tokens = JSON.parse(readFileSync(new URL('../../../docs/brand/tokens.json', import.meta.url), 'utf8')) as {
      color: { light: Record<string, string>; dark: Record<string, string>; neutral: { stone: { value: string } } };
    };
    expect(BADGE_PILL).toEqual({ ready: tokens.color.light['status-pass'], needs_work: tokens.color.light['status-slipping'], not_ready: tokens.color.light['status-fail'], no_score: tokens.color.neutral.stone.value });
    expect(TERMINAL_COLORS).toEqual({ pass: tokens.color.dark['status-pass'], warn: tokens.color.dark['status-slipping'], fail: tokens.color.dark['status-fail'], dim: tokens.color.dark['text-muted'] });
  });
});

describe('pagePath', () => {
  it('URLs, folder paths', () => {
    expect(pagePath('https://bywell.org/learn/roth-ira?x=1')).toBe('/learn/roth-ira?x=1');
    expect(pagePath('https://bywell.org')).toBe('/');
    expect(pagePath('/learn/', { target: './out', kind: 'folder' })).toBe('/learn/');
    expect(pagePath('out/layout/index.html', { target: './out', kind: 'folder' })).toBe('/layout/');
  });
});
