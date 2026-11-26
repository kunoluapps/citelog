// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import type { AiViewSummary } from '@morningdesk/core';
import { CHECK_IDS, aiView, scoreBand, type AiCrawlerFetch } from '@morningdesk/geo';
import type { CheckId, CheckOutcome, CheckResult, LogSummary, PageReport, PromptResult, PromptRun, RunPromptsOptions, SiteReport } from '@morningdesk/geo';
import type { CliIO, GeoEngine } from '../src/index.js';

export const LABELS: Record<CheckId, string> = {
  indexable: 'Page can be indexed',
  robots_ai: 'robots.txt allows the main AI crawlers',
  canonical: 'Canonical URL',
  title_meta: 'Title and meta description',
  direct_answer: 'Short direct answer near the top',
  question_headings: 'Question-style subheadings',
  updated_date: 'Visible "updated" date matches structured data',
  json_ld: 'Valid JSON-LD',
  no_js_content: 'Content present without JavaScript',
  llms_txt: 'llms.txt',
};

const FIX: Partial<Record<CheckId, string>> = {
  direct_answer: 'A short answer under the title.',
  no_js_content: 'Render the plan table on the server.',
  updated_date: 'Set dateModified to the real edit date.',
  json_ld: 'Use an ISO date in datePublished.',
  question_headings: 'Make one subheading a question.',
  robots_ai: 'Remove the rule, unless you mean to block it.',
};

const DETAIL: Partial<Record<CheckId, string>> = {
  no_js_content: 'Main text appears only after JS runs. AI crawlers mostly read the HTML as sent.',
  updated_date: 'Page says Nov 2, dateModified says 2026-10-14.',
  robots_ai: 'robots.txt blocks ClaudeBot. "User-agent: ClaudeBot / Disallow: /" (line 14)',
  direct_answer: 'No answer in the first 60 words.',
  json_ld: 'datePublished is "Nov 2026".',
};

/** A page with the given non-pass checks; everything else passes (llms.txt is info). */
export function page(path: string, score: number | null, issues: Partial<Record<CheckId, CheckResult>> = {}, origin = 'https://bywell.org'): PageReport {
  const checks: CheckOutcome[] = CHECK_IDS.map((id) => {
    const result: CheckResult = id === 'llms_txt' ? 'info' : (issues[id] ?? 'pass');
    const c: CheckOutcome = {
      id,
      label: LABELS[id],
      result,
      weight: id === 'llms_txt' ? 0 : id === 'robots_ai' || id === 'no_js_content' ? 15 : 10,
      detail: id === 'llms_txt' ? 'Found at /llms.txt. Not scored: evidence that engines use it is thin.' : result === 'pass' ? 'OK.' : (DETAIL[id] ?? `${LABELS[id]} needs work.`),
      why: `${LABELS[id]} helps engines quote the page.`,
    };
    if (result === 'fail' || result === 'warn') c.fix = FIX[id] ?? `Fix ${LABELS[id].toLowerCase()}.`;
    return c;
  });
  return { url: `${origin}${path}`, status: 200, score, band: scoreBand(score), checks };
}

export function site(pages: PageReport[], over: Partial<SiteReport> = {}): SiteReport {
  const scored = pages.map((p) => p.score).filter((s): s is number => s !== null);
  const score = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  return { target: 'https://bywell.org', kind: 'sitemap', pages, score, band: scoreBand(score), blockedBots: [], checkedAt: '2026-11-18T07:00:00.000Z', ...over };
}

/** Board CCli state 1: ansa.chat, 12 pages, all pass. */
export function boardPass(): SiteReport {
  const scores = [96, 93, 91, 95, 94, 97, 92, 96, 95, 93, 94, 93];
  const paths = ['/', '/pricing', '/blog/group-chats-with-ai', '/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i'];
  return site(
    paths.map((p, i) => page(p, scores[i] ?? 90, {}, 'https://ansa.chat')),
    { target: 'https://ansa.chat', score: 94, band: 'ready' },
  );
}

/** Board CCli state 2: a build folder with warnings only. */
export function boardWarn(): SiteReport {
  const pages = [page('/learn/etf-vs-index-fund', 88, { updated_date: 'warn' }, ''), page('/learn/compound-interest', 86, { question_headings: 'warn' }, '')];
  for (let i = 0; i < 4; i++) pages.push(page(`/learn/w${i}`, 89, { question_headings: 'warn' }, ''));
  for (let i = 0; i < 35; i++) pages.push(page(`/learn/p${i}`, 92, {}, ''));
  return site(pages, { target: './out', kind: 'folder', score: 89, band: 'needs_work' });
}

