import { useEffect, useReducer, useState } from 'react';
import type { OrchestratorEvent } from '../../src/orchestrator/events.js';
import { initialState, reduce, type RunState } from '../../src/orchestrator/reducer.js';
import { Canvas } from './Canvas';
import { Matrix } from './Matrix';
import { StageBar } from './StageBar';

interface Info {
  model: string;
  runtime: string;
  project?: string;
  write: boolean;
  concurrency: number;
  liveAvailable: boolean;
  problems: string[];
  busy: boolean;
}

type Action = { kind: 'event'; e: OrchestratorEvent } | { kind: 'reset' };
const root = (s: RunState, a: Action) => (a.kind === 'reset' ? initialState : reduce(s, a.e));

export function App() {
  const [state, dispatch] = useReducer(root, initialState);
  const [info, setInfo] = useState<Info>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    fetch('/api/info')
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => setError('Orchestrator API not reachable. Start it with: npm run orchestrate -- --serve'));
    const es = new EventSource('/api/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => dispatch({ kind: 'event', e: JSON.parse(m.data) });
    return () => es.close();
  }, []);

  const start = async (mode: 'demo' | 'live') => {
    setError(undefined);
    setSelected(undefined);
    const r = await fetch(`/api/runs?mode=${mode}`, { method: 'POST' });
    if (!r.ok) setError((await r.json()).error ?? `Could not start (${r.status})`);
  };

  const running = state.status === 'running';
  const model = state.model ?? info?.model ?? 'claude-sonnet-4-5';

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <strong>Agent Orchestrator</strong>
          <span className="muted"> · modello test repair</span>
        </div>
        <div className="chips">
          <span className="chip">{state.mode ?? 'idle'} · {state.write ?? info?.write ? 'write' : 'dry-run'}</span>
          <span className={`chip dot ${connected ? 'ok' : 'off'}`}>{connected ? 'stream live' : 'disconnected'}</span>
          <span className="chip mono">
            runtime: <b>{info?.runtime ?? 'claude-agent-sdk'}</b> · {model}
          </span>
        </div>
      </header>

      <p className="intro">
        The orchestrator gives every course module its own Claude agent and runs them <b>in parallel</b>, each in an isolated copy of the
        course. Inside a module the agent works <b>in sequence</b>: run the Cypress spec, diagnose failures, fix one model value,
        rebuild, verify, report. Verified fixes are merged back to the checkout; anything ambiguous is handed to a human.
      </p>

      <div className="actions">
        <button className="primary" disabled={running || !info?.liveAvailable} onClick={() => start('live')}
          title={info?.liveAvailable ? `Live run on ${info.project}` : `Live runs disabled: ${info?.problems?.join('; ') ?? ''}`}>
          ▶ Run orchestrator
        </button>
        <button disabled={running} onClick={() => start('demo')}>✦ Run demo</button>
        <button className="ghost" disabled={running} onClick={() => { dispatch({ kind: 'reset' }); setSelected(undefined); }}>↺ Reset</button>
        <span className="muted small">
          {info?.project ? `project: ${info.project}` : 'demo only (no --project)'} · {info?.concurrency ?? 2} agents in parallel
        </span>
      </div>
      {error && <div className="error">{error}</div>}

      {state.status === 'idle' ? (
        <div className="empty">Start a run to see the agents work. The demo needs no Cypress and spends nothing.</div>
      ) : (
        <>
          <div className="run-title">
            <h2>{state.pipeline ? 'Fix pipeline' : 'Orchestration'} · {state.project?.split('/').filter(Boolean).pop()}</h2>
            <span className={`pill ${running ? 'running' : state.pipeline?.status === 'failed' ? 'failed' : 'done'}`}>
              {running ? '● running' : state.pipeline?.status === 'failed' ? '✕ failed' : '✓ completed'}
            </span>
          </div>
          {state.pipeline && <StageBar p={state.pipeline} />}
          <div className="grid">
            <Canvas state={state} selected={selected} onSelect={setSelected} />
            <Matrix state={state} selected={selected} onClear={() => setSelected(undefined)} />
          </div>
        </>
      )}
    </div>
  );
}
