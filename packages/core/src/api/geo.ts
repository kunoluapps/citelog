// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
/**
 * API request/response types for the geo area (AI search). Owned by the geo workstream. Paths are relative to /api.
 * Every number the UI shows comes with its Evidence (source + range or asOf). Site-scoped routes live under
 * /geo/sites/:siteId/... ; the log drain is POST /ingest/logs/:token (no session; the token is the credential).
 */
import type { Evidence, IsoDate, IsoDateTime } from '../evidence.js';
import type { JudgeProvider, Perception, PerceptionMode, PerceptionStatus, PromptStage, StageSource } from '../measures.js';

/** Same ids as @morningdesk/geo ENGINE_IDS (core can't import geo). */
export type GeoEngineId = 'openai' | 'anthropic' | 'perplexity' | 'gemini';
export type GeoScoreBand = 'ready' | 'needs_work' | 'not_ready' | 'no_score';
export type GeoCheckResult = 'pass' | 'warn' | 'fail' | 'info' | 'skip';
export type GeoLogHost = 'cloudflare' | 'vercel' | 'nginx' | 'upload';
export type GeoTab = 'pages' | 'prompts' | 'crawlers' | 'referrals' | 'bing';

/* ---------- Pages (readiness) ---------- */

export interface ReadinessRunInfo {
  id: string;
  status: 'running' | 'ok' | 'failed';
  scope: 'site' | 'page';
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  /** Readiness check failed as a whole (sitemap unreachable...). Plain copy. */
  error: string | null;
  /** While running, once the page list is known; null otherwise. */
  progress: ReadinessProgress | null;
}

/** "23 of 41 pages checked · about 1 min left". */
export interface ReadinessProgress {
  /** Pages this run checks (after the plan's page cap). */
  total: number;
  done: number;
  /** Path of the page that finished last; null before the first one. */
  currentPage: string | null;
  /** Seconds left at the pace so far; null until a page has finished. */
  etaSeconds: number | null;
}

export interface PageRow {
  path: string;
  url: string;
  score: number | null;
  band: GeoScoreBand;
  failCount: number;
  warnCount: number;
  topFix: string | null;
  error: string | null;
  checkedAt: IsoDateTime;
  /** Search Console clicks, 28 days; null when Google isn't connected or the page had none recorded. */
  clicks28d: Evidence | null;
}

/** GET /geo/sites/:siteId/pages */
export interface PagesResponse {
  /** 'first_check' while the very first check runs (no results yet). */
  state: 'never_checked' | 'first_check' | 'ready';
  domain: string;
  run: ReadinessRunInfo | null;
  /** Latest finished site-wide run. */
  lastCheckedAt: IsoDateTime | null;
  site: {
    score: Evidence | null;
    band: GeoScoreBand;
    pageCount: number;
    failing: number;
    warnings: number;
    ready: number;
    truncated: { limit: number; total: number } | null;
    blockedBots: string[];
  };
  /** The fix that covers the most pages (lead). `why` is the readiness check's "why it matters" line; `checkId` that check. */
  topFix: { text: string; checkId: string | null; why: string | null; pageCount: Evidence; clicks28d: Evidence | null } | null;
  /** 'clicks' when Search Console clicks are available, else 'score' (lowest first). */
  sortedBy: 'clicks' | 'score';
  pages: PageRow[];
}

export interface PageCheck {
  id: string;
  name: string;
  result: GeoCheckResult;
  detail: string;
  why: string;
  fix: string | null;
  weight: number;
}

/** A page's most important open readiness check (highest-weight fail, else warn). */
export interface PageCheckRef {
  id: string;
  name: string;
  result: 'fail' | 'warn';
  detail: string;
  fix: string | null;
}

/** GET /geo/sites/:siteId/pages/detail?path=/learn/roth-ira (drawer). */
export interface PageDetailResponse {
  path: string;
  url: string;
  checkedAt: IsoDateTime;
  score: Evidence | null;
  band: GeoScoreBand;
  counts: { pass: number; warn: number; fail: number };
  checks: PageCheck[];
  clicks28d: Evidence | null;
  citedPrompts: { count: number; engines: GeoEngineId[] };
  /** Latest prompt version: answers whose engine considered this page, and how many cited it ("Considered in N answers, cited in M"); null before measures or when not collected. */
  considered: { answers: number; cited: number; version: number } | null;
  error: string | null;
}

