// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GEO_TOOL } from '@morningdesk/core';
import type { SiteReport } from '@morningdesk/geo';
import { runAction } from '../src/main.js';
import { renderBadgeSvg } from '../src/cli.js';
import { boardFail, boardMeasures, boardOneEngineFailed, fakeEngine, page, site } from '../../packages/cli/test/helpers.js';
import { FakeGitHub } from './fakeGitHub.js';

let gh: FakeGitHub;
let dir: string;

beforeEach(async () => {
  gh = await new FakeGitHub().start();
  dir = await mkdtemp(join(tmpdir(), 'geo-action-'));
});
afterEach(() => gh.stop());

function prEvent(sha: string, fork = false) {
  return {
    pull_request: {
      number: 7,
      head: { sha, repo: { full_name: fork ? 'someone/bywell' : 'kunolu/bywell' } },
      base: { ref: 'main', repo: { full_name: 'kunolu/bywell' } },
    },
  };
}

async function env(event: object, inputs: Record<string, string>, name = 'pull_request'): Promise<Record<string, string>> {
  const eventPath = join(dir, 'event.json');
  await writeFile(eventPath, JSON.stringify(event));
  const summary = join(dir, `summary-${Math.random()}.md`);
  const output = join(dir, `output-${Math.random()}.txt`);
  await writeFile(summary, '');
  await writeFile(output, '');
  const e: Record<string, string> = {
    GITHUB_EVENT_NAME: name,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: 'kunolu/bywell',
    GITHUB_API_URL: gh.url,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_OUTPUT: output,
    GITHUB_WORKSPACE: dir,
    RUNNER_TEMP: join(dir, 'tmp'),
    'INPUT_GITHUB-TOKEN': 'ghs_test',
    INPUT_COMMENT: 'true',
    INPUT_PROMPTS: 'false',
    'INPUT_MAX-PAGES': '50',
  };
  for (const [k, v] of Object.entries(inputs)) e[`INPUT_${k.toUpperCase()}`] = v;
  return e;
}

function prSite(): SiteReport {
  return site(
    [
      page('/learn/roth-ira', 64, { direct_answer: 'fail' }, 'https://bywell-git-roth.vercel.app'),
      page('/learn/ira-basics', 86, { question_headings: 'warn' }, 'https://bywell-git-roth.vercel.app'),
      page('/pricing', 95, {}, 'https://bywell-git-roth.vercel.app'),
    ],
    { target: 'https://bywell-git-roth.vercel.app' },
  );
}

function run(e: Record<string, string>, report: () => SiteReport = prSite, over = {}) {
  const lines: string[] = [];
  const hosts = new Set<string>();
  const { engine, calls } = fakeEngine({ checkTarget: async () => report(), ...over });
  const p = runAction({
    env: e,
    fetch: (input, init) => {
      hosts.add(new URL(input).host);
      return fetch(input, init);
    },
    engine,
    log: (s) => lines.push(s),
  });
  return { p, lines, hosts, calls };
}

