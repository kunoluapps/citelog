// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
// Bug bash 2026-11-26 (citelog-public BUGBASH.md): the Action's prompts and perception inputs.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GEO_TOOL } from '@morningdesk/core';
import { runAction } from '../src/main.js';
import { boardFail, boardMeasures, fakeEngine, page, site } from '../../packages/cli/test/helpers.js';
import { FakeGitHub } from './fakeGitHub.js';

let gh: FakeGitHub;
let dir: string;

beforeEach(async () => {
  gh = await new FakeGitHub().start();
  dir = await mkdtemp(join(tmpdir(), 'geo-action-qa-'));
  await writeFile(join(dir, `${GEO_TOOL.configBase}.json`), JSON.stringify({ site: 'https://bywell.org', brandTerms: ['Bywell'], prompts: ['roth ira for beginners'] }));
});
afterEach(() => gh.stop());

const PR = { pull_request: { number: 7, head: { sha: 'a81d3e2aaaa', repo: { full_name: 'kunolu/bywell' } }, base: { ref: 'main', repo: { full_name: 'kunolu/bywell' } } } };

async function env(name: string, inputs: Record<string, string>): Promise<Record<string, string>> {
  const eventPath = join(dir, 'event.json');
  await writeFile(eventPath, JSON.stringify(name === 'pull_request' ? PR : {}));
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
    'INPUT_MAX-PAGES': '50',
    OPENAI_API_KEY: 'sk-FAKE',
    ANTHROPIC_API_KEY: 'sk-ant-FAKE',
  };
  for (const [k, v] of Object.entries(inputs)) e[`INPUT_${k.toUpperCase()}`] = v;
  return e;
}

function run(e: Record<string, string>) {
  const lines: string[] = [];
  const { engine, calls } = fakeEngine({
    checkTarget: async () => (e.GITHUB_EVENT_NAME === 'pull_request' ? site([page('/learn/roth-ira', 92, {}, 'https://bywell-git-roth.vercel.app')], { target: 'https://bywell-git-roth.vercel.app' }) : boardFail()),
    runPrompts: async () => boardMeasures(),
  });
  const p = runAction({ env: e, fetch: (input, init) => fetch(input, init), engine, log: (s) => lines.push(s) });
  return { p, lines, calls };
}

describe('Action prompts and perception inputs', () => {
  it('a pull request never runs prompts or the judge, even with both inputs on and keys in env', async () => {
    const r = run(await env('pull_request', { url: 'https://bywell-git-roth.vercel.app', prompts: 'true', perception: 'true' }));
    expect(await r.p).toBe(0);
    expect(r.calls.runPrompts).toEqual([]);
  });

  it('BUG QA-B5: prompts on a pull request say why they did not run (a notice, not silence)', async () => {
    const r = run(await env('pull_request', { url: 'https://bywell-git-roth.vercel.app', prompts: 'true' }));
    await r.p;
    expect(r.lines.join('')).toMatch(/::notice[^\n]*::Prompts don't run in pull requests/);
  });

  it('BUG QA-B4: perception without prompts says it did nothing; nothing is sent', async () => {
    const r = run(await env('schedule', { url: 'https://bywell.org', perception: 'true' }));
    await r.p;
    expect(r.calls.runPrompts).toEqual([]);
    expect(r.lines.join('')).toMatch(/::notice[^\n]*::The perception input works with prompts: true/);
  });

  it('no notice when the inputs are used as meant (scheduled, prompts + perception)', async () => {
    const r = run(await env('schedule', { url: 'https://bywell.org', prompts: 'true', perception: 'true' }));
    await r.p;
    expect(r.calls.runPrompts[0]?.opts).toMatchObject({ brandTerms: ['Bywell'], perception: { mode: 'auto' } });
    expect(r.lines.join('')).not.toContain('::notice');
  });

  it('push runs (not only schedules) run prompts too, as the notice says', async () => {
    const r = run(await env('push', { url: 'https://bywell.org', prompts: 'true' }));
    await r.p;
    expect(r.calls.runPrompts).toHaveLength(1);
    expect(r.calls.runPrompts[0]?.opts.perception).toEqual({ mode: 'off' });
  });
});
