// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu

/** RFC 9309 robots.txt parsing and matching (https://www.rfc-editor.org/rfc/rfc9309.html). */

export interface RobotsRule {
  allow: boolean;
  /** Pattern as written in the file. */
  pattern: string;
  /** 1-based line number in the file. */
  line: number;
}

export interface RobotsGroup {
  /** Lowercased product tokens from the group's user-agent lines ('*' for the catch-all). */
  agents: string[];
  /** The user-agent lines as written, for messages. */
  agentLines: string[];
  rules: RobotsRule[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  /** Absolute URLs from sitemap: lines. */
  sitemaps: string[];
}

export interface RobotsMatch {
  allowed: boolean;
  /** The deciding rule, absent when no rule matched (allowed by default). */
  rule?: RobotsRule;
  /** The user-agent line of the group the rule came from, e.g. "User-agent: ClaudeBot". */
  agentLine?: string;
}

/** RFC 9309 §2.5: crawlers must parse at least 500 KiB. */
const MAX_ROBOTS_CHARS = 512 * 1024;

function productToken(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith('*')) return '*';
  const m = /^[a-z0-9_-]+/.exec(v);
  return m ? m[0] : '';
}

export function parseRobots(robotsTxt: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  const lines = robotsTxt.slice(0, MAX_ROBOTS_CHARS).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  lines.forEach((rawLine, i) => {
    const hash = rawLine.indexOf('#');
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    const colon = line.indexOf(':');
    if (colon <= 0) return;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      const token = productToken(value);
      if (!token) return;
      if (!current || current.rules.length > 0) {
        current = { agents: [], agentLines: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(token);
      current.agentLines.push(`User-agent: ${value}`);
    } else if (key === 'allow' || key === 'disallow') {
      if (!current) return;
      current.rules.push({ allow: key === 'allow', pattern: value, line: i + 1 });
    } else if (key === 'sitemap') {
      if (/^https?:\/\//i.test(value)) sitemaps.push(value);
    }
  });
  return { groups, sitemaps };
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * Bring a path or pattern to one canonical octet form: decode percent-encoded unreserved characters, upper-case the
 * remaining escapes, and percent-encode non-ASCII, spaces and controls as UTF-8. In paths, literal `*` and `$` become
 * %2A and %24 so they never collide with pattern wildcards (RFC 9309 §2.2.3).
 */
export function normalizeRobotsPath(input: string, isPattern: boolean): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(input.slice(i + 1, i + 3))) {
      const code = parseInt(input.slice(i + 1, i + 3), 16);
      const decoded = String.fromCharCode(code);
      out += UNRESERVED.test(decoded) ? decoded : `%${input.slice(i + 1, i + 3).toUpperCase()}`;
      i += 2;
      continue;
    }
    const code = ch.codePointAt(0) as number;
    if (code > 0x7e || code <= 0x20) {
      const cp = String.fromCodePoint(code);
      for (const b of new TextEncoder().encode(cp)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
      if (cp.length === 2) i++;
      continue;
    }
    if (!isPattern && ch === '*') out += '%2A';
    else if (!isPattern && ch === '$') out += '%24';
    else out += ch;
  }
  return out;
}

/**
 * Wildcard match in linear time (no RegExp, so a pattern like `/a*a*a*a*b` can't backtrack). `*` matches any run of
 * characters, a trailing `$` anchors the end, anything else is literal; the pattern is a prefix match otherwise.
 * Greedy-with-restart: on a mismatch, retry from the last `*` one character further on, which is O(pattern × path)
 * worst case and needs no state beyond two indexes.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const p = (anchored ? pattern.slice(0, -1) : pattern).replace(/\*{2,}/g, '*').replaceAll('$', '%24');
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < path.length) {
    if (pi === p.length && !anchored) return true;
    if (pi < p.length && p[pi] !== '*' && p[pi] === path[si]) {
      pi++;
      si++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = si;
    } else if (star >= 0) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

function selectGroups(parsed: ParsedRobots, token: string): RobotsGroup[] {
  const t = token.toLowerCase();
  const exact = parsed.groups.filter((g) => g.agents.includes(t));
  if (exact.length) return exact;
  return parsed.groups.filter((g) => g.agents.includes('*'));
}

/** Full RFC 9309 decision for one product token and one path (path plus query). */
export function robotsMatch(robots: string | ParsedRobots | null, robotsToken: string, path: string): RobotsMatch {
  if (robots === null) return { allowed: true };
  const parsed = typeof robots === 'string' ? parseRobots(robots) : robots;
  const testPath = normalizeRobotsPath(path.startsWith('/') ? path : `/${path}`, false);
  if (testPath === '/robots.txt') return { allowed: true };
  let best: { rule: RobotsRule; agentLine: string; length: number } | null = null;
  for (const group of selectGroups(parsed, robotsToken)) {
    for (const rule of group.rules) {
      if (rule.pattern === '') continue;
      const pattern = normalizeRobotsPath(rule.pattern, true);
      if (!patternMatches(pattern, testPath)) continue;
      const length = pattern.length;
      if (!best || length > best.length || (length === best.length && rule.allow && !best.rule.allow)) {
        best = { rule, agentLine: group.agentLines[0] ?? '', length };
      }
    }
  }
  if (!best) return { allowed: true };
  return { allowed: best.rule.allow, rule: best.rule, agentLine: best.agentLine };
}

/** RFC 9309: is `path` allowed for `robotsToken` by this robots.txt? Missing robots.txt allows everything. */
export function robotsAllows(robotsTxt: string | null, robotsToken: string, path: string): boolean {
  return robotsMatch(robotsTxt, robotsToken, path).allowed;
}
