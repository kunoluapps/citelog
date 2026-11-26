// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { SOURCES } from '@morningdesk/core';
import type { EngineId, EngineInfo } from '../types.js';

/** Labels come from core SOURCES (one name per engine across the CLI, Action, desk and source tags). */
export const ENGINES: Record<EngineId, EngineInfo> = {
  openai: { id: 'openai', label: SOURCES.openai, envVar: 'OPENAI_API_KEY', model: 'gpt-6.2-astra' },
  anthropic: { id: 'anthropic', label: SOURCES.anthropic, envVar: 'ANTHROPIC_API_KEY', model: 'claude-haiku-5-5' },
  perplexity: { id: 'perplexity', label: SOURCES.perplexity, envVar: 'PERPLEXITY_API_KEY', model: 'perplexity/sonar' },
  gemini: { id: 'gemini', label: SOURCES.gemini, envVar: 'GOOGLE_API_KEY or GEMINI_API_KEY', model: 'gemini-4-hydrogen' },
};

/** Gemini also reads GOOGLE_API_KEY, which takes precedence over GEMINI_API_KEY (Google's documented order). */
const KEY_VARS: Record<EngineId, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'],
  gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
};

/** The key that enables an engine, or undefined. */
export function engineApiKey(engine: EngineId, env: Record<string, string | undefined>): string | undefined {
  for (const name of KEY_VARS[engine]) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  return undefined;
}