/** Board CCli state 3: bywell.org scoring 72 with fails. */
export function boardFail(): SiteReport {
  const pages = [
    page('/pricing', 42, { no_js_content: 'fail', direct_answer: 'fail', json_ld: 'fail', robots_ai: 'fail' }),
    page('/learn/what-is-diversification', 58, { direct_answer: 'fail', json_ld: 'fail', robots_ai: 'fail' }),
    page('/learn/roth-ira', 64, { direct_answer: 'fail', updated_date: 'fail', robots_ai: 'fail' }),
  ];
  for (let i = 0; i < 6; i++) pages.push(page(`/learn/f${i}`, 70, { direct_answer: 'fail' }));
  for (let i = 0; i < 5; i++) pages.push(page(`/learn/g${i}`, 74, { question_headings: 'fail' }));
  for (let i = 0; i < 9; i++) pages.push(page(`/learn/w${i}`, 80, { updated_date: 'warn' }));
  for (let i = 0; i < 18; i++) pages.push(page(`/learn/p${i}`, 90));
  return site(pages, { score: 72, band: 'needs_work', blockedBots: ['claudebot'] });
}

/** Measures for a checked answer: named, considered sources, perception. Defaults: not named, considered not collected. */
export interface Measures {
  mentioned?: boolean;
  considered?: PromptResult['considered'];
  consideredOffsite?: number | null;
  perception?: PromptResult['perception'];
}

export function promptResult(prompt: string, engine: PromptResult['engine'], cited: boolean | 'nc' | 'skip', others: string[] = [], m: Measures = {}): PromptResult {
  const unchecked = { mentioned: null, considered: null, consideredOffsite: null } as const;
  if (cited === 'nc') return { prompt, engine, status: 'not_checked', cited: null, others: [], error: { kind: 'rate_limited', message: 'rate limit (HTTP 429) after 2 tries' }, checkedAt: '2026-11-18T07:00:00.000Z', ...unchecked, perceptionStatus: 'not_checked' };
  if (cited === 'skip') return { prompt, engine, status: 'skipped', cited: null, others: [], checkedAt: '2026-11-18T07:00:00.000Z', ...unchecked, perceptionStatus: 'not_checked' };
  const mentioned = m.mentioned ?? false;
  return {
    prompt,
    engine,
    status: 'checked',
    cited,
    citedUrl: cited ? 'https://bywell.org/learn/roth-ira' : undefined,
    others,
    checkedAt: '2026-11-18T07:00:00.000Z',
    mentioned,
    ...(mentioned ? { mentionSnippet: `… ${prompt}: Bywell is a good place to start …` } : {}),
    considered: m.considered ?? null,
    consideredOffsite: m.consideredOffsite ?? (m.considered ? 6 : null),
    perceptionStatus: m.perception ? 'judged' : mentioned || cited ? 'off' : 'not_about_you',
    ...(m.perception ? { perception: m.perception } : {}),
  };
}

/** An empty run (no engine answered). */
export function emptyRun(site: string, skipped: PromptRun['skipped'] = []): PromptRun {
  return { site, results: [], skipped, costUsdMicros: 0, judge: null };
}

export const BOARD_PROMPTS = ['roth ira for beginners', 'best app to learn investing', 'etf vs index fund'];

/** Board CCli state 5: Gemini rate-limited, the other three finish. */
export function boardOneEngineFailed(): PromptRun {
  const [a = '', b = '', c = ''] = BOARD_PROMPTS;
  return {
    site: 'bywell.org',
    results: [
      promptResult(a, 'openai', true),
      promptResult(a, 'anthropic', true),
      promptResult(a, 'perplexity', false, ['nerdwallet.com']),
      promptResult(a, 'gemini', 'nc'),
      promptResult(b, 'openai', false, ['nerdwallet.com', 'investopedia.com']),
      promptResult(b, 'anthropic', false, ['investopedia.com']),
      promptResult(b, 'perplexity', false, ['nerdwallet.com', 'investopedia.com']),
      promptResult(b, 'gemini', 'nc'),
      promptResult(c, 'openai', true),
      promptResult(c, 'anthropic', false, ['nerdwallet.com']),
      promptResult(c, 'perplexity', true),
      promptResult(c, 'gemini', 'nc'),
    ],
    skipped: [],
    costUsdMicros: 30_000,
    judge: null,
  };
}

