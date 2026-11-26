#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
// Rules for the public Citelog repository, run in CI and by the export:
//   1. only the folders the public repo should have; nothing from the private desk or its notes
//   2. no internal names, company mailboxes, service accounts or secrets in any text file
//   3. an MIT SPDX header on every source file, MIT licence in every package.json
//   4. every version agrees (package.json, the CLI's version constant, server.json, the .mcpb manifest, the plugin)
//   5. the README carries the current MCP install links and the listing files agree with package.json
// Usage: node scripts/check-public.mjs [--root DIR] [--version X.Y.Z]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLinks } from './install-links.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = flag('--root') ?? fileURLToPath(new URL('..', import.meta.url));
const wantVersion = flag('--version');
const problems = [];
const warnings = [];

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage']);
/** Build output that isn't committed (the Action's dist is committed and is checked). */
const UNCOMMITTED = [`packages${sep}cli${sep}dist${sep}`, `dist${sep}`, `.verify${sep}`];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(root).map((f) => relative(root, f));
const committed = files.filter((f) => !UNCOMMITTED.some((p) => f.startsWith(p)));

/* 1. Layout */
const TOP = new Set([
  '.github', '.claude-plugin', '.gitignore', '.nvmrc', 'action', 'action.yml', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md',
  'docs', 'glama.json', 'LICENSE', 'mcpb', 'package.json', 'packages', 'plugin', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md',
  'scripts', 'SECURITY.md', 'server.json', 'tsconfig.base.json', 'vitest.config.ts',
]);
const PACKAGES = new Set(['cli', 'core', 'geo']);
for (const f of committed) {
  const parts = f.split(sep);
  if (parts.includes('.claude')) problems.push(`${f}: a .claude/ folder (team notes) must never be public.`);
  if (!TOP.has(parts[0])) problems.push(`${f}: "${parts[0]}" isn't part of the public repo.`);
  if (parts[0] === 'packages' && parts[1] && !PACKAGES.has(parts[1])) problems.push(`${f}: packages/${parts[1]} belongs to the private desk.`);
  if (parts[0] === 'docs' && f !== join('docs', 'brand', 'tokens.json')) problems.push(`${f}: only docs/brand/tokens.json is public.`);
  if (/^LICENSE-AGPL|\.env($|\.)/.test(parts[parts.length - 1])) problems.push(`${f}: must not be public.`);
}
for (const required of ['LICENSE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'action.yml', 'server.json', 'glama.json']) {
  if (!existsSync(join(root, required))) problems.push(`${required} is missing.`);
}

/* 2. Content. Patterns are assembled from parts so this file never matches itself. */
const w = (...p) => p.join('');
const FORBIDDEN = [
  { re: new RegExp(w('fal', 'se[\\s_-]?9'), 'i'), why: 'names an internal product' },
  { re: new RegExp(w('open', 'post'), 'i'), why: 'names an internal product' },
  { re: new RegExp(w('kunolu', '-marketing'), 'i'), why: 'names an internal cloud project' },
  { re: new RegExp(w('[\\w.+-]+@', 'kunolu\\.com'), 'i'), why: 'a company mailbox' },
  { re: new RegExp(w('[\\w.-]+@[\\w.-]+\\.iam\\.', 'gserviceaccount\\.com'), 'i'), why: 'a service account' },
  { re: new RegExp(w('desk\\.', 'kunolu\\.com'), 'i'), why: 'an internal desk address' },
  { re: new RegExp(w('bywell', '-nonprod'), 'i'), why: 'an internal cloud project' },
  { re: new RegExp(w('SPDX-License-Identifier: ', 'AGPL')), why: 'AGPL code belongs to the private desk' },
  { re: /\.claude\/team/, why: 'points at internal team notes' },
];
const SECRETS = [
  /sk-ant-api\d\d-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
];
/** Test fixtures label their fake keys; anything that says so is not a secret. */
const FAKE = /fake|test|example|dummy|redact|xxxx/i;
/** Internal planning references: allowed (design notes in comments), but listed so a release can review them. */
const INTERNAL_REFS = /initiatives\/|PRD\b|BRIEF\.md|PLAN\.md|REVIEW-[a-z]/;
const TEXT = /\.(ts|tsx|mjs|cjs|js|json|md|ya?ml|txt|html|css|svg|log|ndjson|toml)$/i;

for (const f of files) {
  if (!TEXT.test(f) || f === 'pnpm-lock.yaml') continue;
  const text = readFileSync(join(root, f), 'utf8');
  text.split('\n').forEach((line, i) => {
    for (const { re, why } of FORBIDDEN) if (re.test(line)) problems.push(`${f}:${i + 1}: ${why}.`);
    for (const re of SECRETS) {
      const m = re.exec(line);
      if (m && !FAKE.test(line)) problems.push(`${f}:${i + 1}: looks like a real secret (${m[0].slice(0, 12)}…).`);
    }
    if (INTERNAL_REFS.test(line) && !f.includes(`dist${sep}`)) warnings.push(`${f}:${i + 1}`);
  });
}

/* 3. Licences */
for (const f of committed) {
  if (!/\.(ts|mjs|js)$/.test(f) || f.endsWith('.d.ts') || f.includes(`${sep}fixtures${sep}`)) continue;
  if (!/^(packages|action|scripts)/.test(f) && f !== 'vitest.config.ts') continue;
  const head = readFileSync(join(root, f), 'utf8').split('\n').slice(0, 3).join('\n');
  if (!head.includes('SPDX-License-Identifier: MIT')) problems.push(`${f}: first lines must include "SPDX-License-Identifier: MIT".`);
}
for (const f of committed.filter((x) => x.endsWith('package.json') && !x.includes(`dist${sep}`))) {
  const pkg = JSON.parse(readFileSync(join(root, f), 'utf8'));
  if (pkg.license !== 'MIT') problems.push(`${f}: "license" must be "MIT" (found ${JSON.stringify(pkg.license)}).`);
}
if (existsSync(join(root, 'LICENSE')) && !/^MIT License/.test(readFileSync(join(root, 'LICENSE'), 'utf8'))) problems.push('LICENSE must be the MIT licence.');

/* 4. Versions */
const readJson = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));
if (existsSync(join(root, 'packages/cli/package.json'))) {
  const cli = readJson('packages/cli/package.json');
  const brand = readFileSync(join(root, 'packages/core/src/brand.ts'), 'utf8');
  const versions = {
    'packages/cli/package.json': cli.version,
    'packages/core/src/brand.ts (GEO_TOOL.version)': /version: '([^']+)'/.exec(brand)?.[1],
    'server.json': existsSync(join(root, 'server.json')) ? readJson('server.json').version : undefined,
    'server.json packages[0]': existsSync(join(root, 'server.json')) ? readJson('server.json').packages?.[0]?.version : undefined,
    'mcpb/manifest.json': existsSync(join(root, 'mcpb/manifest.json')) ? readJson('mcpb/manifest.json').version : undefined,
    'plugin/.claude-plugin/plugin.json': existsSync(join(root, 'plugin/.claude-plugin/plugin.json')) ? readJson('plugin/.claude-plugin/plugin.json').version : undefined,
    'plugin/.mcp.json (npx pin)': existsSync(join(root, 'plugin/.mcp.json')) ? /^citelog@(.+)$/.exec(readJson('plugin/.mcp.json').mcpServers?.citelog?.args?.[1] ?? '')?.[1] : undefined,
  };
  const expected = wantVersion ?? cli.version;
  for (const [where, v] of Object.entries(versions)) {
    if (v !== expected) problems.push(`${where}: version ${JSON.stringify(v)}, expected ${expected}.`);
  }

  /* 5. Listings agree with the package */
  if (existsSync(join(root, 'server.json'))) {
    const server = readJson('server.json');
    if (server.name !== cli.mcpName) problems.push(`server.json "name" (${server.name}) must equal packages/cli/package.json "mcpName" (${cli.mcpName}).`);
    if (server.packages?.[0]?.identifier !== cli.name) problems.push('server.json packages[0].identifier must be the npm package name.');
    if ((server.description ?? '').length > 100) problems.push('server.json "description" must be 100 characters or fewer.');
  }
  if (cli.private) problems.push('packages/cli/package.json must not be private (it is published to npm).');
  if (existsSync(join(root, 'README.md'))) {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const links = installLinks();
    for (const key of ['cursorWeb', 'vscodeWeb']) if (!readme.includes(links[key])) problems.push(`README.md: the ${key} install link is out of date (node scripts/install-links.mjs).`);
    if (/\]\((?!https?:|#|mailto:)[^)]+\)|src="(?!https?:)/.test(readme)) problems.push('README.md: relative links or images break on npmjs.com; use absolute URLs.');
  }
  if (existsSync(join(root, 'action.yml'))) {
    const yml = readFileSync(join(root, 'action.yml'), 'utf8');
    const main = /main:\s*(\S+)/.exec(yml)?.[1];
    if (!main || !existsSync(join(root, main))) problems.push(`action.yml: runs.main "${main}" doesn't exist (commit action/dist).`);
  }
}

if (warnings.length) console.log(`Note: ${warnings.length} lines mention internal planning docs (allowed; review before a release):\n${warnings.slice(0, 20).map((x) => `  ${x}`).join('\n')}${warnings.length > 20 ? '\n  …' : ''}`);
if (problems.length) {
  console.error(`Public repo check failed (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Public repo check passed: ${committed.length} files.`);
