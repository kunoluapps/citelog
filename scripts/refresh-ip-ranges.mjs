#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
// Maintainer-only: regenerates packages/geo/src/ipranges/snapshot.json from the official AI crawler IP lists.
// The AI-search tool never calls this at runtime (PRD AC 10); it reads the committed snapshot.
//
// Usage:
//   node scripts/refresh-ip-ranges.mjs                 fetch every source and rewrite the snapshot
//   node scripts/refresh-ip-ranges.mjs --offline DIR   read DIR/<url with "/" and "." replaced by "_"> instead of fetching
//   node scripts/refresh-ip-ranges.mjs --check         fetch and print what would change, without writing
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';

const OUT = new URL('../packages/geo/src/ipranges/snapshot.json', import.meta.url);

/** Official JSON lists from REVIEW-citelog-apis.md section 2. Keep in step with ipRangesUrl in packages/geo/src/bots. */
export const SOURCES = [
  { url: 'https://openai.com/searchbot.json', vendor: 'OpenAI', bots: ['OAI-SearchBot'] },
  { url: 'https://openai.com/chatgpt-user.json', vendor: 'OpenAI', bots: ['ChatGPT-User'] },
  { url: 'https://openai.com/gptbot.json', vendor: 'OpenAI', bots: ['GPTBot'] },
  { url: 'https://openai.com/adsbot.json', vendor: 'OpenAI', bots: ['OAI-AdsBot'] },
  { url: 'https://claude.com/crawling/bots.json', vendor: 'Anthropic', bots: ['ClaudeBot', 'Claude-SearchBot', 'Claude-User'] },
  { url: 'https://www.perplexity.ai/perplexitybot.json', vendor: 'Perplexity', bots: ['PerplexityBot'] },
  { url: 'https://www.perplexity.ai/perplexity-user.json', vendor: 'Perplexity', bots: ['Perplexity-User'] },
  { url: 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json', vendor: 'Google', bots: ['Googlebot', 'Google-CloudVertexBot'] },
  { url: 'https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json', vendor: 'Google', bots: ['Google-Agent'] },
  { url: 'https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers.json', vendor: 'Google', bots: ['Google-GeminiNotebook'] },
  { url: 'https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json', vendor: 'Google', bots: ['Google-GeminiNotebook'] },
  { url: 'https://www.bing.com/toolbox/bingbot.json', vendor: 'Microsoft', bots: ['bingbot'] },
  { url: 'http://search.developer.apple.com/applebot.json', vendor: 'Apple', bots: ['Applebot'] },
  { url: 'https://duckduckgo.com/duckassistbot.json', vendor: 'DuckDuckGo', bots: ['DuckAssistBot'] },
  { url: 'https://mistral.ai/mistralai-user-ips.json', vendor: 'Mistral', bots: ['MistralAI-User'] },
  { url: 'https://mistral.ai/mistralai-index-ips.json', vendor: 'Mistral', bots: ['MistralAI-Index'] },
  { url: 'https://index.commoncrawl.org/ccbot.json', vendor: 'Common Crawl', bots: ['CCBot'] },
];

function validCidr(cidr, family) {
  const [addr, bits, extra] = String(cidr).split('/');
  if (extra !== undefined || addr === undefined || bits === undefined || !/^\d{1,3}$/.test(bits)) return false;
  return isIP(addr) === family && Number(bits) <= (family === 4 ? 32 : 128);
}

/** Accepts {creationTime, prefixes:[{ipv4Prefix}|{ipv6Prefix}]}; unknown keys are ignored. */
export function normalise(source, body) {
  const json = JSON.parse(body);
  if (!json || !Array.isArray(json.prefixes)) throw new Error(`${source.url}: no "prefixes" array`);
  const ipv4 = [];
  const ipv6 = [];
  for (const p of json.prefixes) {
    if (p && typeof p.ipv4Prefix === 'string') {
      if (!validCidr(p.ipv4Prefix, 4)) throw new Error(`${source.url}: bad ipv4Prefix ${p.ipv4Prefix}`);
      ipv4.push(p.ipv4Prefix);
    }
    if (p && typeof p.ipv6Prefix === 'string') {
      if (!validCidr(p.ipv6Prefix, 6)) throw new Error(`${source.url}: bad ipv6Prefix ${p.ipv6Prefix}`);
      ipv6.push(p.ipv6Prefix);
    }
  }
  if (ipv4.length + ipv6.length === 0) throw new Error(`${source.url}: no prefixes found`);
  return {
    url: source.url,
    vendor: source.vendor,
    bots: source.bots,
    creationTime: typeof json.creationTime === 'string' ? json.creationTime : null,
    ipv4: [...new Set(ipv4)].sort(),
    ipv6: [...new Set(ipv6)].sort(),
  };
}

async function load(source, offlineDir) {
  if (offlineDir) return readFileSync(join(offlineDir, source.url.replace(/[/.]/g, '_')), 'utf8');
  const res = await fetch(source.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${source.url}: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const args = process.argv.slice(2);
  const offIdx = args.indexOf('--offline');
  const offlineDir = offIdx >= 0 ? args[offIdx + 1] : undefined;
  if (offIdx >= 0 && !offlineDir) throw new Error('--offline needs a directory');
  const check = args.includes('--check');

  const lists = [];
  for (const source of SOURCES) {
    lists.push(normalise(source, await load(source, offlineDir)));
  }
  const snapshot = {
    asOf: new Date().toISOString().slice(0, 10),
    note: 'Official AI crawler IP lists, bundled so the AI-search tool never fetches them at runtime. Regenerate with node scripts/refresh-ip-ranges.mjs.',
    lists,
  };
  const text = `${JSON.stringify(snapshot, null, 1)}\n`;
  for (const l of lists) console.log(`${l.url}: ${l.ipv4.length} IPv4, ${l.ipv6.length} IPv6 (list dated ${l.creationTime ?? 'unknown'})`);
  if (check) {
    const readOld = () => {
      try {
        return JSON.parse(readFileSync(OUT, 'utf8'));
      } catch {
        return { lists: [] };
      }
    };
    const before = readOld();
    for (const l of lists) {
      const prev = before.lists.find((p) => p.url === l.url);
      const changed = !prev || prev.ipv4.join() !== l.ipv4.join() || prev.ipv6.join() !== l.ipv6.join();
      console.log(`${changed ? 'CHANGED' : 'same   '} ${l.url}`);
    }
    return;
  }
  writeFileSync(OUT, text);
  console.log(`Wrote ${OUT.pathname} (asOf ${snapshot.asOf}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
