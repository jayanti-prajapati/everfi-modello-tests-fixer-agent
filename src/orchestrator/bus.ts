import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EventBody, OrchestratorEvent } from './events.js';

type Listener = (e: OrchestratorEvent) => void;

/** One run's event stream: keeps history (for late SSE subscribers) and appends to a JSONL log for replay. */
export class Bus {
  readonly runId: string;
  readonly history: OrchestratorEvent[] = [];
  readonly logFile?: string;
  private listeners = new Set<Listener>();

  constructor(opts: { runId?: string; logDir?: string } = {}) {
    this.runId = opts.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
    if (opts.logDir) {
      fs.mkdirSync(opts.logDir, { recursive: true });
      this.logFile = path.join(opts.logDir, `${this.runId}.jsonl`);
    }
  }

  publish(body: EventBody): OrchestratorEvent {
    const e = { ...body, runId: this.runId, t: Date.now() } as OrchestratorEvent;
    this.history.push(e);
    if (this.logFile) fs.appendFileSync(this.logFile, JSON.stringify(e) + '\n');
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // A broken subscriber (closed socket) must not stop the run.
      }
    }
    return e;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export function readLog(file: string): OrchestratorEvent[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as OrchestratorEvent);
}
