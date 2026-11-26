// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { AiBot } from '../types.js';

const OPENAI_DOCS = 'https://developers.openai.com/api/docs/bots';
const ANTHROPIC_DOCS = 'https://support.claude.com/en/articles/8896518';
const ANTHROPIC_IPS = 'https://claude.com/crawling/bots.json';
const PERPLEXITY_DOCS = 'https://docs.perplexity.ai/docs/resources/perplexity-crawlers.md';
const GOOGLE_COMMON_DOCS = 'https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers';
const GOOGLE_USER_DOCS = 'https://developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers';
const APPLE_DOCS = 'https://support.apple.com/en-us/119829';
const MISTRAL_DOCS = 'https://docs.mistral.ai/robots';
const AMAZON_DOCS = 'https://developer.amazon.com/amazonbot';
const META_DOCS = 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/';

/**
 * AI crawler catalog, from REVIEW-citelog-apis.md section 2 (checked against vendor docs 2026-11-18).
 * `main` bots are the search indexers and user-triggered fetchers the readiness check requires to be allowed.
 */
export const AI_BOTS: readonly AiBot[] = [
  { id: 'oai-searchbot', name: 'OAI-SearchBot', vendor: 'OpenAI', purpose: 'search', uaSubstring: 'OAI-SearchBot', robotsToken: 'OAI-SearchBot', main: true, ipRangesUrl: 'https://openai.com/searchbot.json', docsUrl: OPENAI_DOCS },
  { id: 'chatgpt-user', name: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'user', uaSubstring: 'ChatGPT-User', robotsToken: 'ChatGPT-User', main: true, ipRangesUrl: 'https://openai.com/chatgpt-user.json', docsUrl: OPENAI_DOCS },
  { id: 'gptbot', name: 'GPTBot', vendor: 'OpenAI', purpose: 'training', uaSubstring: 'GPTBot', robotsToken: 'GPTBot', main: false, ipRangesUrl: 'https://openai.com/gptbot.json', docsUrl: OPENAI_DOCS },
  { id: 'oai-adsbot', name: 'OAI-AdsBot', vendor: 'OpenAI', purpose: 'search', uaSubstring: 'OAI-AdsBot', robotsToken: 'OAI-AdsBot', main: false, ipRangesUrl: 'https://openai.com/adsbot.json', docsUrl: OPENAI_DOCS },
  { id: 'claude-searchbot', name: 'Claude-SearchBot', vendor: 'Anthropic', purpose: 'search', uaSubstring: 'Claude-SearchBot', robotsToken: 'Claude-SearchBot', main: true, ipRangesUrl: ANTHROPIC_IPS, docsUrl: ANTHROPIC_DOCS },
  { id: 'claude-user', name: 'Claude-User', vendor: 'Anthropic', purpose: 'user', uaSubstring: 'Claude-User', robotsToken: 'Claude-User', main: true, ipRangesUrl: ANTHROPIC_IPS, docsUrl: ANTHROPIC_DOCS },
  { id: 'claudebot', name: 'ClaudeBot', vendor: 'Anthropic', purpose: 'training', uaSubstring: 'ClaudeBot', robotsToken: 'ClaudeBot', main: false, ipRangesUrl: ANTHROPIC_IPS, docsUrl: ANTHROPIC_DOCS },
  { id: 'claude-agent', name: 'Claude-Agent', vendor: 'Anthropic', purpose: 'user', uaSubstring: 'Claude-Agent', robotsToken: 'Claude-Agent', main: false, docsUrl: ANTHROPIC_DOCS },
  { id: 'perplexitybot', name: 'PerplexityBot', vendor: 'Perplexity', purpose: 'search', uaSubstring: 'PerplexityBot', robotsToken: 'PerplexityBot', main: true, ipRangesUrl: 'https://www.perplexity.ai/perplexitybot.json', docsUrl: PERPLEXITY_DOCS },
  { id: 'perplexity-user', name: 'Perplexity-User', vendor: 'Perplexity', purpose: 'user', uaSubstring: 'Perplexity-User', robotsToken: 'Perplexity-User', main: true, ipRangesUrl: 'https://www.perplexity.ai/perplexity-user.json', docsUrl: PERPLEXITY_DOCS },
  { id: 'googlebot', name: 'Googlebot', vendor: 'Google', purpose: 'search', uaSubstring: 'Googlebot', robotsToken: 'Googlebot', main: true, ipRangesUrl: 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json', docsUrl: GOOGLE_COMMON_DOCS },
  { id: 'google-extended', name: 'Google-Extended', vendor: 'Google', purpose: 'training', robotsToken: 'Google-Extended', main: false, docsUrl: GOOGLE_COMMON_DOCS },
  { id: 'google-agent', name: 'Google-Agent', vendor: 'Google', purpose: 'user', uaSubstring: 'Google-Agent', robotsToken: 'Google-Agent', main: false, ipRangesUrl: 'https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json', docsUrl: GOOGLE_USER_DOCS },
  { id: 'google-gemininotebook', name: 'Google-GeminiNotebook', vendor: 'Google', purpose: 'user', uaSubstring: 'Google-GeminiNotebook', robotsToken: 'Google-GeminiNotebook', main: false, docsUrl: GOOGLE_USER_DOCS },
  { id: 'google-notebooklm', name: 'Google-NotebookLM', vendor: 'Google', purpose: 'user', uaSubstring: 'Google-NotebookLM', robotsToken: 'Google-NotebookLM', main: false, docsUrl: GOOGLE_USER_DOCS },
  { id: 'google-cloudvertexbot', name: 'Google-CloudVertexBot', vendor: 'Google', purpose: 'search', uaSubstring: 'Google-CloudVertexBot', robotsToken: 'Google-CloudVertexBot', main: false, ipRangesUrl: 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json', docsUrl: GOOGLE_COMMON_DOCS },
  { id: 'bingbot', name: 'Bingbot', vendor: 'Microsoft', purpose: 'search', uaSubstring: 'bingbot', robotsToken: 'bingbot', main: true, ipRangesUrl: 'https://www.bing.com/toolbox/bingbot.json', docsUrl: 'https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0' },
  { id: 'applebot', name: 'Applebot', vendor: 'Apple', purpose: 'search', uaSubstring: 'Applebot', robotsToken: 'Applebot', main: false, ipRangesUrl: 'http://search.developer.apple.com/applebot.json', docsUrl: APPLE_DOCS },
  { id: 'applebot-extended', name: 'Applebot-Extended', vendor: 'Apple', purpose: 'training', robotsToken: 'Applebot-Extended', main: false, docsUrl: APPLE_DOCS },
  { id: 'duckassistbot', name: 'DuckAssistBot', vendor: 'DuckDuckGo', purpose: 'search', uaSubstring: 'DuckAssistBot', robotsToken: 'DuckAssistBot', main: false, ipRangesUrl: 'https://duckduckgo.com/duckassistbot.json', docsUrl: 'https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot' },
  { id: 'mistralai-user', name: 'MistralAI-User', vendor: 'Mistral', purpose: 'user', uaSubstring: 'MistralAI-User', robotsToken: 'MistralAI-User', main: false, ipRangesUrl: 'https://mistral.ai/mistralai-user-ips.json', docsUrl: MISTRAL_DOCS },
  { id: 'mistralai-index', name: 'MistralAI-Index', vendor: 'Mistral', purpose: 'search', uaSubstring: 'MistralAI-Index', robotsToken: 'MistralAI-Index', main: false, ipRangesUrl: 'https://mistral.ai/mistralai-index-ips.json', docsUrl: MISTRAL_DOCS },
  { id: 'mistralai-training', name: 'MistralAI-Training', vendor: 'Mistral', purpose: 'training', uaSubstring: 'MistralAI-Training', robotsToken: 'MistralAI-Training', main: false, docsUrl: MISTRAL_DOCS },
  { id: 'amzn-searchbot', name: 'Amzn-SearchBot', vendor: 'Amazon', purpose: 'search', uaSubstring: 'Amzn-SearchBot', robotsToken: 'Amzn-SearchBot', main: false, docsUrl: AMAZON_DOCS },
  { id: 'amzn-user', name: 'Amzn-User', vendor: 'Amazon', purpose: 'user', uaSubstring: 'Amzn-User', robotsToken: 'Amzn-User', main: false, docsUrl: AMAZON_DOCS },
  { id: 'amazonbot', name: 'Amazonbot', vendor: 'Amazon', purpose: 'training', uaSubstring: 'Amazonbot', robotsToken: 'Amazonbot', main: false, docsUrl: AMAZON_DOCS },
  { id: 'meta-webindexer', name: 'Meta-WebIndexer', vendor: 'Meta', purpose: 'search', uaSubstring: 'meta-webindexer', robotsToken: 'meta-webindexer', main: false, docsUrl: META_DOCS },
  { id: 'meta-externalagent', name: 'Meta-ExternalAgent', vendor: 'Meta', purpose: 'training', uaSubstring: 'meta-externalagent', robotsToken: 'meta-externalagent', main: false, docsUrl: META_DOCS },
  { id: 'meta-externalfetcher', name: 'Meta-ExternalFetcher', vendor: 'Meta', purpose: 'user', uaSubstring: 'meta-externalfetcher', robotsToken: 'meta-externalfetcher', main: false, docsUrl: META_DOCS },
  { id: 'ccbot', name: 'CCBot', vendor: 'Common Crawl', purpose: 'training', uaSubstring: 'CCBot', robotsToken: 'CCBot', main: false, ipRangesUrl: 'https://index.commoncrawl.org/ccbot.json', docsUrl: 'https://commoncrawl.org/ccbot' },
];

/** Bots whose robots.txt block warns rather than fails: Google-Extended also gates Gemini grounding (review finding 4). */
export const WARN_IF_BLOCKED: ReadonlySet<string> = new Set(['google-extended']);

/** Match a User-Agent header to a catalogued AI bot. The longest matching product token wins (Claude-SearchBot over ClaudeBot). */
export function matchBot(userAgent: string): AiBot | undefined {
  const ua = userAgent.toLowerCase();
  let best: AiBot | undefined;
  for (const bot of AI_BOTS) {
    if (!bot.uaSubstring) continue;
    if (!ua.includes(bot.uaSubstring.toLowerCase())) continue;
    if (!best || bot.uaSubstring.length > (best.uaSubstring?.length ?? 0)) best = bot;
  }
  return best;
}

export function botById(id: string): AiBot | undefined {
  return AI_BOTS.find((b) => b.id === id);
}
