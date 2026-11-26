#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
// Builds dist/citelog-<version>.mcpb, a Claude Desktop extension (MCP Bundle): a zip with mcpb/manifest.json at its
// root and the CLI bundle as server/citelog.mjs. Run after `pnpm --filter citelog build`. No dependencies: the zip is
// written here (deflate + CRC-32 from node:zlib), so the output is byte-for-byte repeatable.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p));

/** DOS date/time for 2026-01-01 00:00, fixed so the bundle is repeatable. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** @param {{ name: string, data: Buffer }[]} entries */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix, zip 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function buildMcpb() {
  const manifest = JSON.parse(read('mcpb/manifest.json').toString('utf8'));
  const pkg = JSON.parse(read('packages/cli/package.json').toString('utf8'));
  if (manifest.version !== pkg.version) throw new Error(`mcpb/manifest.json version ${manifest.version} != packages/cli/package.json ${pkg.version}`);
  const bundle = join(root, 'packages/cli/dist/citelog.mjs');
  if (!existsSync(bundle)) throw new Error('packages/cli/dist/citelog.mjs is missing: run `pnpm --filter citelog build` first.');
  const entries = [
    { name: 'manifest.json', data: read('mcpb/manifest.json') },
    { name: 'server/citelog.mjs', data: read('packages/cli/dist/citelog.mjs') },
    { name: 'server/LICENSES.txt', data: read('packages/cli/dist/LICENSES.txt') },
    { name: 'LICENSE', data: read('LICENSE') },
    { name: 'README.md', data: read('README.md') },
  ];
  if (existsSync(join(root, 'mcpb/icon.png'))) entries.splice(1, 0, { name: 'icon.png', data: read('mcpb/icon.png') });
  const out = join(root, 'dist', `citelog-${pkg.version}.mcpb`);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(out, zip(entries));
  return { out, entries: entries.map((e) => e.name) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { out, entries } = buildMcpb();
  console.log(`Wrote ${out}: ${entries.join(', ')}`);
}
