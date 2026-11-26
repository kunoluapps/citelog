// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { detectFormat, parseClfTime, parseEdgeTimestamp, parseLine, readLine } from '../../src/logs/index.js';
import type { LogFormat } from '../../src/types.js';
import { fixtureLines } from './helpers.js';

function tally(name: string, format: LogFormat) {
  let hits = 0;
  let malformed = 0;
  let ignored = 0;
  for (const line of fixtureLines(name)) {
    if (!line.trim()) continue;
    const r = readLine(line, format);
    if (r.malformed) malformed++;
    else if (r.hits.length === 0) ignored++;
    hits += r.hits.length;
  }
  return { hits, malformed, ignored };
}

describe('detectFormat', () => {
  it('names each format we read', () => {
    expect(detectFormat(fixtureLines('nginx-combined.log'))).toBe('combined');
    expect(detectFormat(fixtureLines('cloudflare.ndjson'))).toBe('cloudflare');
    expect(detectFormat(fixtureLines('vercel.ndjson'))).toBe('vercel');
    expect(detectFormat(fixtureLines('vercel-array.json'))).toBe('vercel');
  });

  it('returns null for anything else', () => {
    expect(detectFormat(fixtureLines('unknown.log'))).toBeNull();
    expect(detectFormat([])).toBeNull();
    expect(detectFormat(['', '   '])).toBeNull();
  });

  it('goes by the majority when a few lines are odd', () => {
    const lines = fixtureLines('nginx-combined.log').slice(0, 6);
    expect(detectFormat(['garbage', ...lines])).toBe('combined');
  });
});

describe('combined (nginx and Apache)', () => {
  it('reads the documented sample', () => {
    const hit = parseLine(fixtureLines('nginx-combined.log')[0] ?? '', 'combined');
    expect(hit).toEqual({
      time: '2026-11-17T06:25:24.000Z',
      ip: '132.196.86.5',
      method: 'GET',
      path: '/blog/ai-readiness',
      status: 200,
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)',
    });
  });

  it('drops the query string, applies the time zone offset and reads IPv6 clients', () => {
    const lines = fixtureLines('nginx-combined.log');
    expect(parseLine(lines[1] ?? '', 'combined')?.path).toBe('/blog/ai-readiness');
    expect(parseLine(lines[2] ?? '', 'combined')?.time).toBe('2026-11-17T07:00:00.000Z');
    expect(parseLine(lines[9] ?? '', 'combined')?.time).toBe('2026-11-17T18:00:00.000Z');
    expect(parseLine(lines[7] ?? '', 'combined')?.ip).toBe('2001:4860:4801:10::1');
    expect(parseLine(lines[5] ?? '', 'combined')?.status).toBe(304);
  });

  it('unescapes nginx \\xXX and Apache \\" in quoted fields', () => {
    const lines = fixtureLines('nginx-combined.log');
    expect(parseLine(lines[10] ?? '', 'combined')?.userAgent).toBe('Mozilla/5.0 "quoted" \\slash');
    expect(parseLine(lines[11] ?? '', 'combined')?.userAgent).toBe('Apache "quoted" agent');
  });

  it('skips and counts malformed lines: not a log line, no request line, bad date', () => {
    expect(tally('nginx-combined.log', 'combined')).toEqual({ hits: 12, malformed: 3, ignored: 0 });
  });

  it('parses CLF times and rejects bad ones', () => {
    expect(parseClfTime('01/Jan/2026:00:00:00 -0230')).toBe('2026-01-01T02:30:00.000Z');
    expect(parseClfTime('01/Foo/2026:00:00:00 +0000')).toBeNull();
    expect(parseClfTime('31/Feb/2026:00:00:00 +0000')).toBeNull();
    expect(parseClfTime('01/Feb/2026:24:00:00 +0000')).toBeNull();
    expect(parseClfTime('2026-01-01T00:00:00Z')).toBeNull();
  });
});

describe('Cloudflare Logpush', () => {
  it('reads the documented sample with ClientIP, host, method and URI', () => {
    const hit = parseLine(fixtureLines('cloudflare.ndjson')[0] ?? '', 'cloudflare');
    expect(hit).toEqual({
      time: '2026-11-23T06:15:24.433Z',
      ip: '23.98.142.180',
      method: 'GET',
      path: '/blog/ai-readiness',
      status: 200,
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
      host: 'example.com',
    });
  });

  it('falls back to ClientRequestURI without its query', () => {
    expect(parseLine(fixtureLines('cloudflare.ndjson')[1] ?? '', 'cloudflare')?.path).toBe('/pricing');
  });

  it('reads EdgeStartTimestamp in every timestamp_format', () => {
    expect(parseEdgeTimestamp(1795414524433000200)).toBe('2026-11-23T06:15:24.433Z');
    expect(parseEdgeTimestamp('1795414524433000200')).toBe('2026-11-23T06:15:24.433Z');
    expect(parseEdgeTimestamp(1795414524433)).toBe('2026-11-23T06:15:24.433Z');
    expect(parseEdgeTimestamp(1795414524)).toBe('2026-11-23T06:15:24.000Z');
    expect(parseEdgeTimestamp('2026-11-17T06:25:24Z')).toBe('2026-11-17T06:25:24.000Z');
    expect(parseEdgeTimestamp('2026-11-17T06:25:24.123Z')).toBe('2026-11-17T06:25:24.123Z');
    expect(parseEdgeTimestamp('2026-11-17T06:25:24.123456789Z')).toBe('2026-11-17T06:25:24.123Z');
    expect(parseEdgeTimestamp('2026-11-17T06:25:24+01:00')).toBe('2026-11-17T05:25:24.000Z');
    expect(parseEdgeTimestamp('yesterday')).toBeNull();
    expect(parseEdgeTimestamp(null)).toBeNull();
  });

  it('skips and counts a truncated record and one with an unreadable time', () => {
    expect(tally('cloudflare.ndjson', 'cloudflare')).toEqual({ hits: 6, malformed: 2, ignored: 0 });
  });
});

describe('Vercel log drain', () => {
  it('reads proxy fields: clientIp, userAgent[0], path, host, ms timestamp', () => {
    const hit = parseLine(fixtureLines('vercel.ndjson')[0] ?? '', 'vercel');
    expect(hit).toEqual({
      time: '2019-11-15T11:27:30.172Z',
      ip: '107.20.236.150',
      method: 'GET',
      path: '/blog/ai-readiness',
      status: 200,
      userAgent: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
      host: 'example.com',
    });
  });

  it('uses proxy.path, not the top-level function route', () => {
    expect(parseLine(fixtureLines('vercel.ndjson')[3] ?? '', 'vercel')?.path).toBe('/pricing');
  });

  it('ignores build logs and revalidations; skips and counts malformed entries', () => {
    expect(tally('vercel.ndjson', 'vercel')).toEqual({ hits: 2, malformed: 2, ignored: 2 });
  });

  it('reads JSON array output, one entry per line or all on one line', () => {
    expect(tally('vercel-array.json', 'vercel')).toEqual({ hits: 2, malformed: 0, ignored: 2 });
    const entries = fixtureLines('vercel-array.json').slice(1, 3).map((l) => JSON.parse(l.replace(/,$/, '')) as unknown);
    const oneLine = JSON.stringify(entries);
    expect(readLine(oneLine, 'vercel').hits.map((h) => h.path)).toEqual(['/a', '/b']);
    expect(parseLine(oneLine, 'vercel')?.path).toBe('/a');
  });
});
