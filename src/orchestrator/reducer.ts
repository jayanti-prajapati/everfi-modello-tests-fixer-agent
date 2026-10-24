// Folds the event stream into view state. Pure and import-free (types only), so the UI and
// the terminal printer derive the same state from a live run or a replayed log.
import {
  PIPELINE_STAGES,
  STEPS,
  type AgentPlan,
  type AgentStatus,
  type MergeResult,
  type OrchestratorEvent,
  type PipelineStage,
  type StepId,
  type StepStatus,
  type TestCase,
} from './events.js';

export interface ToolCall {
  name: string;
  detail?: string;
  t: number;
}

export interface AgentState extends AgentPlan {
  status: AgentStatus;
  steps: Record<StepId, StepStatus>;
  cases: TestCase[];
  tools: ToolCall[];
  toolCount: number;
  lastText?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  summary?: string;
  workspace?: string;
  startedAt?: number;
  finishedAt?: number;
  proposals: { file: string; path: string[]; before: unknown; value: unknown; applied: boolean }[];
}

export interface PipelineState {
  base: string;
  status: 'running' | 'ok' | 'failed';
  stages: Record<PipelineStage, { status: StepStatus; detail?: string }>;
  branch?: string;
  commit?: string;
  pushed?: boolean;
  report?: string;
  prUrl?: string;
}

export interface RunState {
  runId?: string;
  mode?: 'live' | 'demo' | 'replay';
  model?: string;
  project?: string;
  write?: boolean;
  concurrency?: number;
  status: 'idle' | 'running' | 'done';
  startedAt?: number;
  finishedAt?: number;
  order: string[];
  agents: Record<string, AgentState>;
  merge: MergeResult[];
  costUsd?: number;
  log: { level: string; message: string; t: number }[];
  /** Present when the run is driven by the local fix pipeline (fix-course) */
  pipeline?: PipelineState;
}

export const initialState: RunState = { status: 'idle', order: [], agents: {}, merge: [], log: [] };

const RECENT_TOOLS = 6;
const freshSteps = () => Object.fromEntries(STEPS.map((s) => [s, 'waiting'])) as Record<StepId, StepStatus>;

