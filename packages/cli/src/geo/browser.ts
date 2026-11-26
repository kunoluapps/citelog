// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/**
 * `--render`: load one page in a Chrome, Chromium or Edge the user already has, headless, and return the DOM after
 * JavaScript ran. Nothing is downloaded or bundled; the browser gets a fresh profile in a temp folder that is removed after.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { GEO_TOOL } from '@morningdesk/core';

export const RENDER_TIMEOUT_MS = 20_000;
const MAX_DOM_BYTES = 32 * 1024 * 1024;

export type RenderDomResult =
  | { ok: true; html: string; browser: string }
  | { ok: false; reason: 'no_browser' | 'failed'; message: string };

/** Loads `url` in a local browser and returns the rendered DOM. Injected through CliIO so tests never launch one. */
export type RenderDom = (url: string, opts: { env: Record<string, string | undefined> }) => Promise<RenderDomResult>;

const MAC_APPS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Chromium.app/Contents/MacOS/Chromium',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const LINUX_BINS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
const WINDOWS_EXES = ['Google\\Chrome\\Application\\chrome.exe', 'Chromium\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe'];

/** Where Chrome, Chromium and Edge usually live on this platform, in the order we try them. */
export function chromeCandidates(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') {
    const roots = ['/Applications', ...(env.HOME ? [posix.join(env.HOME, 'Applications')] : [])];
    return MAC_APPS.flatMap((app) => roots.map((r) => posix.join(r, app)));
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
    return WINDOWS_EXES.flatMap((exe) => roots.map((r) => win32.join(r, exe)));
  }
  const dirs = (env.PATH ?? '').split(':').filter(Boolean);
  return LINUX_BINS.flatMap((bin) => dirs.map((d) => posix.join(d, bin)));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** CHROME_PATH when set, else the first standard install found. */
export function findChrome(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = isFile,
): { path: string } | { error: string } | null {
  const set = env.CHROME_PATH?.trim();
  if (set) return exists(set) ? { path: set } : { error: `CHROME_PATH is set to "${set}", but there's no file there.` };
  const found = chromeCandidates(env, platform).find(exists);
  return found ? { path: found } : null;
}

/**
 * The headless flags: a throwaway profile, no first-run screens, none of Chrome's own background traffic (updates, sync,
 * metrics, pings), the DOM printed to stdout. The page's own scripts still load what they load.
 */
export function chromeArgs(profileDir: string, url: string): string[] {
  return [
    '--headless=new',
    '--dump-dom',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-pings',
    `--user-data-dir=${profileDir}`,
    url,
  ];
}

/** Ends the browser and every helper process it started (its own process group on macOS and Linux). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function dumpDom(chrome: string, url: string, timeoutMs: number, profileDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, chromeArgs(profileDir, url), { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const onSigint = () => {
      killTree(child);
      rmSync(profileDir, { recursive: true, force: true });
      process.exit(130);
    };
    process.once('SIGINT', onSigint);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', onSigint);
      killTree(child);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`the page took longer than ${timeoutMs / 1000} s`))), timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_DOM_BYTES) finish(() => reject(new Error('the page is larger than 32 MB')));
      else chunks.push(c);
    });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => {
      const html = Buffer.concat(chunks).toString('utf8');
      finish(() => (html.trim() ? resolve(html) : reject(new Error(`the browser exited with code ${code ?? 'unknown'} and printed no page`))));
    });
  });
}

/** The real launcher: find a local browser, render the page headless, clean up the profile. */
export const renderWithLocalChrome: RenderDom = async (url, { env }) => {
  const found = findChrome(env);
  if (!found) return { ok: false, reason: 'no_browser', message: 'No Chrome, Chromium or Edge found.' };
  if ('error' in found) return { ok: false, reason: 'no_browser', message: found.error };
  const profileDir = await mkdtemp(join(tmpdir(), `${GEO_TOOL.bin}-chrome-`));
  try {
    return { ok: true, html: await dumpDom(found.path, url, RENDER_TIMEOUT_MS, profileDir), browser: found.path };
  } catch (e) {
    return { ok: false, reason: 'failed', message: (e as Error).message };
  } finally {
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
};