const page_ = (path: string, cited = false) => ({ url: `https://bywell.org${path}`, host: 'bywell.org', cited });

/**
 * Measures on fakes: Named without a link, considered-not-cited pages (Gemini by site only), Perplexity not collected,
 * perception judged by Claude Haiku on four answers that name or cite the site.
 */
export function boardMeasures(): PromptRun {
  const [a = '', b = '', c = ''] = BOARD_PROMPTS;
  const pos = { value: 'positive', reason: 'Recommends it for beginners.' } as const;
  const neu = { value: 'neutral', reason: 'Lists it with others.' } as const;
  return {
    site: 'bywell.org',
    results: [
      promptResult(a, 'openai', true, [], { mentioned: true, considered: [page_('/learn/roth-ira', true), page_('/learn/ira-basics')], perception: pos }),
      promptResult(a, 'anthropic', false, ['nerdwallet.com'], { mentioned: true, considered: [page_('/learn/roth-ira')], perception: neu }),
      promptResult(a, 'perplexity', false, ['nerdwallet.com']),
      promptResult(a, 'gemini', false, ['investopedia.com'], { considered: [{ host: 'bywell.org', cited: false }] }),
      promptResult(b, 'openai', false, ['nerdwallet.com'], { considered: [page_('/learn/roth-ira')] }),
      promptResult(b, 'anthropic', false, ['investopedia.com'], { considered: [] }),
      promptResult(b, 'perplexity', false, ['investopedia.com']),
      promptResult(b, 'gemini', false, ['nerdwallet.com'], { considered: [] }),
      promptResult(c, 'openai', true, [], { mentioned: false, considered: [page_('/learn/roth-ira', true)], perception: pos }),
      promptResult(c, 'anthropic', false, [], { mentioned: true, considered: [], perception: pos }),
      promptResult(c, 'perplexity', 'nc'),
      promptResult(c, 'gemini', false, ['investopedia.com'], { considered: [{ host: 'bywell.org', cited: false }] }),
    ],
    skipped: [],
    costUsdMicros: 61_682,
    judge: { provider: 'anthropic', model: 'claude-haiku-5-5', judged: 4, failed: 0, costUsdMicros: 540, stoppedAtLimit: false },
  };
}

