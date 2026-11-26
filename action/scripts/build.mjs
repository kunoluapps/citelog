// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
// Builds dist/index.js, dist/package.json and dist/LICENSES.txt (GitHub runs the committed bundle).
// `--check` builds in memory and fails if the committed dist is stale.
import { fileURLToPath } from 'node:url';
import { bundle, staleFiles } from '../../packages/cli/scripts/bundle.mjs';

export const root = fileURLToPath(new URL('..', import.meta.url));

/** @param {boolean} write */
export function buildAction(write) {
  return bundle({
    root,
    entry: 'src/index.ts',
    outfile: 'dist/index.js',
    banner: '// SPDX-License-Identifier: MIT',
    extraFiles: { 'package.json': '{ "type": "module" }\n' },
    write,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const files = await buildAction(!check);
  if (check) {
    const stale = staleFiles(files, root);
    if (stale.length) {
      console.error(`Stale bundle: ${stale.join(', ')}. Run: pnpm --filter citelog-action build`);
      process.exit(1);
    }
  }
}
