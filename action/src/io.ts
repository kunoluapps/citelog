// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** Workflow commands and files (https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands). */

function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export type AnnotationLevel = 'error' | 'warning' | 'notice';

export function annotation(level: AnnotationLevel, message: string, title?: string): string {
  return `::${level}${title ? ` title=${escapeData(title).replace(/:/g, '%3A').replace(/,/g, '%2C')}` : ''}::${escapeData(message)}\n`;
}

/** Step summary limit is 1 MiB; keep well under it. */
export const SUMMARY_LIMIT = 900 * 1024;

export async function appendSummary(env: Record<string, string | undefined>, markdown: string): Promise<boolean> {
  const file = env.GITHUB_STEP_SUMMARY;
  if (!file) return false;
  const text = Buffer.byteLength(markdown) > SUMMARY_LIMIT ? `${Buffer.from(markdown).subarray(0, SUMMARY_LIMIT).toString('utf8')}\n\n(Summary cut at 900 KB; the JSON report has everything.)` : markdown;
  await appendFile(file, `${text}\n`, 'utf8');
  return true;
}

export async function setOutputs(env: Record<string, string | undefined>, outputs: Record<string, string>): Promise<void> {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  let text = '';
  for (const [k, v] of Object.entries(outputs)) {
    if (v.includes('\n')) {
      const eof = `ghadelimiter_${randomUUID()}`;
      text += `${k}<<${eof}\n${v}\n${eof}\n`;
    } else text += `${k}=${v}\n`;
  }
  await appendFile(file, text, 'utf8');
}
