// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/**
 * `citelog mcp`: every tool through a real MCP client over an in-memory transport, on the real engine with a fake
 * fetch (nothing reaches the network), plus prompts, resources, and a stdio handshake with the built bundle.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { GEO_TOOL } from '@morningdesk/core';
import { AI_BOTS, CHECK_IDS } from '@morningdesk/geo';
import { realEngine, type GeoEngine } from '../src/index.js';
import { createMcpServer, TOOL_NAMES, type McpDeps } from '../src/mcp/index.js';
import { boardMeasures, fakeEngine } from './helpers.js';

const ORIGIN = 'https://bywell.org';
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/site/${name}`, import.meta.url), 'utf8').replaceAll('__ORIGIN__', ORIGIN);
const LOGS = new URL('./fixtures/logs/', import.meta.url).pathname;
const BUNDLE = new URL('../dist/citelog.mjs', import.meta.url).pathname;

type Route = { status?: number; body?: string; type?: string };

/** A fetch over a route table that records every URL; unknown URLs are 404. */
function fakeFetch(routes: Record<string, Route>) {
  const urls: string[] = [];
  const fetch = async (input: string) => {
    urls.push(input);
    const r = routes[input.replace(/\/$/, '') || input] ?? routes[input];
    if (!r) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'text/html; charset=utf-8' } });
  };
  return { fetch, urls };
}

const SITE: Record<string, Route> = {
  [`${ORIGIN}`]: { body: fixture('good.html') },
  [`${ORIGIN}/learn/roth-ira`]: { body: fixture('good.html') },
  [`${ORIGIN}/pricing`]: { body: fixture('js-only.html') },
  [`${ORIGIN}/robots.txt`]: { body: `User-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /pricing\n\nUser-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`, type: 'text/plain' },
  [`${ORIGIN}/sitemap.xml`]: { body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ORIGIN}/learn/roth-ira</loc></url><url><loc>${ORIGIN}/pricing</loc></url></urlset>`, type: 'application/xml' },
  [`${ORIGIN}/llms.txt`]: { body: `# Bywell\n\n> Investing lessons for beginners.\n\n## Lessons\n\n- [Roth IRA](${ORIGIN}/learn/roth-ira): the basics\n`, type: 'text/plain' },
};

let clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function connect(over: Partial<McpDeps> = {}): Promise<{ client: Client; urls: string[] }> {
  const f = fakeFetch(SITE);
  const deps: McpDeps = { fetch: f.fetch, env: {}, cwd: LOGS, engine: realEngine, ...over };
  const server = createMcpServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  return { client, urls: f.urls };
}

function resourceText(r: { contents: ({ text: string } | { blob: string })[] }): string {
  const c = r.contents[0];
  return c && 'text' in c ? c.text : '';
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult & { text: string }> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  return { ...r, text };
}

describe('citelog mcp: server and tool list', () => {
  it('lists the nine tools with explicit annotations; only run_prompts may change anything', async () => {
    const { client } = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: GEO_TOOL.bin, version: GEO_TOOL.version });
    expect(client.getInstructions()).toMatch(/confirm: true/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['ai_view', 'check_readiness', 'crawler_info', 'explain_check', 'llms_txt', 'parse_logs', 'prompts_plan', 'robots_ai', 'run_prompts']);
    expect(TOOL_NAMES).toHaveLength(9);
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.annotations, t.name).toMatchObject({ destructiveHint: false });
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe('boolean');
      expect(typeof t.annotations?.openWorldHint, t.name).toBe('boolean');
      expect(t.annotations?.readOnlyHint, t.name).toBe(t.name !== 'run_prompts');
    }
    const run = tools.find((t) => t.name === 'run_prompts');
    expect(run?.inputSchema.properties).toHaveProperty('confirm');
    expect(run?.description).toMatch(/SPENDS/);
  });

  it('lists the prompts and resources; resources are the bot catalog and the check guide', async () => {
    const { client } = await connect();
    expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(['audit_my_site', 'why_am_i_not_cited']);
    const p = await client.getPrompt({ name: 'why_am_i_not_cited', arguments: { url: `${ORIGIN}/learn/roth-ira`, question: 'roth ira for beginners' } });
    expect(JSON.stringify(p.messages)).toMatch(/Don't call run_prompts unless I say yes/);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([`${GEO_TOOL.bin}://bots`, `${GEO_TOOL.bin}://checks`]);
    const bots = JSON.parse(resourceText(await client.readResource({ uri: `${GEO_TOOL.bin}://bots` })));
    expect(bots.bots).toHaveLength(AI_BOTS.length);
    const checks = JSON.parse(resourceText(await client.readResource({ uri: `${GEO_TOOL.bin}://checks` })));
    expect(checks.checks.map((c: { id: string }) => c.id).sort()).toEqual([...CHECK_IDS].sort());
  });
});

