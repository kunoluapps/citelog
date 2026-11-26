// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/** The committed bundles must match their sources (FIX-P1 M9): a stale dist fails `pnpm test`, not a user. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

describe('shipped bundles', () => {
  it('match a fresh build of the sources (scripts/check-bundles.mjs)', () => {
    const out = execFileSync(process.execPath, ['scripts/check-bundles.mjs'], { cwd: repo, encoding: 'utf8' });
    expect(out).toContain('Bundles match their sources.');
  }, 60_000);

  it.each(['packages/cli/dist/LICENSES.txt', 'action/dist/LICENSES.txt'])('%s names every bundled third-party package with its licence', (file) => {
    const text = readFileSync(`${repo}${file}`, 'utf8');
    for (const pkg of ['htmlparser2@', 'domhandler@', 'domutils@', 'entities@', 'yaml@']) expect(text).toContain(pkg);
    expect(text).toMatch(/Permission is hereby granted|Redistribution and use/);
  });
});
