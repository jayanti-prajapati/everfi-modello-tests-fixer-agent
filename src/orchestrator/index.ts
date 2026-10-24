import os from 'node:os';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runFixer } from '../agent.js';
import { absModelDir, type Config } from '../config.js';
import { Session, type Proposal, type SessionEvent } from '../session.js';
import { runShell } from '../shell.js';
import { SERVER_NAME } from '../tools/index.js';
import type { Bus } from './bus.js';
import type { AgentPlan, AgentStatus, MergeResult, StepId, StepStatus, TestCase } from './events.js';
import { mergeProposals, type AgentPatches } from './merger.js';
import { runPool } from './scheduler.js';
import { assertInside, createWorkspace, removeWorkspace } from './workspace.js';

export interface OrchestrateOptions {
  config: Config;
  /** Spec file names; empty = every spec in the checkout */
  specs: string[];
  concurrency: number;
  /** Give each agent its own copy of the course (required for parallel --write) */
  isolate: boolean;
  keepWorkspaces?: boolean;
  workspaceRoot?: string;
  /** Stop starting new agents once finished agents have spent this much (USD) */
  maxTotalUsd?: number;
  bus: Bus;
}

export interface OrchestrateResult {
  agents: AgentSummary[];
  /** Verified patches replayed onto the checkout (write + isolate only) */
  merge: MergeResult[];
}

export interface AgentSummary extends AgentPlan {
  status: AgentStatus;
  summary: string;
  costUsd?: number;
  /** Leaf changes the agent recorded or applied in its workspace */
  patches: Proposal[];
}

export const moduleOf = (spec: string) => /-(m\d+)-/.exec(spec)?.[1] ?? spec.replace(/\.js$/, '');

export function planAgents(specs: string[]): AgentPlan[] {
  const seen = new Map<string, number>();
  return specs.map((spec) => {
    const module = moduleOf(spec);
    const n = (seen.get(module) ?? 0) + 1;
    seen.set(module, n);
    return { agentId: n === 1 ? module : `${module}#${n}`, module, spec };
  });
}

/** Runs one fixer agent per spec, up to `concurrency` at a time; each agent works through its steps in order. */
export async function orchestrate(o: OrchestrateOptions): Promise<OrchestrateResult> {
  const { config, bus } = o;
  if (config.write && !o.isolate && o.concurrency > 1) {
    throw new Error('Parallel --write needs isolated workspaces: agents would rebuild and edit the same checkout.');
  }
  if (o.isolate && path.isAbsolute(config.modelDir)) {
    throw new Error('--model-dir must be relative to the project when agents run in isolated workspaces.');
  }
  const specs = o.specs.length ? o.specs : new Session(config).listSpecs();
  const agents = planAgents(specs);
  bus.publish({
    type: 'run.started',
    mode: 'live',
    model: config.model,
    project: config.projectDir,
    write: config.write,
    concurrency: o.concurrency,
    agents,
  });

  const root = o.workspaceRoot ?? path.join(os.tmpdir(), 'modello-orchestrator');
  let costUsd = 0;
  try {
    const summaries = await runPool(agents, o.concurrency, (plan) => {
      if (o.maxTotalUsd !== undefined && costUsd >= o.maxTotalUsd) {
        const summary = `Not started: total budget $${o.maxTotalUsd} reached ($${costUsd.toFixed(2)} spent).`;
        bus.publish({ type: 'agent.finished', agentId: plan.agentId, status: 'skipped', summary });
        return Promise.resolve<AgentSummary>({ ...plan, status: 'skipped', summary, patches: [] });
      }
      return runAgent(plan, o, root).then((a) => {
        costUsd += a.costUsd ?? 0;
        return a;
      });
    });
    const merge = config.write && o.isolate ? await mergeBack(o, summaries) : [];
    return { agents: summaries, merge };
  } finally {
    // Always close the run, so the UI never stays on "running" after a failure.
    bus.publish({ type: 'run.finished', costUsd });
  }
}

