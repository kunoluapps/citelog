// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GEO_TOOL, RULES } from '@morningdesk/core';
import { EXIT, runCli } from '../src/index.js';
import { BOARD_PROMPTS, boardFail, boardMeasures, boardOneEngineFailed, captureIO, emptyRun, fakeEngine, page, site } from './helpers.js';

const CONFIG = `${GEO_TOOL.configBase}.json`;

async function emptyDir(files: Record<string, string> = {}): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'geo-cli-'));
  for (const [n, t] of Object.entries(files)) await writeFile(join(d, n), t);
  return d;
}

describe('check', () => {
  it('AC 1: no config, prints the table for up to 50 sitemap pages, exits 0, one-line hint', async () => {
    const { engine, calls } = fakeEngine();
    const c = captureIO(engine, { cwd: await emptyDir() });
    expect(await runCli(['check', 'https://example.com'], c.io)).toBe(EXIT.ok);
    expect(calls.checkTarget).toEqual([{ target: 'https://example.com', maxPages: RULES.geoDefaultMaxPages }]);
    expect(c.out()).toContain('  Page                          Score  Result');
    expect(c.out()).toContain('Site score 94  Ready (90–100)');
    expect(c.out().trimEnd().split('\n').pop()).toBe(`Done in 3.0 s. Track prompts too: npx ${GEO_TOOL.bin} init`);
    expect(c.err()).toBe('');
  });

  it('AC 2: --fail-under 80 on a site scoring 72 exits 1 and names the failed checks', async () => {
    const { engine } = fakeEngine({ checkTarget: async () => boardFail() });
    const c = captureIO(engine, { cwd: await emptyDir() });
    expect(await runCli(['check', 'https://bywell.org', '--fail-under', '80'], c.io)).toBe(EXIT.belowThreshold);
    expect(c.out()).toContain('below --fail-under 80');
    expect(c.out()).toMatch(/Failed checks: short answer \(9\)/);
    expect(c.out()).toContain('content present without JavaScript');
  });

  it('score at the threshold passes; config failUnder and maxPages apply; flags win', async () => {
    const { engine, calls } = fakeEngine({ checkTarget: async () => boardFail() });
    const d = await emptyDir({ [CONFIG]: JSON.stringify({ site: 'https://bywell.org', failUnder: 72, maxPages: 7 }) });
    expect(await runCli(['check'], captureIO(engine, { cwd: d }).io)).toBe(EXIT.ok);
    expect(calls.checkTarget[0]).toEqual({ target: 'https://bywell.org', maxPages: 7 });
    expect(await runCli(['check', '--fail-under', '73', '--max-pages', '3'], captureIO(engine, { cwd: d }).io)).toBe(EXIT.belowThreshold);
    expect(calls.checkTarget[1]?.maxPages).toBe(3);
  });

  it('exit 2 when nothing could be checked (every page errored) and says what to try', async () => {
    const dead = { ...page('/sitemap.xml', null), status: 503, checks: [], error: 'HTTP 503 Service Unavailable, 2 tries, 10 s each.' };
    const { engine } = fakeEngine({ checkTarget: async () => site([dead], { target: 'https://lovestruck.app' }) });
    const c = captureIO(engine, { cwd: await emptyDir() });
    expect(await runCli(['check', 'https://lovestruck.app'], c.io)).toBe(EXIT.couldntRun);
    expect(c.err()).toContain("COULDN'T RUN https://bywell.org/sitemap.xml");
    expect(c.err()).toContain('HTTP 503 Service Unavailable');
    expect(c.err()).toContain(`· or check a build folder: npx ${GEO_TOOL.bin} check ./dist`);
    // QA-B1 (2026-11-26): the reveal's own error isn't repeated above "Couldn't run".
    expect(c.out()).toBe('');
  });

  it('exit 2 when the engine throws, with --json carrying the error', async () => {
    const { engine } = fakeEngine({ checkTarget: async () => { throw new Error('"./nope" isn\'t a URL (http:// or https://) or a folder.'); } });
    const c = captureIO(engine, { cwd: await emptyDir() });
    expect(await runCli(['check', './nope', '--json'], c.io)).toBe(EXIT.couldntRun);
    const j = JSON.parse(c.out());
    expect(j).toMatchObject({ tool: GEO_TOOL.bin, command: 'check', exitCode: 2, error: { what: './nope' } });
  });

  it('exit 2 with no target and no config', async () => {
    const c = captureIO(fakeEngine().engine, { cwd: await emptyDir() });
    expect(await runCli(['check'], c.io)).toBe(EXIT.couldntRun);
    expect(c.err()).toContain("COULDN'T RUN nothing to check");
  });

  it('--json is the report plus exit code; --md is Markdown', async () => {
    const { engine } = fakeEngine({ checkTarget: async () => boardFail() });
    const j = captureIO(engine, { cwd: await emptyDir() });
    expect(await runCli(['check', 'https://bywell.org', '--json', '--fail-under', '80'], j.io)).toBe(1);
    const parsed = JSON.parse(j.out());
    expect(parsed).toMatchObject({ command: 'check', exitCode: 1, failUnder: 80, report: { score: 72 } });
    const m = captureIO(engine, { cwd: await emptyDir() });
    await runCli(['check', 'https://bywell.org', '--md'], m.io);
    expect(m.out()).toMatch(/^## .+: bywell\.org\n\n\*\*Score 72, Needs work\*\*/);
  });

  it('colours only on a TTY and never with --no-color or NO_COLOR', async () => {
    const run = async (isTTY: boolean, argv: string[], env = {}) => {
      const c = captureIO(fakeEngine().engine, { cwd: await emptyDir(), isTTY, env });
      await runCli(['check', 'https://ansa.chat', ...argv], c.io);
      return c.out().includes('\x1b[');
    };
    expect(await run(true, [])).toBe(true);
    expect(await run(false, [])).toBe(false);
    expect(await run(true, ['--no-color'])).toBe(false);
    expect(await run(true, [], { NO_COLOR: '1' })).toBe(false);
  });
});

describe('prompts', () => {
  it('AC 5: no engine keys skips prompts and names each env var', async () => {
    const { engine, calls } = fakeEngine();
    const d = await emptyDir({ [CONFIG]: JSON.stringify({ site: 'https://lovestruck.app', prompts: ['a', 'b', 'c', 'd', 'e'] }) });
    const c = captureIO(engine, { cwd: d });
    expect(await runCli(['prompts'], c.io)).toBe(EXIT.ok);
    expect(calls.runPrompts.map(({ site: s, prompts }) => ({ site: s, prompts }))).toEqual([{ site: 'lovestruck.app', prompts: ['a', 'b', 'c', 'd', 'e'] }]);
    expect(c.out()).toContain(`Read ${CONFIG}: 5 prompts for lovestruck.app`);
    expect(c.out()).toContain('SKIPPED No engine keys found, so no prompts were asked.');
    for (const v of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY', 'GOOGLE_API_KEY or GEMINI_API_KEY']) expect(c.out()).toContain(v);
  });

  it('AC 6: one engine fails, the others print and it is marked not checked', async () => {
    const { engine } = fakeEngine({ runPrompts: async () => boardOneEngineFailed() });
    const d = await emptyDir({ [CONFIG]: JSON.stringify({ site: 'bywell.org', prompts: BOARD_PROMPTS }) });
    const c = captureIO(engine, { cwd: d });
    expect(await runCli(['prompts'], c.io)).toBe(EXIT.ok);
    expect(c.out()).toContain('roth ira for beginners  cited    cited   -       n/c');
    expect(c.out()).toContain('NOT CHECKED Gemini: rate limit (HTTP 429) after 2 tries.');
    expect(c.out()).toContain('The other 3 engines finished.');
  });

  it('passes the environment (keys) and configured engines to the engine', async () => {
    let seen: unknown;
    const { engine } = fakeEngine({ runPrompts: async (s, _p, o) => { seen = { env: o.env, engines: o.engines }; return emptyRun(s); } });
    const d = await emptyDir({ [CONFIG]: JSON.stringify({ site: 'bywell.org', prompts: ['x'], engines: ['openai'] }) });
    await runCli(['prompts'], captureIO(engine, { cwd: d, env: { OPENAI_API_KEY: 'sk-test' } }).io);
    expect(seen).toEqual({ env: { OPENAI_API_KEY: 'sk-test' }, engines: ['openai'] });
  });

  it('positional prompts with --site work without a config; no prompts at all exits 2', async () => {
    const { engine, calls } = fakeEngine();
    expect(await runCli(['prompts', '--site', 'ansa.chat', 'best ai group chat'], captureIO(engine, { cwd: await emptyDir() }).io)).toBe(0);
    expect(calls.runPrompts[0]).toMatchObject({ site: 'ansa.chat', prompts: ['best ai group chat'] });
    const c = captureIO(engine, { cwd: await emptyDir() });
    expect(await runCli(['prompts'], c.io)).toBe(EXIT.couldntRun);
    expect(c.err()).toContain(`There's no ${CONFIG} here yet.`);
  });

  it('a bad config exits 2 and names the problem', async () => {
    const c = captureIO(fakeEngine().engine, { cwd: await emptyDir({ [CONFIG]: '{"prompts": "one"}' }) });
    expect(await runCli(['prompts'], c.io)).toBe(EXIT.couldntRun);
    expect(c.err()).toContain('"prompts" must be a list');
  });
});

describe('prompts: measures (AI search measures, AC 2, 3, 8)', () => {
  const ALL_KEYS = { OPENAI_API_KEY: 'sk-test-openai', ANTHROPIC_API_KEY: 'sk-ant-test', PERPLEXITY_API_KEY: 'pplx-test', GOOGLE_API_KEY: 'g-test' };
  const OBJECTS = [
    { text: 'roth ira for beginners', topic: 'Retirement', stage: 'discovery' },
    { text: 'roth ira vs 401k', topic: 'Retirement' },
    'bywell price',
  ];

  it('marks cells cited / named / -, lists considered-not-cited pages (Gemini by site), not collected engines and the perception line', async () => {
    const { engine, calls } = fakeEngine({ runPrompts: async () => boardMeasures() });
    const d = await emptyDir({ [CONFIG]: JSON.stringify({ site: 'bywell.org', prompts: BOARD_PROMPTS, brandTerms: ['Bywell'] }) });
    const c = captureIO(engine, { cwd: d, env: ALL_KEYS });
    expect(await runCli(['prompts', '--perception'], c.io)).toBe(EXIT.ok);
    expect(calls.runPrompts[0]?.opts).toMatchObject({ brandTerms: ['Bywell'], perception: { mode: 'auto' } });
    const out = c.out();
    expect(out).toContain('roth ira for beginners  cited    named   -       -');
    expect(out).toContain('etf vs index fund       cited    named   n/c     -');
    expect(out).toContain('  Considered, not cited:');
    expect(out).toContain('    /learn/roth-ira         ChatGPT, Claude');
    expect(out).toContain('    a bywell.org page       Gemini (2)');
    expect(out).toContain('    /learn/ira-basics       ChatGPT');
    expect(out).toContain('    Not collected for Perplexity.');
    expect(out).toContain('Perception (Claude Haiku 5.5 on ANTHROPIC_API_KEY, 4 answers about you): 3 positive · 1 neutral · 0 negative. Cost: <$0.01');
  });

  it('perception is off unless asked; no line is printed', async () => {
    const { engine, calls } = fakeEngine({ runPrompts: async () => ({ ...boardMeasures(), judge: null }) });
    const c = captureIO(engine, { cwd: await emptyDir({ [CONFIG]: JSON.stringify({ site: 'bywell.org', prompts: BOARD_PROMPTS }) }) });
    await runCli(['prompts'], c.io);
    expect(calls.runPrompts[0]?.opts.perception).toEqual({ mode: 'off' });
    expect(calls.runPrompts[0]?.opts.brandTerms).toEqual(['bywell', 'bywell.org']);
    expect(c.out()).not.toContain('Perception');
  });

  it('--perception with no OpenAI or Anthropic key says so and costs $0', async () => {
    const run = boardMeasures();
    const noKey = { ...run, judge: null, results: run.results.map((r) => ({ ...r, perceptionStatus: r.status === 'checked' && (r.cited || r.mentioned) ? ('no_key' as const) : r.perceptionStatus, perception: undefined })) };
    const c = captureIO(fakeEngine({ runPrompts: async () => noKey }).engine, { cwd: await emptyDir({ [CONFIG]: JSON.stringify({ site: 'bywell.org', prompts: BOARD_PROMPTS }) }) });
    await runCli(['prompts', '--perception'], c.io);
    expect(c.out()).toContain('Perception needs an OpenAI or Anthropic key (ANTHROPIC_API_KEY or OPENAI_API_KEY); nothing was judged, $0');
  });

  it('config prompts may be objects; only the text goes to the engine; duplicates are dropped', async () => {
    const { engine, calls } = fakeEngine();
    const d = await emptyDir({ [CONFIG]: JSON.stringify({ site: 'bywell.org', prompts: [...OBJECTS, 'bywell price'] }) });
    await runCli(['prompts'], captureIO(engine, { cwd: d }).io);
    expect(calls.runPrompts[0]?.prompts).toEqual(['roth ira for beginners', 'roth ira vs 401k', 'bywell price']);
  });

  it('AC 8: --json carries the new fields with the API\'s names, and prompts with topic and stage', async () => {
    const { engine } = fakeEngine({ runPrompts: async () => boardMeasures() });
    const d = await emptyDir({ [CONFIG]: JSON.stringify({ site: 'bywell.org', prompts: [{ text: BOARD_PROMPTS[0], topic: 'Retirement', stage: 'decision' }, BOARD_PROMPTS[1], BOARD_PROMPTS[2]] }) });
    const c = captureIO(engine, { cwd: d });
    await runCli(['prompts', '--json', '--perception'], c.io);
    const j = JSON.parse(c.out());
    expect(j.prompts).toEqual([
      { text: 'roth ira for beginners', topic: 'Retirement', stage: 'decision', stageSource: 'user' },
      { text: 'best app to learn investing', topic: null, stage: 'discovery', stageSource: 'auto' },
      { text: 'etf vs index fund', topic: null, stage: 'evaluation', stageSource: 'auto' },
    ]);
    const first = j.run.results[0];
    for (const k of ['mentioned', 'mentionSnippet', 'perceptionStatus', 'perception', 'considered', 'consideredOffsite']) expect(first, k).toHaveProperty(k);
    expect(first).toMatchObject({ mentioned: true, perceptionStatus: 'judged', perception: { value: 'positive' }, considered: [{ url: 'https://bywell.org/learn/roth-ira', host: 'bywell.org', cited: true }, { url: 'https://bywell.org/learn/ira-basics', cited: false }] });
    const gemini = j.run.results[3];
    expect(gemini.considered).toEqual([{ url: null, host: 'bywell.org', cited: false }]);
    expect(gemini.perception).toBeNull();
    expect(j.run.results[2].considered).toBeNull();
    expect(j.run.judge).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5', judged: 4, failed: 0, costUsdMicros: 540, stoppedAtLimit: false });
  });

  it('AC 8: --plan prints the plan and sends nothing, with every key set', async () => {
    const { engine, calls } = fakeEngine();
    const hosts: string[] = [];
    const d = await emptyDir({ [CONFIG]: JSON.stringify({ site: 'https://bywell.org', prompts: OBJECTS }) });
    const c = captureIO(engine, {
      cwd: d,
      env: ALL_KEYS,
      fetch: async (input) => {
        hosts.push(String(input));
        throw new Error('--plan must not call the network');
      },
    });
    expect(await runCli(['prompts', '--plan', '--perception'], c.io)).toBe(EXIT.ok);
    expect(hosts).toEqual([]);
    expect(calls.runPrompts).toEqual([]);
    expect(calls.readAiView).toEqual([]);
    expect(calls.checkTarget).toEqual([]);
    const out = c.out();
    expect(out).toContain('Plan for bywell.org: 3 prompts on 4 engines. Nothing was sent.');
    expect(out).toContain('  Retirement · 2 prompts: 1 discovery, 1 evaluation');
    expect(out).toContain('  No topic · 1 prompt: 1 decision');
    expect(out).toMatch(/ {4}roth ira vs 401k +evaluation \(auto\)/);
    expect(out).toMatch(/ {2}ChatGPT +3 +\$\d+\.\d\d/);
    expect(out).toMatch(/ {2}Perception +\d+ +[<$\d.]+ +Claude Haiku 5.5 on ANTHROPIC_API_KEY, about half the answers/);
    expect(out).toContain('first run, rough estimate from list prices');
    expect(out).toContain(`Run it: npx ${GEO_TOOL.bin} prompts --perception`);
  });

  it('--plan --json matches the API plan fields; no keys marks every engine not asked and exits 0', async () => {
    const d = await emptyDir({ [CONFIG]: JSON.stringify({ site: 'bywell.org', prompts: OBJECTS, engines: ['openai', 'gemini'] }) });
    const keyed = captureIO(fakeEngine().engine, { cwd: d, env: ALL_KEYS });
    expect(await runCli(['prompts', '--plan', '--json'], keyed.io)).toBe(EXIT.ok);
    const plan = JSON.parse(keyed.out()).plan;
    expect(Object.keys(plan).sort()).toEqual(['basis', 'byTopic', 'engines', 'judge', 'notAsked', 'prompts', 'totalUsd']);
    expect(plan.engines.map((e: { engine: string }) => e.engine)).toEqual(['openai', 'gemini']);
    expect(Object.keys(plan.engines[0]).sort()).toEqual(['answers', 'engine', 'estimateUsd', 'model']);
    expect(plan.judge).toEqual({ state: 'off' });
    expect(plan.totalUsd).toBeGreaterThan(0);

    const none = captureIO(fakeEngine().engine, { cwd: d, env: {} });
    expect(await runCli(['prompts', '--plan'], none.io)).toBe(EXIT.ok);
    expect(none.out()).toContain('NO KEYS No engine would be asked, so a run would cost $0.00.');
    expect(none.out()).toContain('Not asked (no key): ChatGPT (OPENAI_API_KEY), Gemini (GOOGLE_API_KEY or GEMINI_API_KEY).');
  });

  it('--plan and --perception work with prompts only', async () => {
    const c = captureIO(fakeEngine().engine);
    expect(await runCli(['check', 'https://bywell.org', '--plan'], c.io)).toBe(EXIT.couldntRun);
    expect(c.err()).toContain('--plan works with prompts only.');
  });
});

describe('logs', () => {
  const fixtures = new URL('./fixtures/logs/', import.meta.url).pathname;

  it('prints visits per bot with verified/unverified', async () => {
    const c = captureIO(fakeEngine().engine, { cwd: fixtures });
    expect(await runCli(['logs', 'nginx-combined.log'], c.io)).toBe(EXIT.ok);
    expect(c.out()).toContain('GPTBot');
    expect(c.out()).toContain('UNVERIFIED 3 of 97');
  });

  it('unknown format names the formats we read and exits 2', async () => {
    const c = captureIO(fakeEngine().engine, { cwd: fixtures });
    expect(await runCli(['logs', 'unknown.log'], c.io)).toBe(EXIT.couldntRun);
    expect(c.err()).toContain('Unknown log format.');
    expect(c.err()).toContain('· nginx or Apache combined');
    expect(c.err()).toContain('· Cloudflare Logpush JSON (http_requests)');
    expect(c.err()).toContain('· Vercel log drain JSON');
  });

  it('a missing file exits 2', async () => {
    const c = captureIO(fakeEngine().engine, { cwd: fixtures });
    expect(await runCli(['logs', 'nope.log'], c.io)).toBe(EXIT.couldntRun);
    expect(c.err()).toContain('No such file.');
  });
});

describe('help, version, usage errors, init', () => {
  it('--version, --help, unknown flag', async () => {
    const v = captureIO(fakeEngine().engine);
    expect(await runCli(['--version'], v.io)).toBe(0);
    expect(v.out()).toBe(`${GEO_TOOL.bin} ${GEO_TOOL.version}\n`);
    const h = captureIO(fakeEngine().engine);
    expect(await runCli(['--help'], h.io)).toBe(0);
    expect(h.out()).toContain("Exit codes: 0 ok, 1 below --fail-under, 2 couldn't run.");
    const e = captureIO(fakeEngine().engine);
    expect(await runCli(['check', '--nope'], e.io)).toBe(EXIT.couldntRun);
    expect(e.err()).toContain(`Run ${GEO_TOOL.bin} --help for usage.`);
  });

  it('init writes a starter config once', async () => {
    const d = await emptyDir();
    const c = captureIO(fakeEngine().engine, { cwd: d });
    expect(await runCli(['init', 'https://ansa.chat'], c.io)).toBe(0);
    expect(JSON.parse(await readFile(join(d, CONFIG), 'utf8')).site).toBe('https://ansa.chat');
    const again = captureIO(fakeEngine().engine, { cwd: d });
    await runCli(['init'], again.io);
    expect(again.out()).toContain('already exists');
  });
});
