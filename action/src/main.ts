// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { GEO_TOOL, GEO_TOOL_USER_AGENT, RULES } from '@morningdesk/core';
import { LogFormatError, SUPPORTED_FORMATS_MESSAGE, logFileLines } from '@morningdesk/geo';
import type { FetchLike, SiteReport } from '@morningdesk/geo';
import {
  ConfigError,
  EXIT,
  badgeSiteLine,
  belowThreshold,
  brandTermsFor,
  domainOf,
  loadConfig,
  mdCode,
  pagePath,
  pageVerdict,
  promptTexts,
  promptsJsonBody,
  renderBadgeSvg,
  renderCheckMarkdown,
  renderFooterMarkdown,
  scoreFromBadge,
  siteName,
  type GeoConfig,
  type GeoEngine,
} from './cli.js';
import { pagesScore, selectChangedPages } from './changed.js';
import { failingKeys, parseState, renderPrComment, type Baseline } from './comment.js';
import { ACTIONS_BOT, GitHub, GitHubError, findStickyComment, upsertStickyComment, type PrFile } from './github.js';
import { annotation, appendSummary, setOutputs } from './io.js';
import { namedFailures, renderPrSummary, renderSiteSummary } from './summary.js';

export interface ActionInputs {
  url?: string;
  path?: string;
  baseUrl?: string;
  maxPages: number;
  failUnder?: number;
  prompts: boolean;
  /** Perception check on scheduled prompt runs (an OpenAI or Anthropic key); off by default, so CI has no judge cost. */
  perception: boolean;
  token?: string;
  badge?: string;
  comment: boolean;
  logs?: string;
}

export interface ActionDeps {
  env: Record<string, string | undefined>;
  /** Site, engines and the GitHub API; nothing else (AC 10). */
  fetch: FetchLike;
  engine: GeoEngine;
  /** Workflow command output (annotations, log lines). */
  log(s: string): void;
}

/** GitHub passes `with:` values as INPUT_<NAME> (upper case, spaces to underscores, hyphens kept). */
export function input(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`]?.trim();
  return v ? v : undefined;
}

function bool(v: string | undefined, dflt: boolean, name: string): boolean {
  if (v === undefined) return dflt;
  if (/^(true|yes|1|on)$/i.test(v)) return true;
  if (/^(false|no|0|off)$/i.test(v)) return false;
  throw new Error(`Input "${name}" must be true or false (got "${v}").`);
}

function int(v: string | undefined, name: string, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new Error(`Input "${name}" must be a whole number from ${min} to ${max} (got "${v}").`);
  return Number(v);
}

export function readInputs(env: Record<string, string | undefined>): ActionInputs {
  return {
    url: input(env, 'url'),
    path: input(env, 'path'),
    baseUrl: input(env, 'base-url'),
    maxPages: int(input(env, 'max-pages'), 'max-pages', 1, 100_000) ?? RULES.geoDefaultMaxPages,
    failUnder: int(input(env, 'fail-under'), 'fail-under', 0, 100),
    prompts: bool(input(env, 'prompts'), false, 'prompts'),
    perception: bool(input(env, 'perception'), false, 'perception'),
    token: input(env, 'github-token') ?? env.GITHUB_TOKEN,
    badge: input(env, 'badge'),
    comment: bool(input(env, 'comment'), true, 'comment'),
    logs: input(env, 'logs'),
  };
}

interface PrPayload {
  pull_request?: {
    number: number;
    head: { sha: string; repo?: { full_name?: string } | null };
    base: { ref: string; repo?: { full_name?: string } | null };
  };
}

async function readEvent(env: Record<string, string | undefined>): Promise<PrPayload> {
  if (!env.GITHUB_EVENT_PATH) return {};
  try {
    return JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')) as PrPayload;
  } catch {
    return {};
  }
}

function workspacePath(env: Record<string, string | undefined>, p: string): string {
  return isAbsolute(p) ? p : join(env.GITHUB_WORKSPACE ?? process.cwd(), p);
}

function nothingToCheck(pr: boolean): string {
  const lines = [
    `${GEO_TOOL.name} has nothing to check${pr ? ' in this pull request' : ''}. Fix it one of two ways:`,
    `1. Pass your preview deployment's URL: \`url: \${{ steps.deploy.outputs.url }}\` (or any URL that serves this branch).`,
    '2. Build the site in an earlier step and pass the folder it writes: `path: ./dist` (or out, build, public).',
  ];
  if (!pr) lines.push(`On a schedule you can also set "site" in ${GEO_TOOL.configBase}.json.`);
  return lines.join('\n');
}

function short(sha: string | undefined): string {
  return (sha ?? '').slice(0, 7) || 'this commit';
}

function hostOrPath(target: string): string {
  return /^https?:\/\//i.test(target) ? siteName(target) : target;
}

