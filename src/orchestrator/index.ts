import os from 'node:os';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runFixer } from '../agent.js';
import { absModelDir, type Config } from '../config.js';
import { Session, type Proposal, type SessionEvent } from '../session.js';
import { runShell } from '../shell.js';
import { SERVER_NAME } from '../tools/index.js';
import type { Bus } from './bus.js';
import { buildCaseFile } from '../casefile.js';
import { locate } from '../locate.js';
import { loadLedger, proposeFix, recordFix, type RecipeFix } from '../recipes.js';
import { environmentProblem } from '../triage.js';
import type { AgentPlan, AgentStatus, FixMethod, MergeResult, StepId, StepStatus, TestCase } from './events.js';
import { mergeProposals, revertPatches, type AgentPatches } from './merger.js';
import { runPool } from './scheduler.js';
import { assertInside, createWorkspace, removeWorkspace } from './workspace.js';

export interface OrchestrateOptions {
  config: Config;
  /** Spec file names; empty = every spec in the checkout */
  specs: string[];
  /** Specs tested at the same time (real course) or agents at the same time (isolate) */
  concurrency: number;
  /**
   * false (default for the CLIs): work in the real course folder. All specs are tested in
   * parallel first, then failing modules are fixed by one agent at a time, so writes and
   * rebuilds never overlap. true: each agent gets a private copy and fixes are merged back.
   */
  isolate: boolean;
  /** Called after the test phase (real course mode) with the modules that failed */
  onTested?: (failed: AgentPlan[]) => void;
  keepWorkspaces?: boolean;
  workspaceRoot?: string;
  /** Stop starting new agents once finished agents have spent this much (USD) */
  maxTotalUsd?: number;
  /** Real course mode: retry each failure once before any fixing (default true) */
  flakyCheck?: boolean;
  /** Real course mode, write: try deterministic recipes before agents (default true) */
  recipes?: boolean;
  /** JSON file of verified fixes, reused before recipes and agents */
  ledgerFile?: string;
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
  /** How the module was handled (rule, recipe or AI agent) */
  method?: FixMethod;
  /** Agent turns (model round trips) */
  turns?: number;
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
    if (!o.isolate) {
      const summaries = await testThenFix(agents, o, () => costUsd, (c) => (costUsd += c));
      return { agents: summaries, merge: [] };
    }
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

type RunResult = Awaited<ReturnType<Session['runSpec']>>;

interface Pending {
  plan: AgentPlan;
  result: RunResult | undefined;
  /** What rules and recipes found out; goes into the agent's case file */
  notes: string[];
}

/**
 * Real course mode, cheapest step first:
 *  1. test   - run every spec in the checkout, `concurrency` at a time (plain Cypress, no AI)
 *  2. triage - environment failures go to a human with the evidence line (no AI)
 *  3. flaky  - re-run each remaining failure once; passing now = flaky, no change (no AI)
 *  4. recipe - ledger / translation markup / stale selector with exactly one candidate; all
 *              recipe changes applied, ONE rebuild, affected specs re-run; failures reverted (no AI)
 *  5. agents - one at a time, each with a case file; a spec is re-run first if anything changed
 *              since its last run (an earlier fix may have fixed it too)
 */
async function testThenFix(
  agents: AgentPlan[],
  o: OrchestrateOptions,
  spent: () => number,
  addCost: (c: number) => void,
): Promise<AgentSummary[]> {
  const { bus, config } = o;
  const course = path.basename(config.projectDir);
  const byId = new Map<string, AgentSummary>();
  const finish = (plan: AgentPlan, status: AgentStatus, summary: string, extra: Partial<AgentSummary> = {}) => {
    const a: AgentSummary = { ...plan, status, summary, costUsd: 0, patches: [], ...extra };
    bus.publish({ type: 'agent.finished', agentId: plan.agentId, status, summary, costUsd: a.costUsd, method: a.method, turns: a.turns });
    byId.set(plan.agentId, a);
    return a;
  };
  const step = (id: string, s: StepId, status: StepStatus) => bus.publish({ type: 'step', agentId: id, step: s, status });
  const skipRest = (id: string, from: StepId[]) => from.forEach((s) => step(id, s, 'skipped'));
  const runOnce = async (plan: AgentPlan, run: number): Promise<RunResult | undefined> => {
    const session = new Session({ ...config, maxAttempts: 1 }, (e) => {
      if (e.kind === 'run') bus.publish({ type: 'cases', agentId: plan.agentId, run, cases: toCases(e.cases, e.status) });
    });
    try {
      return await session.runSpec(plan.spec);
    } catch (e) {
      bus.publish({ type: 'log', level: 'error', message: `${plan.agentId}: could not run ${plan.spec}: ${e instanceof Error ? e.message : e}` });
      return undefined;
    }
  };

  // 1. Test every spec.
  const tested = await runPool(agents, o.concurrency, async (plan) => {
    bus.publish({ type: 'agent.started', agentId: plan.agentId });
    step(plan.agentId, 'run', 'running');
    const result = await runOnce(plan, 1);
    const passed = result?.status === 'passed';
    step(plan.agentId, 'run', passed ? 'done' : 'failed');
    if (passed) {
      skipRest(plan.agentId, ['diagnose', 'fix', 'rebuild', 'verify']);
      step(plan.agentId, 'report', 'done');
      finish(plan, 'passed', 'Spec passed; no agent needed.', { method: 'rule' });
    }
    return { plan, result, notes: [] as string[], passed };
  });
  let pending: Pending[] = tested.filter((t) => !t.passed);

  // 2. Environment triage.
  pending = pending.filter((p) => {
    const reason = p.result ? environmentProblem(p.result) : 'the spec could not be run';
    if (!reason) return true;
    skipRest(p.plan.agentId, ['diagnose', 'fix', 'rebuild', 'verify']);
    step(p.plan.agentId, 'report', 'done');
    finish(p.plan, 'unfixable', `Needs human (environment): ${reason}. Not a model-config problem; no agent started.`, { method: 'rule' });
    return false;
  });

  // 3. Flaky check: one plain retry.
  if (o.flakyCheck !== false && pending.length) {
    const retried = await runPool(pending, o.concurrency, async (p) => ({ p, retry: await runOnce(p.plan, 1) }));
    pending = [];
    for (const { p, retry } of retried) {
      if (retry?.status === 'passed') {
        skipRest(p.plan.agentId, ['diagnose', 'fix', 'rebuild', 'verify']);
        step(p.plan.agentId, 'report', 'done');
        finish(p.plan, 'flaky', 'Failed once, passed on a plain retry (flaky). No change made; worth a look if it repeats.', { method: 'rule' });
      } else {
        pending.push({ ...p, result: retry ?? p.result });
      }
    }
  }
  o.onTested?.(pending.map((p) => p.plan));

  // 4. Recipes: write mode only (a recipe must be verified by a rebuild and a passing run).
  let changedSince = false;
  if (config.write && o.recipes !== false && pending.length) {
    const ledger = loadLedger(o.ledgerFile);
    const applied: { p: Pending; fix: RecipeFix; proposal?: Proposal }[] = [];
    const keys = new Map<string, unknown>();
    const session = new Session(config);
    for (const p of pending) {
      if (!p.result) continue;
      const loc = locate(config, p.plan.spec, p.result);
      const prop = proposeFix(config, loc, { course, ledger });
      if (!prop.fix) {
        p.notes.push(`No recipe: ${prop.note}`);
        continue;
      }
      const key = `${prop.fix.patch.file}${JSON.stringify(prop.fix.patch.path)}`;
      if (keys.has(key) && keys.get(key) !== prop.fix.patch.value) {
        p.notes.push(`Recipe skipped: another module needs a different value for ${JSON.stringify(prop.fix.patch.path)}.`);
        continue;
      }
      step(p.plan.agentId, 'diagnose', 'done');
      let proposal: Proposal | undefined;
      if (!keys.has(key)) {
        session.setValue(prop.fix.patch);
        proposal = session.proposals.at(-1);
        keys.set(key, prop.fix.patch.value);
        bus.publish({ type: 'proposal', agentId: p.plan.agentId, file: prop.fix.patch.file, path: prop.fix.patch.path, before: prop.fix.before, value: prop.fix.patch.value, applied: true });
      }
      step(p.plan.agentId, 'fix', 'done');
      applied.push({ p, fix: prop.fix, proposal });
    }
    if (applied.length) {
      bus.publish({ type: 'log', level: 'info', message: `Applied ${applied.length} recipe fix(es) without AI; rebuilding once.` });
      applied.forEach((a) => step(a.p.plan.agentId, 'rebuild', 'running'));
      const built = await runShell(config.buildCommand, config.projectDir);
      applied.forEach((a) => step(a.p.plan.agentId, 'rebuild', built.code === 0 ? 'done' : 'failed'));
      const verified = await runPool(applied, o.concurrency, async (a) => {
        step(a.p.plan.agentId, 'verify', 'running');
        const r = built.code === 0 ? await runOnce(a.p.plan, 2) : undefined;
        return { a, r, ok: r?.status === 'passed' };
      });
      const failed = verified.filter((v) => !v.ok);
      // Keys shared with a failed module are reverted too: a value only stays if every module using it passed.
      const badKeys = new Set(failed.map((v) => `${v.a.fix.patch.file}${JSON.stringify(v.a.fix.patch.path)}`));
      const proposals = applied.flatMap((a) => (a.proposal ? [a.proposal] : []));
      const toRevert = proposals.filter((pr) => badKeys.has(`${pr.file}${JSON.stringify(pr.path)}`));
      if (toRevert.length) {
        revertPatches(absModelDir(config), toRevert);
        await runShell(config.buildCommand, config.projectDir);
      }
      pending = pending.filter((p) => !verified.some((v) => v.a.p === p));
      for (const { a, r, ok } of verified) {
        const key = `${a.fix.patch.file}${JSON.stringify(a.fix.patch.path)}`;
        const id = a.p.plan.agentId;
        if (ok && !badKeys.has(key)) {
          step(id, 'verify', 'done');
          step(id, 'report', 'done');
          recordFix(o.ledgerFile, course, a.fix.before, String(a.fix.patch.value), a.fix.recipe);
          finish(a.p.plan, 'fixed', `Fixed without AI (${a.fix.recipe}): ${a.fix.before} -> ${a.fix.patch.value}. ${a.fix.evidence}`, {
            method: 'recipe',
            patches: a.proposal ? [a.proposal] : [],
          });
          changedSince = true;
        } else {
          step(id, 'verify', 'failed');
          a.p.notes.push(`Tried ${a.fix.recipe} recipe ${a.fix.before} -> ${a.fix.patch.value} (${a.fix.evidence}); after rebuild the spec still failed${r?.failures?.[0] ? `: ${r.failures[0].message.slice(0, 200)}` : ''}. Reverted.`);
          pending.push({ ...a.p, result: r && r.status !== 'passed' ? r : a.p.result });
        }
      }
    }
  }

  // 5. Agents, one at a time.
  for (const p of pending) {
    let result = p.result;
    if (changedSince) {
      // An earlier fix may have fixed this module too: a plain re-run is far cheaper than an agent.
      result = await runOnce(p.plan, 1);
      if (result?.status === 'passed') {
        skipRest(p.plan.agentId, ['diagnose', 'fix', 'rebuild', 'verify']);
        step(p.plan.agentId, 'report', 'done');
        finish(p.plan, 'passed', 'Passes after an earlier fix in this run; no agent needed.', { method: 'rule' });
        continue;
      }
    }
    if (o.maxTotalUsd !== undefined && spent() >= o.maxTotalUsd) {
      finish(p.plan, 'skipped', `Not started: total budget $${o.maxTotalUsd} reached ($${spent().toFixed(2)} spent).${p.notes.length ? ` ${p.notes.join(' ')}` : ''}`);
      continue;
    }
    const loc = result ? locate(config, p.plan.spec, result) : { blocks: [], entries: [] };
    const caseFile = result ? buildCaseFile(config, p.plan.spec, result, loc, p.notes) : undefined;
    const a = await runAgent(p.plan, o, '', result, caseFile);
    addCost(a.costUsd ?? 0);
    if (config.write && a.status !== 'fixed') await revertUnverified(a, o);
    if (a.status === 'fixed') {
      changedSince = true;
      // Remember what fixed this selector, so the same failure is fixed without AI next time.
      const p0 = a.patches.find((x) => x.applied && typeof x.value === 'string');
      if (loc.selector && p0 && loc.entries.some((e) => JSON.stringify(e.path) === JSON.stringify(p0.path))) {
        recordFix(o.ledgerFile, course, loc.selector, String(p0.value), 'agent');
      }
    }
    byId.set(p.plan.agentId, a);
  }
  return agents.map((plan) => byId.get(plan.agentId)!);
}

/** Real course mode: an agent's applied change that did not end verified must not stay in the checkout. */
async function revertUnverified(a: AgentSummary, { config, bus }: OrchestrateOptions): Promise<void> {
  const applied = a.patches.filter((p) => p.applied);
  if (applied.length === 0) return;
  const reverted = revertPatches(absModelDir(config), applied);
  if (reverted.length === 0) return;
  bus.publish({ type: 'log', level: 'warn', message: `${a.agentId}: reverted ${reverted.length} unverified change(s); rebuilding specs.` });
  const res = await runShell(config.buildCommand, config.projectDir);
  if (res.code !== 0) bus.publish({ type: 'log', level: 'error', message: `Rebuild after revert failed (exit ${res.code}).` });
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

/** `firstResult`/`caseFile`: real course mode passes what it already knows, so the agent does not re-run or re-explore. */
async function runAgent(plan: AgentPlan, o: OrchestrateOptions, root: string, firstResult?: RunResult, caseFile?: string): Promise<AgentSummary> {
  const { bus } = o;
  const id = plan.agentId;
  let workspace: string | undefined;
  let patches: Proposal[] = [];
  const steps = new StepTracker((step, status) => bus.publish({ type: 'step', agentId: id, step, status }));
  try {
    workspace = o.isolate ? createWorkspace(o.config.projectDir, root, id) : o.config.projectDir;
    const config: Config = { ...o.config, projectDir: workspace };
    if (o.isolate) assertInside(workspace, absModelDir(config));
    if (firstResult) {
      // Started in the test phase already: carry on from its result.
      steps.set('run', 'done');
      steps.set('diagnose', 'running');
    } else {
      bus.publish({ type: 'agent.started', agentId: id, workspace: o.isolate ? workspace : undefined });
      steps.set('run', 'running');
    }

    // What the runs showed, independent of what the agent reports: a fix counts as verified
    // only if a successful rebuild and then a passing run came after the last patch.
    let firstRun: 'passed' | 'failed' | undefined = firstResult ? (firstResult.status === 'passed' ? 'passed' : 'failed') : undefined;
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
    if (firstResult) session.seed(plan.spec, firstResult);

    // The SDK emits one assistant message per content block, all carrying the same API message's
    // usage (and early ones partial): keep the latest usage per message id and sum those.
    const usageById = new Map<string, { input: number; output: number }>();
    const onMessage = (msg: SDKMessage) => {
      if (msg.type !== 'assistant') return;
      const u = msg.message.usage;
      if (u) {
        usageById.set(msg.message.id ?? String(usageById.size), {
          input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          output: u.output_tokens ?? 0,
        });
        let inputTokens = 0;
        let outputTokens = 0;
        for (const v of usageById.values()) {
          inputTokens += v.input;
          outputTokens += v.output;
        }
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

    const result = await runFixer(config, [plan.spec], () => {}, { session, onMessage, caseFile });
    const turns = usageById.size;
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
      summary += ' [Orchestrator: not verified by a rebuild and passing run after the last change; not kept.]';
    }
    steps.finish(status !== 'error');
    bus.publish({ type: 'agent.finished', agentId: id, status, summary, costUsd: result.costUsd, method: 'agent', turns });
    return { ...plan, status, summary, costUsd: result.costUsd, patches, method: 'agent', turns };
  } catch (e) {
    const summary = e instanceof Error ? e.message : String(e);
    steps.finish(false);
    bus.publish({ type: 'agent.finished', agentId: id, status: 'error', summary, method: 'agent' });
    return { ...plan, status: 'error', summary, patches, method: 'agent' };
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
