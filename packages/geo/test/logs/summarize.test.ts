// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { AI_BOTS } from '../../src/bots/index.js';
import { IP_RANGES_AS_OF, LogFormatError, SUPPORTED_FORMATS_MESSAGE, summarizeLogs, summarizeWith } from '../../src/logs/index.js';
import { fixtureLines, streamOf, testDeps } from './helpers.js';

describe('summarizeLogs on an nginx combined log (AC 7)', () => {
  it('counts visits per AI bot and marks each verified, unverified or unknown', async () => {
    const s = await summarizeWith(fixtureLines('nginx-combined.log'), undefined, testDeps);
    expect(s.format).toBe('combined');
    expect(s.linesRead).toBe(15);
    expect(s.linesSkipped).toBe(3);
    expect(s.ipRangesAsOf).toBe(IP_RANGES_AS_OF);
    expect(s.from).toBe('2026-11-17T06:25:24.000Z');
    expect(s.to).toBe('2026-11-17T18:00:00.000Z');

    expect(s.bots).toEqual([
      { botId: 'gptbot', hits: 4, verifiedHits: 3, unverifiedHits: 1, unknownHits: 0, pages: 2 },
      { botId: 'claude-searchbot', hits: 1, verifiedHits: 1, unverifiedHits: 0, unknownHits: 0, pages: 1 },
      { botId: 'claudebot', hits: 1, verifiedHits: 1, unverifiedHits: 0, unknownHits: 0, pages: 1 },
      { botId: 'googlebot', hits: 1, verifiedHits: 1, unverifiedHits: 0, unknownHits: 0, pages: 1 },
      { botId: 'meta-externalagent', hits: 1, verifiedHits: 0, unverifiedHits: 0, unknownHits: 1, pages: 1 },
      { botId: 'perplexitybot', hits: 1, verifiedHits: 1, unverifiedHits: 0, unknownHits: 0, pages: 1 },
    ]);

    expect(s.rows[0]).toEqual({ botId: 'gptbot', path: '/blog/ai-readiness', hits: 2, verified: true, lastSeen: '2026-11-17T07:01:00.000Z' });
    expect(s.rows).toContainEqual({ botId: 'meta-externalagent', path: '/about', hits: 1, verified: null, lastSeen: '2026-11-17T12:30:00.000Z' });
    expect(s.rows).toContainEqual({ botId: 'googlebot', path: '/', hits: 1, verified: true, lastSeen: '2026-11-17T12:00:00.000Z' });
  });

  it('marks a GPTBot user agent from a non-OpenAI IP as unverified', async () => {
    const s = await summarizeWith(fixtureLines('nginx-combined.log'), 'combined', testDeps);
    expect(s.rows).toContainEqual({ botId: 'gptbot', path: '/blog/ai-readiness', hits: 1, verified: false, lastSeen: '2026-11-17T09:12:45.000Z' });
    const spoof = ['203.0.113.9 - - [17/Nov/2026:09:12:45 +0000] "GET / HTTP/1.1" 200 1 "-" "Mozilla/5.0 (compatible; GPTBot/1.4; +https://openai.com/gptbot)"'];
    const only = await summarizeWith(spoof, undefined, testDeps);
    expect(only.bots).toEqual([{ botId: 'gptbot', hits: 1, verifiedHits: 0, unverifiedHits: 1, unknownHits: 0, pages: 1 }]);
  });

  it('reads an async stream the same as an array', async () => {
    const lines = fixtureLines('nginx-combined.log');
    const a = await summarizeWith(lines, undefined, testDeps);
    const b = await summarizeWith(streamOf(lines), undefined, testDeps);
    expect(b).toEqual(a);
  });

  it('keeps one row per bot, page and verification state however many lines', async () => {
    const line = (i: number) =>
      `132.196.86.${i % 200} - - [17/Nov/2026:06:${String(i % 60).padStart(2, '0')}:00 +0000] "GET /p${i % 5}?n=${i} HTTP/1.1" 200 1 "-" "GPTBot/1.4"`;
    function* many() {
      for (let i = 0; i < 50_000; i++) yield line(i);
    }
    const s = await summarizeWith(many(), undefined, testDeps);
    expect(s.linesRead).toBe(50_000);
    expect(s.rows).toHaveLength(5);
    expect(s.bots[0]?.verifiedHits).toBe(50_000);
  });
});

describe('summarizeLogs on Cloudflare and Vercel logs', () => {
  it('summarises Cloudflare Logpush with ClientIP verification', async () => {
    const s = await summarizeWith(fixtureLines('cloudflare.ndjson'), undefined, testDeps);
    expect(s.format).toBe('cloudflare');
    expect(s.linesSkipped).toBe(2);
    expect(s.bots.find((b) => b.botId === 'gptbot')).toEqual({ botId: 'gptbot', hits: 5, verifiedHits: 5, unverifiedHits: 0, unknownHits: 0, pages: 1 });
    expect(s.bots.find((b) => b.botId === 'chatgpt-user')?.verifiedHits).toBe(1);
  });

  it('names the Cloudflare fields a Logpush job is missing', async () => {
    await expect(summarizeWith(fixtureLines('cloudflare-missing-fields.ndjson'), 'cloudflare', testDeps)).rejects.toThrow(
      /missing ClientRequestUserAgent, ClientRequestPath or ClientRequestURI/,
    );
  });

  it('summarises a Vercel drain using proxy.clientIp', async () => {
    const s = await summarizeWith(fixtureLines('vercel.ndjson'), undefined, testDeps);
    expect(s.format).toBe('vercel');
    expect(s.linesSkipped).toBe(2);
    expect(s.rows).toEqual([
      { botId: 'perplexitybot', path: '/blog/ai-readiness', hits: 1, verified: true, lastSeen: '2019-11-15T11:27:30.172Z' },
      { botId: 'perplexitybot', path: '/pricing', hits: 1, verified: false, lastSeen: '2019-11-15T11:27:30.400Z' },
    ]);
  });

  it('refuses an unknown format and names the formats it reads', async () => {
    await expect(summarizeWith(fixtureLines('unknown.log'), undefined, testDeps)).rejects.toThrow(LogFormatError);
    await expect(summarizeWith(fixtureLines('unknown.log'), undefined, testDeps)).rejects.toThrow(SUPPORTED_FORMATS_MESSAGE);
    expect(SUPPORTED_FORMATS_MESSAGE).toMatch(/nginx\/Apache combined, Cloudflare Logpush \(JSON\) and Vercel log drain/);
  });

  it('with a format given, an unreadable file is all skipped lines rather than an error', async () => {
    const s = await summarizeWith(fixtureLines('unknown.log'), 'combined', testDeps);
    expect(s).toMatchObject({ linesRead: 3, linesSkipped: 3, bots: [], rows: [], from: null, to: null });
  });
});

describe('summarizeLogs with the real bot catalog', () => {
  it.skipIf(AI_BOTS.length === 0)('marks verified and spoofed GPTBot hits', async () => {
    const s = await summarizeLogs(fixtureLines('nginx-combined.log'));
    const gpt = s.bots.find((b) => b.hits > 0 && b.unverifiedHits === 1 && b.verifiedHits === 3);
    expect(gpt).toBeDefined();
  });
});
