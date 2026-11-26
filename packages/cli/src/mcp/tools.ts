// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/**
 * The local MCP server's tools (`citelog mcp`). Thin wrappers over packages/geo and the CLI's own renderers, so an
 * agent gets the same checks, wording and numbers as the terminal. No account and no telemetry: tools fetch only the
 * site they are asked about; run_prompts is the only tool that calls an AI engine, with the user's own keys, and only
 * with `confirm: true`.
 */
import { existsSync, statSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { GEO_TOOL, GEO_TOOL_USER_AGENT, PROMPT_STAGES, RULES, formatUsd, microsToUsd } from '@morningdesk/core';
import {
  AI_BOTS,
  CHECK_GUIDE,
  CHECK_IDS,
  ENGINE_IDS,
  IP_RANGES,
  IP_RANGES_AS_OF,
  SCORE_RULE,
  botById,
  logFileLines,
  matchBot,
  rangeKey,
  readLlmsTxt,
  readRobotsTxt,
  robotsAiReport,
  type AiBot,
  type CheckId,
  type FetchLike,
  type LogFormat,
  type SiteReport,
} from '@morningdesk/geo';
import { hostToUrl, looksLikeHost } from '../geo/args.js';
import { ConfigError, brandTermsFor, domainOf, loadConfig, placeholderPrompts, promptTexts, validateConfig, type GeoConfig, type PromptSpec } from '../geo/config.js';
import type { GeoEngine } from '../geo/engine.js';
import { promptsJsonBody } from '../geo/render/json.js';
import { renderCheckMarkdown, renderLogsMarkdown, renderPromptsMarkdown } from '../geo/render/markdown.js';
import { failedChecks, pageVerdict } from '../geo/render/model.js';
import { buildPlan, planJson, renderPlanMarkdown } from '../geo/render/plan.js';
import { renderAiViewText } from '../geo/render/reveal.js';
import { makeStyle } from '../geo/render/style.js';

export interface McpDeps {
  fetch: FetchLike;
  /** Engine keys (OPENAI_API_KEY, …) are read from here, only by run_prompts and the perception judge. */
  env: Record<string, string | undefined>;
  /** The folder the client started the server in: config file, relative log paths and build folders. */
  cwd: string;
  engine: GeoEngine;
}

export interface ToolResult {
  text: string;
  structured: Record<string, unknown>;
}

/** A problem to show the agent as a tool error (isError), in plain words. */
export class ToolError extends Error {
  override name = 'ToolError';
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run: (deps: McpDeps, args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>;
}

const define = <S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef => def as unknown as ToolDef;

/** Reads a site the user names; changes nothing. */
const READ_WEB: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Local only: the bundled catalog, a local file or the config. */
const READ_LOCAL: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Calls AI engines on the user's own API keys: spends their credit. */
const SPEND: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export const MCP_MAX_PAGES = 50;
const B = GEO_TOOL.bin;
const NO_TELEMETRY = `${GEO_TOOL.name} has no telemetry: it fetches only the site you name.`;

/* ---------- shared helpers ---------- */

/**
 * The server's environment without values an MCP host left unfilled: an optional key a person skipped in a desktop
 * extension or plugin form can arrive as the literal "${user_config.openai_api_key}", and must not count as a key.
 */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && !/^\$\{[^}]*\}$/.test(v.trim())));
}

/** "example.com" → "https://example.com"; http(s) URLs as given. Anything else is refused. */
export function toUrl(raw: string): string {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).toString();
    } catch {
      throw new ToolError(`"${raw}" isn't a valid URL.`);
    }
  }
  if (looksLikeHost(s)) return new URL(hostToUrl(s)).toString();
  throw new ToolError(`"${raw}" isn't a URL or a domain. Pass something like https://example.com/page or example.com.`);
}

/** A URL, a host (https://), or a folder of built HTML under the server's folder. */
function toTarget(raw: string, cwd: string): string {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) return toUrl(s);
  const path = isAbsolute(s) ? s : resolve(cwd, s);
  if (existsSync(path) && statSync(path).isDirectory()) return path;
  if (looksLikeHost(s)) return toUrl(s);
  throw new ToolError(`"${raw}" isn't a URL, a domain or a folder of built HTML (looked for ${path}).`);
}