/** POST /geo/sites/:siteId/pages/check  body: { path?: string } (omit for the whole site). 202. */
export interface CheckPagesRequest {
  path?: string;
}
export interface CheckPagesResponse {
  run: ReadinessRunInfo;
}

/* ---------- Prompts ---------- */

export type PromptSource = 'gsc' | 'user' | 'bing' | 'mcp';
export type PromptCellStatus = 'cited' | 'lost' | 'not_cited' | 'not_checked' | 'no_key' | 'not_run';

export interface PromptCell {
  engine: GeoEngineId;
  status: PromptCellStatus;
  citedUrl: string | null;
  /** Domains cited instead. */
  instead: string[];
  /** For not_checked: last earlier checked result. */
  previous: { date: IsoDate; cited: boolean } | null;
  checkedAt: IsoDateTime | null;
  error: { kind: string; message: string } | null;
  /** Start of the engine's answer this run (at most 600 characters, keys removed); null when not checked or not stored. */
  answerExcerpt: string | null;
  /** Named in the answer; null when not checked. */
  mentioned: boolean | null;
  mentionSnippet: string | null;
  perceptionStatus: PerceptionStatus;
  perception: { value: Perception; reason: string } | null;
  /** On-site pages considered (Gemini: host only, url null); null = not collected for this answer. */
  considered: { url: string | null; host: string; cited: boolean }[] | null;
  /** Previous version's cell, for "v6: named, not linked" on a not-checked cell. */
  previousVersion: { version: number; mentioned: boolean | null; cited: boolean | null } | null;
}

export interface PromptRow {
  id: string;
  text: string;
  source: PromptSource;
  impressions: Evidence | null;
  topic: string | null;
  stage: PromptStage;
  stageSource: StageSource;
  cells: PromptCell[];
  /** Engines citing the site per run, oldest first, up to 4 runs; null until two runs exist ("after two runs"). */
  trend: number[] | null;
  createdAt: IsoDateTime;
}

export interface PromptRunInfo {
  id: string;
  /** 'user' runs are labelled "Manual run" (label), scheduled ones "Weekly prompt run". */
  trigger: 'schedule' | 'user';
  label: string;
  status: 'running' | 'ok' | 'failed' | 'refused';
  reason: string | null;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  engines: GeoEngineId[];
  promptCount: number;
  cost: Evidence;
  /** v1, v2... per site (every run is a version). */
  version: number;
  steer: string | null;
  /** Plan estimate in USD; null for runs before versions existed. */
  estimate: Evidence | null;
  /** stoppedAtLimit: the perception check stopped before the monthly spend limit; some answers weren't judged. */
  judge: { model: string; judged: number; cost: Evidence; stoppedAtLimit: boolean } | null;
  /** Live progress while running: per engine answers done of total, spent so far. */
  progress: { engine: GeoEngineId; done: number; total: number; costUsd: number }[] | null;
}

export interface EngineKeyState {
  engine: GeoEngineId;
  label: string;
  /** 'off' = the Anthropic writer key exists but isn't opted in for prompts. */
  state: 'ready' | 'no_key' | 'off' | 'invalid' | 'out_of_credit' | 'rate_limited';
  last4: string | null;
}

/** "Answers citing you 14 / 36 · 3 engines": cited answers out of answers checked in one run. */
export interface PromptTotals {
  cited: Evidence;
  asked: number;
  engines: number;
  /** Named answers (Evidence unit 'answers'); null for runs before measures. */
  mentioned: Evidence | null;
  /** Perception counts over judged answers; null when nothing was judged. */
  perception: Record<Perception, number> | null;
}

