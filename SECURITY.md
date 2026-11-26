# Security policy

## Reporting a vulnerability

Please don't open a public issue. Report it privately:

- GitHub: **Security › Report a vulnerability** on this repository (private vulnerability reporting), or
- email **security@getmorningdesk.com**.

Include what you found, how to reproduce it and the version (`citelog --version`). We aim to reply within 3 working days and to ship a fix for confirmed issues within 30 days, and we'll credit you in the release notes unless you'd rather not be named.

## Supported versions

The latest `0.x` release on npm and the `v0` tag of the Action.

## What's in scope

- The `citelog` CLI and MCP server, and the GitHub Action in this repository.
- Things like: a page or log file that makes Citelog run code, read or write files it shouldn't, or send data anywhere other than the site being checked and the engines whose keys are set; API keys appearing in output, errors or PR comments; a pull request comment that can be made to ping people or inject markup.

Out of scope: the sites you check, the AI engines' APIs, and reports that only show that Citelog fetches the URLs you give it (that's its job; run it only on sites you're allowed to check).
