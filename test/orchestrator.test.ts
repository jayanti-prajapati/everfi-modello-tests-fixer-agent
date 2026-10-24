import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixerHooks } from '../src/agent.js';
import { DEFAULTS, type Config } from '../src/config.js';
import { parseJUnitCases } from '../src/failures.js';
import type { Patch } from '../src/guard.js';
import { Bus } from '../src/orchestrator/bus.js';
import { runDemo } from '../src/orchestrator/demo.js';
import type { OrchestratorEvent } from '../src/orchestrator/events.js';
import { orchestrate, planAgents, StepTracker } from '../src/orchestrator/index.js';
import { mergeProposals } from '../src/orchestrator/merger.js';
import { initialState, progress, reduce } from '../src/orchestrator/reducer.js';
import { runPool } from '../src/orchestrator/scheduler.js';
import { assertInside, createWorkspace, removeWorkspace } from '../src/orchestrator/workspace.js';
import { startServer } from '../src/server/index.js';
import { childEnv } from '../src/shell.js';

// The only thing faked is the Claude call: each "agent" drives its real Session the way the model would.
const fakePatches: Record<string, Omit<Patch, 'file'> & { file?: Patch['file'] }> = {};
/** Specs whose fake agent claims "fixed" without rebuilding or rerunning */
const claimsOnly = new Set<string>();
vi.mock('../src/agent.js', () => ({
  runFixer: async (config: Config, specs: string[], _log: unknown, hooks: FixerHooks) => {
    const s = hooks.session!;
    const spec = specs[0];
    const tool = (name: string, input: object) =>
      hooks.onMessage?.({
        type: 'assistant',
        message: { usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'tool_use', name: `mcp__fixer__${name}`, input }] },
      } as never);
    tool('run_cypress', { spec });
    await s.runSpec(spec);
    const p = fakePatches[spec];
    if (p) {
      tool('set_model_value', p);
      s.setValue({ file: 'model-parameters.json', ...p });
    }
    if (p && config.write && !claimsOnly.has(spec)) {
      tool('rebuild_spec', {});
      await s.rebuild();
      tool('run_cypress', { spec });
      await s.runSpec(spec);
    }
    tool('report_outcome', {});
    s.outcome = { status: config.write ? 'fixed' : 'proposed', summary: `done ${spec}` };
    return { session: s, costUsd: 0.01 };
  },
}));

const PASSING = `node -e "require('fs').writeFileSync(process.argv[1], '<testsuites><testsuite name=\\\\'s\\\\'><testcase name=\\\\'page 1\\\\'/></testsuite></testsuites>')" {report}`;
const PARAMS = { '&common': { p1: { b: { selector: '#old1' } }, p2: { b: { selector: '#old2' } } } };

let dir: string;
let wsRoot: string;
const paramsFile = () => path.join(dir, 'test/ui/model-parameters.json');
const cfg = (over: Partial<Config> = {}): Config => ({
  ...DEFAULTS,
  projectDir: dir,
  write: true,
  local: false,
  runCommand: PASSING,
  buildCommand: 'true',
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ws-'));
  fs.mkdirSync(path.join(dir, 'test/ui/cypress/e2e'), { recursive: true });
  for (const m of ['m1', 'm2']) fs.writeFileSync(path.join(dir, `test/ui/cypress/e2e/c-${m}-s3.js`), '// spec');
  fs.writeFileSync(paramsFile(), JSON.stringify(PARAMS, null, 4) + '\n');
  for (const k of Object.keys(fakePatches)) delete fakePatches[k];
  claimsOnly.clear();
});

const run = async (over: Partial<Config> = {}, concurrency = 2) => {
  const bus = new Bus();
  const { agents: summaries } = await orchestrate({ config: cfg(over), specs: [], concurrency, isolate: true, workspaceRoot: wsRoot, bus });
  return { bus, summaries, state: bus.history.reduce(reduce, initialState) };
};

