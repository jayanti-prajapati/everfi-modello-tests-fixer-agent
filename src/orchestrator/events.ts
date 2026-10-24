// Event model shared by the orchestrator, the SSE server and the UI. Keep this file import-free
// so the UI bundle can use it as-is.

/** Sequential pipeline every module agent goes through. */
export const STEPS = ['run', 'diagnose', 'fix', 'rebuild', 'verify', 'report'] as const;
export type StepId = (typeof STEPS)[number];
export type StepStatus = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';

/** passed = spec was green on the first run, nothing to do. error = the agent crashed or reported nothing. skipped = budget reached before it started. */
export type AgentStatus = 'queued' | 'running' | 'passed' | 'fixed' | 'proposed' | 'unfixable' | 'error' | 'skipped';

/** Stages of the local fix pipeline (fix-course), in order. */
export const PIPELINE_STAGES = ['preflight', 'branch', 'install', 'build', 'generate', 'fix', 'verify', 'report', 'commit', 'push'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** One row of the execution matrix: a Cypress test case of a module's spec. */
export type CaseStatus = 'waiting' | 'pass' | 'fail' | 'fixed' | 'proposed' | 'blocker';
export interface TestCase {
  id: string;
  title: string;
  status: CaseStatus;
  /** Failure message (first line), when the case failed */
  message?: string;
  /** Who resolves it: the agent, or a human (unfixable) */
  method?: 'agent' | 'human';
}

export interface AgentPlan {
  agentId: string;
  module: string;
  spec: string;
}

export type MergeStatus = 'applied' | 'unchanged' | 'conflict' | 'error';
export interface MergeResult {
  agentId: string;
  file: string;
  path: string[];
  value: unknown;
  status: MergeStatus;
  message?: string;
}

export type EventBody =
  | { type: 'pipeline.started'; project: string; base: string }
  | { type: 'stage'; stage: PipelineStage; status: StepStatus; detail?: string }
  | {
      type: 'pipeline.finished';
      ok: boolean;
      branch?: string;
      commit?: string;
      pushed: boolean;
      report?: string;
      prUrl?: string;
    }
  | {
      type: 'run.started';
      mode: 'live' | 'demo' | 'replay';
      model: string;
      project: string;
      write: boolean;
      concurrency: number;
      agents: AgentPlan[];
    }
  | { type: 'agent.started'; agentId: string; workspace?: string }
  | { type: 'step'; agentId: string; step: StepId; status: StepStatus }
  | { type: 'tool'; agentId: string; name: string; detail?: string }
  | { type: 'text'; agentId: string; text: string }
  | { type: 'usage'; agentId: string; inputTokens: number; outputTokens: number }
  | { type: 'cases'; agentId: string; run: number; cases: TestCase[] }
  | {
      type: 'proposal';
      agentId: string;
      file: string;
      path: string[];
      before: unknown;
      value: unknown;
      applied: boolean;
    }
  | { type: 'agent.finished'; agentId: string; status: AgentStatus; summary: string; costUsd?: number }
  | { type: 'merge'; results: MergeResult[] }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'run.finished'; costUsd: number };

export type OrchestratorEvent = EventBody & { runId: string; t: number };