export const NO_KEYS_SKIPPED: PromptRun['skipped'] = [
  { engine: 'openai', envVar: 'OPENAI_API_KEY' },
  { engine: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { engine: 'perplexity', envVar: 'PERPLEXITY_API_KEY' },
  { engine: 'gemini', envVar: 'GOOGLE_API_KEY or GEMINI_API_KEY' },
];

export function logSummary(): LogSummary {
  return {
    format: 'combined',
    linesRead: 12034,
    linesSkipped: 12,
    bots: [
      { botId: 'gptbot', hits: 412, verifiedHits: 412, unverifiedHits: 0, unknownHits: 0, pages: 38 },
      { botId: 'claudebot', hits: 97, verifiedHits: 94, unverifiedHits: 3, unknownHits: 0, pages: 12 },
      { botId: 'bytespider', hits: 40, verifiedHits: 0, unverifiedHits: 0, unknownHits: 40, pages: 9 },
    ],
    rows: [
      { botId: 'gptbot', path: '/learn/roth-ira', hits: 40, verified: true, lastSeen: '2026-11-15T10:00:00Z' },
      { botId: 'claudebot', path: '/pricing', hits: 12, verified: false, lastSeen: '2026-11-14T10:00:00Z' },
    ],
    from: '2026-11-09T00:01:00Z',
    to: '2026-11-15T23:59:00Z',
    ipRangesAsOf: '2026-11-18',
  };
}

/** A Lewis-like client-rendered home page: a title, a description and an empty div#root. */
export const SPA_HOME = `<!doctype html><html lang="en"><head><meta charset="UTF-8" />
<title>Lewis: AI Car Diagnostics | OBD2 Codes and Live Data</title>
<meta name="description" content="Lewis reads your car's trouble codes and live data through a Bluetooth OBD2 scanner." />
<script type="module" src="/assets/index-abc123.js"></script></head>
<body><div id="root"></div></body></html>`;

const SSR_PARAGRAPH =
  '<p>Ansa answers your customers on chat, email and WhatsApp, day and night, using what your team already wrote. It hands a conversation to a person when it should, and it tells you which questions come up most so you can fix the page that caused them.</p>';

/** An ansa.chat-like server-rendered home page with a headline, an FAQ section and FAQPage data. */
export const SSR_HOME = `<!doctype html><html lang="en"><head><meta charset="UTF-8" />
<title>Ansa: AI customer support for small businesses</title>
<meta name="description" content="AI customer support for small businesses." />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is Ansa?","acceptedAnswer":{"@type":"Answer","text":"AI customer support."}}]}</script>
</head><body><main><h1>AI customer support for small businesses.</h1>
${SSR_PARAGRAPH.repeat(8)}
<h2>FAQ</h2><h3>What is Ansa?</h3>${SSR_PARAGRAPH}</main></body></html>`;

/** The reveal for fixed HTML, computed by the real geo engine (no network). */
export function aiViewOf(
  html: string,
  opts: { url?: string; robotsTxt?: string | null; crawler?: AiCrawlerFetch; status?: number } = {},
): AiViewSummary {
  return aiView({
    url: opts.url ?? 'https://www.thelewisapp.com/',
    status: opts.status ?? 200,
    html,
    robotsTxt: opts.robotsTxt ?? 'User-agent: *\nAllow: /\n',
    crawler: opts.crawler ?? { status: 200, headers: {}, html },
    now: new Date('2026-11-19T07:00:00.000Z'),
  });
}

export interface FakeCalls {
  checkTarget: { target: string; maxPages: number }[];
  runPrompts: { site: string; prompts: string[]; opts: RunPromptsOptions }[];
  readAiView: string[];
}

export function fakeEngine(over: Partial<GeoEngine> = {}): { engine: GeoEngine; calls: FakeCalls } {
  const calls: FakeCalls = { checkTarget: [], runPrompts: [], readAiView: [] };
  const engine: GeoEngine = {
    async checkTarget(target, opts) {
      calls.checkTarget.push({ target, maxPages: opts.maxPages });
      return boardPass();
    },
    async readAiView() {
      return { error: 'no network in unit tests' };
    },
    detectFormat: (sample) => (sample.some((l) => /"\w+ \/.* HTTP\/1\.[01]"/.test(l)) ? 'combined' : null),
    async summarizeLogs() {
      return logSummary();
    },
    async runPrompts(siteName, prompts, opts) {
      calls.runPrompts.push({ site: siteName, prompts, opts });
      return emptyRun(siteName, NO_KEYS_SKIPPED);
    },
    bots: [
      { id: 'gptbot', name: 'GPTBot', vendor: 'OpenAI', purpose: 'training', robotsToken: 'GPTBot', main: false, docsUrl: 'https://example.com' },
      { id: 'claudebot', name: 'ClaudeBot', vendor: 'Anthropic', purpose: 'training', robotsToken: 'ClaudeBot', main: false, docsUrl: 'https://example.com' },
    ],
    ...over,
  };
  if (over.checkTarget) {
    const inner = over.checkTarget;
    engine.checkTarget = async (target, opts) => {
      calls.checkTarget.push({ target, maxPages: opts.maxPages });
      return inner(target, opts);
    };
  }
  if (over.readAiView) {
    const inner = over.readAiView;
    engine.readAiView = async (url, opts) => {
      calls.readAiView.push(url);
      return inner(url, opts);
    };
  } else {
    const inner = engine.readAiView;
    engine.readAiView = async (url, opts) => {
      calls.readAiView.push(url);
      return inner(url, opts);
    };
  }
  if (over.runPrompts) {
    const inner = over.runPrompts;
    engine.runPrompts = async (s, p, o) => {
      calls.runPrompts.push({ site: s, prompts: p, opts: o });
      return inner(s, p, o);
    };
  }
  return { engine, calls };
}

export interface Captured {
  io: CliIO;
  out: () => string;
  err: () => string;
}

export function captureIO(engine: GeoEngine, over: Partial<CliIO> = {}): Captured {
  let out = '';
  let err = '';
  const io: CliIO = {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    env: {},
    cwd: process.cwd(),
    isTTY: false,
    fetch: async () => {
      throw new Error('no network in unit tests');
    },
    engine,
    clock: (() => {
      let t = 0;
      return () => (t += 3050);
    })(),
    ...over,
  };
  return { io, out: () => out, err: () => err };
}
