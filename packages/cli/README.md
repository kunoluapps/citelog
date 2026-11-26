<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/kunoluapps/citelog/main/packages/cli/assets/citelog-lockup-dark.svg">
  <img src="https://raw.githubusercontent.com/kunoluapps/citelog/main/packages/cli/assets/citelog-lockup-light.svg" alt="Citelog" width="200">
</picture>

**Lighthouse for AI answers.** Check whether ChatGPT, Claude, Perplexity and Gemini can crawl, read and cite your site.

[![npm](https://img.shields.io/npm/v/citelog)](https://www.npmjs.com/package/citelog)
[![CI](https://github.com/kunoluapps/citelog/actions/workflows/ci.yml/badge.svg)](https://github.com/kunoluapps/citelog/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/kunoluapps/citelog/blob/main/LICENSE)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Citelog_AI_Search_Readiness-2ea44f?logo=github)](https://github.com/marketplace/actions/citelog-ai-search-readiness)
![No telemetry](https://img.shields.io/badge/telemetry-none-brightgreen)

Citelog is a free, open-source CLI, GitHub Action and MCP server for **AI search readiness** (GEO, generative engine optimization; AEO, answer engine optimization). It shows what AI crawlers like GPTBot, ClaudeBot and PerplexityBot get from your pages; checks robots.txt, llms.txt, structured data (JSON-LD) and content that needs JavaScript; reads your access logs for verified AI crawler visits; and, with your own API keys, asks the engines your questions to see who they cite. No account and no telemetry.

## Try it in 10 seconds

```sh
npx citelog your-site.com
```

That prints what AI crawlers see on your home page, then runs ten readiness checks on up to 50 pages from your sitemap, with the fix for each failure. Needs Node 22.12 or newer.

Example output for a page that renders its text only with JavaScript (trimmed):

```text
What AI crawlers see on /privacy
  Words of text   0
  Headline        none
  App root        <div id="root"> is empty
  robots.txt      allows all main AI crawlers

FAIL  ChatGPT, Perplexity and Claude get no text to quote.
      People see text only after JavaScript runs.
Fix   Render the main text on the server (SSR or a
      static build) so it is in the HTML.

  Page                          Score  Result
  /privacy                         63  FAIL  2

  Site score 63  Needs work (50–89)
  Top fix: render the main text on the server (1 page)
```

## What it checks

Each page gets a 0-100 score: the weight of passed checks plus half the weight of warnings, over the weight of the checks that apply. The site score is the mean of the page scores. Bands: 90-100 ready, 50-89 needs work, 0-49 not ready.

| Check | Weight | Passes when |
|---|---|---|
| **Page indexable** (`indexable`) | 3 | HTTP 2xx and no `noindex` in a robots meta tag or the `X-Robots-Tag` header. |
| **robots.txt allows the main AI crawlers** (`robots_ai`) | 3 | The AI search crawlers and user-triggered fetchers (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Googlebot, Bingbot) may read the page. Blocking only training crawlers is a warning, not a failure. |
| **Content present without JavaScript** (`no_js_content`) | 3 | At least 50 words in the HTML as sent, and no empty app root (`#root`, `#app`, `#__next`…) unless the page has 150+ words outside it. |
| **A short direct answer near the top** (`direct_answer`) | 2 | The first paragraph is 60 words or fewer and starts within 150 words of the title. |
| **Valid JSON-LD** (`json_ld`) | 2 | Valid, typed JSON-LD that matches the page (an Article on article pages, FAQPage only for questions shown on the page). |
| **Canonical points to itself** (`canonical`) | 1 | One canonical link, pointing to this URL. |
| **Title and meta description** (`title_meta`) | 1 | A title of 65 characters or fewer and a description of 160 or fewer. |
| **Question-style subheadings** (`question_headings`) | 1 | At least a third of the h2/h3 subheadings are questions. |
| **Visible "updated" date matches structured data** (`updated_date`) | 1 | The visible "Updated" date and the JSON-LD `dateModified` are both there and agree. |
| **llms.txt** (`llms_txt`) | info | Shown, never scored: evidence that engines read llms.txt is thin. |

The MCP server's `explain_check` tool gives the full pass, warn and fail rules for each check.

## Which AI crawlers

30 crawlers, from each vendor's own documentation. **Bold** = the main crawlers the robots.txt check requires to be allowed.

| Purpose | Crawlers |
|---|---|
| AI search indexers | **OAI-SearchBot**, **Claude-SearchBot**, **PerplexityBot**, **Googlebot**, **Bingbot**, OAI-AdsBot, Google-CloudVertexBot, Applebot, DuckAssistBot, MistralAI-Index, Amzn-SearchBot, Meta-WebIndexer |
| User-triggered fetchers (someone asked an AI to open your page) | **ChatGPT-User**, **Claude-User**, **Perplexity-User**, Claude-Agent, Google-Agent, Google-GeminiNotebook, Google-NotebookLM, MistralAI-User, Amzn-User, Meta-ExternalFetcher |
| Training crawlers | GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, MistralAI-Training, Amazonbot, Meta-ExternalAgent, CCBot |

`citelog logs` checks each visit against the IP ranges the vendors publish (a dated snapshot ships in the package), so a fake "GPTBot" from someone else's server shows as unverified.

## Commands

| Command | What it does |
|---|---|
| `citelog <url>` | The same as `check <url>`. A bare host like `your-site.com` means `https://` (`localhost:3000` and IP addresses mean `http://`). For a page URL it first prints what AI crawlers see there: words of text, headline, robots.txt, and whether a firewall turns them away, with PASS or FAIL and the fix. |
| `citelog check <url \| sitemap.xml \| ./dist>` | Reads up to 50 pages (a page, a sitemap, the sitemap a site points to, or a folder of built HTML), runs the ten checks and prints a score per page and for the site. |
| `citelog logs <file>` | Reads nginx or Apache combined logs, Cloudflare Logpush JSON or Vercel log drain JSON (`.gz` too) and prints AI crawler visits by bot and page, each verified or unverified by IP. Nothing is looked up online. |
| `citelog prompts` | Asks each engine whose key is set the prompts in `citelog.config.json` and marks each answer **cited** (links a page on your domain), **named** (says your name without a link) or **-**, with who was cited instead and the pages engines considered but didn't cite. `--plan` prints the prompts, engines and estimated cost and sends nothing. `--perception` judges answers that name or cite you as positive, neutral or negative. |
| `citelog init [site]` | Writes a starter `citelog.config.json`. |
| `citelog mcp` | Starts the local MCP server (below). |

Options: `--json`, `--md` (Markdown for PRs and job summaries), `--fail-under <0-100>`, `--max-pages <n>` (default 50), `--render`, `--verbose`, `--no-color` (also `NO_COLOR=1`), `--plan`, `--perception`, `--format <combined|cloudflare|vercel>`, `--site <domain>`, `--config <file>`, `--help`, `--version`.

**Exit codes:** `0` ok, `1` the score is below `--fail-under`, `2` couldn't run (site unreachable, unknown log format, bad config).

`--render` helps when a page sends its text only after JavaScript runs. It loads the page in a Chrome, Chromium or Edge you already have (`CHROME_PATH`, or the usual install paths), headless with a throwaway profile, and prints how many words people see against what AI crawlers get. Nothing is downloaded. It works with `check` on a page URL, in text or `--json` output.

### Engine keys (for `prompts` only)

| Engine | Environment variable | Model |
|---|---|---|
| ChatGPT | `OPENAI_API_KEY` | gpt-6.2-astra with web search |
| Claude | `ANTHROPIC_API_KEY` | claude-haiku-5-5 with web search |
| Perplexity | `PERPLEXITY_API_KEY` | perplexity/sonar |
| Gemini | `GOOGLE_API_KEY` or `GEMINI_API_KEY` | gemini-4-hydrogen grounded with Google Search |

Run `citelog prompts --plan` first: it shows the estimated cost per engine and sends nothing. `--perception` uses a small model on a key you already set (Claude Haiku 5.5 on `ANTHROPIC_API_KEY`, else gpt-6-luna on `OPENAI_API_KEY`), about $0.00014 per judged answer. API answers can differ from what a person sees in the ChatGPT, Claude, Perplexity and Gemini apps; the output says so.

### Config

`citelog.config.json` (or `.yaml` / `.yml`). Everything is optional; with no file, `check` works with the defaults.

```json
{
  "site": "https://your-site.com",
  "brandTerms": ["Your Product", "your-site.com"],
  "prompts": [
    "best budgeting app for beginners",
    { "text": "your-product vs a-competitor", "topic": "Comparisons", "stage": "evaluation" }
  ],
  "engines": ["openai", "anthropic", "perplexity", "gemini"],
  "failUnder": 80,
  "maxPages": 50
}
```

A prompt is a string or `{ "text", "topic", "stage" }` (`discovery`, `evaluation` or `decision`; without one a word rule picks it). Only the text goes to engines. `brandTerms` (up to 5) are the names that count as named; the default is your domain and its name. They belong to the config's own site: `prompts --site other.com` uses that site's defaults.

## GitHub Action

```yaml
# .github/workflows/citelog.yml
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  citelog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npm ci && npm run build
      - uses: kunoluapps/citelog@v0
        with:
          path: ./dist          # or url: the preview deployment of this branch
          fail-under: 75
```

The Action posts one comment per pull request and edits it on every push (add `base-url: https://your-site.com` to compare changed pages with the live site), writes the full report to the job summary, and on a schedule can write a README badge, read an access log and run your prompts. Prompts never run in pull requests. All inputs: [action/README.md](https://github.com/kunoluapps/citelog/blob/main/action/README.md). On the GitHub Marketplace it's **Citelog AI Search Readiness**.

## MCP server

`citelog mcp` is a local MCP server over stdio for Claude Code, Claude Desktop, Cursor, VS Code, Codex and other MCP clients. No account: it runs on your machine and fetches only the sites you ask about.

Because an AI agent picks the URLs, the MCP server only fetches public sites: it refuses localhost, private network, link-local and cloud metadata addresses (checked after DNS lookup, on every redirect). To check a local dev site on purpose, start it with `CITELOG_MCP_ALLOW_PRIVATE=1`. The `citelog` command in your terminal has no such limit, since you type the target yourself.

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en-US/install-mcp?name=citelog&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNpdGVsb2ciLCJtY3AiXX0=)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Citelog-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=citelog&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22citelog%22%2C%22mcp%22%5D%7D)

```sh
# Claude Code
claude mcp add citelog -- npx -y citelog mcp

# VS Code
code --add-mcp '{"name":"citelog","command":"npx","args":["-y","citelog","mcp"]}'
```

Cursor, Claude Desktop and other clients (`mcp.json`, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "citelog": { "command": "npx", "args": ["-y", "citelog", "mcp"] }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.citelog]
command = "npx"
args = ["-y", "citelog", "mcp"]
```

Claude Desktop users can also download `citelog.mcpb` from the [latest release](https://github.com/kunoluapps/citelog/releases/latest) and open it.

| Tool | What it does | Network |
|---|---|---|
| `ai_view` | What AI crawlers see on one page: words, headline, empty app root, robots.txt blocks, firewall, PASS/FAIL and the fix | the page's site |
| `check_readiness` | The ten checks on a URL, sitemap or local build folder (up to 50 pages), as Markdown or JSON | the site |
| `robots_ai` | robots.txt (fetched or pasted) against all 30 crawlers for a path, with a starter "allow AI search, block training" block | the site, or none when pasted |
| `llms_txt` | Fetch `/llms.txt` and compare it with the llmstxt.org format | the site |
| `crawler_info` | The crawler catalog: vendor, purpose, robots.txt token, docs, IP-range snapshot | none |
| `parse_logs` | AI crawler visits from a local access log, verified by IP (counts only, never log lines) | none |
| `prompts_plan` | What `run_prompts` would ask and roughly cost; sends nothing | none |
| `explain_check` | Why a check matters, its exact rules and the fix | none |
| `run_prompts` | Asks the engines your prompts on your own keys. **Spends your API credit**, so it only returns the plan until it's called with `confirm: true` | the engines whose keys are set |

It also has two prompts, `audit_my_site` and `why_am_i_not_cited`, and two resources, `citelog://bots` and `citelog://checks`. The prompt tools read `citelog.config.json` from the folder the client starts the server in, and engine keys from the server's environment, e.g. `claude mcp add citelog -e OPENAI_API_KEY=sk-... -- npx -y citelog mcp`.

## What Citelog sends where

Citelog has no telemetry and no server of its own. It sends nothing to Kunolu or Morningdesk.

| Command or tool | Requests | To |
|---|---|---|
| `check`, `<url>`, `ai_view`, `check_readiness`, `robots_ai`, `llms_txt` | `GET` for the pages, `/robots.txt`, sitemaps and `/llms.txt`, as `Citelog/0.1.0 (+https://getmorningdesk.com/citelog)`, at most 2 at a time per host with a 250 ms gap. For a page URL, one more request to that page as `Mozilla/5.0 (compatible; Citelog/0.1.0; …; as GPTBot)`, to spot firewalls that turn AI crawlers away (never OpenAI's own User-Agent). | Only the site you name. Sitemap entries on other hosts are skipped and counted. |
| `check --render` | Loads the page in your own Chrome with its background networking off. The page's own scripts load what they load, as in any browser. | The page and what it loads. |
| `logs`, `parse_logs`, `crawler_info`, `explain_check`, `prompts --plan`, `prompts_plan` | None. | Nothing. |
| `prompts`, `run_prompts` | Each prompt's text (never its topic or stage), with your key. | `api.openai.com`, `api.anthropic.com`, `api.perplexity.ai`, `generativelanguage.googleapis.com`: only the engines whose keys are set. |
| `--perception` | The question, your brand terms and up to 4,000 characters of each answer that names or cites you. | Anthropic, else OpenAI, on your key. |
| GitHub Action | All of the above, plus the GitHub API with the workflow token to post or edit the PR comment. | `api.github.com` |

## FAQ

**What is GEO / AEO?** Generative engine optimization (GEO) and answer engine optimization (AEO) mean making pages that AI answer engines (ChatGPT search, Perplexity, Claude, Gemini, Google AI Overviews) can crawl, understand and quote. Citelog checks the parts you control: crawler access, text in the HTML, a quotable answer, structured data and dates.

**How do I let ChatGPT search my site but block AI training?** Allow `OAI-SearchBot` and `ChatGPT-User` (they fetch pages for ChatGPT answers) and disallow `GPTBot` (OpenAI's training crawler). Anthropic has the same split (`Claude-SearchBot` and `Claude-User` vs `ClaudeBot`). The MCP `robots_ai` tool prints a starter block for every vendor. Remember that a crawler with its own `User-agent` group ignores your `User-agent: *` rules.

**Does llms.txt matter?** Maybe a little, maybe not. It's a proposal (llmstxt.org), and there's little public evidence that the big engines read it, so Citelog shows whether you have one and never scores it.

**Why does my React or Vite single-page app get 0 words?** Most AI crawlers read the HTML as sent and don't run JavaScript. If your text is rendered in the browser, they see an empty `<div id="root">`. Prerender or server-render the pages you want cited; `citelog <url> --render` shows the gap.

**Does a score of 100 mean I'll be cited?** No. Readiness means engines can read and quote the page. Whether they cite it depends on the question, the competition and the engine. `citelog prompts` measures that directly, with your keys.

**Is it free?** Yes, MIT-licensed. Checks, logs and the MCP server cost nothing. Prompt checks spend your own API credit, usually cents per run, and `--plan` estimates it first.

**Citelog vs GeoReady, Otterly or Profound?** [GEO Optimizer / GeoReady](https://github.com/Auriti-Labs/geo-optimizer-skill) is a capable MIT tool in Python with a CLI, MCP server and Action; pick it if you live in Python. Citelog runs with `npx` (no Python), keeps one PR comment that can compare with your live site, verifies crawler visits in your logs against published IP ranges, shows what people see vs what AI crawlers get with `--render`, lists the pages engines considered but didn't cite, and has no telemetry. Commercial trackers such as Profound, Peec AI and Otterly.AI track prompts over time with dashboards for teams; Citelog is a free check you run in a terminal or CI, and a quick way to fix the basics before you pay for tracking.

## Privacy

No telemetry, no account, no server. Keys stay on your machine or in your CI secrets. See [What Citelog sends where](#what-citelog-sends-where).

## Contributing and licence

Issues and pull requests are welcome: see [CONTRIBUTING.md](https://github.com/kunoluapps/citelog/blob/main/CONTRIBUTING.md). Report security problems as [SECURITY.md](https://github.com/kunoluapps/citelog/blob/main/SECURITY.md) describes. MIT licence, © 2026 Kunolu.

Citelog is part of [Morningdesk](https://getmorningdesk.com), a growth desk for indie sites.