async function loadCfg(deps: ActionDeps): Promise<GeoConfig> {
  try {
    return (await loadConfig(deps.env.GITHUB_WORKSPACE ?? process.cwd())).config;
  } catch (e) {
    if (e instanceof ConfigError) {
      deps.log(annotation('warning', `${e.message} Using the defaults.`, GEO_TOOL.name));
      return {};
    }
    throw e;
  }
}

/** Run the Action. Returns the process exit code. */
export async function runAction(deps: ActionDeps): Promise<number> {
  const { env } = deps;
  let inputs: ActionInputs;
  try {
    inputs = readInputs(env);
  } catch (e) {
    deps.log(annotation('error', (e as Error).message, GEO_TOOL.name));
    return EXIT.couldntRun;
  }
  const config = await loadCfg(deps);
  const failUnder = inputs.failUnder ?? (config.failUnder ? config.failUnder : undefined);
  const event = await readEvent(env);
  const isPr = (env.GITHUB_EVENT_NAME === 'pull_request' || env.GITHUB_EVENT_NAME === 'pull_request_target') && Boolean(event.pull_request);
  // Inputs that do nothing on this run say so, instead of being skipped in silence.
  if (inputs.perception && !inputs.prompts) {
    deps.log(annotation('notice', 'The perception input works with prompts: true, so nothing was judged.', GEO_TOOL.name));
  }
  if (isPr && inputs.prompts) {
    deps.log(annotation('notice', "Prompts don't run in pull requests (they spend your engine keys). They run on scheduled and push runs.", GEO_TOOL.name));
  }
  const target = inputs.url ?? (inputs.path ? workspacePath(env, inputs.path) : undefined) ?? (isPr ? undefined : config.site);
  const shownTarget = inputs.url ?? inputs.path ?? config.site ?? '';

  if (!target) {
    const msg = nothingToCheck(isPr);
    deps.log(annotation('error', msg, `${GEO_TOOL.name}: nothing to check`));
    await appendSummary(env, `## ${GEO_TOOL.name}: nothing to check\n\n${msg.split('\n').join('\n\n')}`);
    return EXIT.couldntRun;
  }

  let report: SiteReport;
  try {
    report = await deps.engine.checkTarget(target, { maxPages: inputs.maxPages, fetch: deps.fetch, userAgent: GEO_TOOL_USER_AGENT });
    if (inputs.path) report = { ...report, target: inputs.path };
  } catch (e) {
    const msg = `${GEO_TOOL.name} couldn't run on ${shownTarget}: ${(e as Error).message} Nothing was checked, so there's no score.`;
    deps.log(annotation('error', msg, GEO_TOOL.name));
    await appendSummary(env, `## ${GEO_TOOL.name}: ${hostOrPath(shownTarget)}\n\n**Couldn't run.** ${(e as Error).message} Nothing was checked, so there's no score.\n\n${renderFooterMarkdown()}`);
    return EXIT.couldntRun;
  }

  if (!report.pages.some((p) => pageVerdict(p) !== 'error')) return nothingLoaded(deps, inputs, report, shownTarget, isPr);

  return isPr ? runPr(deps, inputs, event, report, failUnder) : runSite(deps, inputs, config, report, failUnder);
}

/**
 * The CLI's no-page-loaded guard (FIX-P1 flows H1): a refused preview, a 503 site or an empty folder must fail the job,
 * never pass it. On a schedule the badge says "no score" only when the site answered (a status came back); when
 * nothing answered at all the badge is left as it was.
 */
async function nothingLoaded(deps: ActionDeps, inputs: ActionInputs, report: SiteReport, shownTarget: string, isPr: boolean): Promise<number> {
  const { env } = deps;
  const first = report.pages[0];
  const why = first?.error ?? (report.kind === 'folder' ? 'The folder has no HTML files.' : 'No pages found to check.');
  const msg = `${GEO_TOOL.name} couldn't check any page of ${shownTarget}. ${why} Nothing was checked, so there's no score.`;
  deps.log(annotation('error', msg, `${GEO_TOOL.name}: nothing checked`));
  await appendSummary(env, `## ${GEO_TOOL.name}: ${hostOrPath(shownTarget)}\n\n**Couldn't run.** ${why} Nothing was checked, so there's no score.\n\n${renderFooterMarkdown()}`);
  if (!isPr && inputs.badge && report.pages.some((p) => p.status !== null)) await writeFileSafe(workspacePath(env, inputs.badge), renderBadgeSvg(null));
  return EXIT.couldntRun;
}

