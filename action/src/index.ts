// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { realEngine } from './cli.js';
import { runAction } from './main.js';

runAction({
  env: process.env,
  fetch: (input, init) => fetch(input, init),
  engine: realEngine,
  log: (s) => process.stdout.write(s),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stdout.write(`::error::${msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`);
    process.exitCode = 2;
  },
);