async function mergeBack({ config, bus }: OrchestrateOptions, summaries: AgentSummary[]): Promise<MergeResult[]> {
  // Agents verified their fixes in their own workspaces; bring only those back to the real checkout.
  const sets: AgentPatches[] = summaries
    .filter((a) => a.status === 'fixed')
    .map((a) => ({ agentId: a.agentId, patches: a.patches }));
  const results = mergeProposals(absModelDir(config), sets);
  bus.publish({ type: 'merge', results });
  if (results.some((r) => r.status === 'applied')) {
    bus.publish({ type: 'log', level: 'info', message: `Rebuilding the real checkout: ${config.buildCommand}` });
    const res = await runShell(config.buildCommand, config.projectDir);
    bus.publish({
      type: 'log',
      level: res.code === 0 ? 'info' : 'error',
      message: res.code === 0 ? 'Checkout rebuilt.' : `Checkout rebuild failed (exit ${res.code}).`,
    });
  }
  return results;
}

async function runAgent(plan: AgentPlan, o: OrchestrateOptions, root: string): Promise<AgentSummary> {
  const { bus } = o;
  const id = plan.agentId;
  let workspace: string | undefined;
  let patches: Proposal[] = [];
  const steps = new StepTracker((step, status) => bus.publish({ type: 'step', agentId: id, step, status }));
  try {
    workspace = o.isolate ? createWorkspace(o.config.projectDir, root, id) : o.config.projectDir;
    const config: Config = { ...o.config, projectDir: workspace };
    if (o.isolate) assertInside(workspace, absModelDir(config));
    bus.publish({ type: 'agent.started', agentId: id, workspace: o.isolate ? workspace : undefined });
    steps.set('run', 'running');

    // What the runs showed, independent of what the agent reports: a fix counts as verified
    // only if a successful rebuild and then a passing run came after the last patch.
    let firstRun: 'passed' | 'failed' | undefined;
    let rebuiltSincePatch = false;
    let verified = false;
    const session = new Session(config, (e: SessionEvent) => {
      if (e.kind === 'run') {
        firstRun ??= e.status === 'passed' ? 'passed' : 'failed';
        if (rebuiltSincePatch) verified = e.status === 'passed';
        bus.publish({ type: 'cases', agentId: id, run: e.run, cases: toCases(e.cases, e.status) });
        steps.onRun(e.status === 'passed');
      } else if (e.kind === 'patch') {
        rebuiltSincePatch = false;
        verified = false;
        const p = e.proposal;
        bus.publish({ type: 'proposal', agentId: id, file: p.file, path: p.path, before: p.before, value: p.value, applied: p.applied });
        steps.set('fix', 'done');
      } else {
        rebuiltSincePatch = e.exitCode === 0;
        steps.set('rebuild', e.exitCode === 0 ? 'done' : 'failed');
      }
    });
    patches = session.proposals;

    let inputTokens = 0;
    let outputTokens = 0;
    const onMessage = (msg: SDKMessage) => {
      if (msg.type !== 'assistant') return;
      const u = msg.message.usage;
      if (u) {
        inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        outputTokens += u.output_tokens ?? 0;
        bus.publish({ type: 'usage', agentId: id, inputTokens, outputTokens });
      }
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text.trim()) bus.publish({ type: 'text', agentId: id, text: block.text.trim().slice(0, 400) });
        if (block.type === 'tool_use') {
          const name = block.name.replace(`mcp__${SERVER_NAME}__`, '');
          bus.publish({ type: 'tool', agentId: id, name, detail: toolDetail(block.input) });
          steps.onTool(name);
        }
      }
    };

    const result = await runFixer(config, [plan.spec], () => {}, { session, onMessage });
    const outcome = session.outcome;
    let status: AgentStatus = !outcome
      ? 'error'
      : outcome.status === 'unfixable'
        ? 'unfixable'
        : firstRun === 'passed' && session.proposals.length === 0
          ? 'passed'
          : outcome.status;
    let summary = outcome?.summary ?? 'The agent finished without reporting an outcome.';
    if (status === 'fixed' && !verified) {
      // Never merge a fix the runs did not confirm.
      status = 'proposed';
      summary += ' [Orchestrator: not verified by a rebuild and passing run after the last change; not merged.]';
    }
    steps.finish(status !== 'error');
    bus.publish({ type: 'agent.finished', agentId: id, status, summary, costUsd: result.costUsd });
    return { ...plan, status, summary, costUsd: result.costUsd, patches };
  } catch (e) {
    const summary = e instanceof Error ? e.message : String(e);
    steps.finish(false);
    bus.publish({ type: 'agent.finished', agentId: id, status: 'error', summary });
    return { ...plan, status: 'error', summary, patches };
  } finally {
    if (o.isolate && workspace && !o.keepWorkspaces) removeWorkspace(workspace);
  }
}

