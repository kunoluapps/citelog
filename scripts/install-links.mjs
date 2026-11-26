#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
// The MCP install links for the README and the docs site: a Cursor button, a VS Code button, and the commands.
// `node scripts/install-links.mjs` prints them; scripts/check-public.mjs checks the README carries the same ones.

export const SERVER = 'citelog';
export const CONFIG = { command: 'npx', args: ['-y', 'citelog', 'mcp'] };

export function installLinks() {
  const cursorConfig = Buffer.from(JSON.stringify(CONFIG)).toString('base64');
  const vscodeConfig = encodeURIComponent(JSON.stringify({ type: 'stdio', ...CONFIG }));
  return {
    cursorWeb: `https://cursor.com/en-US/install-mcp?name=${SERVER}&config=${cursorConfig}`,
    cursorDeeplink: `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER}&config=${cursorConfig}`,
    vscodeWeb: `https://insiders.vscode.dev/redirect/mcp/install?name=${SERVER}&config=${vscodeConfig}`,
    vscodeCli: `code --add-mcp '${JSON.stringify({ name: SERVER, ...CONFIG })}'`,
    claudeCode: `claude mcp add ${SERVER} -- ${CONFIG.command} ${CONFIG.args.join(' ')}`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const l = installLinks();
  console.log(`Cursor button (Markdown):
[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](${l.cursorWeb})

Cursor deeplink (for the docs site; GitHub strips custom-scheme links):
${l.cursorDeeplink}

VS Code button (Markdown):
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Citelog-0098FF?logo=visualstudiocode&logoColor=white)](${l.vscodeWeb})

VS Code command:
${l.vscodeCli}

Claude Code:
${l.claudeCode}`);
}
