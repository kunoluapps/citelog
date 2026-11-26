// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/index.js';

describe('parseCliArgs', () => {
  it('reads a command, a target and every flag', () => {
    const p = parseCliArgs(['check', 'https://bywell.org', '--fail-under', '80', '--max-pages', '10', '--json', '--no-color', '--verbose']);
    expect(p).toEqual({
      kind: 'run',
      command: 'check',
      positionals: ['https://bywell.org'],
      flags: { json: true, md: false, failUnder: 80, maxPages: 10, noColor: true, verbose: true, format: undefined, site: undefined, config: undefined, render: false, plan: false, perception: false },
    });
  });

  it('accepts --flag=value', () => {
    const p = parseCliArgs(['check', './dist', '--fail-under=75', '--md']);
    expect(p.kind === 'run' && p.flags.failUnder).toBe(75);
    expect(p.kind === 'run' && p.flags.md).toBe(true);
  });

  it('help and version', () => {
    expect(parseCliArgs([])).toEqual({ kind: 'help', command: undefined });
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help', command: undefined });
    expect(parseCliArgs(['check', '-h'])).toEqual({ kind: 'help', command: 'check' });
    expect(parseCliArgs(['help', 'logs'])).toEqual({ kind: 'help', command: 'logs' });
    expect(parseCliArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseCliArgs(['-v'])).toEqual({ kind: 'version' });
  });

  it.each([
    [['frobnicate'], /Unknown command "frobnicate"/],
    [['check', '--wat'], /Unknown option '--wat'/],
    [['check', 'x', '--fail-under', '101'], /--fail-under takes a whole number from 0 to 100/],
    [['check', 'x', '--fail-under', 'high'], /--fail-under takes a whole number/],
    [['check', 'x', '--max-pages', '0'], /--max-pages takes a whole number from 1/],
    [['check', 'x', '--json', '--md'], /--json or --md, not both/],
    [['logs', 'a.log', '--format', 'iis'], /--format takes combined, cloudflare, vercel/],
    [['check', 'x', '--perception'], /--perception works with prompts only/],
  ])('rejects %j', (argv, msg) => {
    const p = parseCliArgs(argv);
    expect(p.kind).toBe('error');
    expect(p.kind === 'error' && p.message).toMatch(msg);
  });
});
