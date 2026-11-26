# Citelog plugin for Claude Code

Checks whether ChatGPT, Claude, Perplexity and Gemini can crawl, read and cite a website. It adds the Citelog MCP server (`npx -y citelog@0.1.0 mcp`, pinned to an exact version) with nine tools: `ai_view` (what AI crawlers see on a page), `check_readiness` (ten readiness checks with fixes), `robots_ai`, `llms_txt`, `crawler_info`, `parse_logs`, `prompts_plan`, `explain_check` and `run_prompts`.

Ask things like "audit example.com for AI search", "why isn't my pricing page cited by ChatGPT?" or "write a robots.txt that allows AI search but blocks training".

## What it fetches and sends

- The readiness tools (`ai_view`, `check_readiness`, `robots_ai`, `llms_txt`) send `GET` requests only to the site you name: the page, `/robots.txt`, sitemaps and `/llms.txt`, as `Citelog/0.1.0 (+https://getmorningdesk.com/citelog)`, plus one request to the page with a User-Agent ending "as GPTBot" to spot firewalls that turn AI crawlers away.
- `crawler_info`, `explain_check`, `prompts_plan` and `parse_logs` make no network requests. `parse_logs` reads only the log file you name and returns counts, never log lines.
- `run_prompts` is the only tool that calls AI engines: it sends your prompt text to the engines whose API keys you entered (OpenAI, Anthropic, Perplexity, Google), and with perception on, an excerpt of each answer that names you to Anthropic or OpenAI. It spends your API credit, so it returns only a plan and a cost estimate until it's called with `confirm: true`.
- No telemetry. Nothing is sent to Kunolu or Morningdesk.

## Settings

All four API keys are optional and stored as sensitive settings. Without keys, every tool except `run_prompts` works.

MIT licence. Source and docs: https://github.com/kunoluapps/citelog
