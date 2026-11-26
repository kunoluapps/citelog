// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { GEO_TOOL, type GeoApi } from '@morningdesk/core';
import type { PromptResult, PromptRun } from '@morningdesk/geo';
import { promptStage, type PromptSpec } from '../config.js';

export type JsonCommand = 'check' | 'logs' | 'prompts';

/** Machine output for `--json`: one object, stable top-level keys, the engine's own shapes inside. */
export function renderJson(command: JsonCommand, exitCode: number, body: Record<string, unknown>): string {
  return `${JSON.stringify({ tool: GEO_TOOL.bin, version: GEO_TOOL.version, command, exitCode, ...body }, null, 2)}\n`;
}

/** The measure fields of a result, named and shaped as in the desk API's PromptCell (AC 8). */
export type PromptMeasuresJson = Pick<GeoApi.PromptCell, 'mentioned' | 'mentionSnippet' | 'perceptionStatus' | 'perception' | 'considered'> & {
  consideredOffsite: number | null;
};

export type PromptResultJson = Omit<PromptResult, keyof PromptMeasuresJson> & PromptMeasuresJson;

/** A prompt as the API's PromptRow names it: text, topic, stage, stageSource. */
export type PromptJson = Pick<GeoApi.PromptRow, 'text' | 'topic' | 'stage' | 'stageSource'>;

export function promptResultJson(r: PromptResult): PromptResultJson {
  return {
    ...r,
    mentioned: r.mentioned,
    mentionSnippet: r.mentionSnippet ?? null,
    perceptionStatus: r.perceptionStatus,
    perception: r.perception ?? null,
    considered: r.considered ? r.considered.map((c) => ({ url: c.url ?? null, host: c.host, cited: c.cited })) : null,
    consideredOffsite: r.consideredOffsite,
  };
}

export function promptJson(p: PromptSpec): PromptJson {
  return { text: p.text, topic: p.topic, ...promptStage(p) };
}

/** `prompts --json` body: prompts with topic and stage, and the run with API-named measure fields. */
export function promptsJsonBody(run: PromptRun, prompts: readonly PromptSpec[]): { prompts: PromptJson[]; run: Omit<PromptRun, 'results'> & { results: PromptResultJson[] } } {
  return { prompts: prompts.map(promptJson), run: { ...run, results: run.results.map(promptResultJson) } };
}