describe('ai_view', () => {
  it('a JavaScript-only page fails with the words AI crawlers get; a bare host means https', async () => {
    const { client, urls } = await connect();
    const r = await call(client, 'ai_view', { url: 'bywell.org/pricing' });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/What AI crawlers see on \/pricing/);
    expect(r.text).toMatch(/FAIL/);
    expect(r.structuredContent).toMatchObject({ result: 'blocked', blockedBy: 'robots', path: '/pricing' });
    expect(new Set(urls.map((u) => new URL(u).host))).toEqual(new Set(['bywell.org']));
  });

  it('a readable page passes', async () => {
    const { client } = await connect();
    const r = await call(client, 'ai_view', { url: `${ORIGIN}/learn/roth-ira` });
    expect(r.structuredContent).toMatchObject({ result: 'ok' });
    expect(r.text).toMatch(/PASS/);
  });

  it('refuses something that is not a URL; a page that does not load is a tool error', async () => {
    const { client } = await connect();
    expect((await call(client, 'ai_view', { url: 'not a url' })).isError).toBe(true);
    const missing = await call(client, 'ai_view', { url: `${ORIGIN}/missing` });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/HTTP 404/);
  });
});

describe('cleanEnv', () => {
  it('drops placeholders a host left unfilled, keeps real values', async () => {
    const { cleanEnv } = await import('../src/mcp/index.js');
    expect(cleanEnv({ OPENAI_API_KEY: '${user_config.openai_api_key}', ANTHROPIC_API_KEY: 'sk-ant-test-fake', PATH: '/bin', EMPTY: undefined })).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-test-fake', PATH: '/bin' });
  });
});

describe('bare hosts', () => {
  it('localhost and IP addresses mean http://, other hosts https://', async () => {
    const { toUrl } = await import('../src/mcp/index.js');
    expect(toUrl('localhost:3000/pricing')).toBe('http://localhost:3000/pricing');
    expect(toUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(toUrl('bywell.org')).toBe('https://bywell.org/');
  });
});

describe('check_readiness', () => {
  it('a site URL reads the sitemap and returns the Markdown report and a compact structure', async () => {
    const { client } = await connect();
    const r = await call(client, 'check_readiness', { target: 'bywell.org' });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/robots\.txt|AI crawlers/);
    const s = r.structuredContent as { kind: string; pages: { url: string; failed: string[] }[]; score: number };
    expect(s.kind).toBe('sitemap');
    expect(s.pages.map((p) => p.url).sort()).toEqual([`${ORIGIN}/learn/roth-ira`, `${ORIGIN}/pricing`]);
    expect(s.pages.find((p) => p.url.endsWith('/pricing'))?.failed).toEqual(expect.arrayContaining(['robots_ai', 'no_js_content']));
    expect(typeof s.score).toBe('number');
  });

  it('format json returns the full report; max_pages is capped at 50 by the schema', async () => {
    const { client } = await connect();
    const r = await call(client, 'check_readiness', { target: `${ORIGIN}/learn/roth-ira`, format: 'json' });
    const report = JSON.parse(r.text);
    expect(report.pages[0].checks).toHaveLength(CHECK_IDS.length);
    const tooMany = await call(client, 'check_readiness', { target: ORIGIN, max_pages: 51 });
    expect(tooMany.isError).toBe(true);
  });

  it('checks a local folder of built HTML without any fetch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-folder-'));
    writeFileSync(join(dir, 'index.html'), fixture('good.html'));
    const f = fakeFetch({});
    const { client } = await connect({ fetch: f.fetch, cwd: dir });
    const r = await call(client, 'check_readiness', { target: '.' });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { kind: string }).kind).toBe('folder');
    expect(f.urls).toEqual([]);
  });

  it('nothing loaded is a tool error, not a score', async () => {
    const f = fakeFetch({});
    const { client } = await connect({ fetch: f.fetch });
    const r = await call(client, 'check_readiness', { target: 'https://down.example/page' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no score/);
  });
});

