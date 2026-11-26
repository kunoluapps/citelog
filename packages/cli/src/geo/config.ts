// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { GEO_TOOL, MEASURES, PROMPT_STAGES, RULES, autoStage, defaultBrandTerms, type PromptStage, type StageSource } from '@morningdesk/core';
import { ENGINE_IDS, type EngineId } from '@morningdesk/geo';
import { parse as parseYaml } from 'yaml';

/** A config prompt after validation: a bare string in the file has no topic and no stage. */
export interface PromptSpec {
  text: string;
  topic: string | null;
  /** Set in the file; null = the auto word rule (core autoStage). */
  stage: PromptStage | null;
}

/** citelog.config.json | .yaml | .yml (base name from GEO_TOOL.configBase). */
export interface GeoConfig {
  /** Site to check and to look for in citations, e.g. "https://bywell.org" or "bywell.org". */
  site?: string;
  /** Strings or {text, topic, stage}; duplicates (same text) are dropped. */
  prompts?: PromptSpec[];
  /** Words that count as Named (at most MEASURES.brandTermsPerSite); default: the domain and its name. */
  brandTerms?: string[];
  engines?: EngineId[];
  failUnder?: number;
  maxPages?: number;
  /** Access log to read in the Action's scheduled run. */
  logs?: string;
}

export interface LoadedConfig {
  config: GeoConfig;
  /** File name as found (e.g. "citelog.config.json"), or null when there is none. */
  file: string | null;
}

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const CONFIG_FILES = [`${GEO_TOOL.configBase}.json`, `${GEO_TOOL.configBase}.yaml`, `${GEO_TOOL.configBase}.yml`];

const KEYS = new Set(['site', 'prompts', 'brandTerms', 'engines', 'failUnder', 'maxPages', 'logs', '$schema', '$comment']);
const PROMPT_KEYS = new Set(['text', 'topic', 'stage']);
const PROMPTS_HINT = 'a list of questions people ask, e.g. ["best budgeting app"] or [{ "text": "best budgeting app", "topic": "Budgeting", "stage": "discovery" }]';

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

export function validateConfig(raw: unknown, file: string): GeoConfig {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(file, `${file} must be an object with keys like "site" and "prompts".`);
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !KEYS.has(k));
  if (unknown.length) throw new ConfigError(file, `${file}: unknown key ${unknown.map((k) => `"${k}"`).join(', ')}. Keys: site, prompts, brandTerms, engines, failUnder, maxPages, logs.`);
  const c: GeoConfig = {};
  if (o.site !== undefined) {
    if (typeof o.site !== 'string' || !o.site.trim()) throw new ConfigError(file, `${file}: "site" must be a URL or domain, e.g. "https://example.com".`);
    c.site = o.site.trim();
  }
  if (o.prompts !== undefined) {
    if (!Array.isArray(o.prompts)) throw new ConfigError(file, `${file}: "prompts" must be ${PROMPTS_HINT}.`);
    const specs: PromptSpec[] = [];
    o.prompts.forEach((p: unknown, i) => {
      const spec = promptSpec(p, `${file}: prompt ${i + 1}`, file);
      if (!specs.some((s) => s.text === spec.text)) specs.push(spec);
    });
    c.prompts = specs;
  }
  if (o.brandTerms !== undefined) {
    const max = MEASURES.brandTermsPerSite;
    if (!Array.isArray(o.brandTerms) || o.brandTerms.some((t) => typeof t !== 'string' || !t.trim()) || o.brandTerms.length > max) {
      throw new ConfigError(file, `${file}: "brandTerms" must list up to ${max} names that count as Named, e.g. ["Bywell", "bywell.org"].`);
    }
    c.brandTerms = (o.brandTerms as string[]).map((t) => t.trim());
  }
  if (o.engines !== undefined) {
    const ids = ENGINE_IDS as readonly string[];
    if (!Array.isArray(o.engines) || o.engines.some((e) => typeof e !== 'string' || !ids.includes(e))) {
      throw new ConfigError(file, `${file}: "engines" must list some of ${ENGINE_IDS.join(', ')}.`);
    }
    c.engines = o.engines as EngineId[];
  }
  if (o.failUnder !== undefined) {
    if (!isInt(o.failUnder, 0, 100)) throw new ConfigError(file, `${file}: "failUnder" must be a whole number from 0 to 100.`);
    c.failUnder = o.failUnder;
  }
  if (o.maxPages !== undefined) {
    if (!isInt(o.maxPages, 1, 100_000)) throw new ConfigError(file, `${file}: "maxPages" must be a whole number of 1 or more.`);
    c.maxPages = o.maxPages;
  }
  if (o.logs !== undefined) {
    if (typeof o.logs !== 'string' || !o.logs.trim()) throw new ConfigError(file, `${file}: "logs" must be a path to an access log.`);
    c.logs = o.logs.trim();
  }
  return c;
}

