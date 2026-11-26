// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GEO_TOOL } from '@morningdesk/core';
import { ConfigError, brandTermsFor, domainOf, loadConfig, promptStage, promptTexts, starterConfig, validateConfig } from '../src/index.js';

async function dir(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'geo-config-'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(d, name), text);
  return d;
}

const JSON_NAME = `${GEO_TOOL.configBase}.json`;
const spec = (text: string, topic: string | null = null, stage: string | null = null) => ({ text, topic, stage });
const YAML_NAME = `${GEO_TOOL.configBase}.yaml`;

describe('loadConfig', () => {
  it('no file: empty config, file null (first run uses defaults)', async () => {
    expect(await loadConfig(await dir({}))).toEqual({ config: {}, file: null });
  });

  it('reads JSON', async () => {
    const d = await dir({ [JSON_NAME]: JSON.stringify({ site: 'https://lovestruck.app', prompts: ['a', 'b'], engines: ['openai'], failUnder: 80, maxPages: 20 }) });
    expect(await loadConfig(d)).toEqual({ file: JSON_NAME, config: { site: 'https://lovestruck.app', prompts: [spec('a'), spec('b')], engines: ['openai'], failUnder: 80, maxPages: 20 } });
  });

  it('reads YAML and prefers JSON when both exist', async () => {
    const yaml = 'site: bywell.org\nprompts:\n  - roth ira for beginners\n  - etf vs index fund\nlogs: ./logs/access.log\n';
    expect((await loadConfig(await dir({ [YAML_NAME]: yaml }))).config).toEqual({ site: 'bywell.org', prompts: [spec('roth ira for beginners'), spec('etf vs index fund')], logs: './logs/access.log' });
    const both = await dir({ [YAML_NAME]: yaml, [JSON_NAME]: '{"site":"a.com"}' });
    expect((await loadConfig(both)).file).toBe(JSON_NAME);
  });

  it('explains bad files', async () => {
    await expect(loadConfig(await dir({ [JSON_NAME]: '{ nope' }))).rejects.toThrow(/isn't valid JSON/);
    await expect(loadConfig(await dir({}), 'missing.json')).rejects.toThrow(/missing.json not found/);
  });

  it.each([
    [{ prompt: [] }, /unknown key "prompt"/],
    [{ prompts: 'one' }, /"prompts" must be a list/],
    [{ engines: ['bing'] }, /"engines" must list some of openai, anthropic, perplexity, gemini/],
    [{ failUnder: 120 }, /"failUnder" must be a whole number from 0 to 100/],
    [{ maxPages: 0 }, /"maxPages"/],
    [{ site: '' }, /"site"/],
    [[1], /must be an object/],
    [{ prompts: [{ text: 'a', stage: 'awareness' }] }, /prompt 1: "stage" must be one of discovery, evaluation, decision/],
    [{ prompts: ['a', { text: 'b', why: 'x' }] }, /prompt 2: unknown key "why"/],
    [{ prompts: [{ topic: 'Retirement' }] }, /prompt 1: "text" must be the question/],
    [{ prompts: [{ text: 'a', topic: '' }] }, /"topic" must be a name/],
    [{ prompts: [''] }, /prompt 1 is empty/],
    [{ brandTerms: ['a', 'b', 'c', 'd', 'e', 'f'] }, /"brandTerms" must list up to 5 names/],
    [{ brandTerms: 'Bywell' }, /"brandTerms"/],
  ])('validates %j', (raw, msg) => {
    expect(() => validateConfig(raw, 'x.json')).toThrow(ConfigError);
    expect(() => validateConfig(raw, 'x.json')).toThrow(msg);
  });

  it('prompts may be strings or {text, topic, stage}; duplicates dropped; YAML too', async () => {
    const c = validateConfig({ prompts: ['roth ira vs 401k', { text: ' bywell price ', topic: ' Pricing ', stage: 'decision' }, { text: 'roth ira vs 401k', topic: 'X' }], brandTerms: [' Bywell '] }, 'x.json');
    expect(c.prompts).toEqual([spec('roth ira vs 401k'), spec('bywell price', 'Pricing', 'decision')]);
    expect(c.brandTerms).toEqual(['Bywell']);
    expect(promptTexts(c.prompts ?? [])).toEqual(['roth ira vs 401k', 'bywell price']);
    expect((c.prompts ?? []).map(promptStage)).toEqual([{ stage: 'evaluation', stageSource: 'auto' }, { stage: 'decision', stageSource: 'user' }]);
    const yaml = 'site: bywell.org\nbrandTerms: [Bywell]\nprompts:\n  - text: roth ira for beginners\n    topic: Retirement\n  - best app to learn investing\n';
    expect((await loadConfig(await dir({ [YAML_NAME]: yaml }))).config.prompts).toEqual([spec('roth ira for beginners', 'Retirement'), spec('best app to learn investing')]);
  });

  it('brand terms default to the domain and, for a two-label domain, its name', () => {
    expect(brandTermsFor({}, 'bywell.org')).toEqual(['bywell', 'bywell.org']);
    expect(brandTermsFor({}, 'docs.example.com')).toEqual(['docs.example.com']);
    expect(brandTermsFor({ brandTerms: ['Lewis'] }, 'thelewisapp.com')).toEqual(['Lewis']);
  });

  it('domainOf and starter config', () => {
    expect(domainOf('https://www.bywell.org/learn')).toBe('bywell.org');
    expect(domainOf('lovestruck.app')).toBe('lovestruck.app');
    expect(validateConfig(JSON.parse(starterConfig('https://ansa.chat')), 'x.json').site).toBe('https://ansa.chat');
  });
});
