// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/**
 * Network guard for the CLI's MCP server (`mcp` subcommand). In the terminal a person types the target, so `citelog check http://localhost:3000`
 * is fine. Over MCP an AI agent picks the URL, and a page it read could steer it toward the person's own network
 * (a router, a dev server, a cloud metadata address) and read the answer back. So the MCP server refuses loopback,
 * private, link-local and other non-public addresses, after DNS resolution, on every request (each redirect hop is a
 * new request). Set CITELOG_MCP_ALLOW_PRIVATE=1 in the server's environment to check a local site on purpose.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { GEO_TOOL } from '@morningdesk/core';
import type { FetchLike } from '@morningdesk/geo';

export const ALLOW_PRIVATE_ENV = `${GEO_TOOL.bin.toUpperCase()}_MCP_ALLOW_PRIVATE`;

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i;

function v4Blocked(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function v6Blocked(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::' || s === '::1') return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Blocked(mapped[1]!);
  const first = parseInt(s.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 || // multicast
    s.startsWith('64:ff9b:') // NAT64 can reach private v4
  );
}

/** True when an address is not a public internet address. */
export function blockedAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, ''));
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip);
  return true;
}

export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(`${host} is a private or local address. The MCP server only fetches public sites; set ${ALLOW_PRIVATE_ENV}=1 to check a local site on purpose.`);
    this.name = 'PrivateAddressError';
  }
}

type Resolve = (host: string) => Promise<string[]>;
const resolveAll: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Wraps fetch so every request's host must resolve only to public addresses (unless allowed by env). */
export function guardFetch(inner: FetchLike, env: Record<string, string | undefined>, resolve: Resolve = resolveAll): FetchLike {
  if (env[ALLOW_PRIVATE_ENV] === '1') return inner;
  return async (input, init) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return inner(input, init);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (BLOCKED_NAMES.test(host)) throw new PrivateAddressError(host);
    const addresses = isIP(host) ? [host] : await resolve(host);
    if (addresses.length === 0 || addresses.some(blockedAddress)) throw new PrivateAddressError(host);
    return inner(input, init);
  };
}