/** GET /geo/sites/:siteId/prompts */
export interface PromptsResponse {
  state: 'no_prompts' | 'waiting_for_key' | 'waiting_for_first_run' | 'first_run' | 'results';
  domain: string;
  engines: EngineKeyState[];
  limit: { max: number; enforced: boolean; used: number };
  lastRun: PromptRunInfo | null;
  nextRunAt: IsoDateTime | null;
  /** Engines that failed in the last run (banner). */
  engineErrors: { engine: GeoEngineId; kind: string; message: string; at: IsoDateTime }[];
  totals: { thisRun: PromptTotals | null; lastRun: PromptTotals | null };
  /** Lost citations this run (lead candidates). */
  lost: {
    promptId: string;
    prompt: string;
    engine: GeoEngineId;
    weeksCited: number;
    instead: string[];
    /** The site page the engine cited in the previous checked run. */
    previouslyCited: { url: string; path: string } | null;
    /** That page's most important open readiness check, from its latest check; null when it passes or was never checked. */
    failingCheck: PageCheckRef | null;
    /** This run's answer excerpt (for "Read {engine}'s answer"). */
    answerExcerpt: string | null;
  }[];
  prompts: PromptRow[];
  spend: { limitReached: boolean };
  /** Brand terms used for Named, and the perception setting with the key it would use ('no_key' when none). */
  measures: { brandTerms: string[]; perceptionMode: PerceptionMode; judge: { provider: JudgeProvider; model: string } | 'no_key' };
  topics: string[];
  /** The plan for the next weekly run ("Next run" card); null when nothing can run. */
  nextRunPlan: PromptPlanResponse | null;
}

/** GET /geo/sites/:siteId/prompts/plan?engines=  — nothing is sent to any engine. */
export interface PromptPlanResponse {
  version: number;
  prompts: number;
  byTopic: { topic: string | null; prompts: number; stages: Record<PromptStage, number> }[];
  engines: { engine: GeoEngineId; answers: number; estimateUsd: number | null }[];
  judge: { provider: JudgeProvider; model: string; estimateUsd: number } | { state: 'no_key' } | { state: 'off' };
  totalUsd: number;
  /** 'history' = median cost per answer over the last MEASURES.estimateRuns runs; 'list_prices' = first run, rough. */
  basis: 'history' | 'list_prices';
  spend: { limitUsd: number; spentUsd: number; leftUsd: number; overBudget: boolean };
}

/** GET /geo/sites/:siteId/prompts/stages — the By stage view, numbers equal to the result rows. */
export interface PromptStagesResponse {
  version: number | null;
  stages: { stage: PromptStage; prompts: number; answers: number; /** Null when no answer was measured for Named. */ mentioned: number | null; cited: number; perception: Record<Perception, number> | null }[];
}

/** GET /geo/sites/:siteId/prompts/heatmap?measure=cited|mentioned|positive */
export interface PromptHeatmapResponse {
  version: number | null;
  measure: 'cited' | 'mentioned' | 'positive';
  engines: GeoEngineId[];
  topics: {
    topic: string | null;
    /** Share of checked answers 0..1 per engine and over all engines; null = none checked. */
    cells: (number | null)[];
    all: number | null;
    notChecked: number;
    prompts: { promptId: string; text: string; cells: (number | null)[]; all: number | null }[];
  }[];
}

/** GET /geo/sites/:siteId/prompts/sources — considered, not cited, for the latest version. */
export interface PromptSourcesResponse {
  version: number | null;
  pages: {
    /** Null for Gemini rows ("a bywell.org page"). */
    path: string | null;
    host: string;
    considered: number;
    cited: number;
    prompts: { promptId: string; text: string }[];
    engines: GeoEngineId[];
    citedInstead: string[];
    readiness: { score: number | null; band: string; failingCheck: PageCheckRef | null } | null;
  }[];
  /** Null when no engine collected considered sources in this version. */
  offsiteConsidered: number | null;
  /** Engines whose answers this version didn't report considered sources ("not collected"). */
  notCollected: GeoEngineId[];
}

/** GET /geo/sites/:siteId/prompts/versions and ?compare=a,b */
export interface PromptVersionsResponse {
  versions: { version: number; runId: string; trigger: 'schedule' | 'user'; at: IsoDateTime; steer: string | null; /** The perception check ran in this version. */ perception: boolean; prompts: number; answers: number; /** Null when no answer in the version was measured for Named (before measures). */ mentioned: number | null; cited: number; /** Engines this version asked (a one-engine retry is its own version). */ engines: GeoEngineId[]; cost: Evidence; promptsAdded: number; promptsRemoved: number }[];
  compare: {
    a: number;
    b: number;
    /** Totals over prompts present in both versions. */
    common: number;
    /** Over prompts and engines in both versions; null when either version wasn't measured for Named. */
    mentionedDelta: number | null;
    citedDelta: number;
    onlyIn: { version: number; prompts: string[] }[];
    changes: { prompt: string; engine: GeoEngineId; what: 'now_cited' | 'no_longer_cited' | 'now_named' | 'no_longer_named' | 'turned_negative' | 'turned_positive'; url: string | null }[];
  } | null;
}

