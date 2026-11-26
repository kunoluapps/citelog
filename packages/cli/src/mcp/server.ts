// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/** `citelog mcp`: the local MCP server. One registered tool per TOOLS entry, two prompts and two resources. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GEO_TOOL } from '@morningdesk/core';
import { AI_BOTS, CHECK_GUIDE, IP_RANGES_AS_OF, SCORE_RULE } from '@morningdesk/geo';
import { TOOLS, ToolError, type McpDeps } from './tools.js';

export const SERVER_NAME = GEO_TOOL.bin;

export const INSTRUCTIONS =
  `${GEO_TOOL.name} checks whether AI answer engines (ChatGPT, Claude, Perplexity, Gemini) can crawl, read and cite a website. ` +
  'Start with ai_view for one page, then check_readiness for the site; robots_ai and llms_txt look at those files; explain_check says how to fix a check; ' +
  'crawler_info and parse_logs cover AI crawlers and their visits. prompts_plan is free. run_prompts spends the user\'s own API credit: ' +
  'call it with confirm: true only after the user has seen the plan and agreed. Readiness is not a promise of citations; say so when it matters.';

export const RESOURCE_URIS = { bots: `${GEO_TOOL.bin}://bots`, checks: `${GEO_TOOL.bin}://checks` } as const;

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, title: GEO_TOOL.name, version: GEO_TOOL.version, websiteUrl: GEO_TOOL.docsUrl }, { instructions: INSTRUCTIONS });

  for (const tool of TOOLS) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: { title: tool.title, ...tool.annotations } }, async (args: unknown): Promise<CallToolResult> => {
      try {
        const out = await tool.run(deps, args as never);
        return { content: [{ type: 'text', text: out.text }], structuredContent: out.structured };
      } catch (err) {
        if (err instanceof ToolError) return failure(err.message);
        return failure(`${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  server.registerPrompt(
    'audit_my_site',
    {
      title: 'Audit my site for AI answers',
      description: 'Check what AI crawlers see, run the readiness checks and list the fixes in order.',
      argsSchema: { url: z.string().describe('Your site or page URL, e.g. https://example.com') },
    },
    ({ url }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Audit ${url} for AI answer engines with the ${GEO_TOOL.name} tools. 1) ai_view on ${url}. 2) check_readiness on ${url}. ` +
              `3) robots_ai and llms_txt for the site. Then give me the fixes in order of impact (failed checks with the most weight first), ` +
              'each with the exact change to make, and say plainly that passing the checks makes a page readable and quotable, not guaranteed to be cited.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'why_am_i_not_cited',
    {
      title: 'Why am I not cited?',
      description: 'Look for the reasons an AI answer to a question cites other sites and not yours.',
      argsSchema: {
        url: z.string().describe('The page you want cited'),
        question: z.string().describe('The question people ask, e.g. "best budgeting app for beginners"'),
      },
    },
    ({ url, question }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `I want ${url} cited when people ask AI "${question}". With the ${GEO_TOOL.name} tools: run ai_view and check_readiness on ${url}, and robots_ai for the site. ` +
              `Then run prompts_plan for that question and show me the plan and cost. Don't call run_prompts unless I say yes to the cost. ` +
              'Explain the likely reasons in order, and what to change on the page.',
          },
        },
      ],
    }),
  );

  server.registerResource(
    'bots',
    RESOURCE_URIS.bots,
    { title: 'AI crawler catalog', description: 'Every AI crawler the checks and log reader know, with purpose, robots.txt token and docs.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ ipRangesAsOf: IP_RANGES_AS_OF, bots: AI_BOTS }, null, 2) }] }),
  );

  server.registerResource(
    'checks',
    RESOURCE_URIS.checks,
    { title: 'Readiness checks', description: 'What each readiness check tests, its weight, and how to fix it.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ scoreRule: SCORE_RULE, checks: Object.values(CHECK_GUIDE) }, null, 2) }] }),
  );

  return server;
}

/** Serve on stdin/stdout until the client closes the pipe. Notes go to stderr; stdout carries the protocol only. */
export async function serveStdio(deps: McpDeps): Promise<void> {
  const server = createMcpServer(deps);
  await server.connect(new StdioServerTransport());
}