async function writeFileSafe(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

async function runPr(deps: ActionDeps, inputs: ActionInputs, event: PrPayload, report: SiteReport, failUnder: number | undefined): Promise<number> {
  const { env } = deps;
  const pr = event.pull_request!;
  const headRepo = pr.head.repo?.full_name;
  const fork = !headRepo || headRepo !== pr.base.repo?.full_name;
  const repo = env.GITHUB_REPOSITORY ?? pr.base.repo?.full_name ?? '';
  const gh = inputs.token && repo ? new GitHub(env.GITHUB_API_URL ?? 'https://api.github.com', inputs.token, repo, deps.fetch) : null;

  let files: PrFile[] | null = null;
  if (gh) {
    try {
      files = await gh.listPrFiles(pr.number);
    } catch {
      files = null;
    }
  }
  const { pages, matched } = selectChangedPages(report, files);

  let baseline: Baseline | undefined;
  if (inputs.baseUrl) {
    try {
      const base = await deps.engine.checkTarget(inputs.baseUrl, { maxPages: inputs.maxPages, fetch: deps.fetch, userAgent: GEO_TOOL_USER_AGENT });
      const paths = new Set(pages.map((p) => pagePath(p.url, report)));
      const basePages = base.pages.filter((p) => paths.has(pagePath(p.url, base)));
      baseline = { ref: pr.base.ref, score: pagesScore(basePages), failing: new Set(failingKeys(basePages, base)) };
    } catch (e) {
      deps.log(annotation('warning', `Couldn't check base-url ${inputs.baseUrl}: ${(e as Error).message} Comparing without it.`, GEO_TOOL.name));
    }
  }

  const sha = short(pr.head.sha);
  const where = inputs.url ? `the preview ${mdCode(siteName(inputs.url))}` : `the build in ${mdCode(inputs.path ?? '')}`;
  const localTarget = inputs.path ?? inputs.url ?? './dist';
  let commentNote: string | undefined;
  if (fork) commentNote = undefined;
  else if (!inputs.comment) commentNote = 'Comment turned off (comment: false). Results are in this summary only.';
  else if (!gh) commentNote = 'No GitHub token, so no PR comment. Results are in this summary only.';

  // The summary goes first: a GitHub outage or a permission problem on the comment must never lose the results.
  await appendSummary(env, renderPrSummary({ report, pages, changedOnly: matched, fork, commentNote, baseline, failUnder }));
  const score = matched ? pagesScore(pages) : (report.score ?? pagesScore(pages));

  let commentUrl = '';
  if (!fork && inputs.comment && gh) {
    try {
      const comments = await gh.listComments(pr.number);
      const login = await gh.login();
      const existing = findStickyComment(comments, login ? [ACTIONS_BOT, login] : [ACTIONS_BOT]);
      const previous = parseState(existing?.body);
      const { body } = renderPrComment({ report, pages, changedOnly: matched, where, sha, baseline, previous, firstRun: !existing, failUnder, localTarget });
      const { comment } = await upsertStickyComment(gh, pr.number, body, existing);
      commentUrl = comment.html_url ?? '';
    } catch (e) {
      const why =
        e instanceof GitHubError && (e.status === 403 || e.status === 404)
          ? `No permission to comment (HTTP ${e.status}). Add \`permissions: pull-requests: write\` to the job (or \`issues: write\` if that's not enough).`
          : `Couldn't post the PR comment: ${(e as Error).message}.`;
      deps.log(annotation('warning', `${why} Results are in the job summary.`, GEO_TOOL.name));
    }
  }

  if (fork) {
    deps.log(
      annotation(
        'notice',
        [
          'This pull request comes from a fork, so this run has no permission to comment and no access to secrets.',
          `- Readiness checks ran on ${inputs.path ?? siteName(inputs.url ?? '')} (${plural(pages.length)}). Results are in the job summary.`,
          "- Prompts skipped: engine keys aren't shared with forks.",
          '- Not failing the job for missing permissions.',
        ].join('\n'),
        GEO_TOOL.name,
      ),
    );
  } else if (commentNote) deps.log(annotation('notice', commentNote, GEO_TOOL.name));

  await setOutputs(env, { score: score === null ? '' : String(score), 'comment-url': commentUrl });
  return threshold(deps, score, failUnder, pages, report);
}

function plural(n: number): string {
  return `${n} ${n === 1 ? 'page' : 'pages'}`;
}

/** The CLI's threshold rule (belowThreshold): with fail-under set, a score under it or no score at all fails. */
function threshold(deps: ActionDeps, score: number | null, failUnder: number | undefined, pages: SiteReport['pages'], report: SiteReport): number {
  if (!belowThreshold(score, failUnder)) return EXIT.ok;
  const named = namedFailures(pages, report);
  const lead = score === null ? `No score: none of these pages could be checked, so fail-under ${failUnder} can't pass.` : `Score ${score} is below fail-under ${failUnder}.`;
  deps.log(annotation('error', `${lead}${named ? ` Failed checks: ${named}.` : ''}`, `${GEO_TOOL.name}: below threshold`));
  return EXIT.belowThreshold;
}

const BADGE_LINE_OPEN = `<!-- ${GEO_TOOL.bin}:badge-line -->`;
const BADGE_LINE_CLOSE = `<!-- /${GEO_TOOL.bin}:badge-line -->`;

/** Rewrite the site line between the badge-line markers in README.md, if the README has them. */
async function updateReadmeLine(env: Record<string, string | undefined>, line: string): Promise<boolean> {
  const path = workspacePath(env, 'README.md');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return false;
  }
  const a = text.indexOf(BADGE_LINE_OPEN);
  const b = text.indexOf(BADGE_LINE_CLOSE, a);
  if (a < 0 || b < 0) return false;
  const next = `${text.slice(0, a + BADGE_LINE_OPEN.length)}${line}${text.slice(b)}`;
  if (next !== text) await writeFile(path, next, 'utf8');
  return true;
}

