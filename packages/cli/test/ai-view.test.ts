// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_VIEW_COPY, type AiViewSummary } from '@morningdesk/core';
import {
  EXIT,
  chromeArgs,
  chromeCandidates,
  findChrome,
  makeStyle,
  parseCliArgs,
  renderAiViewText,
  runCli,
  stripAnsi,
  type RenderDom,
} from '../src/index.js';
import { SPA_HOME, SSR_HOME, aiViewOf, captureIO, fakeEngine } from './helpers.js';

const plain = makeStyle(false);

const lewis = (): AiViewSummary => aiViewOf(SPA_HOME);
const ansa = (): AiViewSummary => aiViewOf(SSR_HOME, { url: 'https://ansa.chat/' });

function engineWith(view: AiViewSummary | { error: string }) {
  return fakeEngine({ readAiView: async () => ('error' in view ? view : { summary: view }) });
}

/** A launcher that records calls and returns a rendered page with `words` words. */
function fakeLauncher(words: number) {
  const calls: string[] = [];
  const renderDom: RenderDom = async (url) => {
    calls.push(url);
    return { ok: true, html: `<html><body><div id="root"><p>${'word '.repeat(words)}</p></div></body></html>`, browser: '/fake/chrome' };
  };
  return { renderDom, calls };
}

async function emptyDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'geo-cli-aiview-'));
}

describe('`citelog <url>` alias', () => {
  it.each([
    [['thelewisapp.com'], ['thelewisapp.com']],
    [['https://ansa.chat'], ['https://ansa.chat']],
    [['www.ansa.chat/pricing', '--json'], ['www.ansa.chat/pricing']],
    [['http://localhost:3000/'], ['http://localhost:3000/']],
  ])('%j is check', (argv, positionals) => {
    const p = parseCliArgs(argv);
    expect(p.kind === 'run' && p.command).toBe('check');
    expect(p.kind === 'run' && p.positionals).toEqual(positionals);
  });

  it.each([['frobnicate'], ['sitemap.xml'], ['./dist'], ['index.html']])('%s still errors as an unknown command', (word) => {
    const p = parseCliArgs([word]);
    expect(p.kind).toBe('error');
    expect(p.kind === 'error' && p.message).toContain(`Unknown command "${word}"`);
  });

  it('parses --render, for check only and not with --md', () => {
    const p = parseCliArgs(['thelewisapp.com', '--render']);
    expect(p.kind === 'run' && p.flags.render).toBe(true);
    for (const argv of [['logs', 'a.log', '--render'], ['prompts', '--render'], ['thelewisapp.com', '--render', '--md']]) {
      const e = parseCliArgs(argv);
      expect(e.kind === 'error' && e.message).toBe('--render works with check only, in text or --json output.');
    }
  });

  it('help puts `npx citelog <url>` first', async () => {
    const h = captureIO(fakeEngine().engine);
    await runCli(['--help'], h.io);
    const firstCommand = h.out().split('\n').find((l) => /citelog /.test(l) && l.startsWith('  '));
    expect(firstCommand).toMatch(/^ {2}npx citelog <url>/);
    expect(h.out()).toContain('--render');
  });

  it('a bare host is checked over https, and the reveal reads the same URL', async () => {
    const { engine, calls } = engineWith(ansa());
    const c = captureIO(engine, { cwd: await emptyDir() });
    expect(await runCli(['ansa.chat'], c.io)).toBe(EXIT.ok);
    expect(calls.readAiView).toEqual(['https://ansa.chat']);
    expect(calls.checkTarget[0]?.target).toBe('https://ansa.chat');
  });
});