describe('robots_ai', () => {
  it('fetches robots.txt from the URL origin and judges the URL path', async () => {
    const { client, urls } = await connect();
    const r = await call(client, 'robots_ai', { url: `${ORIGIN}/pricing` });
    expect(urls).toEqual([`${ORIGIN}/robots.txt`]);
    const s = r.structuredContent as { path: string; verdict: { result: string }; blocked: Record<string, string[]>; suggested: string };
    expect(s.path).toBe('/pricing');
    expect(s.verdict.result).toBe('fail');
    expect(s.blocked).toMatchObject({ search: ['PerplexityBot'], training: ['GPTBot'] });
    expect(r.text).toMatch(/\| PerplexityBot \| Perplexity \| search \(main\) \| \*\*blocked\*\* \| User-agent: PerplexityBot \/ Disallow: \/pricing \(line 5\) \|/);
    expect(s.suggested).toMatch(/User-agent: OAI-SearchBot/);
  });

  it('takes pasted robots.txt (no fetch); url and robots_txt together are refused', async () => {
    const { client, urls } = await connect();
    const r = await call(client, 'robots_ai', { robots_txt: 'User-agent: GPTBot\nDisallow: /\n', path: '/blog' });
    expect((r.structuredContent as { verdict: { result: string } }).verdict.result).toBe('warn');
    expect(urls).toEqual([]);
    expect((await call(client, 'robots_ai', { url: ORIGIN, robots_txt: '' })).isError).toBe(true);
    expect((await call(client, 'robots_ai', {})).isError).toBe(true);
  });
});

describe('llms_txt', () => {
  it('reads and validates /llms.txt on the origin', async () => {
    const { client } = await connect();
    const r = await call(client, 'llms_txt', { url: `${ORIGIN}/learn/roth-ira` });
    expect(r.structuredContent).toMatchObject({ url: `${ORIGIN}/llms.txt`, found: true, fullFound: false, report: { valid: true, title: 'Bywell', links: 1 } });
    expect(r.text).toMatch(/Follows the llmstxt.org format/);
    expect(r.text).toMatch(/not scored/);
  });

  it('says plainly when there is none', async () => {
    const f = fakeFetch({});
    const { client } = await connect({ fetch: f.fetch });
    const r = await call(client, 'llms_txt', { url: 'ansa.chat' });
    expect(r.structuredContent).toMatchObject({ found: false });
    expect(r.text).toMatch(/No llms\.txt/);
  });
});