async function readConfig(cwd: string): Promise<{ config: GeoConfig; file: string | null }> {
  try {
    return await loadConfig(cwd);
  } catch (e) {
    if (e instanceof ConfigError) throw new ToolError(`${e.message} Fix the file, or pass the values as arguments.`);
    throw e;
  }
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

/** Compact per-page view for structuredContent (the Markdown text has the details). */
function compactReport(r: SiteReport): Record<string, unknown> {
  return {
    target: r.target,
    kind: r.kind,
    score: r.score,
    band: r.band,
    checkedAt: r.checkedAt,
    blockedBots: r.blockedBots,
    ...(r.truncated ? { truncated: r.truncated } : {}),
    pages: r.pages.map((p) => ({
      url: p.url,
      score: p.score,
      band: p.band,
      verdict: pageVerdict(p),
      ...(p.error ? { error: p.error } : {}),
      failed: failedChecks(p, 'fail').map((c) => c.id),
      warned: failedChecks(p, 'warn').map((c) => c.id),
    })),
  };
}

/* ---------- prompt arguments (prompts_plan, run_prompts) ---------- */

const promptArg = z.union([
  z.string().min(1),
  z.object({
    text: z.string().min(1).describe('The question people ask an AI.'),
    topic: z.string().min(1).optional().describe('A group name, e.g. "Retirement accounts".'),
    stage: z.enum(PROMPT_STAGES).optional().describe('Buyer stage; without one, a word rule picks it.'),
  }),
]);

const promptsShape = {
  site: z.string().min(1).optional().describe(`Site to look for in answers (URL or domain). Default: "site" in ${GEO_TOOL.configBase}.json in the server's folder.`),
  prompts: z.array(promptArg).min(1).max(100).optional().describe(`Questions people ask AI about your field. Default: "prompts" in ${GEO_TOOL.configBase}.json.`),
  engines: z.array(z.enum(ENGINE_IDS)).min(1).optional().describe('Engines to ask (default: every engine whose API key is set in the server\'s environment).'),
  brand_terms: z.array(z.string().min(1)).min(1).optional().describe('Words that count as "named" in an answer (default: brandTerms in the config, else the domain and its name).'),
  perception: z.boolean().optional().describe('Also judge answers that name or cite the site as positive, neutral or negative, on the OpenAI or Anthropic key (costs a little per answer). Default false.'),
};

type PromptArgs = z.infer<z.ZodObject<typeof promptsShape>>;

interface ResolvedPrompts {
  site: string;
  domain: string;
  specs: PromptSpec[];
  config: GeoConfig;
}

/** Arguments over the config file; validated by the same rules as the config (so the messages match the CLI's). */
async function resolvePrompts(deps: McpDeps, args: PromptArgs): Promise<ResolvedPrompts> {
  const loaded = await readConfig(deps.cwd);
  let fromArgs: GeoConfig;
  try {
    fromArgs = validateConfig(
      {
        ...(args.site ? { site: args.site } : {}),
        ...(args.prompts ? { prompts: args.prompts } : {}),
        ...(args.engines ? { engines: args.engines } : {}),
        ...(args.brand_terms ? { brandTerms: args.brand_terms } : {}),
      },
      'arguments',
    );
  } catch (e) {
    if (e instanceof ConfigError) throw new ToolError(e.message);
    throw e;
  }
  // The file's brand terms belong to the file's site: another site gets its own defaults (as with --site in the CLI).
  const otherSite = Boolean(args.site && loaded.config.site && domainOf(args.site) !== domainOf(loaded.config.site));
  const config: GeoConfig = { ...loaded.config, ...(otherSite ? { brandTerms: undefined } : {}), ...fromArgs };
  const site = config.site;
  const specs = config.prompts ?? [];
  if (!site || !specs.length) {
    throw new ToolError(
      `No ${!site ? 'site' : 'prompts'} to use. Pass "site" and "prompts" as arguments, or run \`npx ${B} init <site>\` in this folder and add prompts to ${GEO_TOOL.configBase}.json.`,
    );
  }
  const placeholders = placeholderPrompts(promptTexts(specs));
  if (placeholders.length) throw new ToolError(`A prompt still has a <placeholder>: "${placeholders[0]}". Write the real question first.`);
  return { site, domain: domainOf(site), specs, config };
}

function planFor(deps: McpDeps, r: ResolvedPrompts, perception: boolean) {
  return buildPlan(r.domain, r.specs, { engines: r.config.engines, env: deps.env, perception });
}

/* ---------- tools ---------- */

export const TOOLS: ToolDef[] = [
  define({
    name: 'ai_view',
    title: 'What AI crawlers see on a page',
    description:
      'Fetch one page the way AI crawlers do (no JavaScript) and report what they get: words of text, headline, title, empty app root, structured data, robots.txt blocks on the main AI crawlers, and whether a firewall turns an AI-crawler request away (one extra request sent "as GPTBot"). Ends with PASS/FAIL and the fix. Use it first for "can ChatGPT/Claude/Perplexity read my page?".',
    input: { url: z.string().min(1).describe('Page URL or domain, e.g. https://example.com/pricing or example.com.') },
    annotations: READ_WEB,
    run: async (deps, args) => {
      const url = toUrl(args.url);
      const r = await deps.engine.readAiView(url, { fetch: deps.fetch, userAgent: GEO_TOOL_USER_AGENT });
      if ('error' in r) throw new ToolError(`Couldn't read ${url} as an AI crawler: ${r.error}.`);
      const text = renderAiViewText(r.summary, { style: makeStyle(false), columns: 100 });
      return { text, structured: { ...r.summary } };
    },
  }),

  define({
    name: 'check_readiness',
    title: 'AI answer readiness checks',
    description: `Run the ten readiness checks (indexable, robots.txt for AI crawlers, content without JavaScript, short direct answer, JSON-LD, canonical, title and description, question headings, updated date, llms.txt) on a page URL, a sitemap URL (or a site URL whose sitemap is found), or a local folder of built HTML. Returns a 0-100 score per page and for the site, worst pages first, with the fix for each failed check. ${NO_TELEMETRY}`,
    input: {
      target: z.string().min(1).describe('A page URL, a site URL or domain (its sitemap is read), a sitemap.xml URL, or a folder of built HTML (e.g. ./dist), relative to the server\'s folder.'),
      max_pages: z.number().int().min(1).max(MCP_MAX_PAGES).optional().describe(`Pages to read from a sitemap or folder (1-${MCP_MAX_PAGES}, default ${Math.min(RULES.geoDefaultMaxPages, MCP_MAX_PAGES)}).`),
      format: z.enum(['md', 'json']).optional().describe('md (default): a readable report. json: the full report with every check.'),
    },
    annotations: READ_WEB,
    run: async (deps, args) => {
      const target = toTarget(args.target, deps.cwd);
      let report: SiteReport;
      try {
        report = await deps.engine.checkTarget(target, { maxPages: args.max_pages ?? Math.min(RULES.geoDefaultMaxPages, MCP_MAX_PAGES), fetch: deps.fetch, userAgent: GEO_TOOL_USER_AGENT });
      } catch (e) {
        throw new ToolError(`Couldn't check ${target}: ${(e as Error).message}`);
      }
      if (!report.pages.some((p) => pageVerdict(p) !== 'error')) {
        const first = report.pages[0];
        throw new ToolError(`Couldn't check ${first?.url ?? target}: ${first?.error ?? 'no pages found'}. Nothing was checked, so there's no score.`);
      }
      const text = args.format === 'json' ? json(report) : renderCheckMarkdown(report);
      return { text, structured: compactReport(report) };
    },
  }),

  define({
    name: 'robots_ai',
    title: 'robots.txt vs AI crawlers',
    description:
      "Check a site's robots.txt (fetched from the URL's origin, or pasted text) against the catalog of AI crawlers: allowed or blocked per bot for a path, grouped as search, user-triggered and training crawlers, the readiness verdict, and a starter robots.txt block that lets AI search in and keeps training crawlers out. Answers \"how do I allow GPTBot but block training?\"-type questions.",
    input: {
      url: z.string().min(1).optional().describe('Site or page URL (or domain); robots.txt is read from its origin. Give this or robots_txt.'),
      robots_txt: z.string().max(512 * 1024).optional().describe('robots.txt text to evaluate instead of fetching one.'),
      path: z.string().min(1).optional().describe('Path to evaluate, e.g. /blog/post (default: the URL\'s path, else /).'),
    },
    annotations: READ_WEB,
    run: async (deps, args) => {
      if ((args.url === undefined) === (args.robots_txt === undefined)) throw new ToolError('Give either url (to fetch robots.txt) or robots_txt (to paste one), not both.');
      let body: string | null = args.robots_txt ?? null;
      let source: Record<string, unknown> = { source: 'pasted' };
      let path = args.path ?? '/';
      if (args.url !== undefined) {
        const url = new URL(toUrl(args.url));
        if (!args.path) path = url.pathname + url.search;
        const file = await readRobotsTxt(url.toString(), { fetch: deps.fetch, userAgent: GEO_TOOL_USER_AGENT });
        body = file.body;
        source = { source: file.url, status: file.status, unreachable: file.unreachable, ...(file.reason ? { reason: file.reason } : {}) };
        if (file.unreachable) source.note = `robots.txt couldn't be read (${file.reason}); RFC 9309 says to treat that as "disallow all", so every bot shows as blocked.`;
        else if (file.body === null) source.note = 'No robots.txt (or an HTML page in its place), so every crawler may read every page.';
      }
      const report = robotsAiReport(body, path);
      const rows = report.bots.map((b) => `| ${b.name} | ${b.vendor} | ${b.purpose}${b.main ? ' (main)' : ''} | ${b.allowed ? 'allowed' : '**blocked**'} | ${b.rule ?? ''} |`);
      const text = [
        `## robots.txt for AI crawlers: ${report.path}`,
        '',
        typeof source.source === 'string' && source.source !== 'pasted' ? `Read ${source.source}${source.status ? ` (HTTP ${source.status})` : ''}.` : 'Evaluated the pasted robots.txt.',
        ...(source.note ? [String(source.note)] : []),
        '',
        `**${report.verdict.result.toUpperCase()}** ${report.verdict.detail}${report.verdict.fix ? `\nFix: ${report.verdict.fix}` : ''}`,
        '',
        `Blocked: search ${report.blocked.search.join(', ') || 'none'}; user-triggered ${report.blocked.user.join(', ') || 'none'}; training ${report.blocked.training.join(', ') || 'none'}.`,
        '',
        '| Bot | Vendor | Purpose | This path | Deciding rule |',
        '|---|---|---|---|---|',
        ...rows,
        '',
        'Starter block (allow AI search, block training):',
        '```',
        report.suggested,
        '```',
        report.suggestedNote,
      ].join('\n');
      return { text, structured: { ...source, ...report } };
    },
  }),

  define({
    name: 'llms_txt',
    title: 'llms.txt check',
    description:
      "Fetch a site's /llms.txt (and see whether /llms-full.txt exists) and compare it with the llmstxt.org format: H1 name, summary, link sections, Optional section. Informational, like the readiness check: evidence that AI engines read llms.txt is thin, so it never affects the score.",
    input: { url: z.string().min(1).describe('Site URL or domain; /llms.txt is read from its origin.') },
    annotations: READ_WEB,
    run: async (deps, args) => {
      const r = await readLlmsTxt(toUrl(args.url), { fetch: deps.fetch, userAgent: GEO_TOOL_USER_AGENT });
      const lines: string[] = [`## llms.txt: ${r.url}`, ''];
      if (r.found === null) lines.push(`Couldn't tell whether it exists: ${r.error}.`);
      else if (!r.found) lines.push(`No llms.txt${r.status ? ` (HTTP ${r.status}, or an HTML page in its place)` : ''}.`);
      else if (r.report) {
        const rep = r.report;
        lines.push(`Found. ${rep.valid ? 'Follows the llmstxt.org format' : "Doesn't follow the llmstxt.org format"}: title ${rep.title ? `"${rep.title}"` : 'missing'}, ${rep.summary ? 'a summary' : 'no summary'}, ${rep.sections.length} sections, ${rep.links} links.`);
        if (rep.issues.length) lines.push('', 'Issues:', ...rep.issues.map((i) => `- ${i.level}: ${i.message}${i.line ? ` (line ${i.line})` : ''}`));
      }
      lines.push('', `/llms-full.txt: ${r.fullFound === null ? "couldn't tell" : r.fullFound ? 'found' : 'not found'}.`, '', r.note);
      return { text: lines.join('\n'), structured: { ...r } };
    },
  }),

  define({
    name: 'crawler_info',
    title: 'AI crawler catalog',
    description:
      'Look up AI crawlers in the bundled catalog: name, vendor, purpose (search, user-triggered or training), robots.txt token, User-Agent substring, whether the readiness check requires it to be allowed, its official docs, and whether its published IP ranges are in the bundled snapshot (with the snapshot date). Pass a bot name, id or a full User-Agent header; omit it to list every crawler. No network.',
    input: {
      bot: z.string().min(1).optional().describe('Bot name or id (GPTBot, claude-searchbot) or a User-Agent string.'),
      purpose: z.enum(['search', 'user', 'training']).optional().describe('List only crawlers with this purpose.'),
    },
    annotations: READ_LOCAL,
    run: async (_deps, args) => {
      const snapshot = new Set(IP_RANGES.lists.map((l) => rangeKey(l.url)));
      const entry = (b: AiBot) => ({
        ...b,
        ipRangesInSnapshot: b.ipRangesUrl ? snapshot.has(rangeKey(b.ipRangesUrl)) : false,
        robotsExample: `User-agent: ${b.robotsToken}\nDisallow: /`,
      });
      let bots: readonly AiBot[] = AI_BOTS;
      if (args.bot) {
        const q = args.bot.trim();
        const found = botById(q.toLowerCase()) ?? AI_BOTS.find((b) => b.name.toLowerCase() === q.toLowerCase() || b.robotsToken.toLowerCase() === q.toLowerCase()) ?? matchBot(q);
        if (!found) throw new ToolError(`"${q}" isn't in the catalog. Known crawlers: ${AI_BOTS.map((b) => b.name).join(', ')}.`);
        bots = [found];
      }
      if (args.purpose) bots = bots.filter((b) => b.purpose === args.purpose);
      const list = bots.map(entry);
      const text = [
        `${list.length} AI crawler${list.length === 1 ? '' : 's'}. IP range snapshot: ${IP_RANGES_AS_OF}.`,
        '',
        '| Bot | Vendor | Purpose | Main | robots.txt token | IP list in snapshot | Docs |',
        '|---|---|---|---|---|---|---|',
        ...list.map((b) => `| ${b.name} | ${b.vendor} | ${b.purpose} | ${b.main ? 'yes' : 'no'} | ${b.robotsToken} | ${b.ipRangesInSnapshot ? 'yes' : 'no'} | ${b.docsUrl} |`),
        '',
        '"Main" crawlers are the search indexers and user-triggered fetchers that must be allowed for AI answers to cite a page.',
      ].join('\n');
      return { text, structured: { ipRangesAsOf: IP_RANGES_AS_OF, bots: list } };
    },
  }),

  define({
    name: 'parse_logs',
    title: 'AI crawler visits from an access log',
    description:
      'Read a local access log (nginx/Apache combined, Cloudflare Logpush JSON, Vercel log drain JSON; .gz too) and report AI crawler visits by bot and page, each verified or not against the vendors\' published IP ranges (a dated snapshot bundled with the tool; nothing is looked up online). Only the counts are returned, never the log lines.',
    input: {
      path: z.string().min(1).describe("Path to the log file, absolute or relative to the server's folder."),
      format: z.enum(['combined', 'cloudflare', 'vercel']).optional().describe('Log format (default: detected from the first lines).'),
    },
    annotations: READ_LOCAL,
    run: async (deps, args) => {
      const path = isAbsolute(args.path) ? args.path : join(deps.cwd, args.path);
      try {
        await access(path);
      } catch {
        throw new ToolError(`No such file: ${path}.`);
      }
      if (!statSync(path).isFile()) throw new ToolError(`${path} isn't a file.`);
      const it = logFileLines(path)[Symbol.asyncIterator]();
      const head: string[] = [];
      try {
        while (head.filter((l) => l.trim()).length < 20) {
          const r = await it.next();
          if (r.done) break;
          head.push(r.value);
        }
      } catch (e) {
        throw new ToolError(`Couldn't read ${path}: ${(e as Error).message}`);
      }
      if (!head.some((l) => l.trim())) throw new ToolError(`${path} is empty: there are no lines to read.`);
      const format: LogFormat | null = args.format ?? deps.engine.detectFormat(head.filter((l) => l.trim()).slice(0, 20));
      if (!format) {
        await it.return?.(undefined);
        throw new ToolError(`Unknown log format in ${path}. ${GEO_TOOL.name} reads nginx/Apache combined, Cloudflare Logpush JSON and Vercel log drain JSON; pass format if the file is one of these with unusual lines.`);
      }
      async function* all(): AsyncGenerator<string> {
        yield* head;
        for (;;) {
          const r = await it.next();
          if (r.done) return;
          yield r.value;
        }
      }
      let summary;
      try {
        summary = await deps.engine.summarizeLogs(all(), format);
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      return { text: renderLogsMarkdown(summary, deps.engine.bots, { heading: '##' }), structured: { file: path, summary } };
    },
  }),

  define({
    name: 'prompts_plan',
    title: 'Plan a prompt check (sends nothing)',
    description: `Show what run_prompts would ask: the prompts by topic and stage, which engines have an API key set in the server's environment, and the estimated cost per engine. Sends nothing to any engine and costs nothing. Prompts and site come from the arguments or ${GEO_TOOL.configBase}.json in the server's folder.`,
    input: promptsShape,
    annotations: READ_LOCAL,
    run: async (deps, args) => {
      const r = await resolvePrompts(deps, args);
      const plan = planFor(deps, r, Boolean(args.perception));
      return { text: `${renderPlanMarkdown(plan, { heading: '##' })}\n\nNothing was sent.`, structured: { site: r.domain, ...planJson(plan) } };
    },
  }),

  define({
    name: 'explain_check',
    title: 'Explain a readiness check',
    description: 'Why a readiness check matters for AI answers, exactly what it tests, what passes, warns and fails, its weight in the score, and how to fix it. No network.',
    input: { check: z.enum(CHECK_IDS).describe(`Check id: ${CHECK_IDS.join(', ')}.`) },
    annotations: READ_LOCAL,
    run: async (_deps, args) => {
      const g = CHECK_GUIDE[args.check as CheckId];
      const text = [
        `## ${g.label} (${g.id})`,
        '',
        g.why,
        '',
        `Weight: ${g.weight}${g.weight === 0 ? ' (informational, not scored)' : ''}.`,
        `Tests: ${g.tests}`,
        `Pass: ${g.pass}`,
        ...(g.warn ? [`Warn: ${g.warn}`] : []),
        ...(g.fail ? [`Fail: ${g.fail}`] : []),
        ...(g.skip ? [`Skipped: ${g.skip}`] : []),
        `Fix: ${g.fix}`,
        '',
        SCORE_RULE,
        `Docs: ${GEO_TOOL.docsUrl}`,
      ].join('\n');
      return { text, structured: { ...g, scoreRule: SCORE_RULE, docsUrl: GEO_TOOL.docsUrl } };
    },
  }),

  define({
    name: 'run_prompts',
    title: 'Ask AI engines your prompts (spends your API credit)',
    description:
      "Ask ChatGPT, Claude, Perplexity and Gemini (each only if its API key is set in the server's environment: OPENAI_API_KEY, ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, GOOGLE_API_KEY or GEMINI_API_KEY) the prompts, and report per answer whether the site was cited (linked) or named, who was cited instead, and the pages engines considered. This SPENDS the user's API credit. Without confirm: true it only returns the plan and estimated cost; show that to the user and call again with confirm: true only after they agree. API answers can differ from what people see in the consumer apps.",
    input: {
      ...promptsShape,
      confirm: z.boolean().optional().describe('Must be true to send anything. Ask the user first: it spends their API credit.'),
    },
    annotations: SPEND,
    run: async (deps, args) => {
      const r = await resolvePrompts(deps, args);
      const perception = Boolean(args.perception);
      const plan = planFor(deps, r, perception);
      if (args.confirm !== true) {
        const asked = plan.estimate.engines.length;
        const text = [
          renderPlanMarkdown(plan, { heading: '##' }),
          '',
          asked
            ? `Nothing was sent. This would spend about ${formatUsd(plan.estimate.totalUsdMicros)} of the user's own API credit. Show this plan to the user and call run_prompts again with confirm: true only if they agree.`
            : 'Nothing was sent: no engine has an API key set in the server\'s environment, so there is nothing to run.',
        ].join('\n');
        return { text, structured: { sent: false, site: r.domain, estimateUsd: microsToUsd(plan.estimate.totalUsdMicros), plan: planJson(plan) } };
      }
      if (!plan.estimate.engines.length) {
        throw new ToolError(`No engine has an API key set in the server's environment (${ENGINE_IDS.length} engines checked). Set OPENAI_API_KEY, ANTHROPIC_API_KEY, PERPLEXITY_API_KEY or GOOGLE_API_KEY/GEMINI_API_KEY in the MCP client's config for this server.`);
      }
      const prompts = promptTexts(r.specs);
      let run;
      try {
        run = await deps.engine.runPrompts(r.domain, prompts, {
          env: deps.env,
          fetch: deps.fetch,
          engines: r.config.engines,
          brandTerms: brandTermsFor(r.config, r.domain),
          perception: { mode: perception ? 'auto' : 'off' },
        });
      } catch (e) {
        throw new ToolError(`The prompt run stopped: ${(e as Error).message}`);
      }
      return { text: renderPromptsMarkdown(run, prompts, { heading: '##', perception }), structured: { sent: true, site: r.domain, ...promptsJsonBody(run, r.specs) } };
    },
  }),
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
