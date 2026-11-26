// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu

export { runCli, EXIT, type CliIO } from './geo/main.js';
export { realEngine, type GeoEngine } from './geo/engine.js';
export { parseCliArgs, hostToUrl, looksLikeHost, looksLikeUrl, HELP, COMMANDS, type Command, type Flags, type Parsed } from './geo/args.js';
export {
  loadConfig,
  validateConfig,
  domainOf,
  starterConfig,
  promptTexts,
  promptStage,
  promptTopics,
  brandTermsFor,
  ConfigError,
  CONFIG_FILES,
  type GeoConfig,
  type LoadedConfig,
  type PromptSpec,
} from './geo/config.js';
export * from './geo/render/model.js';
export * from './geo/render/style.js';
export * from './geo/render/text.js';
export * from './geo/render/markdown.js';
export * from './geo/render/badge.js';
export * from './geo/render/json.js';
export * from './geo/render/plan.js';
export * from './geo/render/reveal.js';
export { chromeArgs, chromeCandidates, findChrome, renderWithLocalChrome, RENDER_TIMEOUT_MS, type RenderDom, type RenderDomResult } from './geo/browser.js';
// The MCP server (src/mcp) is not re-exported: the Action imports this file, and must not bundle the MCP SDK.
