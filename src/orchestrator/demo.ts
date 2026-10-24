// Demo and replay: drive the same event bus without Cypress, ECC or model spend, so the UI
// can be shown and developed offline. The scenario mirrors failure kinds seen on real courses.
import type { Bus } from './bus.js';
import { readLog } from './bus.js';
import type { AgentStatus, EventBody, TestCase } from './events.js';
import { planAgents } from './index.js';
import { runPool } from './scheduler.js';

type Kind = 'fixed' | 'passed' | 'unfixable';
interface Scenario {
  spec: string;
  kind: Kind;
  pages: string[];
  failAt: number;
  error: string;
  fix?: { path: string[]; before: string; value: string };
  summary: string;
}

const SCENARIOS: Scenario[] = [
  {
    spec: 'digital-banking-m1-s3-s3.amazonaws.com.js',
    kind: 'fixed',
    pages: ['a1/page-1 intro modal', 'a1/page-2 continue button', 'a1/page-3 flip cards', 'a2/page-1 drag & drop', 'a2/page-4 form fields', 'a3/page-2 summary'],
    failAt: 1,
    error: 'Timed out retrying after 10000ms: Expected to find element: `#btn2-stale`, but never found it.',
    fix: { path: ['&common', 'm1/a1/page-2', 'select_block_by_type("button";2)', 'selector'], before: '#btn2-stale', value: '#btn2' },
    summary: 'm1/a1/page-2 button selector was stale (#btn2-stale). Course source has a single #btn2 on that page; changed it, rebuilt, spec passes.',
  },
  {
    spec: 'digital-banking-m2-s3-s3.amazonaws.com.js',
    kind: 'passed',
    pages: ['a1/page-1 intro modal', 'a1/page-3 video', 'a2/page-2 sorting', 'a3/page-1 scenario', 'a4/page-4 form fields'],
    failAt: -1,
    error: '',
    summary: 'Spec passed on the first run; no change needed.',
  },
  {
    spec: 'digital-banking-m3-s3-s3.amazonaws.com.js',
    kind: 'fixed',
    pages: ['a1/page-1 intro modal', 'a1/page-5 tabs', 'a2/page-3 flip cards', 'a2/page-6 hotspot', 'a3/page-2 slider', 'a3/page-4 reflection'],
    failAt: 3,
    error: 'Timed out retrying after 10000ms: Expected to find element: `[data-hotspot="budget-old"]`, but never found it.',
    fix: { path: ['&common', 'm3/a2/page-6', 'select_block_by_type("hotspot";0)', 'selector'], before: '[data-hotspot="budget-old"]', value: '[data-hotspot="budget"]' },
    summary: 'm3/a2/page-6 hotspot id renamed in content.yml (budget-old -> budget); updated the selector, rebuilt, spec passes.',
  },
  {
    spec: 'digital-banking-m4-s3-s3.amazonaws.com.js',
    kind: 'unfixable',
    pages: ['a1/page-1 intro modal', 'a1/page-6 assessment q1', 'a1/page-6 assessment q2', 'a2/page-1 results', 'a2/page-3 certificate'],
    failAt: 2,
    error: 'Expected to find element: `[data-action-type="assessment-question__container"]`, but never found it.',
    summary: 'Random-answer assessment failed and navigated back to the intro page. Needs a deterministic custom-code replacement in model-map.json; a human must choose the answers.',
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DemoOptions {
  bus: Bus;
  concurrency: number;
  /** Playback speed: 1 = realistic pacing (~20s per module), 2 = twice as fast, 0 = instant (tests) */
  speed?: number;
  model?: string;
}

export async function runDemo(o: DemoOptions): Promise<void> {
  const { bus } = o;
  const speed = o.speed ?? 1;
  const agents = planAgents(SCENARIOS.map((s) => s.spec));
  bus.publish({
    type: 'run.started',
    mode: 'demo',
    model: o.model ?? 'claude-sonnet-4-5',
    project: '/courses/digital-banking (demo)',
    write: true,
    concurrency: o.concurrency,
    agents,
  });
  const costs = await runPool(agents, o.concurrency, async ({ agentId }, i) => {
    const sc = SCENARIOS[i];
    let tokensIn = 0;
    let tokensOut = 0;
    const emit = async (ms: number, body: EventBody) => {
      // Jitter so parallel agents do not move in lockstep.
      if (speed > 0) await sleep((ms / speed) * (0.7 + Math.random() * 0.6));
      bus.publish(body);
    };
    const think = async (ms: number, text?: string) => {
      tokensIn += 2500 + Math.round(Math.random() * 1500);
      tokensOut += 150 + Math.round(Math.random() * 250);
      await emit(ms, { type: 'usage', agentId, inputTokens: tokensIn, outputTokens: tokensOut });
      if (text) await emit(100, { type: 'text', agentId, text });
    };
    const tool = (ms: number, name: string, detail?: string) => emit(ms, { type: 'tool', agentId, name, detail });
    const step = (ms: number, s: Parameters<typeof stepBody>[1], st: Parameters<typeof stepBody>[2]) => emit(ms, stepBody(agentId, s, st));
    const cases = (run: number, failing: boolean): TestCase[] =>
      sc.pages.map((p, n) => ({
        id: `T${String(n + 1).padStart(2, '0')}`,
        title: `${agentId}/${p}`,
        status: n === sc.failAt && failing ? 'fail' : n > sc.failAt && sc.failAt >= 0 && failing ? 'fail' : 'pass',
        message: n === sc.failAt && failing ? sc.error : n > sc.failAt && failing ? 'Not reached: an earlier page failed.' : undefined,
      }));

    await emit(300, { type: 'agent.started', agentId, workspace: `/tmp/modello-orchestrator/${agentId}-demo` });
    await step(100, 'run', 'running');
    await think(800, `Running ${sc.spec} to see what fails.`);
    await tool(400, 'list_specs');
    await tool(600, 'run_cypress', sc.spec);
    const failing = sc.kind !== 'passed';
    await emit(4000, { type: 'cases', agentId, run: 1, cases: cases(1, failing) });
    await step(100, 'run', 'done');

    let status: AgentStatus;
    if (!failing) {
      for (const s of ['diagnose', 'fix', 'rebuild', 'verify'] as const) await step(150, s, 'skipped');
      status = 'passed';
    } else {
      await step(200, 'diagnose', 'running');
      await think(1200, `Failure on ${sc.pages[sc.failAt]}: ${sc.error.split(':').slice(-1)[0].trim()}. Looking for the current value in the course source.`);
      await tool(700, 'Grep', sc.fix ? sc.fix.before : 'assessment-question__container');
      await tool(900, 'Read', 'test/ui/model-parameters.json');
      await tool(900, 'Grep', sc.fix ? sc.fix.value : 'assessment');
      await tool(700, 'Read', sc.fix ? 'app/content/en/content.yml' : 'test/ui/model-map.json');
      await think(1500);
      await step(100, 'diagnose', 'done');
      if (sc.fix) {
        await step(100, 'fix', 'running');
        await tool(500, 'set_model_value', sc.fix.path.join(' › '));
        await emit(300, { type: 'proposal', agentId, file: 'model-parameters.json', ...sc.fix, applied: true });
        await step(100, 'fix', 'done');
        await step(200, 'rebuild', 'running');
        await tool(200, 'rebuild_spec');
        await step(3500, 'rebuild', 'done');
        await step(200, 'verify', 'running');
        await tool(200, 'run_cypress', sc.spec);
        await emit(4000, { type: 'cases', agentId, run: 2, cases: cases(2, false) });
        await step(100, 'verify', 'done');
        status = 'fixed';
      } else {
        await think(1000, 'Not a single-value config fix: the assessment picks random answers. Reporting for a human.');
        for (const s of ['fix', 'rebuild', 'verify'] as const) await step(100, s, 'skipped');
        status = 'unfixable';
      }
    }
    await step(200, 'report', 'running');
    await tool(300, 'report_outcome', status === 'passed' ? undefined : status);
    await step(200, 'report', 'done');
    const costUsd = Math.round((tokensIn * 3 + tokensOut * 15) / 1e4) / 100;
    await emit(100, { type: 'agent.finished', agentId, status, summary: sc.summary, costUsd });
    return costUsd;
  });
  bus.publish({
    type: 'merge',
    results: SCENARIOS.flatMap((s, i) =>
      s.fix && s.kind === 'fixed' ? [{ agentId: agents[i].agentId, file: 'model-parameters.json', path: s.fix.path, value: s.fix.value, status: 'applied' as const }] : [],
    ),
  });
  bus.publish({ type: 'run.finished', costUsd: Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 });
}

function stepBody(agentId: string, step: 'run' | 'diagnose' | 'fix' | 'rebuild' | 'verify' | 'report', status: 'running' | 'done' | 'skipped'): EventBody {
  return { type: 'step', agentId, step, status };
}

/** Re-emits a saved run log under a new run id, keeping relative timing (gaps capped at 3s) divided by speed. */
export async function replay(file: string, bus: Bus, speed = 1): Promise<void> {
  const events = readLog(file);
  let last = events[0]?.t ?? 0;
  for (const e of events) {
    const { runId: _r, t, ...body } = e;
    if (speed > 0) await sleep(Math.min(t - last, 3000) / speed);
    last = t;
    bus.publish(body.type === 'run.started' ? { ...body, mode: 'replay' } : (body as EventBody));
  }
}
