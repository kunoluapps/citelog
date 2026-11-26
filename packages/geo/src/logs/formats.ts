// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { GEO_TOOL } from '@morningdesk/core';
import type { LogFormat, LogHit } from '../types.js';

/** Shown when a log is in none of the formats we read (API review, section 3). */
export const SUPPORTED_FORMATS_MESSAGE = `${GEO_TOOL.name} reads nginx/Apache combined, Cloudflare Logpush (JSON) and Vercel log drain (JSON or NDJSON) logs.`;

export const LOG_FORMAT_LABEL: Record<LogFormat, string> = {
  combined: 'nginx/Apache combined',
  cloudflare: 'Cloudflare Logpush (JSON)',
  vercel: 'Vercel log drain (JSON)',
};

/** A log we can't read: unknown format, or Cloudflare records without the fields we need. */
/** The file had no lines with content. */
export const EMPTY_LOG_MESSAGE = 'The log file is empty: there are no lines to read.';

export class LogFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogFormatError';
  }
}

/**
 * The result of reading one line.
 * - hits: the requests on the line (a Vercel JSON array line can hold several; most lines hold one)
 * - malformed: the line is in the format but couldn't be read; counted as skipped
 * A line with no hits and not malformed is a non-request record (Vercel build log, revalidation, JSON array brackets).
 */
export interface LineResult {
  hits: LogHit[];
  malformed: boolean;
}

const MALFORMED: LineResult = { hits: [], malformed: true };
const NOTHING: LineResult = { hits: [], malformed: false };

/* ---------- combined (nginx and Apache) ---------- */

