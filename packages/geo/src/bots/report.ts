// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/**
 * robots.txt against the AI crawler catalog: which bots may read a path, grouped by what they do (search, user
 * fetchers, training), the readiness verdict (the same rule as the robots_ai check) and a starter block for "let AI
 * search in, keep training out". Used by the MCP robots_ai tool; pure apart from readRobotsTxt.
 */
import { PoliteFetcher } from '../fetch/polite.js';
import { robotsFromResult, type RobotsFile } from '../fetch/site.js';
import { checkRobots } from '../readiness/checks.js';
import type { AiBot, CheckResult, FetchLike, PageInput } from '../types.js';
import { AI_BOTS } from './catalog.js';
import { parseRobots, robotsMatch } from './robots.js';

export interface RobotsBotRow {
  id: string;
  name: string;
  vendor: string;
  purpose: AiBot['purpose'];
  /** A search indexer or user fetcher the readiness check requires to be allowed. */
  main: boolean;
  robotsToken: string;
  allowed: boolean;
  /** The rule that decided it, e.g. `User-agent: GPTBot / Disallow: /` (line 3); null when no rule matched. */
  rule: string | null;
}

export interface RobotsAiReport {
  path: string;
  /** False when there is no robots.txt (every crawler may read everything). */
  hasRobotsTxt: boolean;
  bots: RobotsBotRow[];
  /** Names of blocked bots by purpose. */
  blocked: Record<AiBot['purpose'], string[]>;
  /** The readiness check's verdict for this path (robots_ai). */
  verdict: { result: CheckResult; detail: string; fix?: string };
  /** Sitemap: lines in the file. */
  sitemaps: string[];
  /** A robots.txt block that lets the main AI crawlers in and keeps training-only crawlers out. */
  suggested: string;
  suggestedNote: string;
}

const PURPOSES: AiBot['purpose'][] = ['search', 'user', 'training'];

/** The readiness verdict for a path, by the robots_ai check itself (no copy of its rules). */
function verdictFor(robotsTxt: string | null, path: string): RobotsAiReport['verdict'] {
  const url = new URL(path, 'https://site.invalid');
  const input: PageInput = { url: url.toString(), status: 200, headers: {}, html: '', robotsTxt, llmsTxt: null };
  const r = checkRobots({ input, url, pathOnly: true, page: undefined as never });
  return r.fix ? { result: r.result, detail: r.detail, fix: r.fix } : { result: r.result, detail: r.detail };
}

/** "Allow AI search, block training": main bots get their own group with Allow, training-only bots get Disallow. */
export function suggestedRobotsBlock(bots: readonly AiBot[] = AI_BOTS): string {
  const main = bots.filter((b) => b.main);
  const training = bots.filter((b) => b.purpose === 'training');
  return [
    '# AI search and user-triggered fetchers may read the site',
    ...main.map((b) => `User-agent: ${b.robotsToken}`),
    'Allow: /',
    '',
    "# AI training crawlers stay out (this doesn't stop AI answers citing you)",
    ...training.map((b) => `User-agent: ${b.robotsToken}`),
    'Disallow: /',
  ].join('\n');
}

export const SUGGESTED_ROBOTS_NOTE =
  'A crawler with its own group ignores the "User-agent: *" group, so copy any Disallow lines you still want (like /admin/) into the first group. Google-Extended also controls grounding in Gemini answers; leave it out of the second group if you want Gemini to cite you.';

/** Every catalogued AI bot against `robotsTxt` (null = no file) for `path`. */
export function robotsAiReport(robotsTxt: string | null, path = '/', bots: readonly AiBot[] = AI_BOTS): RobotsAiReport {
  const p = path.startsWith('/') ? path : `/${path}`;
  const parsed = robotsTxt === null ? null : parseRobots(robotsTxt);
  const rows: RobotsBotRow[] = bots.map((bot) => {
    const m = parsed ? robotsMatch(parsed, bot.robotsToken, p) : null;
    const rule = m?.rule ? `${m.agentLine} / ${m.rule.allow ? 'Allow' : 'Disallow'}: ${m.rule.pattern} (line ${m.rule.line})` : null;
    return { id: bot.id, name: bot.name, vendor: bot.vendor, purpose: bot.purpose, main: bot.main, robotsToken: bot.robotsToken, allowed: m ? m.allowed : true, rule };
  });
  const blocked = Object.fromEntries(PURPOSES.map((purpose) => [purpose, rows.filter((r) => r.purpose === purpose && !r.allowed).map((r) => r.name)])) as RobotsAiReport['blocked'];
  return {
    path: p,
    hasRobotsTxt: robotsTxt !== null,
    bots: rows,
    blocked,
    verdict: verdictFor(robotsTxt, p),
    sitemaps: parsed?.sitemaps ?? [],
    suggested: suggestedRobotsBlock(bots),
    suggestedNote: SUGGESTED_ROBOTS_NOTE,
  };
}

/** Fetch `<origin>/robots.txt` the way the readiness check does (4xx = no file; 5xx or unreachable = disallow all). */
export async function readRobotsTxt(siteUrl: string, opts: { fetch: FetchLike; userAgent?: string; timeoutMs?: number }): Promise<RobotsFile & { url: string }> {
  const base = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
  const url = `${base.origin}/robots.txt`;
  const fetcher = new PoliteFetcher({ fetch: opts.fetch, userAgent: opts.userAgent, timeoutMs: opts.timeoutMs });
  return { url, ...robotsFromResult(await fetcher.get(url, 'text/plain,*/*;q=0.5')) };
}