describe('crawler_info', () => {
  it('finds a bot by name, id or User-Agent, never fetching', async () => {
    const { client, urls } = await connect();
    const byName = await call(client, 'crawler_info', { bot: 'gptbot' });
    expect((byName.structuredContent as { bots: { name: string; ipRangesInSnapshot: boolean }[] }).bots).toEqual([expect.objectContaining({ name: 'GPTBot', purpose: 'training', ipRangesInSnapshot: true })]);
    const byUa = await call(client, 'crawler_info', { bot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)' });
    expect((byUa.structuredContent as { bots: { id: string }[] }).bots[0]?.id).toBe('claude-searchbot');
    const training = await call(client, 'crawler_info', { purpose: 'training' });
    expect((training.structuredContent as { bots: { purpose: string }[] }).bots.every((b) => b.purpose === 'training')).toBe(true);
    expect(urls).toEqual([]);
  });

  it('an unknown bot is a tool error that lists the known ones', async () => {
    const { client } = await connect();
    const r = await call(client, 'crawler_info', { bot: 'NotABot' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/OAI-SearchBot/);
  });
});

describe('parse_logs', () => {
  it('reads a log relative to the server folder and returns counts only', async () => {
    const { client, urls } = await connect();
    const r = await call(client, 'parse_logs', { path: 'nginx-combined.log' });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { summary: { format: string; bots: { botId: string }[] } };
    expect(s.summary.format).toBe('combined');
    expect(s.summary.bots.map((b) => b.botId)).toContain('gptbot');
    expect(r.text).not.toMatch(/Mozilla\/5\.0/);
    expect(urls).toEqual([]);
  });

  it('missing files, folders and unknown formats are tool errors', async () => {
    const { client } = await connect();
    expect((await call(client, 'parse_logs', { path: 'nope.log' })).text).toMatch(/No such file/);
    expect((await call(client, 'parse_logs', { path: '.' })).text).toMatch(/isn't a file/);
    expect((await call(client, 'parse_logs', { path: 'unknown.log' })).text).toMatch(/Unknown log format/);
  });
});

describe('prompts_plan', () => {
  it('plans from arguments without sending anything', async () => {
    const { engine, calls } = fakeEngine();
    const f = fakeFetch({});
    const { client } = await connect({ engine, fetch: f.fetch, env: { OPENAI_API_KEY: 'sk-test-fake', ANTHROPIC_API_KEY: 'sk-ant-test-fake' } });
    const r = await call(client, 'prompts_plan', { site: 'bywell.org', prompts: ['roth ira for beginners', { text: 'best app to learn investing', topic: 'Apps', stage: 'evaluation' }], perception: true });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/Nothing was sent/);
    const s = r.structuredContent as { site: string; engines: { engine: string }[]; notAsked: { engine: string }[]; totalUsd: number };
    expect(s.site).toBe('bywell.org');
    expect(s.engines.map((e) => e.engine).sort()).toEqual(['anthropic', 'openai']);
    expect(s.notAsked.map((e) => e.engine).sort()).toEqual(['gemini', 'perplexity']);
    expect(s.totalUsd).toBeGreaterThan(0);
    expect(calls.runPrompts).toEqual([]);
    expect(f.urls).toEqual([]);
  });

  it('reads site and prompts from the config in the server folder; refuses placeholders and missing prompts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-config-'));
    writeFileSync(join(dir, `${GEO_TOOL.configBase}.json`), JSON.stringify({ site: 'https://ansa.chat', prompts: ['ai customer support for small business'] }));
    const { client } = await connect({ cwd: dir });
    const r = await call(client, 'prompts_plan');
    expect((r.structuredContent as { site: string }).site).toBe('ansa.chat');
    expect((await call(client, 'prompts_plan', { prompts: ['best <product> for me'] })).text).toMatch(/placeholder/);
    const empty = mkdtempSync(join(tmpdir(), 'mcp-empty-'));
    const { client: c2 } = await connect({ cwd: empty });
    expect((await call(c2, 'prompts_plan')).text).toMatch(/No site to use/);
    expect((await call(c2, 'prompts_plan', { site: 'bywell.org', prompts: ['x'], brand_terms: Array(50).fill('b') })).isError).toBe(true);
  });
});

