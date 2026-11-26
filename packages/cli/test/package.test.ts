// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/** The npm package and the listings that point at it (QA-2, QA-3, launch readiness a5 and §2.3). */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GEO_TOOL, GEO_TOOL_USER_AGENT } from '@morningdesk/core';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown> & {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  exports: Record<string, string>;
  keywords: string[];
  repository: { url: string; directory: string };
  bugs: { url: string };
};
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const actionYml = readFileSync(new URL(existsSync(new URL('../../../action/action.yml', import.meta.url)) ? '../../../action/action.yml' : '../../../action.yml', import.meta.url), 'utf8');

describe('npm package (QA-3)', () => {
  it('is publishable and names match brand.ts', () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.name).toBe(GEO_TOOL.npmPackage);
    expect(pkg.version).toBe(GEO_TOOL.version);
    expect(pkg.bin).toEqual({ [GEO_TOOL.bin]: `dist/${GEO_TOOL.bin}.mjs` });
    expect(pkg.mcpName).toBe(GEO_TOOL.mcpName);
    expect(pkg.license).toBe('MIT');
  });

  it('every export points at a file that ships (no src/*.ts)', () => {
    for (const target of Object.values(pkg.exports)) {
      const shipped = target === './package.json' || pkg.files.some((f) => target.replace(/^\.\//, '').startsWith(`${f.replace(/\/$/, '')}/`));
      expect(shipped, target).toBe(true);
      expect(target).not.toMatch(/\.ts$/);
    }
  });

  it('has the metadata npm search and the registry read', () => {
    expect(pkg.repository.url).toContain(`github.com/${GEO_TOOL.repo}.git`);
    expect(pkg.repository.directory).toBe('packages/cli');
    expect(pkg.bugs.url).toBe(`${GEO_TOOL.repoUrl}/issues`);
    expect(pkg.homepage).toMatch(/^https:\/\//);
    expect(pkg.engines).toEqual({ node: '>=22.12' });
    expect(pkg.keywords).toHaveLength(24);
    expect(new Set(pkg.keywords).size).toBe(24);
    expect(pkg.keywords).toEqual(expect.arrayContaining(['geo', 'aeo', 'gptbot', 'llms.txt', 'mcp-server', 'github-action']));
    expect(String(pkg.description)).toMatch(/ChatGPT, Claude, Perplexity and Gemini/);
  });
});

describe('public owner (QA-2) and listings', () => {
  it('README and the Action point at the kunoluapps repo, never kunolu/', () => {
    expect(readme).toContain(`uses: ${GEO_TOOL.repo}@v0`);
    expect(readme).not.toMatch(/github\.com\/kunolu\/|kunolu\/citelog/);
    expect(GEO_TOOL.repo).toBe(`kunoluapps/${GEO_TOOL.bin}`);
  });

  it('action.yml uses the Marketplace name from brand.ts', () => {
    expect(actionYml.split('\n')[0]).toBe(`name: ${GEO_TOOL.actionName}`);
    expect(GEO_TOOL.actionName).not.toBe(GEO_TOOL.name);
  });

  it('README images and links are absolute (npmjs.com cannot resolve relative ones)', () => {
    expect(readme).not.toMatch(/src="(?!https:)/);
    expect(readme).not.toMatch(/\]\((?!https?:|#|mailto:)[^)]+\)/);
  });

  it('README states the User-Agent the tool really sends, and lists all nine MCP tools', async () => {
    expect(readme).toContain(`\`${GEO_TOOL_USER_AGENT}\``);
    const { TOOL_NAMES } = await import('../src/mcp/index.js');
    for (const t of TOOL_NAMES) expect(readme).toContain(`| \`${t}\` |`);
  });
});

describe('bundles', () => {
  it("the Action bundle doesn't carry the MCP SDK (only the CLI starts the MCP server)", () => {
    const action = readFileSync(new URL('../../../action/dist/index.js', import.meta.url), 'utf8');
    expect(action).not.toContain('@modelcontextprotocol');
    expect(action).not.toContain('McpServer');
  });
});
