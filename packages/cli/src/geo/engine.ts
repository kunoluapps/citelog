// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { AiViewSummary } from '@morningdesk/core';
import { AI_BOTS, checkTarget, detectFormat, readAiView, runPrompts, summarizeLogs } from '@morningdesk/geo';
import type { AiBot, CrawlOptions, FetchLike, LogFormat, LogSummary, PromptRun, RunPromptsOptions, SiteReport } from '@morningdesk/geo';

/** The engine calls the CLI and the Action make. Tests pass fakes; the real one is packages/geo. */
export interface GeoEngine {
  checkTarget(target: string, opts: CrawlOptions): Promise<SiteReport>;
  /** What AI crawlers see on one page (the reveal). Never throws. */
  readAiView(url: string, opts: { fetch: FetchLike; userAgent?: string }): Promise<{ summary: AiViewSummary } | { error: string }>;
  detectFormat(sample: string[]): LogFormat | null;
  summarizeLogs(lines: AsyncIterable<string> | Iterable<string>, format?: LogFormat): Promise<LogSummary>;
  runPrompts(site: string, prompts: string[], opts: RunPromptsOptions): Promise<PromptRun>;
  bots: readonly AiBot[];
}

export const realEngine: GeoEngine = {
  checkTarget,
  readAiView,
  detectFormat,
  summarizeLogs,
  runPrompts,
  get bots() {
    return AI_BOTS;
  },
};
