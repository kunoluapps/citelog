// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { AI_BOTS, matchBot } from '../../src/bots/index.js';

describe('AI_BOTS', () => {
  it('has unique ids and robots tokens', () => {
    expect(new Set(AI_BOTS.map((b) => b.id)).size).toBe(AI_BOTS.length);
    expect(new Set(AI_BOTS.map((b) => b.robotsToken.toLowerCase())).size).toBe(AI_BOTS.length);
  });

  it('marks the search indexers and user fetchers the check requires as main', () => {
    expect(AI_BOTS.filter((b) => b.main).map((b) => b.id).sort()).toEqual(
      ['bingbot', 'chatgpt-user', 'claude-searchbot', 'claude-user', 'googlebot', 'oai-searchbot', 'perplexity-user', 'perplexitybot'].sort(),
    );
    expect(AI_BOTS.filter((b) => b.main).every((b) => b.purpose !== 'training')).toBe(true);
  });

  it('keeps robots-only tokens without a UA substring', () => {
    const extended = AI_BOTS.find((b) => b.id === 'google-extended');
    expect(extended?.uaSubstring).toBeUndefined();
    expect(extended?.robotsToken).toBe('Google-Extended');
  });

  it('gives every bot an https docs link', () => {
    for (const b of AI_BOTS) expect(b.docsUrl).toMatch(/^https:\/\//);
  });
});

describe('matchBot', () => {
  it('tells ChatGPT-User from GPTBot', () => {
    expect(matchBot('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot')?.id).toBe('chatgpt-user');
    expect(matchBot('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot')?.id).toBe('gptbot');
    expect(matchBot('Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)')?.id).toBe('oai-searchbot');
  });

  it('prefers the longest token (Claude-SearchBot over ClaudeBot)', () => {
    expect(matchBot('Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +claudebot@anthropic.com)')?.id).toBe('claude-searchbot');
    expect(matchBot('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)')?.id).toBe('claudebot');
  });

  it('matches case-insensitively', () => {
    expect(matchBot('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)')?.id).toBe('bingbot');
    expect(matchBot('MOZILLA/5.0 (COMPATIBLE; PERPLEXITYBOT/1.0)')?.id).toBe('perplexitybot');
    expect(matchBot('meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)')?.id).toBe('meta-externalagent');
  });

  it('returns undefined for browsers and unknown bots', () => {
    expect(matchBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15')).toBeUndefined();
    expect(matchBot('')).toBeUndefined();
  });
});
