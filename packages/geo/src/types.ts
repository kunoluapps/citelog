// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu

/**
 * Citelog engine contract (packages/geo). One engine for the CLI, the Action, the desk's AI search page,
 * the writer's Checks tab and the publish live check (concept map row "Readiness checks").
 * Written by the tech lead; workstreams implement it and don't change these shapes without the tech lead.
 */
import type { JudgeProvider, Perception, PerceptionMode, PerceptionStatus, PromptStage, TokenUsage, UsdMicros } from '@morningdesk/core';

/* ---------- fetching ---------- */

/** Injectable fetch so tests use recorded fixtures and nothing reaches the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CrawlOptions {
  /** Pages to read from a sitemap or folder (default RULES.geoDefaultMaxPages = 50). */
  maxPages: number;
  fetch: FetchLike;
  /** Requests in flight to one host (default 2). */
  concurrency?: number;
  /** Minimum gap between requests to one host, ms (default 250). Polite by default. */
  delayMs?: number;
  /** Sent on every request. Default "Citelog/<version> (+https://getmorningdesk.com/citelog)". */
  userAgent?: string;
  /** Per-request timeout, ms (default 10000). */
  timeoutMs?: number;
  /**
   * Called once the page list is known (done 0) and after each page is checked. Optional; a throwing callback
   * never stops the crawl.
   */
  onProgress?: (progress: CrawlProgress) => void;
}

/** Crawl progress: `total` pages to check (after maxPages), `done` so far, and the page that just finished. */
export interface CrawlProgress {
  total: number;
  done: number;
  /** URL (or folder path) of the page that just finished; null on the first call. */
  current: string | null;
}

/* ---------- readiness ---------- */