const COMBINED =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "(?:(\S+) (\S+)(?: [^"]*)?|[^"]*)" (\d{3}) (\S+) "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"/;

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const CLF_TIME = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

/** `17/Nov/2026:06:25:24 +0000` to ISO, or null. */
export function parseClfTime(s: string): string | null {
  const m = CLF_TIME.exec(s);
  if (!m) return null;
  const [, dd, mon, yyyy, hh, mi, ss, sign, oh, om] = m;
  const month = MONTHS[mon ?? ''];
  if (month === undefined) return null;
  const local = Date.UTC(Number(yyyy), month, Number(dd), Number(hh), Number(mi), Number(ss));
  const check = new Date(local);
  if (check.getUTCDate() !== Number(dd) || check.getUTCHours() !== Number(hh) || check.getUTCMinutes() !== Number(mi)) return null;
  const offsetMs = (Number(oh) * 60 + Number(om)) * 60_000 * (sign === '-' ? -1 : 1);
  const d = new Date(local - offsetMs);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** nginx escapes `"`, `\` and non-printables as \xXX; Apache uses \" and \\. */
function unescapeQuoted(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})|\\(["\\])/g, (_m, hex: string | undefined, ch: string | undefined) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : (ch ?? ''),
  );
}

/** Request target to a path without query or fragment; absolute-form targets keep only their path. */
export function cleanPath(target: string): string | null {
  let t = target.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) {
    try {
      t = new URL(t).pathname;
    } catch {
      return null;
    }
  }
  const cut = t.search(/[?#]/);
  if (cut >= 0) t = t.slice(0, cut);
  return t.startsWith('/') ? t : null;
}

function parseCombined(line: string): LineResult {
  const m = COMBINED.exec(line);
  if (!m) return MALFORMED;
  const [, ip, time, method, target, status, , , ua] = m;
  const iso = parseClfTime(time ?? '');
  const path = target ? cleanPath(target) : null;
  if (!ip || !iso || !path) return MALFORMED;
  const userAgent = unescapeQuoted(ua ?? '');
  return {
    malformed: false,
    hits: [{ time: iso, ip, method, path, status: Number(status), userAgent: userAgent === '-' ? '' : userAgent }],
  };
}

/* ---------- Cloudflare Logpush (http_requests) ---------- */

/** EdgeStartTimestamp in any Logpush timestamp_format: unixnano, unix (s), rfc3339, rfc3339ms, rfc3339ns. */
export function parseEdgeTimestamp(v: unknown): string | null {
  let ms: number | null = null;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    ms = n > 1e17 ? n / 1e6 : n > 1e11 ? n : n * 1000;
  } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const frac = /^(.*T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i.exec(v.trim());
    if (!frac) return null;
    const millis = frac[2] ? frac[2].slice(0, 4).padEnd(4, '0') : '';
    const zone = (frac[3] ?? 'Z').toUpperCase().replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    ms = Date.parse(`${frac[1]}${millis}${zone}`);
  }
  if (ms === null || Number.isNaN(ms)) return null;
  const d = new Date(Math.floor(ms));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The Logpush fields we need. A job's field list must include these. */
export const CLOUDFLARE_REQUIRED = ['ClientIP', 'ClientRequestUserAgent', 'ClientRequestPath or ClientRequestURI', 'EdgeStartTimestamp'] as const;

export function missingCloudflareFields(rec: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (!('ClientIP' in rec)) missing.push('ClientIP');
  if (!('ClientRequestUserAgent' in rec)) missing.push('ClientRequestUserAgent');
  if (!('ClientRequestPath' in rec) && !('ClientRequestURI' in rec)) missing.push('ClientRequestPath or ClientRequestURI');
  if (!('EdgeStartTimestamp' in rec)) missing.push('EdgeStartTimestamp');
  return missing;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function statusOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function cloudflareHit(rec: Record<string, unknown>): LogHit | null {
  const ip = str(rec.ClientIP);
  const ua = str(rec.ClientRequestUserAgent);
  const target = str(rec.ClientRequestPath) ?? str(rec.ClientRequestURI);
  const time = parseEdgeTimestamp(rec.EdgeStartTimestamp);
  const path = target ? cleanPath(target) : null;
  if (!ip || ua === undefined || !path || !time) return null;
  return {
    time,
    ip,
    method: str(rec.ClientRequestMethod),
    path,
    status: statusOf(rec.EdgeResponseStatus),
    userAgent: ua,
    host: str(rec.ClientRequestHost),
  };
}

function parseCloudflare(line: string): LineResult {
  const rec = parseJsonLine(line);
  if (!isObject(rec)) return MALFORMED;
  const hit = cloudflareHit(rec);
  return hit ? { hits: [hit], malformed: false } : MALFORMED;
}

/* ---------- Vercel log drain ---------- */

/** One drain entry: null = malformed, undefined = not a request (no proxy object, or a background revalidation). */
function vercelHit(entry: unknown): LogHit | null | undefined {
  if (!isObject(entry)) return null;
  const proxy = entry.proxy;
  if (proxy === undefined) return undefined;
  if (!isObject(proxy)) return null;
  const status = typeof proxy.statusCode === 'number' ? proxy.statusCode : null;
  if (status === -1) return undefined;
  const uaField = proxy.userAgent;
  const ua = Array.isArray(uaField) ? str(uaField[0]) ?? '' : str(uaField) ?? '';
  const ip = str(proxy.clientIp);
  const path = str(proxy.path) ? cleanPath(str(proxy.path) as string) : null;
  const tsRaw = typeof proxy.timestamp === 'number' ? proxy.timestamp : typeof entry.timestamp === 'number' ? entry.timestamp : NaN;
  const d = new Date(tsRaw);
  if (!ip || !path || Number.isNaN(d.getTime())) return null;
  return {
    time: d.toISOString(),
    ip,
    method: str(proxy.method),
    path,
    status: status !== null && status > 0 ? status : null,
    userAgent: ua,
    host: str(proxy.host) ?? str(entry.host),
  };
}

function parseVercel(line: string): LineResult {
  let t = line.trim();
  if (t === '[' || t === ']' || t === '],' || t === '[]') return NOTHING;
  if (t.endsWith(',')) t = t.slice(0, -1);
  if (t.startsWith('[') && !t.endsWith(']')) t = t.slice(1);
  else if (t.endsWith(']') && !t.startsWith('[')) t = t.slice(0, -1);
  const json = parseJsonLine(t);
  if (json === undefined) return MALFORMED;
  const entries = Array.isArray(json) ? json : [json];
  const hits: LogHit[] = [];
  let bad = false;
  for (const e of entries) {
    const h = vercelHit(e);
    if (h === null) bad = true;
    else if (h) hits.push(h);
  }
  return { hits, malformed: bad && hits.length === 0 };
}

/* ---------- public ---------- */

export function readLine(line: string, format: LogFormat): LineResult {
  if (!line.trim()) return NOTHING;
  switch (format) {
    case 'combined':
      return parseCombined(line);
    case 'cloudflare':
      return parseCloudflare(line);
    case 'vercel':
      return parseVercel(line);
  }
}

function formatOfLine(line: string): LogFormat | null {
  const t = line.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    let body = t.endsWith(',') ? t.slice(0, -1) : t;
    if (body.startsWith('[') && !body.endsWith(']')) body = body.slice(1);
    const json = parseJsonLine(body);
    const first: unknown = Array.isArray(json) ? json[0] : json;
    if (!isObject(first)) return null;
    if (isObject(first.proxy) || ('deploymentId' in first && 'source' in first)) return 'vercel';
    if ('ClientRequestUserAgent' in first || 'EdgeStartTimestamp' in first || 'ClientIP' in first || 'RayID' in first) return 'cloudflare';
    return null;
  }
  return COMBINED.test(t) ? 'combined' : null;
}

/** Detect the log format from the first non-empty lines; null when unknown. */
export function detectFormat(sample: string[]): LogFormat | null {
  const counts = new Map<LogFormat, number>();
  let seen = 0;
  for (const line of sample) {
    const t = line.trim();
    if (!t || t === '[' || t === ']') continue;
    if (++seen > 20) break;
    const f = formatOfLine(t);
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  let best: LogFormat | null = null;
  let bestN = 0;
  for (const [f, n] of counts) {
    if (n > bestN) {
      best = f;
      bestN = n;
    }
  }
  return best;
}
