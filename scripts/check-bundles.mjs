#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
// Fails when a built bundle (packages/cli/dist, action/dist) no longer matches a fresh build of its sources.
// The bundles are deterministic, so a rebuild in memory must equal the files on disk byte for byte.
import { staleFiles } from '../packages/cli/scripts/bundle.mjs';
import { buildCli, root as cliRoot } from '../packages/cli/scripts/build.mjs';
import { buildAction, root as actionRoot } from '../action/scripts/build.mjs';

const stale = [
  ...staleFiles(await buildCli(false), cliRoot).map((f) => `packages/cli/${f} (pnpm --filter citelog build)`),
  ...staleFiles(await buildAction(false), actionRoot).map((f) => `action/${f} (node action/scripts/build.mjs)`),
];
if (stale.length) {
  console.error(`Stale bundles, rebuild them:\n${stale.map((s) => `  ${s}`).join('\n')}`);
  process.exit(1);
}
console.log('Bundles match their sources.');
