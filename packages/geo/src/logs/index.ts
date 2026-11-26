// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { LogFormat, LogHit, LogSummary } from '../types.js';
import { matchBot } from '../bots/index.js';
import { IP_RANGES_AS_OF, verifyBotIp } from '../ipranges/index.js';
import { detectFormat as detect, readLine } from './formats.js';
import { summarizeWith } from './summarize.js';

export {
  CLOUDFLARE_REQUIRED,
  EMPTY_LOG_MESSAGE,
  LOG_FORMAT_LABEL,
  LogFormatError,
  SUPPORTED_FORMATS_MESSAGE,
  cleanPath,
  missingCloudflareFields,
  parseClfTime,
  parseEdgeTimestamp,
  readLine,
} from './formats.js';
export type { LineResult } from './formats.js';
export { IP_RANGES_AS_OF } from '../ipranges/index.js';
export { summarizeWith } from './summarize.js';
export { LogFileTooLargeError, MAX_LOG_UNZIPPED_BYTES, logFileLines } from './file.js';
export type { SummarizeDeps } from './summarize.js';

/** Detect the log format from the first non-empty lines; null when unknown. */
export function detectFormat(sample: string[]): LogFormat | null {
  return detect(sample);
}

/**
 * Parse one line into a request, or null when the line is malformed or isn't a request.
 * Paths drop the query string and fragment. A Vercel JSON array line returns its first request; use readLine for all of them.
 */
export function parseLine(line: string, format: LogFormat): LogHit | null {
  return readLine(line, format).hits[0] ?? null;
}

/**
 * Summarise AI bot visits, verifying IPs against the bundled vendor IP range snapshot (no network).
 * Throws LogFormatError when the format can't be detected or Cloudflare records lack required fields.
 */
export async function summarizeLogs(lines: AsyncIterable<string> | Iterable<string>, format?: LogFormat): Promise<LogSummary> {
  return summarizeWith(lines, format, { matchBot, verify: verifyBotIp, ipRangesAsOf: IP_RANGES_AS_OF });
}