/** PATCH /geo/sites/:siteId/prompts/:promptId/tag */
export interface TagPromptRequest {
  stage?: PromptStage;
  topic?: string | null;
}

/** PATCH /geo/sites/:siteId/prompts/measures */
export interface UpdateMeasuresRequest {
  brandTerms?: string[];
  perceptionMode?: PerceptionMode;
}

/** POST /geo/sites/:siteId/prompts */
export interface AddPromptRequest {
  text: string;
  /** Set when added from a suggestion. */
  suggested?: { source: 'gsc' | 'bing'; impressions?: number };
}
export interface AddPromptResponse {
  prompt: { id: string; text: string; source: PromptSource; createdAt: IsoDateTime };
  /** Soft suggestion on self-host: true when the list is over RULES.promptsPerSite. */
  overSuggestedLimit: boolean;
}

/** PATCH /geo/sites/:siteId/prompts/:promptId */
export interface UpdatePromptRequest {
  text: string;
}

/** GET /geo/sites/:siteId/prompts/suggestions */
export interface PromptSuggestionsResponse {
  /** 'no_gsc' when Search Console data isn't available. */
  state: 'ok' | 'no_gsc';
  range: { start: IsoDate; end: IsoDate } | null;
  suggestions: { text: string; impressions: Evidence; added: boolean }[];
}

/** POST /geo/sites/:siteId/prompts/run  body: { engines?: GeoEngineId[] } */
export interface RunPromptsRequest {
  engines?: GeoEngineId[];
  /** Version note and perception focus (≤ MEASURES.steerMaxChars). Never sent to engines. */
  steer?: string;
  /** The plan's total the person saw, for the run's estimate and the event. */
  estimateUsd?: number;
  /** This run only: the plan's "Check perception" box. Absent = the site setting. */
  perception?: boolean;
}
export interface RunPromptsResponse {
  run: PromptRunInfo;
}

/* ---------- Crawlers ---------- */

export interface CrawlerBotRow {
  botId: string;
  name: string;
  vendor: string;
  purpose: 'training' | 'search' | 'user';
  verified: number;
  unverified: number;
  /** Vendor publishes no IP list ("can't verify"). */
  unknown: number;
  pages: number;
}

/** GET /geo/sites/:siteId/crawlers */
export interface CrawlersResponse {
  state: 'not_connected' | 'waiting' | 'data';
  /**
   * The drain itself. not_created: no drain URL yet; reading this page never makes one, only POST …/crawlers/source
   * ("Create drain URL") does. waiting_for_first_batch: the URL exists, no real log batch yet (test lines don't count),
   * so the logs connection is not connected. receiving: a real batch arrived and the logs connection is connected.
   * The full drain URL is never in this response (only `source.drainUrlMasked`); it is shown once, by the create call.
   */
  drainState: 'not_created' | 'waiting_for_first_batch' | 'receiving';
  range: { start: IsoDate; end: IsoDate };
  source: {
    host: GeoLogHost;
    createdAt: IsoDateTime;
    firstBatchAt: IsoDateTime | null;
    lastBatchAt: IsoDateTime | null;
    /** Last "Send a test" line received (test lines never count as the host's first batch). */
    testReceivedAt: IsoDateTime | null;
    firstBotAt: IsoDateTime | null;
    lastFormat: string | null;
    tokenLast4: string;
    /** The drain URL with only the token's last four visible; the full URL is shown once, on create/rotate. */
    drainUrlMasked: string;
  } | null;
  /** Host detected from the site's response headers, for the not-connected state. */
  detectedHost: GeoLogHost | null;
  sampled: null;
  totals: { verified: Evidence; unverified: Evidence } | null;
  daily: { date: IsoDate; vendor: string; verified: number }[];
  bots: CrawlerBotRow[];
  pages: { path: string; verified: number; lastRead: IsoDateTime }[];
  /** Sitemap pages (from the last readiness check) with no verified AI-bot read in the range. */
  neverVisited: string[];
  lastTest: LogTestEvent | null;
  ipRangesAsOf: IsoDate;
}

