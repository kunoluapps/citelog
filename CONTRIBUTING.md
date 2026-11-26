# Contributing to Citelog

Thanks for helping. Bug reports, false positives ("this check is wrong about my page"), new AI crawlers and fixes are all welcome.

## Before you start

- **A check is wrong for your page?** Open a "False positive" issue with the URL (or the HTML) and what you expected. Those reports make the checks better for everyone.
- **A new AI crawler?** Open a "New crawler" issue with the vendor's own documentation page. We only add crawlers the vendor documents, and IP ranges only from the vendor's published list.
- **Bigger changes** (a new check, a new log format, a new engine): open an issue first so we can agree on the behaviour.

## Development

Node 22.12 or newer and pnpm 9 (`corepack enable`).

```sh
pnpm install
pnpm --filter citelog build     # the CLI bundle (tests run it)
pnpm typecheck
pnpm test
pnpm check                      # licence headers and repo rules
```

Layout:

| Folder | What |
|---|---|
| `packages/geo` | The engine: readiness checks, the AI crawler catalog, robots.txt, log parsers, prompt adapters, llms.txt |
| `packages/core` | Shared names, score bands, money and prompt-measure rules |
| `packages/cli` | The `citelog` npm package: CLI, renderers and the MCP server (`src/mcp`) |
| `action/` | The GitHub Action. `action/dist` is committed; rebuild it with `node action/scripts/build.mjs` when you change the Action or the engine |
| `scripts/refresh-ip-ranges.mjs` | Maintainers: refresh the bundled IP range snapshot from the vendors' lists |

## Rules the code keeps

- **No telemetry.** Citelog talks only to the site being checked and the engines whose keys are set. A pull request that adds any other network call won't be merged.
- Every source file starts with `// SPDX-License-Identifier: MIT` and `// Copyright (c) 2026 Kunolu` (or your own copyright line for new files).
- User-facing names come from `GEO_TOOL` in `packages/core/src/brand.ts`, not string literals.
- Every behaviour change has a test. Tests never reach the network: use the fake fetch helpers.
- Plain, short wording in output: say what happened and what to do next.

## Where the code lives

Citelog is part of Morningdesk, and this repository is exported from Morningdesk's private monorepo on each release. We review pull requests here and apply accepted changes to the monorepo by hand, so your commit may land as part of a release commit; you are credited in the changelog and with a `Co-authored-by` line.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence of this repository. There is no CLA.
