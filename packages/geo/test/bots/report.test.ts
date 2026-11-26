// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { AI_BOTS, readRobotsTxt, robotsAiReport, suggestedRobotsBlock } from '../../src/index.js';
import { fakeFetch, text } from '../readiness/fake-fetch.js';

const row = (r: ReturnType<typeof robotsAiReport>, name: string) => r.bots.find((b) => b.name === name);

describe('robotsAiReport', () => {
  it('no robots.txt: every bot allowed, check passes', () => {
    const r = robotsAiReport(null);
    expect(r.hasRobotsTxt).toBe(false);
    expect(r.bots).toHaveLength(AI_BOTS.length);
    expect(r.bots.every((b) => b.allowed && b.rule === null)).toBe(true);
    expect(r.verdict.result).toBe('pass');
  });

  it('a blocked main bot fails with the deciding rule and line; training bots are grouped', () => {
    const r = robotsAiReport('User-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /learn/\n\nUser-agent: *\nAllow: /\nSitemap: https://bywell.org/sitemap.xml\n', '/learn/roth-ira');
    expect(row(r, 'PerplexityBot')).toMatchObject({ allowed: false, main: true, rule: 'User-agent: PerplexityBot / Disallow: /learn/ (line 5)' });
    expect(row(r, 'GPTBot')).toMatchObject({ allowed: false, purpose: 'training' });
    expect(row(r, 'OAI-SearchBot')).toMatchObject({ allowed: true });
    expect(r.blocked).toEqual({ search: ['PerplexityBot'], user: [], training: ['GPTBot'] });
    expect(r.verdict.result).toBe('fail');
    expect(r.verdict.fix).toMatch(/Allow PerplexityBot/);
    expect(r.sitemaps).toEqual(['https://bywell.org/sitemap.xml']);
  });

  it('the path matters: the same file passes on another path', () => {
    const robots = 'User-agent: PerplexityBot\nDisallow: /learn/\n';
    expect(robotsAiReport(robots, '/pricing').verdict.result).toBe('pass');
    expect(robotsAiReport(robots, 'learn/x').path).toBe('/learn/x');
  });

  it('only training bots blocked warns, as in the readiness check', () => {
    expect(robotsAiReport('User-agent: GPTBot\nDisallow: /\n').verdict.result).toBe('warn');
  });

  it('the suggested block lets every main bot in and keeps every training bot out', () => {
    const r = robotsAiReport(suggestedRobotsBlock());
    for (const b of r.bots) {
      if (b.main) expect(b.allowed, b.name).toBe(true);
      if (b.purpose === 'training') expect(b.allowed, b.name).toBe(false);
    }
    expect(r.suggestedNote).toMatch(/ignores the "User-agent: \*" group/);
  });
});

describe('readRobotsTxt', () => {
  it('reads the origin\'s robots.txt; 404 = no file; 503 = disallow all (RFC 9309)', async () => {
    const ok = await readRobotsTxt('bywell.org/learn', { fetch: fakeFetch({ 'https://bywell.org/robots.txt': text('User-agent: *\nAllow: /\n') }).fetch });
    expect(ok).toMatchObject({ url: 'https://bywell.org/robots.txt', status: 200, unreachable: false });
    expect(ok.body).toContain('Allow: /');
    expect((await readRobotsTxt('https://a.example', { fetch: fakeFetch({}).fetch })).body).toBeNull();
    const down = await readRobotsTxt('https://a.example', { fetch: fakeFetch({ 'https://a.example/robots.txt': { status: 503 } }).fetch });
    expect(down).toMatchObject({ unreachable: true, reason: 'HTTP 503' });
  });
});
