# Citelog AI Search Readiness (GitHub Action)

AI answer readiness on every pull request: can ChatGPT, Claude, Perplexity and Gemini crawl, read and cite the pages you changed? One comment with what to fix, edited on each push; the full report in the job summary; and on a schedule, a README badge. Citelog, part of Morningdesk · MIT · no telemetry. Listed on the GitHub Marketplace as "Citelog AI Search Readiness".

## Pull requests

```yaml
# .github/workflows/citelog.yml
name: Citelog
on: pull_request            # never pull_request_target with a checkout of PR code
permissions:
  contents: read
  pull-requests: write      # add issues: write if the comment step gets HTTP 403
concurrency:                # one run per PR at a time; a new push cancels the old run
  group: citelog-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  citelog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npm ci && npm run build
      - uses: kunoluapps/citelog@v0
        with:
          path: ./dist                 # or url: your preview deployment of this branch
          # base-url: https://your-site.com   # optional: compare with the live site ("was 81 on main")
          fail-under: 75               # optional: fail the job below this score
```

What it does on a pull request:

- Checks the pages this PR changes (matched from the changed files; every page up to `max-pages` when they don't map to pages) on the preview `url`, or else the built HTML in `path`.
- Writes the job summary first, so a GitHub outage on the comment never loses the results (a failed comment is a warning, not a failed job).
- Posts **one** comment, found again by a hidden marker and edited on later pushes: score, new failures first, fixes, what changed since the last push. Only a marked comment this workflow wrote is edited; a pasted marker from anyone else is ignored.
- Prompts are never asked in pull requests.
- With neither `url` nor `path`, the job fails and says the two ways to fix it.
- With `fail-under` missed, the job fails, and the comment lists every failed check.
- When no page could be loaded (a refused preview, a site answering 5xx, an empty build folder), the job fails and says why. It never passes on nothing.

**From a fork** the token is read-only and secrets aren't passed. Citelog skips the comment and prompts, puts the results in the job summary only, says why, and does not fail for missing permissions. A 403 or 404 on the comment is treated the same way.

## Scheduled run and badge

```yaml
# .github/workflows/citelog-weekly.yml
name: Citelog weekly
on:
  schedule: [{ cron: '0 7 * * 1' }]
  workflow_dispatch:
permissions:
  contents: write          # to commit the badge
concurrency:
  group: citelog-weekly
  cancel-in-progress: false
jobs:
  citelog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - id: citelog
        uses: kunoluapps/citelog@v0
        with:
          url: https://your-site.com
          badge: .github/citelog-badge.svg
          prompts: true                     # asks the prompts in citelog.config.json
          # perception: true                # also judge answers that name or cite you (OpenAI or Anthropic key)
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          # PERPLEXITY_API_KEY, and GOOGLE_API_KEY or GEMINI_API_KEY for Gemini
      - uses: actions/upload-artifact@v4
        with:
          name: citelog-report
          path: |
            ${{ steps.citelog.outputs.report-json }}
            ${{ steps.citelog.outputs.report-md }}
      - name: Commit the badge
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add .github/citelog-badge.svg README.md
          git diff --cached --quiet || git commit -m "Update Citelog badge" && git push
```

The Action writes the badge SVG (and the line under it, if your README has the markers below); committing them is the workflow's job, as above. There is no hosted badge service.

```md
[![Citelog](.github/citelog-badge.svg)](https://your-site.com)
<!-- citelog:badge-line -->AI answer readiness of your-site.com<!-- /citelog:badge-line -->
```

## Inputs

| Input | Default | What it does |
|---|---|---|
| `url` | | Preview URL on a PR; the live site or a sitemap URL on a schedule |
| `path` | | Folder of built HTML (e.g. `./dist`) |
| `base-url` | | Live site, to compare changed pages with the default branch |
| `max-pages` | `50` | Pages to read from a sitemap or folder |
| `fail-under` | | Fail the job below this score (0-100) |
| `prompts` | `false` | Ask the prompts in `citelog.config.json` on runs that aren't pull requests (a schedule, a push to main); never in pull requests |
| `perception` | `false` | With `prompts`, judge each answer that names or cites the site as positive, neutral or negative, on the OpenAI or Anthropic key in `env` (a small model; about $0.00014 an answer). Off by default so CI has no judge cost |
| `logs` | | Access log to read for AI crawler visits (scheduled runs) |
| `github-token` | `${{ github.token }}` | Token for the PR comment |
| `badge` | | Path to write the badge SVG on scheduled and default-branch runs |
| `comment` | `true` | Post and keep editing one PR comment |

Outputs: `score`, `band`, `report-json`, `report-md`, `badge-line`, `comment-url`.

Exit: the job fails when `fail-under` is missed (no score counts as missed) or when nothing could be checked; never for missing comment permissions or a GitHub error on the comment. On a schedule the badge shows "no score" when the site answered but no page could be scored; when nothing answered at all it is left as it was.

`logs` reads nginx or Apache combined logs, Cloudflare Logpush JSON (a `.gz` file is unpacked as it is read) and Vercel log drain JSON, in one pass.

## Privacy

No telemetry. The Action calls only the site it checks, the engines whose keys you pass, and the GitHub API for the comment.

## Developing

`src/` is TypeScript; `dist/index.js` is the committed esbuild bundle GitHub runs (`runs.using: node24`), with the bundled packages' licences in `dist/LICENSES.txt`. Rebuild with `pnpm --filter citelog-action build` and commit `dist/`. The build is deterministic: `node scripts/check-bundles.mjs` (also run by `pnpm test`) fails when `dist/` no longer matches the sources.
