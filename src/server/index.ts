import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Bus } from '../orchestrator/bus.js';
import type { OrchestratorEvent } from '../orchestrator/events.js';

export type RunMode = 'demo' | 'live';

export interface ServerOptions {
  port: number;
  /** Built UI (ui/dist) */
  staticDir: string;
  logDir: string;
  info: Record<string, unknown>;
  /** Live runs are only offered when preflight passed */
  liveAvailable: boolean;
  start: (mode: RunMode, bus: Bus) => Promise<unknown>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

/**
 * Small HTTP server for the orchestration UI: one run at a time, its events streamed over
 * SSE (history first, so a page opened mid-run catches up), plus the built UI as static files.
 */
export interface OrchestratorServer {
  server: http.Server;
  /** Streams a run started outside the server (e.g. by the fix-course pipeline); UI run buttons are refused until done() */
  attach(bus: Bus): { done(): void };
}

export function startServer(o: ServerOptions): OrchestratorServer {
  let current: Bus | undefined;
  let busy = false;
  const clients = new Set<http.ServerResponse>();
  const send = (res: http.ServerResponse, e: OrchestratorEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Local tool only: refuse other hosts (DNS rebinding) and cross-site pages (a bodiless
    // POST is a CORS "simple request", so any open tab could otherwise start a live run).
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const origin = req.headers.origin;
    if (!LOCAL_HOSTS.has(host) || (origin && !LOCAL_HOSTS.has(safeHostname(origin)))) {
      return json(res, 403, { error: 'Only local requests are allowed.' });
    }

    if (url.pathname === '/api/info' && req.method === 'GET') {
      return json(res, 200, { ...o.info, liveAvailable: o.liveAvailable, busy, runId: current?.runId });
    }

    if (url.pathname === '/api/runs' && req.method === 'POST') {
      const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
      if (busy) return json(res, 409, { error: 'A run is already in progress.' });
      if (mode === 'live' && !o.liveAvailable) return json(res, 400, { error: 'Live runs are unavailable (preflight failed or no --project).' });
      const bus = new Bus({ logDir: o.logDir });
      current = bus;
      busy = true;
      bus.subscribe((e) => clients.forEach((c) => send(c, e)));
      o.start(mode, bus)
        .catch((e) => bus.publish({ type: 'log', level: 'error', message: e instanceof Error ? e.message : String(e) }))
        .finally(() => {
          busy = false;
        });
      return json(res, 202, { runId: bus.runId, mode });
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      current?.history.forEach((e) => send(res, e));
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    // Static UI; unknown paths fall back to index.html.
    const root = path.resolve(o.staticDir);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return json(res, 400, { error: 'bad path' });
    }
    let file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(root, 'index.html');
    }
    if (!fs.existsSync(file)) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('UI not built. Run `npm run ui:build`, or use `npm run ui:dev` for the dev server.');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  server.listen(o.port, '127.0.0.1');
  return {
    server,
    attach(bus) {
      current = bus;
      busy = true;
      bus.history.forEach((e) => clients.forEach((c) => send(c, e)));
      bus.subscribe((e) => clients.forEach((c) => send(c, e)));
      return {
        done: () => {
          busy = false;
        },
      };
    },
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function safeHostname(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}
