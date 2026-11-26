// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { readFileSync } from 'node:fs';
import type { AiBot } from '../../src/types.js';
import type { SummarizeDeps } from '../../src/logs/index.js';
import { IP_RANGES_AS_OF, verifyBotIp } from '../../src/ipranges/index.js';

/** A slice of the catalog from REVIEW-citelog-apis.md section 2, so these tests don't depend on the bots workstream. */
export const TEST_BOTS: AiBot[] = [
  { id: 'gptbot', name: 'GPTBot', vendor: 'OpenAI', purpose: 'training', uaSubstring: 'GPTBot', robotsToken: 'GPTBot', main: false, ipRangesUrl: 'https://openai.com/gptbot.json', docsUrl: 'https://developers.openai.com/api/docs/bots' },
  { id: 'chatgpt-user', name: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'user', uaSubstring: 'ChatGPT-User', robotsToken: 'ChatGPT-User', main: true, ipRangesUrl: 'https://openai.com/chatgpt-user.json', docsUrl: 'https://developers.openai.com/api/docs/bots' },
  { id: 'claudebot', name: 'ClaudeBot', vendor: 'Anthropic', purpose: 'training', uaSubstring: 'ClaudeBot', robotsToken: 'ClaudeBot', main: false, ipRangesUrl: 'https://claude.com/crawling/bots.json', docsUrl: 'https://support.claude.com/en/articles/8896518' },
  { id: 'claude-searchbot', name: 'Claude-SearchBot', vendor: 'Anthropic', purpose: 'search', uaSubstring: 'Claude-SearchBot', robotsToken: 'Claude-SearchBot', main: true, ipRangesUrl: 'https://claude.com/crawling/bots.json', docsUrl: 'https://support.claude.com/en/articles/8896518' },
  { id: 'perplexitybot', name: 'PerplexityBot', vendor: 'Perplexity', purpose: 'search', uaSubstring: 'PerplexityBot', robotsToken: 'PerplexityBot', main: true, ipRangesUrl: 'https://perplexity.ai/perplexitybot.json', docsUrl: 'https://docs.perplexity.ai/docs/resources/perplexity-crawlers.md' },
  { id: 'googlebot', name: 'Googlebot', vendor: 'Google', purpose: 'search', uaSubstring: 'Googlebot', robotsToken: 'Googlebot', main: true, ipRangesUrl: 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json', docsUrl: 'https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers' },
  { id: 'applebot', name: 'Applebot', vendor: 'Apple', purpose: 'search', uaSubstring: 'Applebot', robotsToken: 'Applebot', main: false, ipRangesUrl: 'https://search.developer.apple.com/applebot.json', docsUrl: 'https://support.apple.com/en-us/119829' },
  { id: 'meta-externalagent', name: 'Meta-ExternalAgent', vendor: 'Meta', purpose: 'training', uaSubstring: 'meta-externalagent', robotsToken: 'meta-externalagent', main: false, docsUrl: 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/' },
];

/** Longest substring first, case-insensitive (review section 2). */
export function testMatchBot(userAgent: string): AiBot | undefined {
  const ua = userAgent.toLowerCase();
  return [...TEST_BOTS]
    .filter((b) => b.uaSubstring)
    .sort((a, b) => (b.uaSubstring?.length ?? 0) - (a.uaSubstring?.length ?? 0))
    .find((b) => ua.includes((b.uaSubstring ?? '').toLowerCase()));
}

export const testDeps: SummarizeDeps = { matchBot: testMatchBot, verify: verifyBotIp, ipRangesAsOf: IP_RANGES_AS_OF };

export function fixtureLines(name: string): string[] {
  return readFileSync(new URL(`../fixtures/logs/${name}`, import.meta.url), 'utf8').split('\n');
}

export async function* streamOf(lines: string[]): AsyncGenerator<string> {
  for (const l of lines) yield l;
}
