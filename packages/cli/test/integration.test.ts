// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, realEngine, runCli } from '../src/index.js';
import { captureIO } from './helpers.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/site/${name}`, import.meta.url), 'utf8');
const logs = new URL('./fixtures/logs/', import.meta.url).pathname;
const bundle = new URL('../dist/citelog.mjs', import.meta.url).pathname;

let server: Server;
let origin = '';
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req.url ?? '');
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    switch (req.url) {
      case '/robots.txt':
        return send(200, 'text/plain', `User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`);
      case '/sitemap.xml':
        return send(200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/learn/roth-ira</loc></url><url><loc>${origin}/pricing</loc></url><url><loc>${origin}/learn/extra</loc></url></urlset>`);
      case '/learn/roth-ira':
      case '/learn/extra':
        return send(200, 'text/html; charset=utf-8', fixture('good.html').replaceAll('__ORIGIN__', origin));
      case '/pricing':
        return send(200, 'text/html; charset=utf-8', fixture('js-only.html').replaceAll('__ORIGIN__', origin));
      case '/down/sitemap.xml':
        return send(503, 'text/plain', 'down');
      default:
        return send(404, 'text/plain', 'not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Records every host the CLI fetches (AC 10: only the site checked). */
function recordingFetch(hosts: Set<string>) {
  return (input: string, init?: RequestInit) => {
    hosts.add(new URL(input).host);
    return fetch(input, init);
  };
}

describe('CLI end to end on a local fixture site (real engine)', () => {
  it('check: sitemap pages, robots block is a failed check, JS-only page fails, network only to the site', async () => {
    const hosts = new Set<string>();
    const c = captureIO(realEngine, { fetch: recordingFetch(hosts), cwd: logs });
    const code = await runCli(['check', `${origin}/sitemap.xml`, '--max-pages', '2', '--json'], c.io);
    const j = JSON.parse(c.out());
    expect(code).toBe(EXIT.ok);
    expect(j.report.kind).toBe('sitemap');
    expect(j.report.pages).toHaveLength(2);
    expect(j.report.truncated).toEqual({ limit: 2, total: 3 });
    const pricing = j.report.pages.find((p: { url: string }) => p.url.endsWith('/pricing'));
    const noJs = pricing.checks.find((x: { id: string }) => x.id === 'no_js_content');
    expect(noJs.result).toBe('fail');
    const robots = pricing.checks.find((x: { id: string }) => x.id === 'robots_ai');
    expect(robots.result).toBe('fail');
    expect(robots.detail).toContain('OAI-SearchBot');
    expect([...hosts]).toEqual([new URL(origin).host]);
  });

  it('check text output and --fail-under 99 exits 1 naming checks', async () => {
    const c = captureIO(realEngine, { fetch: (i, n) => fetch(i, n), cwd: logs });
    const code = await runCli(['check', `${origin}/sitemap.xml`, '--fail-under', '99'], c.io);
    expect(code).toBe(EXIT.belowThreshold);
    expect(c.out()).toContain('Read sitemap.xml: 3 pages');
    expect(c.out()).toMatch(/below --fail-under 99/);
    expect(c.out()).toMatch(/Failed checks: .*content without JavaScript/);
  });

  it('unreachable sitemap exits 2', async () => {
    const c = captureIO(realEngine, { fetch: (i, n) => fetch(i, n), cwd: logs });
    expect(await runCli(['check', `${origin}/down/sitemap.xml`], c.io)).toBe(EXIT.couldntRun);
    expect(c.err()).toContain("COULDN'T RUN");
  });

  it('logs on an nginx combined log marks bots verified or unverified (AC 7)', async () => {
    const c = captureIO(realEngine, { cwd: logs });
    expect(await runCli(['logs', 'nginx-combined.log'], c.io)).toBe(EXIT.ok);
    expect(c.out()).toContain('GPTBot');
    expect(c.out()).toContain('ClaudeBot');
    expect(c.out()).toMatch(/verified|UNVERIFIED/);
  });

  it('prompts with no keys makes no network calls (AC 5, AC 10)', async () => {
    const hosts = new Set<string>();
    const c = captureIO(realEngine, { fetch: recordingFetch(hosts), cwd: logs, env: {} });
    expect(await runCli(['prompts', '--site', 'bywell.org', 'roth ira for beginners'], c.io)).toBe(EXIT.ok);
    expect(c.out()).toContain('SKIPPED No engine keys found');
    expect(hosts.size).toBe(0);
  });

  it('prompts --plan with every engine key set makes no network calls (AI search measures AC 8)', async () => {
    const hosts = new Set<string>();
    const env = { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test', PERPLEXITY_API_KEY: 'pplx-test', GOOGLE_API_KEY: 'g-test', GEMINI_API_KEY: 'g-test' };
    for (const flags of [['--plan'], ['--plan', '--perception'], ['--plan', '--json', '--perception'], ['--plan', '--md']]) {
      const fetchThatThrows = async (input: string) => {
        hosts.add(new URL(input).host);
        throw new Error('--plan must not call the network');
      };
      const c = captureIO(realEngine, { fetch: fetchThatThrows, cwd: logs, env });
      expect(await runCli(['prompts', '--site', 'bywell.org', 'roth ira for beginners', 'bywell price', ...flags], c.io)).toBe(EXIT.ok);
      expect(c.out()).toMatch(/Nothing was sent|"plan"/);
    }
    expect(hosts.size).toBe(0);
  });

  it.skipIf(!existsSync(bundle))('the bundled bin runs (shebang, exit code)', async () => {
    const run = promisify(execFile);
    const { stdout } = await run(bundle, ['--version']);
    expect(stdout.trim()).toMatch(/^\S+ \d+\.\d+\.\d+$/);
    const r = await run(process.execPath, [bundle, 'check', `${origin}/sitemap.xml`, '--json']).catch((e: { code: number; stdout: string }) => e);
    expect(JSON.parse(r.stdout).report.pages).toHaveLength(3);
  });
});
