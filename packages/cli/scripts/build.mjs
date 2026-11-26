// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
// Builds dist/citelog.mjs and dist/LICENSES.txt. `--check` builds in memory and fails if the committed dist is stale.
import { fileURLToPath } from 'node:url';
import { bundle, staleFiles } from './bundle.mjs';

export const root = fileURLToPath(new URL('..', import.meta.url));

/** @param {boolean} write */
export function buildCli(write) {
  return bundle({
    root,
    entry: 'src/bin.ts',
    outfile: 'dist/citelog.mjs',
    banner: '#!/usr/bin/env node\n// SPDX-License-Identifier: MIT',
    executable: true,
    write,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const files = await buildCli(!check);
  if (check) {
    const stale = staleFiles(files, root);
    if (stale.length) {
      console.error(`Stale bundle: ${stale.join(', ')}. Run: pnpm --filter citelog build`);
      process.exit(1);
    }
  }
}