export function reduce(state: RunState, e: OrchestratorEvent): RunState {
  if (e.type === 'pipeline.started') {
    const stages = Object.fromEntries(PIPELINE_STAGES.map((s) => [s, { status: 'waiting' }])) as PipelineState['stages'];
    return {
      ...initialState,
      runId: e.runId,
      project: e.project,
      status: 'running',
      startedAt: e.t,
      pipeline: { base: e.base, status: 'running', stages },
    };
  }
  if (e.type === 'run.started') {
    // Inside a pipeline the agents' run shares the pipeline's id: keep its stages and start time.
    const keep = e.runId === state.runId && state.pipeline ? { pipeline: state.pipeline, startedAt: state.startedAt } : {};
    const agents: Record<string, AgentState> = {};
    for (const a of e.agents) {
      agents[a.agentId] = {
        ...a,
        status: 'queued',
        steps: freshSteps(),
        cases: [],
        tools: [],
        toolCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        proposals: [],
      };
    }
    return {
      ...initialState,
      runId: e.runId,
      mode: e.mode,
      model: e.model,
      project: e.project,
      write: e.write,
      concurrency: e.concurrency,
      status: 'running',
      startedAt: e.t,
      order: e.agents.map((a) => a.agentId),
      agents,
      ...keep,
    };
  }
  // Ignore stray events from a previous run (e.g. a late SSE message after a reset).
  if (e.runId !== state.runId) return state;

  switch (e.type) {
    case 'stage':
      if (!state.pipeline) return state;
      return {
        ...state,
        pipeline: { ...state.pipeline, stages: { ...state.pipeline.stages, [e.stage]: { status: e.status, detail: e.detail } } },
      };
    case 'pipeline.finished':
      if (!state.pipeline) return state;
      return {
        ...state,
        status: 'done',
        finishedAt: e.t,
        pipeline: { ...state.pipeline, status: e.ok ? 'ok' : 'failed', branch: e.branch, commit: e.commit, pushed: e.pushed, report: e.report, prUrl: e.prUrl },
      };
    case 'agent.started':
      return patchAgent(state, e.agentId, () => ({ status: 'running', startedAt: e.t, workspace: e.workspace }));
    case 'step':
      return patchAgent(state, e.agentId, (a) => ({ steps: { ...a.steps, [e.step]: e.status } }));
    case 'tool':
      return patchAgent(state, e.agentId, (a) => ({
        tools: [...a.tools, { name: e.name, detail: e.detail, t: e.t }].slice(-RECENT_TOOLS),
        toolCount: a.toolCount + 1,
      }));
    case 'text':
      return patchAgent(state, e.agentId, () => ({ lastText: e.text }));
    case 'usage':
      return patchAgent(state, e.agentId, () => ({ inputTokens: e.inputTokens, outputTokens: e.outputTokens }));
    case 'cases':
      return patchAgent(state, e.agentId, (a) => ({ cases: mergeCases(a.cases, e.cases, e.run) }));
    case 'proposal':
      return patchAgent(state, e.agentId, (a) => ({
        proposals: [...a.proposals, { file: e.file, path: e.path, before: e.before, value: e.value, applied: e.applied }],
      }));
    case 'agent.finished':
      return patchAgent(state, e.agentId, (a) => ({
        status: e.status,
        summary: e.summary,
        costUsd: e.costUsd,
        finishedAt: e.t,
        cases: settleCases(a.cases, e.status),
      }));
    case 'merge':
      return { ...state, merge: e.results };
    case 'log':
      return { ...state, log: [...state.log, { level: e.level, message: e.message, t: e.t }].slice(-200) };
    case 'run.finished':
      // In a pipeline, the run is only done when the pipeline finishes.
      return state.pipeline
        ? { ...state, costUsd: e.costUsd }
        : { ...state, status: 'done', finishedAt: e.t, costUsd: e.costUsd };
  }
}

function patchAgent(state: RunState, id: string, fn: (a: AgentState) => Partial<AgentState>): RunState {
  const a = state.agents[id];
  if (!a) return state;
  return { ...state, agents: { ...state.agents, [id]: { ...a, ...fn(a) } } };
}

/** A case that failed earlier and passes on a later run (after a fix) is shown as fixed. */
function mergeCases(prev: TestCase[], next: TestCase[], run: number): TestCase[] {
  if (run <= 1 || prev.length === 0) return next;
  const before = new Map(prev.map((c) => [c.id, c]));
  const merged = next.map((c) => {
    const old = before.get(c.id);
    return old && old.status !== 'pass' && c.status === 'pass' ? { ...c, status: 'fixed' as const, method: 'agent' as const } : c;
  });
  // Cases the verify run did not report keep their earlier state.
  for (const c of prev) if (!next.some((n) => n.id === c.id)) merged.push(c);
  return merged;
}

/** When an agent finishes, still-failing cases become proposed (agent has a fix) or blockers (human needed). */
function settleCases(cases: TestCase[], status: AgentStatus): TestCase[] {
  return cases.map((c) => {
    if (c.status !== 'fail') return c;
    if (status === 'proposed') return { ...c, status: 'proposed', method: 'agent' };
    if (status === 'fixed') return { ...c, status: 'fixed', method: 'agent' };
    return { ...c, status: 'blocker', method: 'human' };
  });
}

/** Share of the pipeline that is finished (done/skipped/failed), 0..1. */
export function progress(a: AgentState): number {
  if (['passed', 'fixed', 'proposed', 'unfixable', 'error', 'skipped'].includes(a.status)) return 1;
  const finished = STEPS.filter((s) => ['done', 'skipped', 'failed'].includes(a.steps[s])).length;
  const running = STEPS.some((s) => a.steps[s] === 'running') ? 0.5 : 0;
  return (finished + running) / STEPS.length;
}