export interface LogTestEvent {
  time: IsoDateTime;
  path: string;
  userAgent: string;
  status: number | null;
  receivedAt: IsoDateTime;
}

/**
 * POST /geo/sites/:siteId/crawlers/source  body: { host }. The explicit "Create drain URL" (and "Rotate") click: creates or
 * rotates the drain token; the URL is shown once. It does not connect the logs; the first real batch does.
 */
export interface CreateLogSourceRequest {
  host: GeoLogHost;
}
export interface CreateLogSourceResponse {
  host: GeoLogHost;
  /** Full drain URL with the token. Shown once; only the last four are kept afterwards. */
  drainUrl: string;
  tokenLast4: string;
}

/** POST /geo/sites/:siteId/crawlers/test: sends a test line through the drain pipeline. */
export interface SendLogTestResponse {
  test: LogTestEvent;
}

/** POST /ingest/logs/:token (drain) and POST /geo/sites/:siteId/crawlers/upload (file): result of one batch. */
export interface IngestResponse {
  format: string | null;
  linesRead: number;
  linesSkipped: number;
  botHits: number;
  /** Repeated lines skipped (already stored). */
  duplicates: number;
  testEvents: number;
}

/* ---------- Referrals ---------- */

export type AiApp = 'chatgpt' | 'perplexity' | 'copilot' | 'gemini' | 'claude';

/** GET /geo/sites/:siteId/referrals */
export interface ReferralsResponse {
  state: 'no_ga4' | 'not_synced' | 'none' | 'data';
  serviceAccountEmail: string | null;
  /** The site's GA4 property; name is its GA4 display name when the Google check found it. */
  property: { id: string; name: string | null } | null;
  range: { start: IsoDate; end: IsoDate } | null;
  syncedAt: IsoDateTime | null;
  error: string | null;
  allSessions: Evidence | null;
  /** AI-app sessions in range; `previous` is the 28 days before when synced. */
  total: Evidence | null;
  /** Percent change of total vs the previous 28 days (one decimal), or null without a previous period. */
  changePct: number | null;
  byApp: { app: AiApp; label: string; sources: string[]; sessions: Evidence }[];
  landingPages: {
    path: string;
    byApp: Partial<Record<AiApp, number>>;
    total: number;
    readiness: { score: number | null; band: GeoScoreBand } | null;
  }[];
}

/* ---------- Bing import ---------- */

/** One row of the "Expected column | In your file" table. */
export interface BingColumnCheck {
  expected: string;
  /** The file's header that matched, or null (Missing). */
  found: string | null;
  /** When missing: a header in the file that sits in its place, e.g. "Keyword" for Page or "Clicks" for Citations. */
  fileHas: string | null;
}

/** POST /geo/sites/:siteId/bing  (raw CSV body; file name in x-file-name). 422 body when unreadable. */
export interface BingImportError {
  error: { code: 'bing_unreadable'; message: string };
  fileName: string;
  /** e.g. "Search Performance" when the file looks like another Bing export. */
  looksLike: string | null;
  expected: BingColumnCheck[];
  imported: 0;
}

/** GET /geo/sites/:siteId/bing and POST success. */
export interface BingResponse {
  /** Copy shown on every view: covers Copilot and Bing AI, not ChatGPT. */
  coverage: string;
  lastImport: {
    id: string;
    fileName: string;
    kind: 'daily' | 'page' | 'query' | 'page_query';
    rows: number;
    importedAt: IsoDateTime;
    range: { start: IsoDate; end: IsoDate } | null;
  } | null;
  totals: { citations: Evidence; pagesCited: Evidence } | null;
  /** Pages in the sitemap (from the last readiness check), for "24 OF 41 IN SITEMAP"; null before any check. */
  sitemapPages: number | null;
  byPage: { page: string; citations: number; queries: number }[];
  topQueries: { query: string; citations: number; tracked: boolean }[];
  daily: { date: IsoDate; citations: number }[];
}