describe('orchestrate', () => {
  it('fixes in isolated workspaces and merges verified patches into the checkout', async () => {
    fakePatches['c-m1-s3.js'] = { path: ['&common', 'p1', 'b', 'selector'], value: '#new1' };
    fakePatches['c-m2-s3.js'] = { path: ['&common', 'p2', 'b', 'selector'], value: '#new2' };
    const { summaries, state, bus } = await run();

    expect(summaries.map((s) => s.status)).toEqual(['fixed', 'fixed']);
    const doc = JSON.parse(fs.readFileSync(paramsFile(), 'utf8'));
    expect(doc['&common'].p1.b.selector).toBe('#new1');
    expect(doc['&common'].p2.b.selector).toBe('#new2');
    expect(fs.readdirSync(wsRoot)).toEqual([]); // workspaces cleaned up
    expect(state.merge.map((m) => m.status)).toEqual(['applied', 'applied']);
    expect(state.status).toBe('done');
    expect(state.agents.m1.steps).toMatchObject({ run: 'done', fix: 'done', rebuild: 'done', verify: 'done', report: 'done' });
    expect(state.agents.m1.inputTokens).toBeGreaterThan(0);
    expect(bus.history.at(-1)?.type).toBe('run.finished');
  });

  it('marks the second agent touching the same key as a conflict', async () => {
    fakePatches['c-m1-s3.js'] = { path: ['&common', 'p1', 'b', 'selector'], value: '#a' };
    fakePatches['c-m2-s3.js'] = { path: ['&common', 'p1', 'b', 'selector'], value: '#b' };
    const { state } = await run();
    expect(state.merge.map((m) => m.status)).toEqual(['applied', 'conflict']);
    expect(JSON.parse(fs.readFileSync(paramsFile(), 'utf8'))['&common'].p1.b.selector).toBe('#a');
  });

  it('dry-run never touches the checkout and reports passed specs as passed', async () => {
    fakePatches['c-m1-s3.js'] = { path: ['&common', 'p1', 'b', 'selector'], value: '#new1' };
    const before = fs.readFileSync(paramsFile(), 'utf8');
    const { summaries, bus } = await run({ write: false });
    expect(fs.readFileSync(paramsFile(), 'utf8')).toBe(before);
    // m1 recorded a proposal; m2 was green with no change.
    expect(summaries.map((s) => s.status)).toEqual(['proposed', 'passed']);
    expect(bus.history.some((e) => e.type === 'merge')).toBe(false);
  });

  it('does not merge a fix the agent claims but never verified', async () => {
    fakePatches['c-m1-s3.js'] = { path: ['&common', 'p1', 'b', 'selector'], value: '#new1' };
    claimsOnly.add('c-m1-s3.js');
    const { summaries, state } = await run();
    expect(summaries[0].status).toBe('proposed');
    expect(summaries[0].summary).toMatch(/not verified/);
    expect(state.merge).toEqual([]);
    expect(fs.readFileSync(paramsFile(), 'utf8')).toContain('#old1');
  });

  it('refuses an absolute model dir when isolating', async () => {
    const bus = new Bus();
    await expect(
      orchestrate({ config: cfg({ modelDir: path.join(dir, 'test/ui') }), specs: [], concurrency: 2, isolate: true, workspaceRoot: wsRoot, bus }),
    ).rejects.toThrow(/relative/);
  });

  it('refuses parallel writes in a shared checkout', async () => {
    await expect(orchestrate({ config: cfg(), specs: [], concurrency: 2, isolate: false, bus: new Bus() })).rejects.toThrow(/isolated/);
  });
});

describe('runPool', () => {
  it('never exceeds the concurrency limit and keeps result order', async () => {
    let active = 0;
    let peak = 0;
    const out = await runPool([5, 1, 3, 2, 4], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n * 3));
      active--;
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(out).toEqual([50, 10, 30, 20, 40]);
  });
});

describe('workspace', () => {
  it('skips .git and Cypress media, symlinks node_modules, and removal leaves the source intact', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'test/ui/cypress/screenshots'), { recursive: true });
    const ws = createWorkspace(dir, wsRoot, 'm1');
    expect(fs.existsSync(path.join(ws, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'test/ui/cypress/screenshots'))).toBe(false);
    expect(fs.lstatSync(path.join(ws, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'test/ui/model-parameters.json'), 'utf8')).toBe(fs.readFileSync(paramsFile(), 'utf8'));
    removeWorkspace(ws);
    expect(fs.existsSync(ws)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'node_modules/pkg'))).toBe(true);
  });
});

describe('assertInside', () => {
  it('rejects a model file that links back to the real checkout', () => {
    const ws = createWorkspace(dir, wsRoot, 'm1');
    const md = path.join(ws, 'test/ui');
    expect(() => assertInside(ws, md)).not.toThrow();
    fs.rmSync(path.join(md, 'model-parameters.json'));
    fs.symlinkSync(paramsFile(), path.join(md, 'model-parameters.json'));
    expect(() => assertInside(ws, md)).toThrow(/links outside/);
  });
});

describe('mergeProposals', () => {
  const modelDir = () => path.join(dir, 'test/ui');
  const prop = (value: string, before = '#old1') => ({ file: 'model-parameters.json' as const, path: ['&common', 'p1', 'b', 'selector'], value, before, applied: true });

  it('reports unchanged when the checkout already holds the value', () => {
    expect(mergeProposals(modelDir(), [{ agentId: 'm1', patches: [prop('#old1', '#x')] }])[0].status).toBe('unchanged');
  });

  it('merges the last value when one agent set the same key twice', () => {
    const r = mergeProposals(modelDir(), [{ agentId: 'm1', patches: [prop('#a'), prop('#b', '#a')] }]);
    expect(r.map((x) => [x.status, x.value])).toEqual([['applied', '#b']]);
    expect(JSON.parse(fs.readFileSync(paramsFile(), 'utf8'))['&common'].p1.b.selector).toBe('#b');
  });

  it("writes none of an agent's patches when one of them conflicts", () => {
    const p2 = { file: 'model-parameters.json' as const, path: ['&common', 'p2', 'b', 'selector'], value: '#n2', before: '#old2', applied: true };
    const r = mergeProposals(modelDir(), [
      { agentId: 'm1', patches: [prop('#x')] },
      { agentId: 'm2', patches: [p2, prop('#y')] },
    ]);
    expect(r.map((x) => `${x.agentId}:${x.status}`)).toEqual(['m1:applied', 'm2:conflict', 'm2:conflict']);
    expect(fs.readFileSync(paramsFile(), 'utf8')).toContain('#old2');
  });

  it('refuses when the checkout changed since the agent started', () => {
    const r = mergeProposals(modelDir(), [{ agentId: 'm1', patches: [prop('#new', '#something-else')] }]);
    expect(r[0].status).toBe('conflict');
    expect(fs.readFileSync(paramsFile(), 'utf8')).toContain('#old1');
  });
});