describe('run_prompts', () => {
  const ARGS = { site: 'bywell.org', prompts: ['roth ira for beginners'] };

  it('without confirm: true it returns the plan and sends nothing', async () => {
    const { engine, calls } = fakeEngine();
    const f = fakeFetch({});
    const { client } = await connect({ engine, fetch: f.fetch, env: { OPENAI_API_KEY: 'sk-test-fake' } });
    for (const confirm of [undefined, false]) {
      const r = await call(client, 'run_prompts', confirm === undefined ? ARGS : { ...ARGS, confirm });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({ sent: false });
      expect(r.text).toMatch(/Nothing was sent\. This would spend about \$/);
      expect(r.text).toMatch(/confirm: true/);
    }
    expect(calls.runPrompts).toEqual([]);
    expect(f.urls).toEqual([]);
    expect((await call(client, 'run_prompts', { ...ARGS, confirm: 'yes' })).isError).toBe(true);
    expect(calls.runPrompts).toEqual([]);
  });

  it('with confirm: true and no keys it refuses before calling any engine', async () => {
    const { engine, calls } = fakeEngine();
    const { client } = await connect({ engine, env: {} });
    const r = await call(client, 'run_prompts', { ...ARGS, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No engine has an API key/);
    expect(calls.runPrompts).toEqual([]);
  });

  it('with confirm: true runs on the user keys with brand terms and perception, and reports cited and named', async () => {
    const { engine, calls } = fakeEngine({ runPrompts: async () => boardMeasures() });
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test-fake' };
    const { client } = await connect({ engine: engine as GeoEngine, env });
    const r = await call(client, 'run_prompts', { ...ARGS, brand_terms: ['Bywell'], perception: true, confirm: true });
    expect(r.isError).toBeFalsy();
    expect(calls.runPrompts).toHaveLength(1);
    expect(calls.runPrompts[0]).toMatchObject({ site: 'bywell.org', prompts: ['roth ira for beginners'], opts: { env, brandTerms: ['Bywell'], perception: { mode: 'auto' } } });
    expect(r.structuredContent).toMatchObject({ sent: true, site: 'bywell.org' });
    expect(r.text).toMatch(/Cited|cited/);
  });
});

describe('run_prompts brand terms', () => {
  it("the config file's brand terms apply to its own site only", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-brand-'));
    writeFileSync(join(dir, `${GEO_TOOL.configBase}.json`), JSON.stringify({ site: 'bywell.org', prompts: ['roth ira for beginners'], brandTerms: ['Bywell'] }));
    const { engine, calls } = fakeEngine({ runPrompts: async (s) => ({ site: s, results: [], skipped: [], costUsdMicros: 0, judge: null }) });
    const { client } = await connect({ engine, cwd: dir, env: { OPENAI_API_KEY: 'sk-test-fake' } });
    await call(client, 'run_prompts', { confirm: true });
    await call(client, 'run_prompts', { site: 'ansa.chat', confirm: true });
    expect(calls.runPrompts.map((c) => c.opts.brandTerms)).toEqual([['Bywell'], expect.not.arrayContaining(['Bywell'])]);
  });
});

describe('explain_check', () => {
  it('explains every check; an unknown id is refused by the schema', async () => {
    const { client } = await connect();
    for (const id of CHECK_IDS) {
      const r = await call(client, 'explain_check', { check: id });
      expect(r.isError, id).toBeFalsy();
      expect(r.text).toContain(`(${id})`);
      expect(r.text).toMatch(/Fix: /);
    }
    expect((await call(client, 'explain_check', { check: 'speed' })).isError).toBe(true);
  });
});

describe('stdio: the built bundle', () => {
  it('`citelog mcp` answers the MCP handshake and lists the tools over stdio', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BUNDLE, 'mcp'], cwd: LOGS, env: { PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);
    expect(client.getServerVersion()?.name).toBe(GEO_TOOL.bin);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);
    const r = (await client.callTool({ name: 'crawler_info', arguments: { bot: 'GPTBot' } })) as CallToolResult;
    expect(JSON.stringify(r.content)).toMatch(/GPTBot/);
  }, 30_000);
});

describe('the mcp command', () => {
  it('is in the help, starts the server through io.serveMcp, and prints nothing on stdout', async () => {
    const { runCli, HELP, EXIT } = await import('../src/index.js');
    const { captureIO } = await import('./helpers.js');
    expect(HELP.main).toMatch(/ mcp {2,}/);
    expect(HELP.mcp).toMatch(/run_prompts/);
    let started = 0;
    const c = captureIO(fakeEngine().engine, { serveMcp: async () => void started++ });
    expect(await runCli(['mcp'], c.io)).toBe(EXIT.ok);
    expect(started).toBe(1);
    expect(c.out()).toBe('');
  });

  it('refuses arguments and output flags, and says so when the server is not available', async () => {
    const { runCli, EXIT } = await import('../src/index.js');
    const { captureIO } = await import('./helpers.js');
    const c = captureIO(fakeEngine().engine, { serveMcp: async () => undefined });
    expect(await runCli(['mcp', 'extra'], c.io)).toBe(EXIT.couldntRun);
    expect(await runCli(['mcp', '--json'], c.io)).toBe(EXIT.couldntRun);
    const none = captureIO(fakeEngine().engine);
    expect(await runCli(['mcp'], none.io)).toBe(EXIT.couldntRun);
    expect(none.err()).toMatch(/isn't available/);
    expect(c.out()).toBe('');
  });
});