describe('reveal block (board 10b, CLI block)', () => {
  it('Lewis-like SPA: 0 words, title, empty root, FAIL, fix and See it', () => {
    const text = renderAiViewText(lewis(), { style: plain, seeIt: 'thelewisapp.com' });
    expect(text).toBe(
      [
        'Citelog 0.1 · thelewisapp.com',
        '',
        'What AI crawlers see on your home page',
        '  Words of text   0',
        '  Headline        none',
        '  Title           Lewis: AI Car Diagnostics | OBD2 Codes and',
        '                  Live Data',
        '  App root        <div id="root"> is empty',
        '  robots.txt      allows all main AI crawlers',
        '',
        'FAIL  ChatGPT, Perplexity and Claude get no text to quote.',
        '      People see text only after JavaScript runs.',
        'Fix   Render the main text on the server (SSR or a',
        '      static build) so it is in the HTML.',
        'See it npx citelog thelewisapp.com --render',
        "      (uses Chrome if you have it; the page's own scripts",
        '      load as usual, nothing is sent to us)',
        '',
        '',
      ].join('\n'),
    );
  });

  it('SSR page: words, headline, FAQ, PASS, no fix and no See it', () => {
    const text = renderAiViewText(ansa(), { style: plain, seeIt: 'ansa.chat' });
    expect(text).toBe(
      [
        'Citelog 0.1 · ansa.chat',
        '',
        'What AI crawlers see on your home page',
        `  Words of text   ${ansa().words.toLocaleString('en-US')}`,
        '  Headline        AI customer support for small businesses.',
        '  FAQ             FAQ section with FAQPage data',
        '  robots.txt      allows all main AI crawlers',
        '',
        'PASS  AI crawlers read the same text people do.',
        '',
        '',
      ].join('\n'),
    );
  });

  it('names the path when it is not the home page', () => {
    const v = aiViewOf(SSR_HOME, { url: 'https://ansa.chat/pricing' });
    expect(renderAiViewText(v, { style: plain })).toContain('What AI crawlers see on /pricing\n');
  });

  it('firewall: names what a browser got and what the AI-crawler request got', () => {
    const v = aiViewOf(SSR_HOME, { url: 'https://ansa.chat/', crawler: { status: 403, headers: {}, html: 'Forbidden' } });
    const text = renderAiViewText(v, { style: plain });
    expect(text).toContain('  As a browser       200 · page loads\n');
    expect(text).toContain('  As an AI crawler   403 · blocked\n');
    expect(text).toContain('FAIL  Your firewall or CDN turns AI crawlers away (or bots\n      claiming to be them).');
    expect(text).toMatch(/Fix {3}Check your CDN’s bot settings/);
    expect(text).not.toContain('See it');
  });

  it('firewall challenge page says so; no answer is not a firewall', () => {
    const challenge = aiViewOf(SSR_HOME, { crawler: { status: 200, headers: { 'cf-mitigated': 'challenge' }, html: '' } });
    expect(renderAiViewText(challenge, { style: plain })).toContain('As an AI crawler   200 · challenge page');
    const none = aiViewOf(SSR_HOME, { crawler: { status: null, headers: {}, html: '', error: 'timeout after 10 s' } });
    expect(renderAiViewText(none, { style: plain })).not.toContain('As an AI crawler');
  });

  it('robots.txt blocking main crawlers, with the training and grounding notes from the shared copy', () => {
    const robotsTxt = 'User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\n';
    const view = aiViewOf(SSR_HOME, { url: 'https://ansa.chat/', robotsTxt });
    const text = renderAiViewText(view, { style: plain, columns: 200 }).replace(/\n {18}/g, ' ');
    const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
    expect(text).toContain(`  robots.txt      ${lower(AI_VIEW_COPY.robotsBlocks(['OAI-SearchBot', 'PerplexityBot']))} ${lower(AI_VIEW_COPY.trainingNote(['GPTBot']))} ${lower(AI_VIEW_COPY.groundingNote(['Google-Extended']))}\n`);
    expect(text).toContain('blocks GPTBot. That stops training, not answers.');
    expect(text).toContain('FAIL  robots.txt blocks OAI-SearchBot and PerplexityBot');
  });

  it('colour only repeats the words, and every line fits the terminal', () => {
    const coloured = renderAiViewText(lewis(), { style: makeStyle(true), seeIt: 'thelewisapp.com' });
    expect(coloured).toContain('\x1b[');
    expect(stripAnsi(coloured)).toBe(renderAiViewText(lewis(), { style: plain, seeIt: 'thelewisapp.com' }));
    for (const l of renderAiViewText(lewis(), { style: plain, seeIt: 'thelewisapp.com', columns: 48 }).split('\n')) expect(l.length).toBeLessThanOrEqual(48);
  });
});

describe('check with the reveal', () => {
  it('prints the reveal first, then the checks without a second tool line', async () => {
    const { engine } = engineWith(lewis());
    const c = captureIO(engine, { cwd: await emptyDir() });
    expect(await runCli(['thelewisapp.com'], c.io)).toBe(EXIT.ok);
    const out = c.out();
    expect(out.startsWith('Citelog 0.1 · thelewisapp.com\n')).toBe(true);
    expect(out).toContain('See it npx citelog thelewisapp.com --render\n');
    expect(out).toContain(`nothing is sent to us)\n\nRead the site's sitemap: 12 pages\n`);
    expect(out).not.toContain('part of');
  });

  it('unreachable: one line instead of the reveal, then the check as before', async () => {
    const { engine, calls } = engineWith({ error: 'HTTP 503' });
    const c = captureIO(engine, { cwd: await emptyDir() });
    await runCli(['check', 'https://lovestruck.app'], c.io);
    expect(calls.readAiView).toEqual(['https://lovestruck.app']);
    expect(c.out()).not.toContain('What AI crawlers see');
    expect(c.out().split('\n')[0]).toBe("Couldn't read the page as an AI crawler: HTTP 503.");
    expect(c.out().split('\n')[2]).toMatch(/^citelog .* · part of /);
  });

  it('sitemaps, folders and --md get no reveal and no extra request', async () => {
    const { engine, calls } = engineWith(lewis());
    const d = await emptyDir();
    await runCli(['check', 'https://bywell.org/sitemap.xml'], captureIO(engine, { cwd: d }).io);
    await runCli(['check', 'https://bywell.org/sitemap.xml.gz'], captureIO(engine, { cwd: d }).io);
    await runCli(['check', './dist'], captureIO(engine, { cwd: d }).io);
    const md = captureIO(engine, { cwd: d });
    await runCli(['check', 'https://bywell.org', '--md'], md.io);
    expect(calls.readAiView).toEqual([]);
    expect(md.out()).not.toContain('What AI crawlers see');
  });

  it('--json gains aiView (the summary, or null)', async () => {
    const j = captureIO(engineWith(ansa()).engine, { cwd: await emptyDir() });
    await runCli(['https://ansa.chat', '--json'], j.io);
    const parsed = JSON.parse(j.out());
    expect(parsed.aiView).toMatchObject({ result: 'ok', words: ansa().words, headline: 'AI customer support for small businesses.' });
    expect(parsed).not.toHaveProperty('render');
    const none = captureIO(engineWith({ error: 'HTTP 503' }).engine, { cwd: await emptyDir() });
    await runCli(['https://ansa.chat', '--json'], none.io);
    expect(JSON.parse(none.out())).toMatchObject({ aiView: null, aiViewError: 'HTTP 503' });
  });
});

