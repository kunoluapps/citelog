// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
// One esbuild setup for both shipped bundles (the CLI and the Action), deterministic so a rebuild can be compared byte
// for byte with the committed dist (check mode), and with every bundled third-party package's licence in LICENSES.txt.
import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/** "…/node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/x.js" -> the package folder (scoped names too). */
function packageDir(absPath) {
  const parts = absPath.split('/node_modules/');
  if (parts.length < 2) return null;
  const tail = parts[parts.length - 1];
  const segs = tail.split('/');
  const name = segs[0].startsWith('@') ? `${segs[0]}/${segs[1]}` : segs[0];
  return `${parts.slice(0, -1).join('/node_modules/')}/node_modules/${name}`;
}

function licenceNotices(metafile, absWorkingDir) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const dir = packageDir(join(absWorkingDir, input));
    if (dir) dirs.add(dir);
  }
  const entries = [];
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
    const text = files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n');
    const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see text');
    entries.push({ id: `${pkg.name}@${pkg.version}`, license, text: text || `(no licence file shipped; package.json says ${license})` });
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const head = [
    'Third-party software bundled in this file, with its licence.',
    'Everything else in the bundle is Kunolu code under the MIT licence.',
    '',
  ];
  return `${[...head, ...entries.map((e) => `${'='.repeat(78)}\n${e.id} (${e.license})\n${'='.repeat(78)}\n\n${e.text}\n`)].join('\n')}`;
}

/**
 * Build `entry` into `outfile` (plus LICENSES.txt next to it). With `write: false`, return the files instead of writing
 * them, so a check can compare them with what is committed.
 * @param {{ root: string, entry: string, outfile: string, banner: string, executable?: boolean, extraFiles?: Record<string, string>, write?: boolean }} o
 * @returns {Promise<Map<string, string>>} absolute path -> contents
 */
export async function bundle(o) {
  const result = await build({
    absWorkingDir: o.root,
    entryPoints: [o.entry],
    outfile: o.outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: false,
    legalComments: 'none',
    banner: { js: `${o.banner}\n// Third-party licences: LICENSES.txt next to this file.\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);` },
    metafile: true,
    write: false,
    logLevel: 'warning',
  });
  const files = new Map();
  for (const f of result.outputFiles) files.set(f.path, f.text);
  files.set(join(dirname(join(o.root, o.outfile)), 'LICENSES.txt'), licenceNotices(result.metafile, o.root));
  for (const [name, text] of Object.entries(o.extraFiles ?? {})) files.set(join(dirname(join(o.root, o.outfile)), name), text);
  if (o.write !== false) {
    for (const [path, text] of files) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    if (o.executable) await chmod(join(o.root, o.outfile), 0o755);
  }
  return files;
}

/** Paths whose committed contents differ from a fresh build (empty = fresh). */
export function staleFiles(files, root) {
  const stale = [];
  for (const [path, text] of files) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) stale.push(relative(root, path));
  }
  return stale;
}
