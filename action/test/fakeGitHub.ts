// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string };
  html_url: string;
}

/** A tiny GitHub REST stand-in: issue comments (paginated, 2 per page) and PR files. */
export class FakeGitHub {
  comments: FakeComment[] = [];
  files: { filename: string; status: string }[] = [];
  requests: { method: string; path: string; auth?: string }[] = [];
  /** Status to answer on comment writes (403 = no permission). */
  writeStatus = 0;
  url = '';
  private server?: Server;
  private nextId = 100;

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server?.close(() => r()));
  }

  addComment(body: string, login = 'someone'): FakeComment {
    const c = { id: this.nextId++, body, user: { login }, html_url: `https://github.test/c/${this.nextId}` };
    this.comments.push(c);
    return c;
  }

  get writes(): { method: string; path: string }[] {
    return this.requests.filter((r) => r.method === 'POST' || r.method === 'PATCH');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', this.url);
    this.requests.push({ method: req.method ?? '', path: u.pathname, auth: req.headers.authorization });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    let m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(u.pathname);
    if (m && req.method === 'GET') {
      const page = Number(u.searchParams.get('page') ?? '1');
      const per = 2;
      const slice = this.comments.slice((page - 1) * per, page * per);
      const more = page * per < this.comments.length;
      const next = new URL(u);
      next.searchParams.set('page', String(page + 1));
      return json(200, slice, more ? { link: `<${next.toString()}>; rel="next"` } : {});
    }
    if (m && req.method === 'POST') {
      if (this.writeStatus) return json(this.writeStatus, { message: 'Resource not accessible by integration' });
      const c = this.addComment((JSON.parse(raw) as { body: string }).body, 'github-actions[bot]');
      return json(201, c);
    }
    m = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(u.pathname);
    if (m && req.method === 'PATCH') {
      if (this.writeStatus) return json(this.writeStatus, { message: 'Resource not accessible by integration' });
      const c = this.comments.find((x) => x.id === Number(m![1]));
      if (!c) return json(404, { message: 'Not Found' });
      c.body = (JSON.parse(raw) as { body: string }).body;
      return json(200, c);
    }
    m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files$/.exec(u.pathname);
    if (m && req.method === 'GET') return json(200, this.files);
    return json(404, { message: 'Not Found' });
  }
}
