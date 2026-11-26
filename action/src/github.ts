// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { GEO_TOOL, GEO_TOOL_USER_AGENT } from '@morningdesk/core';
import type { FetchLike } from '@morningdesk/geo';

/** GitHub REST calls the Action makes: issue comments (every PR is an issue) and the PR's changed files. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface IssueComment {
  id: number;
  body?: string;
  html_url?: string;
  user?: { login?: string } | null;
}

export interface PrFile {
  filename: string;
  status: string;
}

export class GitHub {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly repo: string,
    private readonly fetch: FetchLike,
  ) {}

  private async request<T>(method: string, url: string, body?: unknown): Promise<{ data: T; next: string | null }> {
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': GEO_TOOL_USER_AGENT,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = ((await res.json()) as { message?: string }).message ?? msg;
      } catch {
        // no JSON body
      }
      throw new GitHubError(res.status, `GitHub ${method} ${new URL(url).pathname} returned HTTP ${res.status}: ${msg}`);
    }
    const link = res.headers.get('link') ?? '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
    const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    return { data, next };
  }

  private async paginate<T>(first: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = first;
    for (let i = 0; url && i < 50; i++) {
      const page: { data: T[]; next: string | null } = await this.request<T[]>('GET', url);
      out.push(...page.data);
      url = page.next;
    }
    return out;
  }

  private base(path: string): string {
    return `${this.apiUrl.replace(/\/+$/, '')}/repos/${this.repo}${path}`;
  }

  listComments(issue: number): Promise<IssueComment[]> {
    return this.paginate<IssueComment>(this.base(`/issues/${issue}/comments?per_page=100`));
  }

  async createComment(issue: number, body: string): Promise<IssueComment> {
    return (await this.request<IssueComment>('POST', this.base(`/issues/${issue}/comments`), { body })).data;
  }

  async updateComment(id: number, body: string): Promise<IssueComment> {
    return (await this.request<IssueComment>('PATCH', this.base(`/issues/comments/${id}`), { body })).data;
  }

  listPrFiles(pr: number): Promise<PrFile[]> {
    return this.paginate<PrFile>(this.base(`/pulls/${pr}/files?per_page=100`));
  }

  /** The login the token acts as (a personal or app token); null for the workflow's GITHUB_TOKEN, which can't read /user. */
  async login(): Promise<string | null> {
    try {
      const { data } = await this.request<{ login?: unknown }>('GET', `${this.apiUrl.replace(/\/+$/, '')}/user`);
      return typeof data?.login === 'string' ? data.login : null;
    } catch {
      return null;
    }
  }
}

/** Who writes the comment with the workflow's GITHUB_TOKEN. */
export const ACTIONS_BOT = 'github-actions[bot]';

/**
 * The sticky comment: the first one carrying the marker **written by us** (the Actions bot, or the token's own login).
 * Anyone can paste the marker into a comment; a comment by someone else is never edited and its state never read.
 */
export function findStickyComment(comments: readonly IssueComment[], authors: readonly string[] = [ACTIONS_BOT], marker = GEO_TOOL.commentMarker): IssueComment | undefined {
  return comments.find((c) => c.body?.includes(marker) && typeof c.user?.login === 'string' && authors.includes(c.user.login));
}

/** One comment per PR: edit the marked comment if there is one, otherwise post it (AC 8). */
export async function upsertStickyComment(gh: GitHub, issue: number, body: string, existing?: IssueComment): Promise<{ comment: IssueComment; created: boolean }> {
  if (existing) return { comment: await gh.updateComment(existing.id, body), created: false };
  return { comment: await gh.createComment(issue, body), created: true };
}
