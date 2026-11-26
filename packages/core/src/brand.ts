// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu

/**
 * Product names in one place. Code, file and type names stay neutral ("geo") and every user-facing mention of the
 * AI-search tool reads GEO_TOOL, so renaming it is one pass.
 */
export const DESK_NAME = 'Morningdesk';
export const DESK_DOMAIN = 'getmorningdesk.com';

const GEO_NAME = 'Citelog';
const GEO_BIN = 'citelog';
/** The public repo (CLI, Action, MCP). Note github.com/kunolu is someone else's account; ours is kunoluapps. */
const GEO_REPO = `kunoluapps/${GEO_BIN}`;

export const GEO_TOOL = {
  /** Display name: "Citelog". */
  name: GEO_NAME,
  /** CLI binary and npm package name. Keep in sync with packages/cli/package.json "name" and "bin". */
  bin: GEO_BIN,
  npmPackage: GEO_BIN,
  /** Config file base name: <configBase>.json | .yaml | .yml */
  configBase: `${GEO_BIN}.config`,
  /**
   * GitHub Marketplace display name (action/action.yml "name" must match). Marketplace refuses a name equal to a GitHub
   * user or org unless that owner publishes, and github.com/citelog is another org, so the name carries keywords.
   */
  actionName: `${GEO_NAME} AI Search Readiness`,
  /** Public GitHub repo, owner/name: `uses: <repo>@v0`. */
  repo: GEO_REPO,
  repoUrl: `https://github.com/${GEO_REPO}`,
  /** Official MCP Registry name (packages/cli/package.json "mcpName" and server.json "name" must match). */
  mcpName: `io.github.${GEO_REPO}`,
  /** Docs page on the site. */
  docsUrl: `https://${DESK_DOMAIN}/${GEO_BIN}`,
  /** "Citelog, part of Morningdesk". */
  tagline: `${GEO_NAME}, part of ${DESK_NAME}`,
  version: '0.1.0',
  /** Hidden marker that finds the one sticky PR comment. Changing it orphans old comments (they stay, a new one is posted). */
  commentMarker: `<!-- ${GEO_BIN}:report -->`,
} as const;

export const GEO_TOOL_USER_AGENT = `${GEO_TOOL.name}/${GEO_TOOL.version} (+${GEO_TOOL.docsUrl})`;