async function runSite(deps: ActionDeps, inputs: ActionInputs, config: GeoConfig, report: SiteReport, failUnder: number | undefined): Promise<number> {
  const { env } = deps;

  let previousScore: number | null = null;
  let badgePath: string | undefined;
  if (inputs.badge) {
    badgePath = inputs.badge;
    const abs = workspacePath(env, inputs.badge);
    try {
      previousScore = scoreFromBadge(await readFile(abs, 'utf8'));
    } catch {
      previousScore = null;
    }
    await writeFileSafe(abs, renderBadgeSvg(report.score));
    await updateReadmeLine(env, badgeSiteLine(siteName(config.site ?? report.target), report.pages.length, report.checkedAt));
  }

  let prompts: Parameters<typeof renderSiteSummary>[0]['prompts'];
  if (inputs.prompts) {
    const list = promptTexts(config.prompts ?? []);
    const site = config.site ?? (/^https?:\/\//i.test(report.target) ? report.target : undefined);
    if (!list.length || !site) {
      prompts = { skipped: `Prompts: none to ask. Add "site" and "prompts" to ${GEO_TOOL.configBase}.json.` };
    } else {
      try {
        const domain = domainOf(site);
        const run = await deps.engine.runPrompts(domain, list, {
          env,
          fetch: deps.fetch,
          engines: config.engines,
          brandTerms: brandTermsFor(config, domain),
          perception: { mode: inputs.perception ? 'auto' : 'off' },
        });
        prompts = { run, prompts: list, perception: inputs.perception };
      } catch (e) {
        prompts = { skipped: `Prompts couldn't run: ${(e as Error).message}` };
      }
    }
  }

  let logs: Parameters<typeof renderSiteSummary>[0]['logs'] = { skipped: 'AI crawler logs: not configured. Add `logs: ./logs/access.log` to include them.' };
  const logFile = inputs.logs ?? config.logs;
  if (logFile) {
    try {
      // One pass over the file (gzip unpacked as it streams); the summary detects the format from the first lines.
      const summary = await deps.engine.summarizeLogs(logFileLines(workspacePath(env, logFile)));
      logs = { summary, bots: deps.engine.bots };
    } catch (e) {
      const msg = (e as Error).message;
      logs =
        e instanceof LogFormatError
          ? { skipped: `AI crawler logs: ${logFile}: ${msg === SUPPORTED_FORMATS_MESSAGE ? `not a format ${GEO_TOOL.name} reads. ${msg}` : msg}` }
          : { skipped: `AI crawler logs: couldn't read ${logFile} (${msg}).` };
    }
  }

  const outDir = env.RUNNER_TEMP ? join(env.RUNNER_TEMP, GEO_TOOL.bin) : workspacePath(env, `.${GEO_TOOL.bin}`);
  const jsonName = `${GEO_TOOL.bin}-report.json`;
  const mdName = `${GEO_TOOL.bin}-report.md`;
  const jsonPath = join(outDir, jsonName);
  const mdPath = join(outDir, mdName);
  await writeFileSafe(jsonPath, `${JSON.stringify({ tool: GEO_TOOL.bin, version: GEO_TOOL.version, report, prompts: prompts && 'run' in prompts ? promptsJsonBody(prompts.run, config.prompts ?? []).run : null, logs: 'summary' in logs ? logs.summary : null }, null, 2)}\n`);
  await writeFileSafe(mdPath, `${renderCheckMarkdown(report, { failUnder })}\n`);

  await appendSummary(env, renderSiteSummary({ report, previousScore, badgePath, failUnder, prompts, logs, files: [jsonName, mdName] }));
  await setOutputs(env, {
    score: report.score === null ? '' : String(report.score),
    band: report.band,
    'report-json': jsonPath,
    'report-md': mdPath,
    'badge-line': badgeSiteLine(siteName(config.site ?? report.target), report.pages.length, report.checkedAt),
  });
  return threshold(deps, report.score, failUnder, report.pages, report);
}
