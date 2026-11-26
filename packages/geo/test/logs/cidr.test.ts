// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it } from 'vitest';
import { CidrSet, IP_RANGES, createIpVerifier, parseCidr, parseIp, rangeKey, verifyBotIp } from '../../src/ipranges/index.js';
import { TEST_BOTS } from './helpers.js';

const bot = (id: string) => {
  const b = TEST_BOTS.find((x) => x.id === id);
  if (!b) throw new Error(id);
  return b;
};

describe('parseIp', () => {
  it('reads IPv4 and rejects bad octets', () => {
    expect(parseIp('192.0.2.1')).toEqual({ family: 4, value: 0xc0000201n });
    expect(parseIp('0.0.0.0')?.value).toBe(0n);
    expect(parseIp('255.255.255.255')?.value).toBe(0xffffffffn);
    for (const bad of ['256.0.0.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', 'a.b.c.d', '', '-']) expect(parseIp(bad)).toBeNull();
  });

  it('reads IPv6 in full, compressed and embedded-IPv4 forms', () => {
    expect(parseIp('2001:db8:0:0:0:0:0:1')).toEqual(parseIp('2001:db8::1'));
    expect(parseIp('::')).toEqual({ family: 6, value: 0n });
    expect(parseIp('::1')?.value).toBe(1n);
    expect(parseIp('fe80::1%eth0')).toEqual(parseIp('fe80::1'));
    expect(parseIp('[2001:db8::1]')).toEqual(parseIp('2001:db8::1'));
    expect(parseIp('64:ff9b::192.0.2.33')?.value).toBe((0x64n << 112n) | (0xff9bn << 96n) | 0xc0000221n);
    for (const bad of ['2001:db8::1::2', '1:2:3:4:5:6:7:8:9', '12345::', 'g::1', ':::', '1:2:3:4:5:6:7']) expect(parseIp(bad)).toBeNull();
  });

  it('treats IPv4-mapped IPv6 as IPv4', () => {
    expect(parseIp('::ffff:132.196.86.5')).toEqual(parseIp('132.196.86.5'));
    expect(parseIp('::ffff:84c4:5605')).toEqual(parseIp('132.196.86.5'));
  });
});

describe('parseCidr', () => {
  it('masks host bits and checks prefix length', () => {
    expect(parseCidr('10.1.2.3/8')).toEqual({ family: 4, value: 0x0a000000n, bits: 8 });
    expect(parseCidr('10.1.2.3')).toEqual({ family: 4, value: 0x0a010203n, bits: 32 });
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('2001:db8::/129')).toBeNull();
    expect(parseCidr('2001:db8::/x')).toBeNull();
    expect(parseCidr('2001:db8::ff/120')).toEqual({ family: 6, value: 0x20010db8n << 96n, bits: 120 });
  });
});

describe('CidrSet', () => {
  it('matches IPv4 edges of a prefix', () => {
    const s = new CidrSet(['132.196.86.0/24', '216.73.216.0/22', '107.20.236.150/32']);
    expect(s.has('132.196.86.0')).toBe(true);
    expect(s.has('132.196.86.255')).toBe(true);
    expect(s.has('132.196.85.255')).toBe(false);
    expect(s.has('132.196.87.0')).toBe(false);
    expect(s.has('216.73.219.255')).toBe(true);
    expect(s.has('216.73.220.0')).toBe(false);
    expect(s.has('107.20.236.150')).toBe(true);
    expect(s.has('107.20.236.151')).toBe(false);
    expect(s.has('::ffff:132.196.86.9')).toBe(true);
    expect(s.has('not an ip')).toBe(false);
  });

  it('matches IPv6 edges of a prefix and keeps families apart', () => {
    const s = new CidrSet(['2001:4860:4801:10::/64', '2001:4860:c::/124', '0.0.0.0/0']);
    expect(s.has('2001:4860:4801:10::')).toBe(true);
    expect(s.has('2001:4860:4801:10:ffff:ffff:ffff:ffff')).toBe(true);
    expect(s.has('2001:4860:4801:11::')).toBe(false);
    expect(s.has('2001:4860:4801:f:ffff:ffff:ffff:ffff')).toBe(false);
    expect(s.has('2001:4860:c::f')).toBe(true);
    expect(s.has('2001:4860:c::10')).toBe(false);
    expect(s.has('203.0.113.9')).toBe(true);
    expect(s.has('2001:db8::1')).toBe(false);
  });

  it('counts invalid prefixes instead of throwing', () => {
    const s = new CidrSet(['10.0.0.0/8', 'bogus', '1.2.3.4/40']);
    expect(s.size).toBe(1);
    expect(s.invalid).toEqual(['bogus', '1.2.3.4/40']);
  });
});

describe('bundled snapshot', () => {
  it('is dated, names its sources and has only valid prefixes', () => {
    expect(IP_RANGES.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(IP_RANGES.lists.length).toBeGreaterThanOrEqual(10);
    for (const l of IP_RANGES.lists) {
      expect(l.url).toMatch(/^https?:\/\//);
      const s = new CidrSet([...l.ipv4, ...l.ipv6]);
      expect(s.invalid).toEqual([]);
      expect(s.size).toBeGreaterThan(0);
    }
  });

  it('verifies by the bot ipRangesUrl regardless of scheme or www', () => {
    expect(rangeKey('http://www.Perplexity.ai/perplexitybot.json')).toBe(rangeKey('https://perplexity.ai/perplexitybot.json'));
    expect(verifyBotIp(bot('gptbot'), '132.196.86.5')).toBe(true);
    expect(verifyBotIp(bot('gptbot'), '203.0.113.9')).toBe(false);
    expect(verifyBotIp(bot('perplexitybot'), '107.20.236.150')).toBe(true);
    expect(verifyBotIp(bot('applebot'), '17.166.150.1')).toBe(true);
    expect(verifyBotIp(bot('googlebot'), '2001:4860:4801:10::1')).toBe(true);
    expect(verifyBotIp(bot('meta-externalagent'), '31.13.24.1')).toBeNull();
  });

  it('returns null for a list URL that is not in the snapshot', () => {
    const verify = createIpVerifier({ asOf: '2026-01-01', lists: [] });
    expect(verify(bot('gptbot'), '132.196.86.5')).toBeNull();
  });
});