function promptSpec(p: unknown, where: string, file: string): PromptSpec {
  if (typeof p === 'string') {
    if (!p.trim()) throw new ConfigError(file, `${where} is empty. "prompts" must be ${PROMPTS_HINT}.`);
    return { text: p.trim(), topic: null, stage: null };
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new ConfigError(file, `${where}: "prompts" must be ${PROMPTS_HINT}.`);
  const o = p as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !PROMPT_KEYS.has(k));
  if (unknown.length) throw new ConfigError(file, `${where}: unknown key ${unknown.map((k) => `"${k}"`).join(', ')}. A prompt takes text, topic and stage.`);
  if (typeof o.text !== 'string' || !o.text.trim()) throw new ConfigError(file, `${where}: "text" must be the question people ask.`);
  if (o.topic !== undefined && o.topic !== null && (typeof o.topic !== 'string' || !o.topic.trim())) {
    throw new ConfigError(file, `${where}: "topic" must be a name, e.g. "Retirement accounts".`);
  }
  if (o.stage !== undefined && o.stage !== null && !(PROMPT_STAGES as readonly unknown[]).includes(o.stage)) {
    throw new ConfigError(file, `${where}: "stage" must be one of ${PROMPT_STAGES.join(', ')}.`);
  }
  return { text: o.text.trim(), topic: typeof o.topic === 'string' ? o.topic.trim() : null, stage: (o.stage as PromptStage | null | undefined) ?? null };
}

/** The prompt texts, the only part of a prompt sent to an engine (topic and stage never are). */
export function promptTexts(prompts: readonly PromptSpec[]): string[] {
  return prompts.map((p) => p.text);
}

/** A prompt's stage: set in the file ('user'), else the auto word rule ('auto'). */
export function promptStage(p: PromptSpec): { stage: PromptStage; stageSource: StageSource } {
  return p.stage ? { stage: p.stage, stageSource: 'user' } : { stage: autoStage(p.text), stageSource: 'auto' };
}

/** Distinct topics, in file order. */
export function promptTopics(prompts: readonly PromptSpec[]): string[] {
  return [...new Set(prompts.map((p) => p.topic).filter((t): t is string => t !== null))];
}

/**
 * Brand terms for Named: the config's, else core's defaults for the domain (the CLI has no site name). The config's
 * terms belong to the config's site: when `--site` names a different domain, that site's defaults apply instead.
 */
export function brandTermsFor(config: GeoConfig, domain: string, siteFlag?: string): string[] {
  const otherSite = siteFlag !== undefined && config.site !== undefined && domainOf(config.site) !== domainOf(siteFlag);
  return config.brandTerms?.length && !otherSite ? config.brandTerms : defaultBrandTerms(null, domain);
}

/** Load the config from `explicit` or the first of CONFIG_FILES in `cwd`. No file is fine: defaults apply. */
export async function loadConfig(cwd: string, explicit?: string): Promise<LoadedConfig> {
  const candidates = explicit ? [resolve(cwd, explicit)] : CONFIG_FILES.map((f) => join(cwd, f));
  for (const path of candidates) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        if (explicit) throw new ConfigError(explicit, `${explicit} not found.`);
        continue;
      }
      throw e;
    }
    const file = basename(path);
    let raw: unknown;
    try {
      raw = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    } catch (e) {
      throw new ConfigError(file, `${file} isn't valid ${file.endsWith('.json') ? 'JSON' : 'YAML'}: ${(e as Error).message.split('\n')[0]}`);
    }
    return { config: validateConfig(raw, file), file };
  }
  return { config: {}, file: null };
}

/** "bywell.org" from "https://bywell.org/path" or "bywell.org". */
export function domainOf(site: string): string {
  try {
    return new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).hostname.replace(/^www\./, '');
  } catch {
    return site;
  }
}

/** Prompts that still hold a "<placeholder>"; they are never sent to an engine. */
export function placeholderPrompts(prompts: readonly string[]): string[] {
  return prompts.filter((p) => /<[^>]*>/.test(p));
}

/** A starter config: no prompts yet (so nothing is sent until someone writes real ones), with instructions. */
export function starterConfig(site?: string): string {
  const cfg = {
    $comment: 'Add the questions people ask AI about your field to "prompts", e.g. "best budgeting app for beginners". Engines run only with their API keys set.',
    site: site ?? 'https://example.com',
    prompts: [] as string[],
    engines: [...ENGINE_IDS],
    failUnder: 0,
    maxPages: RULES.geoDefaultMaxPages,
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}
