// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { parseArgs } from 'node:util';
import { GEO_TOOL, JUDGE_MODEL_LABEL, PERCEPTION_JUDGES, PROMPT_STAGES, RULES } from '@morningdesk/core';
import { ENGINES, type LogFormat } from '@morningdesk/geo';

export const COMMANDS = ['check', 'logs', 'prompts', 'init', 'mcp'] as const;
export type Command = (typeof COMMANDS)[number];

export interface Flags {
  json: boolean;
  md: boolean;
  failUnder?: number;
  maxPages?: number;
  noColor: boolean;
  verbose: boolean;
  format?: LogFormat;
  site?: string;
  config?: string;
  /** check: render the page in a Chrome the user has, when the page needs JavaScript for its text. */
  render: boolean;
  /** prompts: print the plan and the estimate, send nothing. */
  plan: boolean;
  /** prompts: run the perception check on answers that name or cite the site (OpenAI or Anthropic key). */
  perception: boolean;
}

export type Parsed =
  | { kind: 'help'; command?: Command }
  | { kind: 'version' }
  | { kind: 'run'; command: Command; positionals: string[]; flags: Flags }
  | { kind: 'error'; message: string };

const LOG_FORMATS: readonly LogFormat[] = ['combined', 'cloudflare', 'vercel'];

/** File extensions that look like a top-level domain but name a file ("sitemap.xml", "index.html"). */
const FILE_SUFFIX = /\.(xml|gz|html?|json|ya?ml|txt|log|md|js|mjs|ts|css|csv)$/i;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9](?::\d{1,5})?$/i;

/** A local dev server: localhost or an IPv4 address, with an optional port. */
const LOCAL_HOST = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?$/i;

/** "thelewisapp.com", "www.ansa.chat/pricing", "localhost:3000": a host (with an optional path), not a file name. */
export function looksLikeHost(s: string): boolean {
  const host = s.split(/[/?#]/, 1)[0] ?? '';
  return (HOST.test(host) && !FILE_SUFFIX.test(host)) || LOCAL_HOST.test(host);
}

/** The URL for a bare host: https://, except http:// for localhost and IP addresses (local dev servers). */
export function hostToUrl(s: string): string {
  const host = s.split(/[/?#]/, 1)[0] ?? '';
  return `${LOCAL_HOST.test(host) ? 'http' : 'https'}://${s}`;
}

/** An http(s) URL, or a host that `npx citelog <host>` checks over https. */
export function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || looksLikeHost(s);
}

function intFlag(name: string, raw: string | undefined, min: number, max: number): number | string | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim())) return `--${name} takes a whole number from ${min} to ${max} (got "${raw}").`;
  const n = Number(raw);
  if (n < min || n > max) return `--${name} takes a whole number from ${min} to ${max} (got ${n}).`;
  return n;
}

export function parseCliArgs(argv: string[]): Parsed {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const r = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        md: { type: 'boolean' },
        'fail-under': { type: 'string' },
        'max-pages': { type: 'string' },
        'no-color': { type: 'boolean' },
        verbose: { type: 'boolean' },
        format: { type: 'string' },
        site: { type: 'string' },
        config: { type: 'string' },
        render: { type: 'boolean' },
        plan: { type: 'boolean' },
        perception: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    values = r.values;
    positionals = r.positionals;
  } catch (e) {
    return { kind: 'error', message: (e as Error).message.replace(/\. To specify a positional argument.*$/s, '.') };
  }

  if (positionals[0] !== undefined && !(COMMANDS as readonly string[]).includes(positionals[0]) && looksLikeUrl(positionals[0])) {
    positionals = ['check', ...positionals];
  }
  const [first, ...rest] = positionals;
  if (values.version) return { kind: 'version' };
  if (first === 'help') return { kind: 'help', command: (COMMANDS as readonly string[]).includes(rest[0] ?? '') ? (rest[0] as Command) : undefined };
  if (first !== undefined && !(COMMANDS as readonly string[]).includes(first)) {
    return { kind: 'error', message: `Unknown command "${first}". Commands: ${COMMANDS.join(', ')}.` };
  }
  const command = first as Command | undefined;
  if (values.help || !command) return { kind: 'help', command };

  if (values.json && values.md) return { kind: 'error', message: 'Use --json or --md, not both.' };
  if (values.render && (command !== 'check' || values.md)) return { kind: 'error', message: '--render works with check only, in text or --json output.' };
  if ((values.plan || values.perception) && command !== 'prompts') return { kind: 'error', message: `--${values.plan ? 'plan' : 'perception'} works with prompts only.` };
  const failUnder = intFlag('fail-under', values['fail-under'] as string | undefined, 0, 100);
  if (typeof failUnder === 'string') return { kind: 'error', message: failUnder };
  const maxPages = intFlag('max-pages', values['max-pages'] as string | undefined, 1, 100_000);
  if (typeof maxPages === 'string') return { kind: 'error', message: maxPages };
  const format = values.format as string | undefined;
  if (format !== undefined && !(LOG_FORMATS as readonly string[]).includes(format)) {
    return { kind: 'error', message: `--format takes ${LOG_FORMATS.join(', ')} (got "${format}").` };
  }

  return {
    kind: 'run',
    command,
    positionals: rest,
    flags: {
      json: Boolean(values.json),
      md: Boolean(values.md),
      failUnder,
      maxPages,
      noColor: Boolean(values['no-color']),
      verbose: Boolean(values.verbose),
      format: format as LogFormat | undefined,
      site: values.site as string | undefined,
      config: values.config as string | undefined,
      render: Boolean(values.render),
      plan: Boolean(values.plan),
      perception: Boolean(values.perception),
    },
  };
}

