// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { AiBot, BotVisitRow, LogFormat, LogSummary } from '../types.js';
import type { IpVerifier } from '../ipranges/index.js';
import { EMPTY_LOG_MESSAGE, LogFormatError, SUPPORTED_FORMATS_MESSAGE, detectFormat, missingCloudflareFields, readLine } from './formats.js';

export interface SummarizeDeps {
  /** UA to catalogued AI bot. */
  matchBot: (userAgent: string) => AiBot | undefined;
  verify: IpVerifier;
  ipRangesAsOf: string;
}

/** Lines buffered to detect the format when none is given. */
const DETECT_LINES = 20;
/** Per-IP verification results kept between lines; cleared when full so memory stays bounded. */
const VERIFY_CACHE_MAX = 10_000;

type Verified = boolean | null;

interface RowAcc {
  botId: string;
  path: string;
  verified: Verified;
  hits: number;
  lastSeen: string;
}

interface BotAcc {
  botId: string;
  hits: number;
  verifiedHits: number;
  unverifiedHits: number;
  unknownHits: number;
  paths: Set<string>;
}

function verifiedKey(v: Verified): string {
  return v === null ? 'n' : v ? 'y' : 'x';
}

/**
 * Streaming summary. Memory is one row per bot x path x verification state, plus a bounded IP cache;
 * lines are never kept beyond the first few used for detection.
 */
export async function summarizeWith(
  lines: AsyncIterable<string> | Iterable<string>,
  format: LogFormat | undefined,
  deps: SummarizeDeps,
): Promise<LogSummary> {
  const rows = new Map<string, RowAcc>();
  const bots = new Map<string, BotAcc>();
  const verifyCache = new Map<string, Verified>();
  let linesRead = 0;
  let linesSkipped = 0;
  let requests = 0;
  let from: string | null = null;
  let to: string | null = null;
  let fmt: LogFormat | undefined = format;
  let checkedCloudflareFields = false;
  const pending: string[] = [];

  const consume = (raw: string): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.trim()) return;
    linesRead++;
    const f = fmt as LogFormat;
    if (f === 'cloudflare' && !checkedCloudflareFields) {
      try {
        const rec: unknown = JSON.parse(line);
        if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
          checkedCloudflareFields = true;
          const missing = missingCloudflareFields(rec as Record<string, unknown>);
          if (missing.length) {
            throw new LogFormatError(
              `Cloudflare Logpush records are missing ${missing.join(', ')}. Add ${missing.length > 1 ? 'these fields' : 'this field'} to the Logpush job's field list.`,
            );
          }
        }
      } catch (err) {
        if (err instanceof LogFormatError) throw err;
      }
    }
    const res = readLine(line, f);
    if (res.malformed) {
      linesSkipped++;
      return;
    }
    requests += res.hits.length;
    for (const hit of res.hits) {
      if (from === null || hit.time < from) from = hit.time;
      if (to === null || hit.time > to) to = hit.time;
      const bot = hit.userAgent ? deps.matchBot(hit.userAgent) : undefined;
      if (!bot) continue;

      const ck = `${bot.id}\u0000${hit.ip}`;
      let verified: Verified;
      if (verifyCache.has(ck)) {
        verified = verifyCache.get(ck) as Verified;
      } else {
        verified = deps.verify(bot, hit.ip);
        if (verifyCache.size >= VERIFY_CACHE_MAX) verifyCache.clear();
        verifyCache.set(ck, verified);
      }

      const rk = `${bot.id}\u0000${hit.path}\u0000${verifiedKey(verified)}`;
      const row = rows.get(rk);
      if (row) {
        row.hits++;
        if (hit.time > row.lastSeen) row.lastSeen = hit.time;
      } else {
        rows.set(rk, { botId: bot.id, path: hit.path, verified, hits: 1, lastSeen: hit.time });
      }

      let b = bots.get(bot.id);
      if (!b) {
        b = { botId: bot.id, hits: 0, verifiedHits: 0, unverifiedHits: 0, unknownHits: 0, paths: new Set() };
        bots.set(bot.id, b);
      }
      b.hits++;
      if (verified === true) b.verifiedHits++;
      else if (verified === false) b.unverifiedHits++;
      else b.unknownHits++;
      b.paths.add(hit.path);
    }
  };

  for await (const line of lines) {
    if (fmt) {
      consume(line);
      continue;
    }
    if (line.trim()) pending.push(line);
    if (pending.length >= DETECT_LINES) {
      fmt = detectFormat(pending) ?? undefined;
      if (!fmt) throw new LogFormatError(SUPPORTED_FORMATS_MESSAGE);
      for (const p of pending.splice(0)) consume(p);
    }
  }
  if (!fmt) {
    if (!pending.length) throw new LogFormatError(EMPTY_LOG_MESSAGE);
    fmt = detectFormat(pending) ?? undefined;
    if (!fmt) throw new LogFormatError(SUPPORTED_FORMATS_MESSAGE);
    for (const p of pending.splice(0)) consume(p);
  }

  const rowList: BotVisitRow[] = [...rows.values()]
    .map((r) => ({ botId: r.botId, path: r.path, hits: r.hits, verified: r.verified, lastSeen: r.lastSeen }))
    .sort((a, b) => b.hits - a.hits || a.botId.localeCompare(b.botId) || a.path.localeCompare(b.path) || verifiedKey(a.verified).localeCompare(verifiedKey(b.verified)));

  const botList = [...bots.values()]
    .map((b) => ({
      botId: b.botId,
      hits: b.hits,
      verifiedHits: b.verifiedHits,
      unverifiedHits: b.unverifiedHits,
      unknownHits: b.unknownHits,
      pages: b.paths.size,
    }))
    .sort((a, b) => b.hits - a.hits || a.botId.localeCompare(b.botId));

  return {
    format: fmt,
    linesRead,
    linesSkipped,
    requests,
    bots: botList,
    rows: rowList,
    from,
    to,
    ipRangesAsOf: deps.ipRangesAsOf,
  };
}