describe('reducer', () => {
  const ev = (body: object, runId = 'r1') => ({ runId, t: 1, ...body }) as OrchestratorEvent;
  const started = ev({ type: 'run.started', mode: 'demo', model: 'm', project: '/p', write: true, concurrency: 2, agents: planAgents(['x-m1-y.js']) });

  it('turns a case that failed and later passes into fixed, and leftovers into blockers', () => {
    let s = reduce(initialState, started);
    s = reduce(s, ev({ type: 'cases', agentId: 'm1', run: 1, cases: [{ id: 'T01', title: 'a', status: 'fail' }, { id: 'T02', title: 'b', status: 'fail' }] }));
    s = reduce(s, ev({ type: 'cases', agentId: 'm1', run: 2, cases: [{ id: 'T01', title: 'a', status: 'pass' }, { id: 'T02', title: 'b', status: 'fail' }] }));
    expect(s.agents.m1.cases.map((c) => c.status)).toEqual(['fixed', 'fail']);
    s = reduce(s, ev({ type: 'agent.finished', agentId: 'm1', status: 'unfixable', summary: 'x' }));
    expect(s.agents.m1.cases.map((c) => [c.status, c.method])).toEqual([['fixed', 'agent'], ['blocker', 'human']]);
    expect(progress(s.agents.m1)).toBe(1);
  });

  it('ignores events from another run', () => {
    const s = reduce(reduce(initialState, started), ev({ type: 'agent.started', agentId: 'm1' }, 'old'));
    expect(s.agents.m1.status).toBe('queued');
  });
});

describe('StepTracker', () => {
  it('walks run -> diagnose -> fix -> rebuild -> verify and skips the rest on finish', () => {
    const seen: string[] = [];
    const t = new StepTracker((step, status) => seen.push(`${step}:${status}`));
    t.set('run', 'running');
    t.onRun(false);
    t.onTool('run_cypress'); // a rerun before any rebuild must not move back to "run"
    t.onRun(false);
    t.onTool('set_model_value');
    t.set('fix', 'done');
    t.onTool('rebuild_spec');
    t.set('rebuild', 'done');
    t.onTool('run_cypress');
    t.onRun(true);
    t.finish(true);
    expect(seen).toEqual([
      'run:running', 'run:done', 'diagnose:running', 'diagnose:done', 'fix:running', 'fix:done',
      'rebuild:running', 'rebuild:done', 'verify:running', 'verify:done', 'report:done',
    ]);
  });
});

describe('demo', () => {
  it('runs every scripted agent to a final status', async () => {
    const bus = new Bus();
    await runDemo({ bus, concurrency: 3, speed: 0 });
    const s = bus.history.reduce(reduce, initialState);
    expect(s.status).toBe('done');
    expect(s.order.map((id) => s.agents[id].status)).toEqual(['fixed', 'passed', 'fixed', 'unfixable']);
  });
});

describe('childEnv', () => {
  it('drops ELECTRON_RUN_AS_NODE so Cypress starts Electron as Electron', () => {
    expect(childEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });
});

describe('server', () => {
  it('rejects cross-site and malformed requests without crashing', async () => {
    const port = 43000 + Math.floor(Math.random() * 1000);
    let started = 0;
    const { server } = startServer({ port, staticDir: dir, logDir: path.join(dir, 'runs'), info: {}, liveAvailable: true, start: async () => { started++; } });
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${port}`;
    try {
      expect((await fetch(`${base}/api/runs?mode=live`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
      expect((await fetch(`${base}/%E0`)).status).toBe(400);
      expect((await fetch(`${base}/api/info`)).status).toBe(200);
      expect((await fetch(`${base}/api/runs?mode=demo`, { method: 'POST' })).status).toBe(202);
      expect(started).toBe(1);
    } finally {
      server.close();
    }
  });
});

describe('parseJUnitCases', () => {
  it('returns passed and failed cases', () => {
    const xml = `<testsuites><testsuite name="s"><testcase name="a"/><testcase name="b"><failure message="boom">x</failure></testcase></testsuite></testsuites>`;
    expect(parseJUnitCases(xml)).toEqual([
      { suite: 's', title: 'a', passed: true, message: undefined },
      { suite: 's', title: 'b', passed: false, message: 'boom' },
    ]);
  });
});