export const CHECK_IDS = [
  'indexable',
  'robots_ai',
  'canonical',
  'title_meta',
  'direct_answer',
  'question_headings',
  'updated_date',
  'json_ld',
  'no_js_content',
  'llms_txt',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** 'info' is shown but never scored (llms.txt). 'skip' = not applicable to this page. */
export type CheckResult = 'pass' | 'warn' | 'fail' | 'info' | 'skip';

export interface CheckOutcome {
  id: CheckId;
  /** Short name, e.g. "Content present without JavaScript". */
  label: string;
  result: CheckResult;
  /** Weight in the score (0 for informational checks). Weights live in readiness/weights.ts. */
  weight: number;
  /** One line: what we found (e.g. "robots.txt blocks GPTBot and ClaudeBot"). */
  detail: string;
  /** Why it matters, one line. */
  why: string;
  /** The fix, one line; present when result is warn or fail. */
  fix?: string;
}

export { scoreBand, SCORE_BAND_LABEL, meanScore, type ScoreBand } from '@morningdesk/core';
import type { ScoreBand } from '@morningdesk/core';

/** What a single page check needs. Pure input: no network inside checkPage. */
export interface PageInput {
  url: string;
  /** HTTP status of the final response; null when unreachable. */
  status: number | null;
  headers: Record<string, string>;
  html: string;
  /** robots.txt body for the page's origin, or null when there is none (404). */
  robotsTxt: string | null;
  /** Whether /llms.txt exists on the origin (informational). */
  llmsTxt: boolean | null;
}

export interface PageReport {
  url: string;
  status: number | null;
  /** 0-100, rounded; null when the page could not be checked. */
  score: number | null;
  band: ScoreBand;
  checks: CheckOutcome[];
  /** The fix from the highest-weight failed check. */
  topFix?: string;
  /** Set when the page could not be loaded ("timeout after 10 s", "HTTP 503"). */
  error?: string;
}

export interface SiteReport {
  /** What the user asked to check (URL, sitemap URL or folder). */
  target: string;
  kind: 'url' | 'sitemap' | 'folder';
  pages: PageReport[];
  /** Mean of page scores (pages with a score only), rounded; null when none scored. */
  score: number | null;
  band: ScoreBand;
  /** Set when the sitemap or folder had more pages than maxPages. */
  truncated?: { limit: number; total: number };
  /** Sitemap entries on another host, left out (we only check the site asked for). */
  skippedOffSite?: number;
  /** AI crawlers blocked by robots.txt for the site root (bot ids). */
  blockedBots: string[];
  checkedAt: string;
}

/* ---------- bots and robots ---------- */

export type BotPurpose = 'training' | 'search' | 'user';

export interface AiBot {
  id: string; // e.g. 'gptbot'
  name: string; // e.g. 'GPTBot'
  vendor: string; // e.g. 'OpenAI'
  purpose: BotPurpose;
  /** Case-insensitive substring found in the User-Agent header. Absent for robots-only tokens (Google-Extended). */
  uaSubstring?: string;
  /** Token used in robots.txt User-agent lines. */
  robotsToken: string;
  /** True for crawlers the readiness check requires to be allowed (search and user fetchers). */
  main: boolean;
  /** Official JSON IP list URL, if the vendor publishes one. */
  ipRangesUrl?: string;
  docsUrl: string;
}

/* ---------- logs ---------- */

export type LogFormat = 'combined' | 'cloudflare' | 'vercel';

export interface LogHit {
  time: string; // ISO
  ip: string;
  method?: string;
  path: string;
  status: number | null;
  userAgent: string;
  host?: string;
}

export interface BotVisitRow {
  botId: string;
  path: string;
  hits: number;
  /** true = IP inside the vendor's published ranges; false = outside; null = vendor publishes no list. */
  verified: boolean | null;
  lastSeen: string;
}

export interface LogSummary {
  format: LogFormat;
  linesRead: number;
  linesSkipped: number;
  /** Requests read; more than lines when a line holds a JSON array of requests (Vercel). */
  requests?: number;
  /** Per bot totals, sorted by hits desc. */
  bots: { botId: string; hits: number; verifiedHits: number; unverifiedHits: number; unknownHits: number; pages: number }[];
  rows: BotVisitRow[];
  from: string | null;
  to: string | null;
  /** Date of the bundled IP range snapshot used for verification. */
  ipRangesAsOf: string;
}

/* ---------- prompts ---------- */

export const ENGINE_IDS = ['openai', 'anthropic', 'perplexity', 'gemini'] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export interface EngineInfo {
  id: EngineId;
  /** Consumer-facing name used in output: ChatGPT, Claude, Perplexity, Gemini. */
  label: string;
  /** Environment variable(s) that enable the engine, as shown to people: "OPENAI_API_KEY", "GOOGLE_API_KEY or GEMINI_API_KEY". */
  envVar: string;
  /** Default model id used for prompt checks. */
  model: string;
}

export interface Citation {
  url: string;
  title?: string;
}

export interface EngineAnswer {
  engine: EngineId;
  model: string;
  text: string;
  citations: Citation[];
  /**
   * Sources the engine considered (retrieved) for this answer, as the API reports them; null = not collected (the engine's
   * response can't tell retrieved from cited, or the field wasn't there). Never [] for "not collected".
   */
  sources: Citation[] | null;
  /** Gemini gives a redirect URI per source, so its sources carry the site (host) only (D16). */
  sourcesBy?: 'page' | 'host';
  usage?: TokenUsage;
  /** Web searches the engine ran for this answer; undefined when the response doesn't say. */
  searches?: number;
  /** Estimated cost including search fees, micro-USD; undefined when the model has no listed price. */
  costUsdMicros?: UsdMicros;
}

export type EngineErrorKind = 'invalid_key' | 'rate_limited' | 'out_of_credit' | 'provider_error' | 'timeout' | 'bad_response';

export class EngineError extends Error {
  constructor(
    readonly engine: EngineId,
    readonly kind: EngineErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface PromptResult {
  prompt: string;
  engine: EngineId;
  /** 'skipped' = no key; 'not_checked' = the engine failed this run. */
  status: 'checked' | 'not_checked' | 'skipped';
  /** Cited = the answer linked a URL on the site's domain (design default 2: linked only). */
  cited: boolean | null;
  citedUrl?: string;
  /** Domains cited instead (or as well), in answer order, deduplicated. */
  others: string[];
  error?: { kind: EngineErrorKind; message: string };
  checkedAt: string;
  costUsdMicros?: UsdMicros;
  /** Plain note shown with the result, e.g. "Answered without searching the web". */
  note?: string;
  /** Start of the engine's answer (at most PROMPT_ANSWER_EXCERPT_MAX characters, keys scrubbed); set when checked. */
  answerExcerpt?: string;
  /** A brand term appears as a whole word in the answer (links and link chips stripped first); null when not checked. */
  mentioned: boolean | null;
  /** Up to MEASURES.mentionSnippetMaxChars around the first match. */
  mentionSnippet?: string;
  /**
   * On-site sources the engine considered, each marked cited or not; null = not collected for this answer. Considered
   * always includes the cited on-site URL (considered = sources ∪ citations).
   */
  considered: ConsideredSource[] | null;
  /** Off-site sources considered (counted, not listed); null = not collected. */
  consideredOffsite: number | null;
  perceptionStatus: PerceptionStatus;
  /** Set when perceptionStatus is 'judged'. */
  perception?: { value: Perception; reason: string };
}

export interface ConsideredSource {
  /** Absent when the engine gives the site only (Gemini). */
  url?: string;
  host: string;
  cited: boolean;
}

/** A prompt with its optional topic and stage (config files and the desk). A bare string = no topic, auto stage. */
export type PromptInput = string | { text: string; topic?: string | null; stage?: PromptStage | null };

/** The perception judge's call for a run: which key and model, what it cost. */
export interface JudgeRun {
  provider: JudgeProvider;
  model: string;
  judged: number;
  failed: number;
  /** Undefined when a judge call's model has no listed price (the model is then in PromptRun.unpricedModels). */
  costUsdMicros?: UsdMicros;
  /** True when the judge stopped because the next call would have gone past `perception.budgetUsdMicros`. */
  stoppedAtLimit: boolean;
}

/** Longest answer excerpt kept with a prompt result. */
export const PROMPT_ANSWER_EXCERPT_MAX = 600;

export interface PromptRun {
  site: string; // domain, e.g. bywell.org
  results: PromptResult[];
  /** Engines skipped for lack of a key, with the env var that enables each. */
  skipped: { engine: EngineId; envVar: string }[];
  /** Sum of the answers that have a price. */
  costUsdMicros: UsdMicros;
  /** Models that answered but have no listed price, so their cost is unknown (not $0). */
  unpricedModels?: string[];
  /** The perception judge; null when it didn't run (off, no key, or nothing about the site). */
  judge: JudgeRun | null;
}

export interface RunPromptsOptions {
  /** Environment to read keys from (process.env in the CLI). Keys are never logged or returned. */
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  /** Limit to these engines. Default: every engine whose key is set. */
  engines?: EngineId[];
  /** Per-engine model override. */
  models?: Partial<Record<EngineId, string>>;
  timeoutMs?: number;
  now?: () => Date;
  /** Words that count as Mentioned (default: the domain). Whole words, case-insensitive. */
  brandTerms?: string[];
  /** Perception judge: 'off' by default in geo (CLI --perception and the desk's Auto turn it on). */
  perception?: {
    mode: PerceptionMode;
    steer?: string;
    /**
     * Spend left before the run (monthly limit minus spent), micro-USD. The judge phase subtracts this run's engine
     * cost, then stops before any call whose estimate would go past what is left. Absent = no limit.
     */
    budgetUsdMicros?: number;
  };
  /** Called as each answer is scored (the desk's Running state). Errors thrown here are ignored. */
  onResult?: (result: PromptResult) => void;
}
