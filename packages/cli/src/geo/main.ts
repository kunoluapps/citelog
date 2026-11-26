// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { existsSync } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { GEO_TOOL, GEO_TOOL_USER_AGENT, MEASURES, RULES, type AiViewSummary } from '@morningdesk/core';
import { aiView, logFileLines } from '@morningdesk/geo';
import type { FetchLike, LogFormat, SiteReport } from '@morningdesk/geo';
import { HELP, hostToUrl, looksLikeHost, parseCliArgs, type Command, type Flags } from './args.js';
import type { RenderDom } from './browser.js';
import {
  CONFIG_FILES,
  ConfigError,
  brandTermsFor,
  domainOf,
  loadConfig,
  placeholderPrompts,
  promptTexts,
  promptTopics,
  starterConfig,
  type LoadedConfig,
  type PromptSpec,
} from './config.js';
import type { GeoEngine } from './engine.js';
import { promptJson, promptsJsonBody, renderJson, type JsonCommand } from './render/json.js';
import { buildPlan, planJson, renderPlanMarkdown, renderPlanText } from './render/plan.js';
import { renderAiViewText, renderedLine } from './render/reveal.js';
import { renderCheckMarkdown, renderFooterMarkdown, renderLogsMarkdown, renderPromptsMarkdown } from './render/markdown.js';
import { belowThreshold, pageVerdict, sentence } from './render/model.js';
import { makeStyle, wantsColor, type Style } from './render/style.js';
import { LOG_FORMAT_NAME, renderCheckText, renderCouldntRunText, renderLogsText, renderPromptsText, type CouldntRun } from './render/text.js';

export const EXIT = { ok: 0, belowThreshold: 1, couldntRun: 2 } as const;

