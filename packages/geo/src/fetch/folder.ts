// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP_DIRS = new Set(['node_modules']);
const SKIP_FILES = new Set(['404.html', '500.html']);

export interface FolderPage {
  /** URL path the file is served at, e.g. "/", "/learn/", "/pricing". */
  path: string;
  file: string;
}

export function isFolder(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Map a built HTML file to the URL path a static host serves it at (clean URLs: "a/b.html" → "/a/b"). */
export function fileToUrlPath(relPath: string): string {
  const posix = relPath.split(sep).join('/');
  if (posix === 'index.html') return '/';
  if (posix.endsWith('/index.html')) return `/${posix.slice(0, -'index.html'.length)}`;
  return `/${posix.replace(/\.html?$/i, '')}`;
}

/**
 * Every .html file under the folder (skipping dot folders, node_modules and error pages), sorted by URL path.
 * Symbolic links are skipped, files and folders alike: a link can point outside the folder (and the report may be a
 * public job summary) or back up the tree (a loop). Built sites don't need them.
 */
export function listFolderPages(root: string): FolderPage[] {
  const out: FolderPage[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      const s = lstatSync(p);
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) walk(p);
      else if (s.isFile() && /\.html?$/i.test(name) && !(dir === root && SKIP_FILES.has(name))) out.push({ path: fileToUrlPath(relative(root, p)), file: p });
    }
  };
  walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A regular file directly in the folder (robots.txt, llms.txt); null when absent or a symbolic link. */
export function readFolderFile(root: string, name: string): string | null {
  const p = join(root, name);
  try {
    return lstatSync(p).isFile() ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}
