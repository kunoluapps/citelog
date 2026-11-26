// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { describe, expect, it, vi } from 'vitest';
import { ALLOW_PRIVATE_ENV, blockedAddress, guardFetch, PrivateAddressError } from '../src/mcp/netguard.js';

const ok = () => Promise.resolve(new Response('ok'));

describe('citelog mcp network guard', () => {
  it('blocks loopback, private, link-local, metadata and CGNAT addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1']) {
      expect(blockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) expect(blockedAddress(ip), ip).toBe(false);
  });

  it('refuses private hosts and hosts that resolve to private addresses', async () => {
    const inner = vi.fn(ok);
    const f = guardFetch(inner, {}, async (h) => (h === 'rebind.example' ? ['93.184.216.34', '10.0.0.5'] : ['93.184.216.34']));
    await expect(f('http://localhost:3000/')).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(f('http://192.168.1.1/admin')).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(f('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(f('http://[::1]:8080/')).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(f('https://printer.local/')).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(f('https://rebind.example/')).rejects.toBeInstanceOf(PrivateAddressError);
    expect(inner).not.toHaveBeenCalled();
    await expect(f('https://example.com/')).resolves.toBeInstanceOf(Response);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it(`allows local sites when ${ALLOW_PRIVATE_ENV}=1`, async () => {
    const inner = vi.fn(ok);
    const f = guardFetch(inner, { [ALLOW_PRIVATE_ENV]: '1' }, async () => ['127.0.0.1']);
    await expect(f('http://localhost:3000/')).resolves.toBeInstanceOf(Response);
  });
});