export interface CliIO {
  stdout(s: string): void;
  stderr(s: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  isTTY: boolean;
  /** Used only for the site being checked and the engines whose keys are set (AC 10). */
  fetch: FetchLike;
  engine: GeoEngine;
  /** Milliseconds clock for "Done in 6.1 s." */
  clock?: () => number;
  /** Terminal width, when stdout is a terminal. */
  columns?: number;
  /** `--render` only: loads a page in a local Chrome. Absent = no browser (tests never launch one). */
  renderDom?: RenderDom;
  /** `mcp`: starts the stdio MCP server (stdout then carries the protocol, so nothing else is printed). */
  serveMcp?: () => Promise<void>;
}

interface Ctx {
  io: CliIO;
  flags: Flags;
  style: Style;
  command: Command;
}

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

function couldntRun(ctx: Ctx, c: CouldntRun): number {
  const { io, flags } = ctx;
  if (flags.json) {
    const message = c.lines.map(sentence).join(' ');
    io.stdout(renderJson(ctx.command as JsonCommand, EXIT.couldntRun, { error: { what: c.what, message, tries: c.tries ?? [] } }));
  } else if (flags.md) {
    const tries = c.tries?.length ? `\n\nTry:\n${c.tries.map((t) => `- ${t}`).join('\n')}` : '';
    io.stdout(`**Couldn't run** ${c.what}\n\n${c.lines.map(sentence).join(' ')}${tries}\n\n${renderFooterMarkdown()}\n`);
  } else {
    io.stderr(renderCouldntRunText(c, ctx.style));
  }
  return EXIT.couldntRun;
}

async function getConfig(ctx: Ctx): Promise<LoadedConfig | number> {
  try {
    return await loadConfig(ctx.io.cwd, ctx.flags.config);
  } catch (e) {
    if (e instanceof ConfigError) {
      return couldntRun(ctx, { what: e.file, lines: [e.message], tries: [`fix the file, or delete it to use the defaults`], header: true });
    }
    throw e;
  }
}

/* ---------- check ---------- */

function unreachableTries(target: string): string[] {
  return isUrl(target)
    ? ['open the URL in a browser to see if the site is up', `or check a build folder: npx ${GEO_TOOL.bin} check ./dist`]
    : ['build the site first, then check the folder it writes (dist, out, build, public)', `or check the live site: npx ${GEO_TOOL.bin} check https://your-site.com`];
}

/** A bare host ("thelewisapp.com") means https:// (http:// for localhost and IPs), unless a file or folder by that name is here. */
function toTarget(raw: string, cwd: string): string {
  if (isUrl(raw) || !looksLikeHost(raw)) return raw;
  return existsSync(isAbsolute(raw) ? raw : join(cwd, raw)) ? raw : hostToUrl(raw);
}

/** The reveal runs on page URLs: http(s), not a sitemap. Folders never reach here (they aren't URLs). */
function wantsReveal(target: string): boolean {
  if (!isUrl(target)) return false;
  try {
    return !/\.xml(\.gz)?$/i.test(new URL(target).pathname);
  } catch {
    return false;
  }
}

/** "thelewisapp.com", "www.ansa.chat/pricing": the target as typed, for the "See it" command. */
function seeItTarget(raw: string): string {
  return raw.replace(/^https:\/\//i, '').replace(/\/$/, '');
}

type RenderOutcome = { words: number } | { error: string; noBrowser: boolean } | { notNeeded: true };

const RENDER_NOT_NEEDED = "--render isn't needed here: it helps only when the page's text needs JavaScript.";

async function renderStep(io: CliIO, view: AiViewSummary): Promise<RenderOutcome> {
  if (view.result !== 'js_only' && view.result !== 'thin') return { notNeeded: true };
  const r = io.renderDom ? await io.renderDom(view.url, { env: io.env }) : { ok: false as const, reason: 'no_browser' as const, message: 'No Chrome, Chromium or Edge found.' };
  if (!r.ok) return { error: r.message, noBrowser: r.reason === 'no_browser' };
  return { words: aiView({ url: view.url, status: 200, html: r.html, robotsTxt: null }).words };
}

function renderText(o: RenderOutcome, view: AiViewSummary): { label?: string; text: string } {
  if ('notNeeded' in o) return { text: RENDER_NOT_NEEDED };
  if ('words' in o) return { label: 'Chrome', text: renderedLine(o.words, view.words) };
  if (o.noBrowser && /^CHROME_PATH/.test(o.error)) return { text: `--render: ${o.error}` };
  if (o.noBrowser) return { text: `--render: ${o.error.replace(/\.$/, '')}. Set CHROME_PATH to one to use it.` };
  return { text: `--render: couldn't render the page: ${o.error.replace(/\.$/, '')}.` };
}

async function runCheck(ctx: Ctx, positionals: string[]): Promise<number> {
  const { io, flags, style } = ctx;
  const loaded = await getConfig(ctx);
  if (typeof loaded === 'number') return loaded;
  const raw = positionals[0] ?? loaded.config.site;
  const target = raw ? toTarget(raw, io.cwd) : raw;
  if (!target) {
    return couldntRun(ctx, {
      what: 'nothing to check',
      lines: ['Give a page URL, a sitemap URL or a folder of built HTML.'],
      tries: [`npx ${GEO_TOOL.bin} check https://your-site.com`, `npx ${GEO_TOOL.bin} check ./dist`],
    });
  }
  const maxPages = flags.maxPages ?? loaded.config.maxPages ?? RULES.geoDefaultMaxPages;
  const failUnder = flags.failUnder ?? (loaded.config.failUnder ? loaded.config.failUnder : undefined);
  const clock = io.clock ?? (() => Date.now());
  const started = clock();

  let view: AiViewSummary | null = null;
  let viewError: string | null = null;
  let rendered: RenderOutcome | null = null;
  if (wantsReveal(target) && !flags.md) {
    const r = await io.engine.readAiView(target, { fetch: io.fetch, userAgent: GEO_TOOL_USER_AGENT });
    // A reveal error is printed only once the check has loaded a page: when nothing loads, "Couldn't run" says it once.
    if ('summary' in r) view = r.summary;
    else viewError = r.error;
    if (view && flags.render) rendered = await renderStep(io, view);
    if (view && !flags.json) {
      const text = rendered ? renderText(rendered, view) : undefined;
      io.stdout(renderAiViewText(view, { style, columns: io.columns, seeIt: seeItTarget(raw ?? target), rendered: text }));
    }
  } else if (flags.render && !flags.json) {
    io.stdout('--render works on a page URL (https://…), not a sitemap or a folder.\n\n');
  }

  let report: SiteReport;
  try {
    report = await io.engine.checkTarget(target, { maxPages, fetch: io.fetch, userAgent: GEO_TOOL_USER_AGENT });
  } catch (e) {
    return couldntRun(ctx, { what: target, lines: [(e as Error).message, "Nothing was checked, so there's no score."], tries: unreachableTries(target), header: true });
  }
  const loadedPages = report.pages.filter((p) => pageVerdict(p) !== 'error');
  if (loadedPages.length === 0) {
    const first = report.pages[0];
    return couldntRun(ctx, {
      what: first?.url ?? target,
      lines: [first?.error ?? 'No pages found to check.', "Nothing was checked, so there's no score."],
      tries: unreachableTries(target),
      header: true,
    });
  }

  if (viewError && !flags.json && !flags.md) io.stdout(`${style.dim(`Couldn't read the page as an AI crawler: ${sentence(viewError)}`)}\n\n`);
  const code = belowThreshold(report.score, failUnder) ? EXIT.belowThreshold : EXIT.ok;
  if (flags.json) {
    const render = flags.render ? { render: rendered && view ? { ...rendered, ...('words' in rendered ? { line: renderedLine(rendered.words, view.words) } : {}) } : null } : {};
    io.stdout(renderJson('check', code, { failUnder: failUnder ?? null, aiView: view, ...(viewError ? { aiViewError: viewError } : {}), ...render, report }));
  }
  else if (flags.md) io.stdout(`${renderCheckMarkdown(report, { failUnder })}\n\n${renderFooterMarkdown()}\n`);
  else {
    io.stdout(
      renderCheckText(report, {
        style,
        verbose: flags.verbose,
        failUnder,
        durationMs: clock() - started,
        configHint: loaded.file === null,
        columns: io.columns,
        toolLine: view === null,
      }),
    );
  }
  return code;
}

/* ---------- logs ---------- */

async function runLogs(ctx: Ctx, positionals: string[]): Promise<number> {
  const { io, flags, style } = ctx;
  const file = positionals[0];
  if (!file) return couldntRun(ctx, { what: 'no log file given', lines: [`Usage: ${GEO_TOOL.bin} logs <file>`], header: true });
  const path = isAbsolute(file) ? file : join(io.cwd, file);
  try {
    await access(path);
  } catch {
    return couldntRun(ctx, { what: file, lines: ['No such file.'], tries: ['check the path to your access log'], header: true });
  }

  const it = logFileLines(path)[Symbol.asyncIterator]();
  const head: string[] = [];
  try {
    while (head.filter((l) => l.trim()).length < 20) {
      const r = await it.next();
      if (r.done) break;
      head.push(r.value);
    }
  } catch (e) {
    return couldntRun(ctx, { what: file, lines: [`Couldn't read it: ${(e as Error).message}`], header: true });
  }
  if (!head.some((l) => l.trim())) {
    return couldntRun(ctx, { what: file, lines: ['The file is empty: there are no lines to read.'], tries: ['check the path, or wait until the server has written some requests'], header: true });
  }
  const format: LogFormat | null = flags.format ?? io.engine.detectFormat(head.filter((l) => l.trim()).slice(0, 20));
  if (!format) {
    await it.return?.(undefined);
    return couldntRun(ctx, {
      what: file,
      lines: [`Unknown log format. ${GEO_TOOL.name} reads:`, ...Object.values(LOG_FORMAT_NAME).map((n) => `· ${n}`)],
      tries: ['--format combined, cloudflare or vercel if the file is one of these with unusual lines'],
      header: true,
    });
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
    summary = await io.engine.summarizeLogs(all(), format);
  } catch (e) {
    return couldntRun(ctx, { what: file, lines: [(e as Error).message], header: true });
  }
  if (flags.json) io.stdout(renderJson('logs', EXIT.ok, { file, summary }));
  else if (flags.md) io.stdout(`${renderLogsMarkdown(summary, io.engine.bots, { heading: '##' })}\n\n${renderFooterMarkdown()}\n`);
  else io.stdout(renderLogsText(summary, { style, file, bots: io.engine.bots, verbose: flags.verbose }));
  return EXIT.ok;
}

/* ---------- prompts ---------- */

async function runPromptsCmd(ctx: Ctx, positionals: string[]): Promise<number> {
  const { io, flags, style } = ctx;
  const loaded = await getConfig(ctx);
  if (typeof loaded === 'number') return loaded;
  // Prompts typed on the command line: trimmed, empty ones dropped and repeats asked once (as in the config), so a
  // repeated prompt never costs twice.
  const typed = [...new Set(positionals.map((t) => t.trim()).filter(Boolean))];
  const specs: PromptSpec[] = typed.length ? typed.map((text) => ({ text, topic: null, stage: null })) : (loaded.config.prompts ?? []);
  const prompts = promptTexts(specs);
  const site = flags.site ?? loaded.config.site;
  if (!prompts.length || !site) {
    return couldntRun(ctx, {
      what: 'no prompts to ask',
      lines: [loaded.file ? `${loaded.file} needs "site" and "prompts".` : `There's no ${CONFIG_FILES[0]} here yet.`],
      tries: [`npx ${GEO_TOOL.bin} init https://your-site.com, then add your prompts`, `or: npx ${GEO_TOOL.bin} prompts --site your-site.com "best budgeting app"`],
    });
  }
  const placeholders = placeholderPrompts(prompts);
  if (placeholders.length) {
    return couldntRun(ctx, {
      what: loaded.file ?? 'prompts',
      lines: [`${placeholders.length === 1 ? 'A prompt still has' : `${placeholders.length} prompts still have`} a <placeholder>: "${placeholders[0]}". Nothing was sent.`],
      tries: ['write the questions people ask, e.g. "best budgeting app for beginners"'],
    });
  }
  const domain = domainOf(site);
  const topics = promptTopics(specs);
  const topicsNote = topics.length > MEASURES.topicsPerSite ? `${topics.length} topics: the desk keeps up to ${MEASURES.topicsPerSite} per site.` : undefined;
  const configLine = loaded.file && !typed.length ? `Read ${loaded.file}: ${prompts.length} prompts for ${domain}` : undefined;
  const engines = loaded.config.engines;

  if (flags.plan) {
    const plan = buildPlan(domain, specs, { engines, env: io.env, perception: flags.perception });
    if (flags.json) io.stdout(renderJson('prompts', EXIT.ok, { prompts: specs.map(promptJson), plan: planJson(plan) }));
    else if (flags.md) io.stdout(`${renderPlanMarkdown(plan, { heading: '##' })}\n\n${renderFooterMarkdown()}\n`);
    else io.stdout(renderPlanText(plan, { style, configLine, note: topicsNote }));
    return EXIT.ok;
  }

  let run;
  try {
    run = await io.engine.runPrompts(domain, prompts, {
      env: io.env,
      fetch: io.fetch,
      engines,
      brandTerms: brandTermsFor(loaded.config, domain, flags.site),
      perception: { mode: flags.perception ? 'auto' : 'off' },
    });
  } catch (e) {
    return couldntRun(ctx, { what: 'prompts', lines: [(e as Error).message] });
  }
  if (flags.json) io.stdout(renderJson('prompts', EXIT.ok, promptsJsonBody(run, specs)));
  else if (flags.md) io.stdout(`${renderPromptsMarkdown(run, prompts, { heading: '##', perception: flags.perception })}\n\n${renderFooterMarkdown()}\n`);
  else io.stdout(renderPromptsText(run, prompts, { style, configLine, note: topicsNote, perception: flags.perception }));
  return EXIT.ok;
}

/* ---------- init ---------- */

async function runInit(ctx: Ctx, positionals: string[]): Promise<number> {
  const { io } = ctx;
  for (const f of CONFIG_FILES) {
    try {
      await access(join(io.cwd, f));
      io.stdout(`${f} already exists, so nothing was written.\n`);
      return EXIT.ok;
    } catch {
      // not there
    }
  }
  const file = CONFIG_FILES[0] as string;
  await writeFile(join(io.cwd, file), starterConfig(positionals[0]), 'utf8');
  io.stdout(`Wrote ${file}. Add the questions people ask about your field to "prompts", then run: npx ${GEO_TOOL.bin} prompts\n`);
  return EXIT.ok;
}

/* ---------- mcp ---------- */

async function runMcp(ctx: Ctx, positionals: string[]): Promise<number> {
  const { io } = ctx;
  if (positionals.length) {
    io.stderr(`${GEO_TOOL.bin} mcp takes no arguments (got "${positionals[0]}").\nRun ${GEO_TOOL.bin} help mcp for usage.\n`);
    return EXIT.couldntRun;
  }
  if (ctx.flags.json || ctx.flags.md) {
    io.stderr(`${GEO_TOOL.bin} mcp speaks MCP on stdout; --json and --md don't apply.\n`);
    return EXIT.couldntRun;
  }
  if (!io.serveMcp) {
    io.stderr(`${GEO_TOOL.bin} mcp isn't available here.\n`);
    return EXIT.couldntRun;
  }
  await io.serveMcp();
  return EXIT.ok;
}

/* ---------- entry ---------- */

/** Run the CLI. Returns the exit code: 0 ok, 1 below --fail-under, 2 couldn't run. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.kind === 'version') {
    io.stdout(`${GEO_TOOL.bin} ${GEO_TOOL.version}\n`);
    return EXIT.ok;
  }
  if (parsed.kind === 'help') {
    io.stdout(HELP[parsed.command ?? 'main']);
    return EXIT.ok;
  }
  if (parsed.kind === 'error') {
    io.stderr(`${parsed.message}\nRun ${GEO_TOOL.bin} --help for usage.\n`);
    return EXIT.couldntRun;
  }
  const style = makeStyle(wantsColor({ isTTY: io.isTTY, noColorFlag: parsed.flags.noColor, env: io.env }) && !parsed.flags.json && !parsed.flags.md);
  const ctx: Ctx = { io, flags: parsed.flags, style, command: parsed.command };
  switch (parsed.command) {
    case 'check':
      return runCheck(ctx, parsed.positionals);
    case 'logs':
      return runLogs(ctx, parsed.positionals);
    case 'prompts':
      return runPromptsCmd(ctx, parsed.positionals);
    case 'init':
      return runInit(ctx, parsed.positionals);
    case 'mcp':
      return runMcp(ctx, parsed.positionals);
  }
}
