# Changelog

## 0.1.0 (unreleased)

First public release.

- `npx citelog <url>`: what AI crawlers see on a page (words, headline, empty app root, robots.txt, firewall), then ten readiness checks on up to 50 pages, with a fix for each failure.
- `citelog logs`: AI crawler visits from nginx/Apache, Cloudflare Logpush and Vercel logs, verified against the vendors' published IP ranges (snapshot of 2026-11-18).
- `citelog prompts`: ask ChatGPT, Claude, Perplexity and Gemini your questions on your own keys; cited, named, considered-not-cited; `--plan` estimates the cost and sends nothing; `--perception` judges how answers portray you.
- `citelog mcp`: a local MCP server with nine tools (`ai_view`, `check_readiness`, `robots_ai`, `llms_txt`, `crawler_info`, `parse_logs`, `prompts_plan`, `explain_check`, `run_prompts`).
- GitHub Action "Citelog AI Search Readiness": one sticky PR comment, job summary, scheduled runs with a README badge.