function toCases(cases: { suite: string; title: string; passed: boolean; message?: string }[], runStatus: string): TestCase[] {
  if (cases.length === 0) {
    return [{ id: 'run', title: 'Spec run', status: runStatus === 'passed' ? 'pass' : 'fail', message: runStatus }];
  }
  return cases.map((c, i) => ({
    id: `T${String(i + 1).padStart(2, '0')}`,
    title: c.title || c.suite,
    status: c.passed ? 'pass' : 'fail',
    message: c.message?.split('\n')[0].slice(0, 200),
  }));
}

function toolDetail(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const i = input as Record<string, unknown>;
  const v = i.spec ?? i.pattern ?? i.file_path ?? i.path ?? i.status;
  return v === undefined ? undefined : String(Array.isArray(v) ? v.join(' › ') : v).slice(0, 120);
}

/** Maps tool calls and session events onto the fixed step pipeline, emitting only changes. */
export class StepTracker {
  private state = new Map<StepId, StepStatus>();
  private rebuilt = false;

  constructor(private readonly emit: (step: StepId, status: StepStatus) => void) {}

  set(step: StepId, status: StepStatus) {
    if (this.state.get(step) === status) return;
    this.state.set(step, status);
    this.emit(step, status);
  }

  private get(step: StepId) {
    return this.state.get(step) ?? 'waiting';
  }

  onTool(name: string) {
    if (name === 'run_cypress') {
      if (this.rebuilt) this.set('verify', 'running');
      else if (this.get('run') === 'waiting') this.set('run', 'running');
    } else if (['Read', 'Grep', 'Glob'].includes(name)) {
      if (this.get('run') === 'done' && this.get('diagnose') === 'waiting') this.set('diagnose', 'running');
    } else if (name === 'set_model_value') {
      if (this.get('diagnose') !== 'done') this.set('diagnose', 'done');
      this.set('fix', 'running');
    } else if (name === 'rebuild_spec') {
      this.rebuilt = true;
      this.set('rebuild', 'running');
    } else if (name === 'report_outcome') {
      this.set('report', 'running');
    }
  }

  onRun(passed: boolean) {
    if (this.rebuilt) {
      this.set('verify', passed ? 'done' : 'failed');
    } else if (this.get('run') === 'waiting' || this.get('run') === 'running') {
      this.set('run', 'done');
      if (!passed) this.set('diagnose', 'running');
    }
  }

  /** Marks the remaining steps: untouched ones skipped, running ones done (ok) or failed. */
  finish(ok: boolean) {
    for (const step of ['run', 'diagnose', 'fix', 'rebuild', 'verify'] as const) {
      const s = this.get(step);
      if (s === 'waiting') this.set(step, 'skipped');
      else if (s === 'running') this.set(step, ok ? 'done' : 'failed');
    }
    this.set('report', ok ? 'done' : 'failed');
  }
}
