// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
// Bug bash 2026-11-26 (citelog-public BUGBASH.md): the CLI features added after the 11-19 bug bash.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GEO_TOOL } from '@morningdesk/core';
import type { FetchLike } from '@morningdesk/geo';
import { EXIT, brandTermsFor, realEngine, runCli } from '../src/index.js';
import { SPA_HOME, SSR_HOME, aiViewOf, boardPass, captureIO, fakeEngine, page, site } from './helpers.js';

const CONFIG = `${GEO_TOOL.configBase}.json`;

async function dir(files: Record<string, string> = {}): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'geo-qa-'));
  for (const [n, t] of Object.entries(files)) await writeFile(join(d, n), t);
  return d;
}

const engineFixture = (name: string): string => readFileSync(new URL(`../../geo/test/fixtures/engines/${name}`, import.meta.url), 'utf8');

describe('bare URL / host (QA-P-1..6)', () => {
  it.each([
    ['BYWELL.ORG', 'https://BYWELL.ORG'],
    ['bywell.org/learn/', 'https://bywell.org/learn/'],
    ['bywell.org:8443/pricing', 'https://bywell.org:8443/pricing'],
    ['HTTP://bywell.org/learn', 'HTTP://bywell.org/learn'],
  ])('%s is checked as %s, with the reveal first', async (arg, target) => {
    const { engine, calls } = fakeEngine({ readAiView: async () => ({ summary: aiViewOf(SSR_HOME, { url: 'https://bywell.org/' }) }) });
    const c = captureIO(engine, { cwd: await dir() });
    expect(await runCli([arg], c.io)).toBe(EXIT.ok);
    expect(calls.checkTarget[0]?.target).toBe(target);
    expect(calls.readAiView).toEqual([target]);
    expect(c.out()).toContain('What AI crawlers see on');
  });

  it('a bare sitemap URL skips the reveal', async () => {
    const { engine, calls } = fakeEngine();
    const c = captureIO(engine, { cwd: await dir() });
    expect(await runCli(['bywell.org/sitemap.xml'], c.io)).toBe(EXIT.ok);
    expect(calls.checkTarget[0]?.target).toBe('https://bywell.org/sitemap.xml');
    expect(calls.readAiView).toEqual([]);
  });

  it('a folder named like a host is checked as the folder, with no reveal and no network', async () => {
    const cwd = await dir();
    await mkdir(join(cwd, 'example.com'));
    const { engine, calls } = fakeEngine();
    const c = captureIO(engine, { cwd });
    expect(await runCli(['example.com'], c.io)).toBe(EXIT.ok);
    expect(calls.checkTarget[0]?.target).toBe('example.com');
    expect(calls.readAiView).toEqual([]);
  });

  it('--md never prints the reveal (it is terminal-only) and never fetches as an AI crawler', async () => {
    const { engine, calls } = fakeEngine();
    const c = captureIO(engine, { cwd: await dir() });
    expect(await runCli(['bywell.org', '--md'], c.io)).toBe(EXIT.ok);
    expect(calls.readAiView).toEqual([]);
    expect(c.out()).not.toContain('What AI crawlers see');
    expect(c.out().startsWith('## ')).toBe(true);
  });

  it('BUG QA-B1: a page that cannot load says so once (no "Couldn\'t read the page as an AI crawler" line above "Couldn\'t run")', async () => {
    const { engine } = fakeEngine({
      readAiView: async () => ({ error: 'HTTP 404' }),
      checkTarget: async () => site([{ ...page('/nope', null), score: null, band: 'no_score', checks: [], status: 404, error: "We couldn't load https://bywell.org/nope: HTTP 404" }], { score: null, band: 'no_score' }),
    });
    const c = captureIO(engine, { cwd: await dir() });
    expect(await runCli(['bywell.org/nope'], c.io)).toBe(EXIT.couldntRun);
    expect(c.out()).not.toContain("Couldn't read the page as an AI crawler");
    expect(c.err()).toContain('HTTP 404');
  });

  it('a reveal error on a page that does load is still shown, once, before the checks', async () => {
    const { engine } = fakeEngine({ readAiView: async () => ({ error: 'timeout after 10 s' }) });
    const c = captureIO(engine, { cwd: await dir() });
    expect(await runCli(['bywell.org'], c.io)).toBe(EXIT.ok);
    expect(c.out().match(/Couldn't read the page as an AI crawler: timeout after 10 s/gi)).toHaveLength(1);
    expect(c.out().indexOf("Couldn't read the page")).toBeLessThan(c.out().indexOf('Site score'));
  });
});

describe('--render (QA-R-1..6)', () => {
  const spa = { readAiView: async () => ({ summary: aiViewOf(SPA_HOME) }) };

  it('renders only when the page needs JavaScript, and reports the people-vs-crawler words', async () => {
    const { engine } = fakeEngine(spa);
    const urls: string[] = [];
    const c = captureIO(engine, { cwd: await dir(), renderDom: async (url) => (urls.push(url), { ok: true, html: SSR_HOME, browser: 'chrome' }) });
    expect(await runCli(['thelewisapp.com', '--render'], c.io)).toBe(EXIT.ok);
    expect(urls).toEqual(['https://www.thelewisapp.com/']);
    expect(c.out()).toMatch(/Chrome People see [\d,]+ words after JavaScript runs; AI\s+crawlers see 0\./);
  });

  it('does not launch a browser for a page that already has its text', async () => {
    const { engine } = fakeEngine({ readAiView: async () => ({ summary: aiViewOf(SSR_HOME) }) });
    let launched = false;
    const c = captureIO(engine, { cwd: await dir(), renderDom: async () => ((launched = true), { ok: true, html: '', browser: 'x' }) });
    await runCli(['ansa.chat', '--render'], c.io);
    expect(launched).toBe(false);
    expect(c.out()).toContain("--render isn't needed here");
  });

  it('a missing CHROME_PATH file is named; no browser is a sentence with the fix', async () => {
    const { engine } = fakeEngine(spa);
    const bad = captureIO(engine, { cwd: await dir(), renderDom: async () => ({ ok: false, reason: 'no_browser', message: 'CHROME_PATH is set to "/nope", but there\'s no file there.' }) });
    await runCli(['thelewisapp.com', '--render'], bad.io);
    expect(bad.out()).toContain('--render: CHROME_PATH is set to "/nope"');
    const none = captureIO(engine, { cwd: await dir() });
    await runCli(['thelewisapp.com', '--render'], none.io);
    expect(none.out().replace(/\s+/g, ' ')).toContain('--render: No Chrome, Chromium or Edge found. Set CHROME_PATH to one to use it.');
  });

  it('--render --json puts the rendered count in "render"; on a sitemap it is null and nothing launches', async () => {
    const { engine } = fakeEngine(spa);
    const c = captureIO(engine, { cwd: await dir(), renderDom: async () => ({ ok: true, html: SSR_HOME, browser: 'chrome' }) });
    await runCli(['thelewisapp.com', '--render', '--json'], c.io);
    const j = JSON.parse(c.out());
    expect(j.render.words).toBeGreaterThan(100);
    expect(j.render.line).toMatch(/^People see/);
    const s = captureIO(fakeEngine().engine, { cwd: await dir(), renderDom: async () => { throw new Error('must not launch'); } });
    await runCli(['bywell.org/sitemap.xml', '--render', '--json'], s.io);
    expect(JSON.parse(s.out()).render).toBeNull();
  });

  it('--render with --md, or on logs/prompts, is refused before anything runs', async () => {
    for (const argv of [['bywell.org', '--render', '--md'], ['logs', 'x.log', '--render'], ['prompts', '--render']]) {
      const { engine, calls } = fakeEngine();
      const c = captureIO(engine, { cwd: await dir() });
      expect(await runCli(argv, c.io)).toBe(EXIT.couldntRun);
      expect(c.err()).toContain('--render works with check only');
      expect(calls.checkTarget).toEqual([]);
    }
  });
});

describe('prompts: objects, brandTerms, --plan, --perception (QA-PR-*)', () => {
  it('BUG QA-B2: --site for another domain does not borrow the config site\'s brandTerms', async () => {
    const cwd = await dir({ [CONFIG]: JSON.stringify({ site: 'bywell.org', brandTerms: ['Bywell'], prompts: ['best investing app'] }) });
    const { engine, calls } = fakeEngine();
    await runCli(['prompts', '--site', 'ansa.chat'], captureIO(engine, { cwd }).io);
    expect(calls.runPrompts[0]?.site).toBe('ansa.chat');
    expect(calls.runPrompts[0]?.opts.brandTerms).toEqual(['ansa', 'ansa.chat']);
    await runCli(['prompts', '--site', 'https://www.bywell.org/learn'], captureIO(engine, { cwd }).io);
    expect(calls.runPrompts[1]?.opts.brandTerms).toEqual(['Bywell']);
    expect(brandTermsFor({ brandTerms: ['Bywell'] }, 'ansa.chat', 'ansa.chat')).toEqual(['Bywell']);
  });

  it('BUG QA-B3: a prompt typed twice is asked once (it would cost twice)', async () => {
    const { engine, calls } = fakeEngine();
    await runCli(['prompts', '--site', 'bywell.org', 'roth ira', ' roth ira ', 'etf vs index fund'], captureIO(engine, { cwd: await dir() }).io);
    expect(calls.runPrompts[0]?.prompts).toEqual(['roth ira', 'etf vs index fund']);
  });

  it('prompt objects send only their text; topic and stage never reach an engine', async () => {
    const cwd = await dir({
      [`${GEO_TOOL.configBase}.yaml`]: 'site: bywell.org\nprompts:\n  - text: what is a roth ira\n    topic: Retirement\n    stage: decision\n  - plain prompt\n',
    });
    const { engine, calls } = fakeEngine();
    expect(await runCli(['prompts'], captureIO(engine, { cwd }).io)).toBe(EXIT.ok);
    expect(calls.runPrompts[0]?.prompts).toEqual(['what is a roth ira', 'plain prompt']);
  });

  it.each([
    [{ site: 'bywell.org', prompts: [{ text: 'x', stage: 'buy' }] }, '"stage" must be one of'],
    [{ site: 'bywell.org', prompts: [{ text: '   ' }] }, '"text" must be the question people ask'],
    [{ site: 'bywell.org', prompts: [{ text: 'x', topic: '' }] }, '"topic" must be a name'],
    [{ site: 'bywell.org', prompts: [{ text: 'x', why: 'y' }] }, 'unknown key "why"'],
    [{ site: 'bywell.org', prompts: [''] }, 'is empty'],
    [{ site: 'bywell.org', prompts: ['q'], brandTerms: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'up to 5 names'],
    [{ site: 'bywell.org', prompts: ['q'], brandTerms: ['ok', ' '] }, 'up to 5 names'],
    [{ site: 'bywell.org', prompts: ['q'], brandTerms: 'Bywell' }, 'up to 5 names'],
  ])('a bad config is refused before anything is sent (%j)', async (cfg, msg) => {
    const { engine, calls } = fakeEngine();
    const c = captureIO(engine, { cwd: await dir({ [CONFIG]: JSON.stringify(cfg) }) });
    expect(await runCli(['prompts', '--plan'], c.io)).toBe(EXIT.couldntRun);
    expect(c.err()).toContain(msg);
    expect(calls.runPrompts).toEqual([]);
  });

  it('--plan with no prompts, or a <placeholder> prompt, sends nothing and exits 2', async () => {
    for (const cfg of [{ site: 'bywell.org' }, { site: 'bywell.org', prompts: ['best <thing> app'] }]) {
      const { engine, calls } = fakeEngine();
      const c = captureIO(engine, { cwd: await dir({ [CONFIG]: JSON.stringify(cfg) }), env: { OPENAI_API_KEY: 'sk-FAKE' } });
      expect(await runCli(['prompts', '--plan'], c.io)).toBe(EXIT.couldntRun);
      expect(calls.runPrompts).toEqual([]);
    }
  });

  it('more than 12 topics is a note, not a refusal', async () => {
    const prompts = Array.from({ length: 14 }, (_, i) => ({ text: `question ${i}`, topic: `T${i}` }));
    const c = captureIO(fakeEngine().engine, { cwd: await dir({ [CONFIG]: JSON.stringify({ site: 'bywell.org', prompts }) }) });
    expect(await runCli(['prompts', '--plan'], c.io)).toBe(EXIT.ok);
    expect(c.out()).toContain('14 topics: the desk keeps up to 12 per site.');
  });

  it('--plan --perception: judge by key (Haiku before Luna, no key = needs a key); --json and --md agree', async () => {
    const cwd = await dir({ [CONFIG]: JSON.stringify({ site: 'bywell.org', prompts: ['a', 'b'] }) });
    const plan = async (env: Record<string, string>, fmt: string[] = ['--json']) => {
      const c = captureIO(fakeEngine().engine, { cwd, env, fetch: async () => { throw new Error('--plan must not fetch'); } });
      expect(await runCli(['prompts', '--plan', '--perception', ...fmt], c.io)).toBe(EXIT.ok);
      return c.out();
    };
    expect(JSON.parse(await plan({ OPENAI_API_KEY: 'sk-FAKE', ANTHROPIC_API_KEY: 'sk-ant-FAKE' })).plan.judge).toMatchObject({ provider: 'anthropic' });
    expect(JSON.parse(await plan({ OPENAI_API_KEY: 'sk-FAKE' })).plan.judge).toMatchObject({ provider: 'openai' });
    expect(JSON.parse(await plan({ PERPLEXITY_API_KEY: 'pplx-FAKE' })).plan.judge).toEqual({ state: 'no_key' });
    expect(await plan({ PERPLEXITY_API_KEY: 'pplx-FAKE' }, ['--md'])).toContain('needs ANTHROPIC\\_API\\_KEY or OPENAI\\_API\\_KEY');
  });

  it('end to end on the real engine: brandTerms make Named, --perception judges it, only engine hosts are called', async () => {
    const hosts: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      const u = new URL(input);
      hosts.push(u.host);
      expect(u.host).toBe('api.openai.com');
      const body = String(init?.body ?? '');
      const judge = !body.includes('web_search');
      return new Response(engineFixture(judge ? 'judge-openai.json' : 'openai-considered.json'), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const cwd = await dir({ [CONFIG]: JSON.stringify({ site: 'example.com', brandTerms: ['Example'], engines: ['openai'], prompts: [{ text: 'roth ira app for beginners', topic: 'Retirement' }] }) });
    const c = captureIO(realEngine, { cwd, env: { OPENAI_API_KEY: 'sk-openai-FAKEFAKEFAKE' }, fetch });
    expect(await runCli(['prompts', '--perception', '--json'], c.io)).toBe(EXIT.ok);
    const j = JSON.parse(c.out());
    const r = j.run.results[0];
    expect(r).toMatchObject({ engine: 'openai', status: 'checked', cited: true, mentioned: true, perceptionStatus: 'judged', perception: { value: 'neutral' } });
    expect(r.mentionSnippet).toContain('Example');
    expect(j.prompts[0]).toMatchObject({ text: 'roth ira app for beginners', topic: 'Retirement', stageSource: 'auto' });
    expect(new Set(hosts)).toEqual(new Set(['api.openai.com']));
    expect(JSON.stringify(j)).not.toContain('sk-openai-FAKEFAKEFAKE');
  });

  it('end to end: without --perception the judge is never called', async () => {
    const bodies: string[] = [];
    const fetch: FetchLike = async (_input, init) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(engineFixture('openai-considered.json'), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const cwd = await dir({ [CONFIG]: JSON.stringify({ site: 'example.com', engines: ['openai'], prompts: ['roth ira app for beginners'] }) });
    const c = captureIO(realEngine, { cwd, env: { OPENAI_API_KEY: 'sk-openai-FAKEFAKEFAKE', ANTHROPIC_API_KEY: 'sk-ant-FAKE' }, fetch });
    expect(await runCli(['prompts', '--json'], c.io)).toBe(EXIT.ok);
    expect(bodies).toHaveLength(1);
    const r = JSON.parse(c.out()).run.results[0];
    expect(r.mentioned).toBe(true); // default brand terms: "example", "example.com"
    expect(r.perceptionStatus).not.toBe('judged');
  });
});

describe('unchanged: the board pass report still renders after the reveal changes', () => {
  it('check on a URL with a reveal prints both blocks', async () => {
    const { engine } = fakeEngine({ readAiView: async () => ({ summary: aiViewOf(SSR_HOME, { url: 'https://ansa.chat/' }) }), checkTarget: async () => boardPass() });
    const c = captureIO(engine, { cwd: await dir() });
    expect(await runCli(['ansa.chat'], c.io)).toBe(EXIT.ok);
    expect(c.out()).toContain('What AI crawlers see on your home page');
    expect(c.out()).toContain('Site score 94');
  });
});

describe('QA-B6: a local dev server as a bare host', () => {
  it('`citelog localhost:3000` and `citelog 127.0.0.1:8080` check over http://', async () => {
    for (const [arg, url] of [
      ['localhost:3000', 'http://localhost:3000'],
      ['127.0.0.1:8080/pricing', 'http://127.0.0.1:8080/pricing'],
      ['bywell.org', 'https://bywell.org'],
    ] as const) {
      const { engine, calls } = fakeEngine();
      const c = captureIO(engine, { cwd: await dir() });
      expect(await runCli([arg, '--json'], c.io)).toBe(EXIT.ok);
      expect(calls.checkTarget[0]?.target, arg).toBe(url);
    }
  });
});
