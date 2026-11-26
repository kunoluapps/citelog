// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu

/** An address as a family plus an unsigned integer (IPv4 in 32 bits, IPv6 in 128 bits). */
export interface ParsedIp {
  family: 4 | 6;
  value: bigint;
}

export interface ParsedCidr extends ParsedIp {
  bits: number;
}

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p.startsWith('0')) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseV6(input: string): bigint | null {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.length < 2 || !/^[0-9a-fA-F:.]+$/.test(s)) return null;

  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseV4(last);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  if (s.includes('.')) return null;

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (!head || !rest) return null;
  const total = head.length + rest.length;
  let groups: number[];
  if (halves.length === 2) {
    if (total > 7) return null;
    groups = [...head, ...new Array<number>(8 - total).fill(0), ...rest];
  } else {
    if (total !== 8) return null;
    groups = head;
  }
  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(g);
  return v;
}

/**
 * Parse an IPv4 or IPv6 address (zone ids dropped). IPv4-mapped IPv6 (::ffff:a.b.c.d) is returned as IPv4,
 * since that is how dual-stack servers log IPv4 clients.
 */
export function parseIp(input: string): ParsedIp | null {
  const s = input.trim().replace(/^\[|\]$/g, '');
  if (s.includes(':')) {
    const v = parseV6(s);
    if (v === null) return null;
    if (v >> 32n === 0xffffn) return { family: 4, value: v & 0xffffffffn };
    return { family: 6, value: v };
  }
  const v = parseV4(s);
  return v === null ? null : { family: 4, value: v };
}

export function parseCidr(input: string): ParsedCidr | null {
  const [addr, bitsStr, extra] = input.trim().split('/');
  if (addr === undefined || extra !== undefined) return null;
  let ip: ParsedIp | null;
  if (addr.includes(':')) {
    const v = parseV6(addr);
    ip = v === null ? null : { family: 6, value: v };
  } else {
    ip = parseIp(addr);
  }
  if (!ip) return null;
  const max = ip.family === 4 ? 32 : 128;
  let bits = max;
  if (bitsStr !== undefined) {
    if (!/^\d{1,3}$/.test(bitsStr)) return null;
    bits = Number(bitsStr);
    if (bits > max) return null;
  }
  return { ...ip, value: ip.value & mask(ip.family, bits), bits };
}

function mask(family: 4 | 6, bits: number): bigint {
  const width = family === 4 ? 32n : 128n;
  if (bits === 0) return 0n;
  return ((1n << BigInt(bits)) - 1n) << (width - BigInt(bits));
}

/** A set of CIDR prefixes for fast membership tests. Invalid prefixes are ignored and counted in `invalid`. */
export class CidrSet {
  private readonly byLength = new Map<string, Set<bigint>>();
  readonly invalid: string[] = [];
  readonly size: number;

  constructor(prefixes: Iterable<string>) {
    let n = 0;
    for (const p of prefixes) {
      const c = parseCidr(p);
      if (!c) {
        this.invalid.push(p);
        continue;
      }
      const key = `${c.family}/${c.bits}`;
      let set = this.byLength.get(key);
      if (!set) {
        set = new Set();
        this.byLength.set(key, set);
      }
      set.add(c.value);
      n++;
    }
    this.size = n;
  }

  has(ip: string | ParsedIp): boolean {
    const parsed = typeof ip === 'string' ? parseIp(ip) : ip;
    if (!parsed) return false;
    for (const [key, set] of this.byLength) {
      const [fam, bits] = key.split('/');
      if (Number(fam) !== parsed.family) continue;
      if (set.has(parsed.value & mask(parsed.family, Number(bits)))) return true;
    }
    return false;
  }
}
