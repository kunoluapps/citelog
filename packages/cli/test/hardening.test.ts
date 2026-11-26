// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/** FIX-P1 findings turned into checks: Markdown escaping, --md footer, init placeholders, gzip and empty logs, wrapping. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { GEO_TOOL } from '@morningdesk/core';
import { realEngine } from '../src/geo/engine.js';
import { describe, expect, it } from 'vitest';
import { EXIT, belowThreshold, makeStyle, mdCell, mdCode, renderCheckMarkdown, renderCheckText, runCli, stripAnsi } from '../src/index.js';
import { boardFail, captureIO, fakeEngine } from './helpers.js';

const CONFIG = `${GEO_TOOL.configBase}.json`;
const plain = makeStyle(false);

async function dir(files: Record<string, string | Uint8Array> = {}): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'geo-cli-hard-'));
  for (const [n, t] of Object.entries(files)) await writeFile(join(d, n), t);
  return d;
}

describe('Markdown escaping of page-controlled text (M6)', () => {
  it('neutralises @mentions, #refs, links, images, HTML and code fences', () => {
    const hostile = '@octocat see #12 ![x](https://evil.example/a.png) [click](https://evil.example) <img src=x> `code` **bold** | pipe';
    const cell = mdCell(hostile);
    expect(cell).not.toMatch(/@[A-Za-z0-9]/);
    expect(cell).not.toMatch(/#\d/);
    expect(cell).not.toMatch(/(?<!\\)\[/);
    expect(cell).not.toMatch(/(?<!\\)!(?!\\\[)/);
    expect(cell).not.toContain('<img');
    expect(cell).not.toMatch(/(?<!\\)`/);
    expect(cell).not.toMatch(/(?<!\\)\*/);
    expect(cell).not.toMatch(/(?<!\\)\|/);
    expect(cell.replace(/\u200b/g, '').replace(/\\(.)/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')).toBe(hostile);
  });

  it('keeps a code span closed whatever the value holds', () => {
    expect(mdCode('a`b')).toBe('``a`b``');
    expect(mdCode('`x`')).toBe('`` `x` ``');
    expect(mdCode('a|b')).toBe('`a\\|b`');
  });

  it('escapes a page path with markdown in it inside the report', () => {
    const r = boardFail();
    r.pages[0]!.url = 'https://bywell.org/@octocat/[x](y)';
    const md = renderCheckMarkdown(r);
    expect(md).toContain('/@\u200boctocat/\\[x\\]\\(y\\)');
  });
});

describe('--md output', () => {
  it('ends with the tool footer (M3)', async () => {
    const c = captureIO(fakeEngine().engine, { cwd: await dir() });
    await runCli(['check', 'https://bywell.org', '--md'], c.io);
    expect(c.out().trimEnd().endsWith(`${GEO_TOOL.name} ${GEO_TOOL.version}, part of Morningdesk.`)).toBe(true);
  });
});

describe('threshold rule', () => {
  it('no score misses a threshold; no threshold never misses', () => {
    expect(belowThreshold(null, 50)).toBe(true);
    expect(belowThreshold(null, undefined)).toBe(false);
    expect(belowThreshold(72, 80)).toBe(true);
    expect(belowThreshold(80, 80)).toBe(false);
  });
});

describe('init and placeholder prompts (M4)', () => {
  it('writes no prompts, explains what to add, and refuses to send <placeholder> prompts', async () => {
    const d = await dir();
    await runCli(['init', 'https://ansa.chat'], captureIO(fakeEngine().engine, { cwd: d }).io);
    const cfg = JSON.parse(await readFile(join(d, CONFIG), 'utf8')) as { prompts: string[]; $comment: string };
    expect(cfg.prompts).toEqual([]);
    expect(cfg.$comment).toContain('prompts');

    const { engine, calls } = fakeEngine();
    const p = await dir({ [CONFIG]: JSON.stringify({ site: 'ansa.chat', prompts: ['best <your category> app'] }) });
    const c = captureIO(engine, { cwd: p, env: { OPENAI_API_KEY: 'sk-test' } });
    expect(await runCli(['prompts'], c.io)).toBe(EXIT.couldntRun);
    expect(c.err()).toContain('<placeholder>');
    expect(calls.runPrompts).toHaveLength(0);
  });
});

describe('logs files', () => {
  const line = '66.249.66.1 - - [15/Nov/2026:10:00:00 +0000] "GET /a HTTP/1.1" 200 512 "-" "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"';

  it('reads a gzip log transparently (Cloudflare Logpush writes .gz)', async () => {
    const d = await dir({ 'access.log.gz': gzipSync(`${line}\n${line}\n`) });
    const c = captureIO(realEngine, { cwd: d });
    expect(await runCli(['logs', 'access.log.gz', '--json'], c.io)).toBe(EXIT.ok);
    const j = JSON.parse(c.out()) as { summary: { linesRead: number; bots: { botId: string; hits: number }[] } };
    expect(j.summary.linesRead).toBe(2);
    expect(j.summary.bots[0]).toMatchObject({ botId: 'gptbot', hits: 2 });
  });

  it('says an empty file is empty, not an unknown format', async () => {
    const d = await dir({ 'empty.log': '\n\n' });
    const c = captureIO(realEngine, { cwd: d });
    expect(await runCli(['logs', 'empty.log'], c.io)).toBe(EXIT.couldntRun);
    expect(c.err()).toContain('The file is empty');
  });

  it('counts requests in a JSON-array line separately from lines', async () => {
    const entry = (p: string) => ({ timestamp: 1763200000000, proxy: { clientIp: '1.2.3.4', path: p, method: 'GET', statusCode: 200, userAgent: ['GPTBot/1.2'] } });
    const d = await dir({ 'vercel.json': `${JSON.stringify([entry('/a'), entry('/b'), entry('/c')])}\n` });
    const c = captureIO(realEngine, { cwd: d });
    expect(await runCli(['logs', 'vercel.json', '--format', 'vercel'], c.io)).toBe(EXIT.ok);
    expect(c.out()).toContain('1 line (3 requests)');
  });
});

describe('terminal wrapping (L9, D2)', () => {
  it('keeps every line within the terminal width and names at most three failed checks', () => {
    const text = renderCheckText(boardFail(), { style: plain, failUnder: 80, columns: 60 });
    for (const l of stripAnsi(text).split('\n')) expect(l.length).toBeLessThanOrEqual(60);
    expect(text.replace(/\n\s+/g, ' ')).toMatch(/Failed checks: short answer \(9\), question headings \(5\), AI crawlers blocked \(3\), 3 more/);
    expect(text).toContain('3 more');
  });
});

describe('badge on light and dark READMEs (M4)', () => {
  it('is one SVG with an inset stroked edge', async () => {
    const { renderBadgeSvg } = await import('../src/index.js');
    const svg = renderBadgeSvg(72);
    expect(svg).toContain('<rect x="0.5" y="0.5" width="169" height="19"');
    expect(svg).toContain('stroke="#46443E"');
    expect(svg).not.toContain('prefers-color-scheme');
  });
});
