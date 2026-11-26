// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { renderWithLocalChrome } from './geo/browser.js';
import { realEngine } from './geo/engine.js';
import { runCli } from './geo/main.js';
import { serveStdio } from './mcp/server.js';
import { guardFetch } from './mcp/netguard.js';
import { cleanEnv } from './mcp/tools.js';

runCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
  isTTY: Boolean(process.stdout.isTTY),
  columns: process.stdout.isTTY ? process.stdout.columns : undefined,
  fetch: (input, init) => fetch(input, init),
  engine: realEngine,
  renderDom: renderWithLocalChrome,
  serveMcp: () => serveStdio({ fetch: guardFetch((input, init) => fetch(input, init), process.env), env: cleanEnv(process.env), cwd: process.cwd(), engine: realEngine }),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`COULDN'T RUN: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  },
);