const B = GEO_TOOL.bin;
const CONFIG = `${GEO_TOOL.configBase}.json`;
const MAX = RULES.geoDefaultMaxPages;
const JUDGE_LINE = PERCEPTION_JUDGES.map((j) => `${JUDGE_MODEL_LABEL[j.model]} on ${ENGINES[j.provider].envVar}`).join(', else ');

export const HELP: Record<Command | 'main', string> = {
  main: `${GEO_TOOL.name} ${GEO_TOOL.version}: will AI answer engines quote your pages?

Start here
  npx ${B} <url>                       what AI crawlers see on the page, then the checks

Usage
  ${B} <url>                                same as check <url>
  ${B} check <url | sitemap.xml | ./dist>   readiness checks, up to ${MAX} pages
  ${B} logs <file>                          AI crawler visits in an access log
  ${B} prompts                              ask engines your prompts (your keys)
  ${B} init [site]                          write a starter ${CONFIG}
  ${B} mcp                                  local MCP server over stdio (Claude, Cursor, VS Code)

Options
  --json               machine-readable output
  --md                 Markdown output (for PRs and job summaries)
  --fail-under <0-100> exit 1 when the score is below this
  --max-pages <n>      pages to read from a sitemap or folder (default ${MAX})
  --format <name>      log format for logs: combined, cloudflare or vercel (default: detect)
  --site <domain>      site for prompts (default: "site" in ${CONFIG})
  --config <file>      config file (default: ${CONFIG})
  --render             check: when the page needs JavaScript for its text, count the
                       words people see in a Chrome you already have (CHROME_PATH)
  --plan               prompts: print the plan and the estimate; nothing is sent
  --perception         prompts: judge answers that name or cite you (positive, neutral,
                       negative) on your OpenAI or Anthropic key
  --verbose            list every page and every issue
  --no-color           plain output (also NO_COLOR=1)
  -h, --help           this help
  -v, --version        print the version

Exit codes: 0 ok, 1 below --fail-under, 2 couldn't run.
No telemetry: ${GEO_TOOL.name} calls only the site you check and the engines whose keys are set.
Docs: ${GEO_TOOL.docsUrl}
`,
  check: `Usage: ${B} check <url | sitemap.xml | ./dist> [--fail-under <0-100>] [--max-pages <n>] [--json | --md] [--verbose] [--render]
       ${B} <url>   (the same as check <url>; a bare host like example.com means https://example.com)

For a page URL, first prints what AI crawlers see on that page (words, headline, robots.txt, firewall).
--render counts the words people see after JavaScript runs, in a Chrome you already have
(CHROME_PATH, or the usual install paths). Nothing is downloaded and nothing is sent to us;
the page's own scripts still load what they load, as in any browser.

Reads a page, a sitemap (or the sitemap a site URL points to) or a folder of built HTML,
runs the readiness checks and prints a score per page and for the site.
With no target, uses "site" from ${CONFIG}.
`,
  logs: `Usage: ${B} logs <file> [--format combined|cloudflare|vercel] [--json | --md] [--verbose]

Reads nginx or Apache combined logs, Cloudflare Logpush JSON (.gz too) or Vercel log drain JSON,
and prints AI crawler visits by bot and page, each bot verified or unverified by IP.
`,
  prompts: `Usage: ${B} prompts [--site <domain>] ["prompt" ...] [--plan] [--perception] [--json | --md]

Asks each engine whose key is set (OPENAI_API_KEY, ANTHROPIC_API_KEY, PERPLEXITY_API_KEY,
GOOGLE_API_KEY or GEMINI_API_KEY) the prompts in ${CONFIG} and prints, per answer:
  cited   it linked a page on your site
  named   it names you ("brandTerms" in ${CONFIG}; default: your domain and its name)
  -       neither
then the pages engines considered but didn't cite (Gemini gives the site only).

--plan        prints the prompts by topic and stage, the engines and the estimated cost per
              engine, and exits. Nothing is sent to any engine.
--perception  also asks a small model whether each answer that names or cites you is
              positive, neutral or negative:
              ${JUDGE_LINE}.
              Off unless you pass it; --plan shows its estimate and the run prints its cost.

Prompts in ${CONFIG} are strings or { "text", "topic", "stage" }
(stage: ${PROMPT_STAGES.join(', ')}; without one, a word rule picks it).
Only the text is sent to engines.
`,
  init: `Usage: ${B} init [site]

Writes a starter ${CONFIG} in this folder (never overwrites one).
`,
  mcp: `Usage: ${B} mcp

Starts a local MCP server on stdin/stdout for AI clients (Claude Code, Claude Desktop,
Cursor, VS Code, Codex). No account and no telemetry: tools fetch only the sites you
ask about, and run_prompts calls the engines whose keys are set, only when called with
confirm: true. Config: ${CONFIG} in the folder the client starts it in.

Add it to a client:
  claude mcp add ${B} -- npx -y ${GEO_TOOL.npmPackage}@${GEO_TOOL.version} mcp
  code --add-mcp '{"name":"${B}","command":"npx","args":["-y","${GEO_TOOL.npmPackage}@${GEO_TOOL.version}","mcp"]}'

Tools: ai_view, check_readiness, robots_ai, llms_txt, crawler_info, parse_logs,
prompts_plan, explain_check, run_prompts.
`,
};
