// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { parseRobots, robotsAllows, robotsMatch } from '../../src/bots/index.js';
import { patternMatches } from '../../src/bots/robots.js';

/** RFC 9309 §5.1 example file. */
const RFC_EXAMPLE = `User-Agent: *
Disallow: *.gif$
Disallow: /example/
Allow: /publications/

User-Agent: foobot
Disallow:/
Allow:/example/page.html
Allow:/example/allowed.gif

User-Agent: barbot
User-Agent: bazbot
Disallow: /example/page.html

User-Agent: quxbot

EOF
`;

describe('robotsAllows (RFC 9309)', () => {
  it('allows everything when there is no robots.txt', () => {
    expect(robotsAllows(null, 'GPTBot', '/anything')).toBe(true);
  });

  it('follows the RFC 9309 §5.1 example', () => {
    expect(robotsAllows(RFC_EXAMPLE, 'foobot', '/example/page.html')).toBe(true);
    expect(robotsAllows(RFC_EXAMPLE, 'foobot', '/example/allowed.gif')).toBe(true);
    expect(robotsAllows(RFC_EXAMPLE, 'foobot', '/other')).toBe(false);
    expect(robotsAllows(RFC_EXAMPLE, 'barbot', '/example/page.html')).toBe(false);
    expect(robotsAllows(RFC_EXAMPLE, 'bazbot', '/example/page.html')).toBe(false);
    expect(robotsAllows(RFC_EXAMPLE, 'bazbot', '/example/other.html')).toBe(true);
    expect(robotsAllows(RFC_EXAMPLE, 'quxbot', '/example/page.html')).toBe(true);
    expect(robotsAllows(RFC_EXAMPLE, 'otherbot', '/pics/a.gif')).toBe(false);
    expect(robotsAllows(RFC_EXAMPLE, 'otherbot', '/example/x')).toBe(false);
    expect(robotsAllows(RFC_EXAMPLE, 'otherbot', '/publications/x')).toBe(true);
  });

  it('matches user-agent tokens case-insensitively and falls back to *', () => {
    const txt = 'user-agent: GPTBOT\ndisallow: /\n\nuser-agent: *\ndisallow: /private\n';
    expect(robotsAllows(txt, 'GPTBot', '/')).toBe(false);
    expect(robotsAllows(txt, 'ClaudeBot', '/')).toBe(true);
    expect(robotsAllows(txt, 'ClaudeBot', '/private/x')).toBe(false);
  });

  it('uses only the specific group when one matches (not * as well)', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n';
    expect(robotsAllows(txt, 'OAI-SearchBot', '/page')).toBe(true);
    expect(robotsAllows(txt, 'PerplexityBot', '/page')).toBe(false);
  });

  it('combines every group that names the bot', () => {
    const txt = 'User-agent: ClaudeBot\nDisallow: /a\n\nUser-agent: Googlebot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /b\n';
    expect(robotsAllows(txt, 'ClaudeBot', '/a')).toBe(false);
    expect(robotsAllows(txt, 'ClaudeBot', '/b')).toBe(false);
    expect(robotsAllows(txt, 'ClaudeBot', '/c')).toBe(true);
  });

  it('takes the product token from versioned user-agent values', () => {
    expect(robotsAllows('User-agent: Googlebot/2.1\nDisallow: /\n', 'Googlebot', '/')).toBe(false);
  });

  it('uses the longest match, and allow wins a tie', () => {
    const txt = 'User-agent: *\nAllow: /example/page/\nDisallow: /example/page/disallowed.gif\nDisallow: /tie\nAllow: /tie\n';
    expect(robotsAllows(txt, 'x', '/example/page/a.html')).toBe(true);
    expect(robotsAllows(txt, 'x', '/example/page/disallowed.gif')).toBe(false);
    expect(robotsAllows(txt, 'x', '/tie')).toBe(true);
  });

  it('supports * and $ wildcards', () => {
    const txt = 'User-agent: *\nDisallow: /*.php$\nDisallow: /fish*.html\nAllow: /$\nDisallow: /\n';
    expect(robotsAllows(txt, 'x', '/index.php')).toBe(false);
    expect(robotsAllows(txt, 'x', '/index.php?x=1')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /*.php$\n', 'x', '/index.php?x=1')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /*.php$\n', 'x', '/index.php5')).toBe(true);
    expect(robotsAllows(txt, 'x', '/fishheads/a.html')).toBe(false);
    expect(robotsAllows(txt, 'x', '/')).toBe(true);
    expect(robotsAllows(txt, 'x', '/other')).toBe(false);
  });

  it('matches paths case-sensitively', () => {
    const txt = 'User-agent: *\nDisallow: /Fish\n';
    expect(robotsAllows(txt, 'x', '/Fish.html')).toBe(false);
    expect(robotsAllows(txt, 'x', '/fish.html')).toBe(true);
  });

  it('compares percent-encoded and raw forms (RFC 9309 §2.2.2 table)', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /foo/bar?baz=quz\n', 'x', '/foo/bar?baz=quz')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /foo/bar/ツ\n', 'x', '/foo/bar/%E3%83%84')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /foo/bar/%E3%83%84\n', 'x', '/foo/bar/ツ')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /foo/bar/%62%61%7A\n', 'x', '/foo/bar/baz')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /path/file-with-a-%2A.html\n', 'x', '/path/file-with-a-*.html')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /path/file-with-a-%2A.html\n', 'x', '/path/file-with-a-b.html')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /path/foo-%24\n', 'x', '/path/foo-$')).toBe(false);
  });

  it('always allows /robots.txt and ignores empty Disallow', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /\n', 'x', '/robots.txt')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow:\n', 'x', '/anything')).toBe(true);
  });

  it('skips comments, unknown keys and broken lines without ending the group', () => {
    const txt = '# hello\nUser-agent: GPTBot # training\nCrawl-delay: 5\nthis line is junk\nDisallow: /secret # hidden\n';
    expect(robotsAllows(txt, 'GPTBot', '/secret/a')).toBe(false);
    expect(robotsAllows(txt, 'GPTBot', '/public')).toBe(true);
  });

  it('collects sitemap lines and reports the deciding rule with its line', () => {
    const txt = 'Sitemap: https://example.com/sitemap.xml\n\nUser-agent: ClaudeBot\nDisallow: /\n';
    expect(parseRobots(txt).sitemaps).toEqual(['https://example.com/sitemap.xml']);
    const m = robotsMatch(txt, 'ClaudeBot', '/x');
    expect(m.allowed).toBe(false);
    expect(m.rule).toEqual({ allow: false, pattern: '/', line: 4 });
    expect(m.agentLine).toBe('User-agent: ClaudeBot');
  });

  it('handles a byte-order mark and CRLF line endings', () => {
    expect(robotsAllows('﻿User-agent: *\r\nDisallow: /a\r\n', 'x', '/a')).toBe(false);
  });

  it('matches wildcards like the reference matcher', () => {
    expect(patternMatches('/a*b', '/axxb')).toBe(true);
    expect(patternMatches('/a*b', '/axxbyy')).toBe(true);
    expect(patternMatches('/a*b$', '/axxbyy')).toBe(false);
    expect(patternMatches('/a*b$', '/axxbyyb')).toBe(true);
    expect(patternMatches('*.gif$', '/x.gif')).toBe(true);
    expect(patternMatches('*.gif$', '/x.gif.html')).toBe(false);
    expect(patternMatches('/fish*', '/fish')).toBe(true);
    expect(patternMatches('/fish$', '/fish')).toBe(true);
    expect(patternMatches('/fish$', '/fishy')).toBe(false);
    expect(patternMatches('/***', '/')).toBe(true);
    expect(patternMatches('/x', '/')).toBe(false);
  });

  it('stays linear on hostile wildcard patterns (ReDoS guard)', () => {
    const pattern = `/${'a*'.repeat(200)}b`;
    const path = `/${'a'.repeat(20_000)}`;
    const robots = `User-agent: *\nDisallow: ${pattern}\nDisallow: /${'*'.repeat(5000)}z$\n`;
    const start = performance.now();
    expect(robotsAllows(robots, 'x', path)).toBe(true);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
