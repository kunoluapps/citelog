// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu

/**
 * Terminal colours: the dark-mode status tokens from docs/brand/tokens.json (pass, slipping, fail, text-muted).
 * Colour only ever repeats a word that is printed anyway, so output reads the same without it.
 */
export const TERMINAL_COLORS = {
  pass: '#5BC88A',
  warn: '#E9A93B',
  fail: '#FF8A7A',
  dim: '#9A978D',
} as const;

export interface Style {
  pass(s: string): string;
  warn(s: string): string;
  fail(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
}

function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

function paint(hex: string): (s: string) => string {
  const open = `\x1b[38;2;${rgb(hex)}m`;
  return (s) => `${open}${s}\x1b[39m`;
}

const plain = (s: string): string => s;

export function makeStyle(color: boolean): Style {
  if (!color) return { pass: plain, warn: plain, fail: plain, dim: plain, bold: plain };
  return {
    pass: paint(TERMINAL_COLORS.pass),
    warn: paint(TERMINAL_COLORS.warn),
    fail: paint(TERMINAL_COLORS.fail),
    dim: paint(TERMINAL_COLORS.dim),
    bold: (s) => `\x1b[1m${s}\x1b[22m`,
  };
}

/** Colour only on a TTY, never with NO_COLOR or --no-color; FORCE_COLOR turns it on. */
export function wantsColor(opts: { isTTY: boolean; noColorFlag: boolean; env: Record<string, string | undefined> }): boolean {
  if (opts.noColorFlag) return false;
  if (opts.env.NO_COLOR !== undefined && opts.env.NO_COLOR !== '') return false;
  if (opts.env.FORCE_COLOR !== undefined && opts.env.FORCE_COLOR !== '0') return true;
  if (opts.env.TERM === 'dumb') return false;
  return opts.isTTY;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

export function padEnd(s: string, width: number): string {
  const len = stripAnsi(s).length;
  return len >= width ? s : s + ' '.repeat(width - len);
}

export function padStart(s: string, width: number): string {
  const len = stripAnsi(s).length;
  return len >= width ? s : ' '.repeat(width - len) + s;
}

/** Cut to `width` characters with an ellipsis. */
export function clip(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, width - 1)}…`;
}

/** Wrap plain text to lines of at most `width` characters. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}