describe('pull request', () => {
  it('first run creates exactly one comment with the marker; second run edits it (AC 8)', async () => {
    gh.addComment('Looks good to me');
    gh.files = [{ filename: 'content/learn/roth-ira.mdx', status: 'modified' }, { filename: 'README.md', status: 'modified' }];
    const r1 = run(await env(prEvent('a81d3e2aaaa'), { url: 'https://bywell-git-roth.vercel.app' }));
    expect(await r1.p).toBe(0);
    expect(gh.writes).toEqual([{ method: 'POST', path: '/repos/kunolu/bywell/issues/7/comments', auth: 'Bearer ghs_test' }].map(({ method, path }) => ({ method, path, auth: 'Bearer ghs_test' })));
    const ours = gh.comments.filter((c) => c.body.includes(GEO_TOOL.commentMarker));
    expect(ours).toHaveLength(1);
    expect(ours[0]!.body).toContain(`First ${GEO_TOOL.name} run on this repo. It checked **the 1 page this PR changes**`);
    expect(ours[0]!.body).toContain('| /learn/roth-ira | **Fail** 64 |');
    expect([...r1.hosts]).toEqual([new URL(gh.url).host]);

    gh.addComment('another human comment');
    const r2 = run(await env(prEvent('9f2c1e4bbbb'), { url: 'https://bywell-git-roth.vercel.app' }), () =>
      site([page('/learn/roth-ira', 92, {}, 'https://bywell-git-roth.vercel.app')], { target: 'https://bywell-git-roth.vercel.app' }),
    );
    expect(await r2.p).toBe(0);
    const writes = gh.requests.filter((x) => x.method === 'POST' || x.method === 'PATCH').map((x) => x.method);
    expect(writes).toEqual(['POST', 'PATCH']);
    const after = gh.comments.filter((c) => c.body.includes(GEO_TOOL.commentMarker));
    expect(after).toHaveLength(1);
    expect(after[0]!.body).toContain('**Updated for 9f2c1e4** (push 2 of this PR). **Score 92, Ready**, was 64 on the last push.');
    expect(after[0]!.body).toContain('#### Fixed since the last push (1)');
    expect(after[0]!.body).toContain('History: push 1 score 64, push 2 score 92');
  });

  it('finds the sticky comment on a later page of comments', async () => {
    for (let i = 0; i < 5; i++) gh.addComment(`human ${i}`);
    gh.addComment(`${GEO_TOOL.commentMarker}\nold`, 'github-actions[bot]');
    const r = run(await env(prEvent('abc1234'), { url: 'https://bywell-git-roth.vercel.app' }));
    expect(await r.p).toBe(0);
    expect(gh.writes.map((w) => w.method)).toEqual(['PATCH']);
    expect(gh.requests.filter((x) => x.method === 'GET' && x.path.endsWith('/comments')).length).toBe(3);
  });

  it('fork: no comment, summary only, prompts skipped, does not fail for permissions (AC 9)', async () => {
    const e = await env(prEvent('a81d3e2', true), { path: 'out' });
    await mkdir(join(dir, 'out'));
    const r = run(e, () => site(boardFail().pages.slice(0, 4), { target: join(dir, 'out'), kind: 'folder' }));
    expect(await r.p).toBe(0);
    expect(gh.writes).toEqual([]);
    expect(r.calls.runPrompts).toEqual([]);
    const summary = await readFile(e.GITHUB_STEP_SUMMARY!, 'utf8');
    expect(summary).toContain('> This pull request comes from a fork');
    expect(summary).toContain('Prompts were skipped. The job didn\'t fail for missing permissions.');
    expect(summary).toContain('Maintainers: re-run from a branch in this repo to get the PR comment.');
    expect(r.lines.join('')).toMatch(/^::notice title=.*::This pull request comes from a fork/m);
    expect(r.lines.join('')).toContain('Not failing the job for missing permissions.');
  });

  it('no comment permission (403) is a warning, not a failure, and the summary is written', async () => {
    gh.writeStatus = 403;
    const e = await env(prEvent('a81d3e2'), { url: 'https://bywell-git-roth.vercel.app' });
    const r = run(e);
    expect(await r.p).toBe(0);
    expect(r.lines.join('')).toMatch(/^::warning title=.*::No permission to comment \(HTTP 403\)/m);
    expect(await readFile(e.GITHUB_STEP_SUMMARY!, 'utf8')).toContain('### Pages (3)');
  });

  it('comment API 500: summary still written, job not failed (H2)', async () => {
    gh.writeStatus = 500;
    const e = await env(prEvent('a81d3e2'), { url: 'https://bywell-git-roth.vercel.app' });
    const r = run(e);
    expect(await r.p).toBe(0);
    expect(r.lines.join('')).toMatch(/^::warning title=.*::Couldn't post the PR comment: GitHub POST .* returned HTTP 500/m);
    expect(await readFile(e.GITHUB_STEP_SUMMARY!, 'utf8')).toContain('### Pages (3)');
  });

  it('ignores a forged marker comment from another author and its state (H3)', async () => {
    const forged = `${GEO_TOOL.commentMarker}\n<!-- ${GEO_TOOL.bin}:state {"v":1,"pushes":[{"sha":"@octocat [x](https://evil.example)","score":5}],"failing":["/x|json_ld"]} -->`;
    gh.addComment(forged, 'mallory');
    const r = run(await env(prEvent('a81d3e2'), { url: 'https://bywell-git-roth.vercel.app' }));
    expect(await r.p).toBe(0);
    expect(gh.writes.map((w) => w.method)).toEqual(['POST']);
    expect(gh.comments.find((c) => c.user.login === 'mallory')!.body).toBe(forged);
    const ours = gh.comments.find((c) => c.user.login === 'github-actions[bot]')!.body;
    expect(ours).not.toContain('octocat');
    expect(ours).not.toContain('Updated for');
  });

  it('nothing loaded (refused preview) fails the job instead of passing (H1)', async () => {
    const e = await env(prEvent('a81d3e2'), { url: 'https://bywell-git-roth.vercel.app' });
    const down = site([{ ...page('/', 0, {}, 'https://bywell-git-roth.vercel.app'), score: null, band: 'no_score', checks: [], status: 401, error: "We couldn't load https://bywell-git-roth.vercel.app/: HTTP 401" }], { target: 'https://bywell-git-roth.vercel.app' });
    const r = run(e, () => down);
    expect(await r.p).toBe(2);
    expect(r.lines.join('')).toMatch(/^::error title=.*nothing checked::.*HTTP 401/m);
    expect(await readFile(e.GITHUB_STEP_SUMMARY!, 'utf8')).toContain("**Couldn't run.**");
    expect(gh.writes).toEqual([]);
  });

  it('no url and no path fails with the two ways to fix it', async () => {
    const e = await env(prEvent('a81d3e2'), {});
    const r = run(e);
    expect(await r.p).toBe(2);
    expect(r.calls.checkTarget).toEqual([]);
    const log = r.lines.join('');
    expect(log).toMatch(/^::error /);
    expect(log).toContain('1. Pass your preview deployment');
    expect(log).toContain('2. Build the site in an earlier step and pass the folder');
    const summary = await readFile(e.GITHUB_STEP_SUMMARY!, 'utf8');
    expect(summary).toContain('url: ${{ steps.deploy.outputs.url }}');
    expect(summary).toContain('path: ./dist');
  });

  it('threshold missed fails the job and names the checks; the comment says so', async () => {
    const e = await env(prEvent('a81d3e2'), { url: 'https://bywell-git-roth.vercel.app', 'fail-under': '90' });
    const r = run(e);
    expect(await r.p).toBe(1);
    expect(r.lines.join('')).toContain('Score 82 is below fail-under 90. Failed checks: Short direct answer near the top (/learn/roth-ira).');
    expect(gh.comments[0]!.body).toContain('below your threshold of 90');
  });

  it('base-url compares with the default branch ("was 81 on main", new failures first)', async () => {
    const e = await env(prEvent('a81d3e2'), { url: 'https://bywell-git-roth.vercel.app', 'base-url': 'https://bywell.org', 'fail-under': '75' });
    const head = site(
      [page('/pricing', 55, { no_js_content: 'fail' }, 'https://p.app'), page('/learn/roth-ira', 64, { json_ld: 'fail', direct_answer: 'fail' }, 'https://p.app'), page('/learn/a', 85, { question_headings: 'warn' }, 'https://p.app')],
      { target: 'https://p.app' },
    );
    const base = site([page('/pricing', 95), page('/learn/roth-ira', 64, { direct_answer: 'fail' }), page('/learn/a', 84, { question_headings: 'warn' })]);
    const r = run(e, () => head, { checkTarget: async (t: string) => (t === 'https://bywell.org' ? base : head) });
    expect(await r.p).toBe(1);
    const body = gh.comments[0]!.body;
    expect(body).toContain('**Fail. Score 68, Needs work, was 81 on main**, below your threshold of 75. This PR adds **2 new failures** on 3 pages.');
    expect(body).toContain('#### New failures');
    expect(body).toContain('<details><summary>Already failing on main (1)</summary>');
    expect(body).toContain('<details><summary>Warnings (1)</summary>');
  });
});

describe('schedule / default branch', () => {
  it('checks the whole site, writes the badge, report files, summary and README line', async () => {
    await mkdir(join(dir, '.github'));
    await writeFile(join(dir, '.github/badge.svg'), renderBadgeSvg(74));
    await writeFile(join(dir, 'README.md'), `# bywell\n\n[![b](.github/badge.svg)](https://bywell.org)\n<!-- ${GEO_TOOL.bin}:badge-line -->old<!-- /${GEO_TOOL.bin}:badge-line -->\n`);
    await writeFile(join(dir, `${GEO_TOOL.configBase}.json`), JSON.stringify({ site: 'https://bywell.org', prompts: ['roth ira for beginners', 'best app to learn investing', 'etf vs index fund'] }));
    const e = await env({}, { url: 'https://bywell.org', badge: '.github/badge.svg', prompts: 'true' }, 'schedule');
    const r = run(e, boardFail, { runPrompts: async () => boardOneEngineFailed() });
    expect(await r.p).toBe(0);
    expect(gh.requests).toEqual([]);
    const svg = await readFile(join(dir, '.github/badge.svg'), 'utf8');
    expect(svg).toContain('>72 · needs work</text>');
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('AI answer readiness of bywell.org, 41 pages, checked Nov 18, 2026<!--');
    const summary = await readFile(e.GITHUB_STEP_SUMMARY!, 'utf8');
    expect(summary).toContain('**Score 72, Needs work** (was 74 last run) · 41 pages');
    expect(summary).toContain('badge written to `.github/badge.svg`');
    expect(summary).toContain('### Prompts (3 of 4 engines)');
    expect(summary).toContain('AI crawler logs: not configured.');
    expect(summary).toContain('No telemetry: this run called only bywell.org');
    const outputs = await readFile(e.GITHUB_OUTPUT!, 'utf8');
    expect(outputs).toContain('score=72');
    const json = JSON.parse(await readFile(join(dir, 'tmp', GEO_TOOL.bin, `${GEO_TOOL.bin}-report.json`), 'utf8'));
    expect(json.report.score).toBe(72);
  });

  it('perception input is off by default; on, it reaches the engine and the summary gets Named, considered and perception', async () => {
    await writeFile(join(dir, `${GEO_TOOL.configBase}.json`), JSON.stringify({ site: 'https://bywell.org', brandTerms: ['Bywell'], prompts: [{ text: 'roth ira for beginners', topic: 'Retirement', stage: 'discovery' }, 'best app to learn investing', 'etf vs index fund'] }));
    const off = run(await env({}, { url: 'https://bywell.org', prompts: 'true' }, 'schedule'), boardFail, { runPrompts: async () => ({ ...boardMeasures(), judge: null }) });
    expect(await off.p).toBe(0);
    expect(off.calls.runPrompts[0]).toMatchObject({ prompts: ['roth ira for beginners', 'best app to learn investing', 'etf vs index fund'], opts: { brandTerms: ['Bywell'], perception: { mode: 'off' } } });

    const e = await env({}, { url: 'https://bywell.org', prompts: 'true', perception: 'true' }, 'schedule');
    const on = run(e, boardFail, { runPrompts: async () => boardMeasures() });
    expect(await on.p).toBe(0);
    expect(on.calls.runPrompts[0]?.opts.perception).toEqual({ mode: 'auto' });
    const summary = await readFile(e.GITHUB_STEP_SUMMARY!, 'utf8');
    expect(summary).toContain('| Prompt | ChatGPT | Claude | Perplexity | Gemini | Named |');
    expect(summary).toContain('Named, not linked');
    expect(summary).toContain('**Considered, not cited:**');
    expect(summary).toContain('- a bywell.org page: Gemini (2)');
    expect(summary).toContain('Perception (Claude Haiku 5.5 on ANTHROPIC_API_KEY, 4 answers about you): 3 positive');
    const json = JSON.parse(await readFile(join(dir, 'tmp', GEO_TOOL.bin, `${GEO_TOOL.bin}-report.json`), 'utf8'));
    expect(json.prompts.results[3].considered).toEqual([{ url: null, host: 'bywell.org', cited: false }]);
  });

  it('rejects a perception input that is not true or false', async () => {
    const r = run(await env({}, { url: 'https://bywell.org', prompts: 'true', perception: 'maybe' }, 'schedule'), boardFail);
    expect(await r.p).toBe(2);
  });

  it('a site that answers 503 everywhere writes a "no score" badge and exits 2', async () => {
    const e = await env({}, { url: 'https://down.example', badge: 'badge.svg' }, 'schedule');
    const r = run(e, () => site([{ ...page('/', 0), score: null, band: 'no_score', checks: [], status: 503, error: "We couldn't load https://down.example/: HTTP 503" }], { target: 'https://down.example' }));
    expect(await r.p).toBe(2);
    expect(await readFile(join(dir, 'badge.svg'), 'utf8')).toContain('>no score</text>');
  });

  it("couldn't run at all leaves the badge alone and exits 2", async () => {
    await writeFile(join(dir, 'badge.svg'), renderBadgeSvg(80));
    const e = await env({}, { url: 'https://down.example', badge: 'badge.svg' }, 'schedule');
    const r = run(e, () => {
      throw new Error('network error (ENOTFOUND)');
    });
    expect(await r.p).toBe(2);
    expect(await readFile(join(dir, 'badge.svg'), 'utf8')).toContain('>80 · needs work</text>');
  });

  it('an empty build folder fails instead of passing', async () => {
    const e = await env({}, { path: 'out', 'fail-under': '50' }, 'schedule');
    const r = run(e, () => site([], { target: join(dir, 'out'), kind: 'folder' }));
    expect(await r.p).toBe(2);
    expect(r.lines.join('')).toContain('The folder has no HTML files.');
  });

  it('reads a gzip log once and summarises it', async () => {
    const { gzipSync } = await import('node:zlib');
    const line = '66.249.66.1 - - [15/Nov/2026:10:00:00 +0000] "GET /a HTTP/1.1" 200 512 "-" "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"';
    await writeFile(join(dir, 'access.log.gz'), gzipSync(`${line}\n${line}\n`));
    const e = await env({}, { url: 'https://bywell.org', logs: 'access.log.gz' }, 'schedule');
    const { realEngine } = await import('../src/cli.js');
    const r = run(e, boardFail, { summarizeLogs: realEngine.summarizeLogs, detectFormat: realEngine.detectFormat });
    expect(await r.p).toBe(0);
    expect(await readFile(e.GITHUB_STEP_SUMMARY!, 'utf8')).toContain('### AI crawler visits');
  });

  it('missing threshold on schedule fails naming checks', async () => {
    const e = await env({}, { url: 'https://bywell.org', 'fail-under': '80' }, 'schedule');
    const r = run(e, boardFail);
    expect(await r.p).toBe(1);
    expect(r.lines.join('')).toMatch(/Score 72 is below fail-under 80\. Failed checks: .*Short direct answer near the top/);
  });

  it('bad inputs exit 2', async () => {
    const r = run(await env({}, { url: 'https://bywell.org', 'max-pages': 'lots' }, 'schedule'));
    expect(await r.p).toBe(2);
    expect(r.lines.join('')).toContain('Input "max-pages" must be a whole number');
  });
});