describe('--render', () => {
  it('never launches a browser without --render', async () => {
    const l = fakeLauncher(500);
    const c = captureIO(engineWith(lewis()).engine, { cwd: await emptyDir(), renderDom: l.renderDom });
    await runCli(['thelewisapp.com'], c.io);
    await runCli(['thelewisapp.com', '--json'], c.io);
    expect(l.calls).toEqual([]);
  });

  it('js_only runs the launcher and prints what people see', async () => {
    const l = fakeLauncher(1240);
    const c = captureIO(engineWith(lewis()).engine, { cwd: await emptyDir(), renderDom: l.renderDom });
    expect(await runCli(['thelewisapp.com', '--render'], c.io)).toBe(EXIT.ok);
    expect(l.calls).toEqual(['https://www.thelewisapp.com/']);
    expect(c.out()).toContain('Chrome People see 1,240 words after JavaScript runs; AI\n      crawlers see 0.\n');
    expect(c.out()).not.toContain('See it');
  });

  it('a page that is fine does not launch it and says so in one line', async () => {
    const l = fakeLauncher(500);
    const c = captureIO(engineWith(ansa()).engine, { cwd: await emptyDir(), renderDom: l.renderDom });
    await runCli(['ansa.chat', '--render'], c.io);
    expect(l.calls).toEqual([]);
    expect(c.out()).toContain("--render isn't needed here");
  });

  it('no browser found: one line on CHROME_PATH, exit code unchanged', async () => {
    const renderDom: RenderDom = async () => ({ ok: false, reason: 'no_browser', message: 'No Chrome, Chromium or Edge found.' });
    const c = captureIO(engineWith(lewis()).engine, { cwd: await emptyDir(), renderDom });
    expect(await runCli(['thelewisapp.com', '--render'], c.io)).toBe(EXIT.ok);
    expect(stripAnsi(c.out()).replace(/\n/g, ' ')).toContain('--render: No Chrome, Chromium or Edge found. Set CHROME_PATH to one to use it.');
  });

  it('--json --render carries the rendered word count', async () => {
    const l = fakeLauncher(30);
    const c = captureIO(engineWith(lewis()).engine, { cwd: await emptyDir(), renderDom: l.renderDom });
    await runCli(['thelewisapp.com', '--render', '--json'], c.io);
    expect(JSON.parse(c.out()).render).toMatchObject({ words: 30 });
  });
});

describe('finding a local Chrome', () => {
  it('CHROME_PATH first, and says when it points nowhere', () => {
    expect(findChrome({ CHROME_PATH: '/opt/chrome' }, 'linux', (p) => p === '/opt/chrome')).toEqual({ path: '/opt/chrome' });
    expect(findChrome({ CHROME_PATH: '/nope' }, 'linux', () => false)).toEqual({ error: 'CHROME_PATH is set to "/nope", but there\'s no file there.' });
  });

  it('standard paths per platform', () => {
    expect(chromeCandidates({}, 'darwin')[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(chromeCandidates({ PATH: '/usr/bin:/snap/bin' }, 'linux')).toContain('/snap/bin/chromium');
    expect(chromeCandidates({ PROGRAMFILES: 'C:\\Program Files' }, 'win32')[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(findChrome({ PATH: '/usr/bin' }, 'linux', (p) => p === '/usr/bin/chromium-browser')).toEqual({ path: '/usr/bin/chromium-browser' });
    expect(findChrome({}, 'linux', () => false)).toBeNull();
  });

  it('headless flags with a throwaway profile, the URL last', () => {
    expect(chromeArgs('/tmp/p', 'https://x.com/')).toEqual([
      '--headless=new',
      '--dump-dom',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-pings',
      '--user-data-dir=/tmp/p',
      'https://x.com/',
    ]);
  });
});
