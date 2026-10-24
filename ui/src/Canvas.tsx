import { useEffect, useState } from 'react';
import { STEPS } from '../../src/orchestrator/events.js';
import { progress, type AgentState, type RunState } from '../../src/orchestrator/reducer.js';

const STEP_LABEL: Record<string, string> = { run: 'Run', diagnose: 'Diagnose', fix: 'Fix', rebuild: 'Rebuild', verify: 'Verify', report: 'Report' };

function Ring({ value, status }: { value: number; status: string }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`ring ${status}`} viewBox="0 0 64 64" width="64" height="64" aria-label={`${Math.round(value * 100)}%`}>
      <circle cx="32" cy="32" r={r} className="track" />
      <circle cx="32" cy="32" r={r} className="bar" strokeDasharray={c} strokeDashoffset={c * (1 - value)} transform="rotate(-90 32 32)" />
      <text x="32" y="36" textAnchor="middle">{Math.round(value * 100)}%</text>
    </svg>
  );
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtTime = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function AgentCard({ a, now, selected, onSelect }: { a: AgentState; now: number; selected: boolean; onSelect: () => void }) {
  const last = a.tools[a.tools.length - 1];
  const elapsed = a.startedAt ? (a.finishedAt ?? now) - a.startedAt : 0;
  return (
    <button className={`agent ${a.status} ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <Ring value={progress(a)} status={a.status} />
      <div className="agent-body">
        <div className="agent-name">
          <span className="spark">✦</span> {a.module} Agent
        </div>
        <div className={`agent-status ${a.status}`}>{a.status.toUpperCase()}</div>
        <div className="steps">
          {STEPS.map((s) => (
            <span key={s} className={`step ${a.steps[s]}`} title={`${STEP_LABEL[s]}: ${a.steps[s]}`}>
              {STEP_LABEL[s]}
            </span>
          ))}
        </div>
        <div className="ticker mono" title={last?.detail}>
          {a.status === 'queued' ? 'waiting for a free slot…' : last ? `→ ${last.name}${last.detail ? ` ${last.detail}` : ''}` : 'starting…'}
        </div>
        <div className="meta mono">
          {fmtTime(elapsed)} · {a.toolCount} tools · {fmtTokens(a.inputTokens + a.outputTokens)} tok
          {a.costUsd !== undefined && ` · $${a.costUsd.toFixed(2)}`}
        </div>
      </div>
    </button>
  );
}

export function Canvas({ state, selected, onSelect }: { state: RunState; selected?: string; onSelect: (id?: string) => void }) {
  const running = state.status === 'running';
  const now = useNow(running);
  const agents = state.order.map((id) => state.agents[id]);
  const done = agents.filter((a) => !['queued', 'running'].includes(a.status)).length;
  const overall = agents.length ? agents.reduce((s, a) => s + progress(a), 0) / agents.length : 0;
  const tokens = agents.reduce((s, a) => s + a.inputTokens + a.outputTokens, 0);
  const cost = state.costUsd ?? agents.reduce((s, a) => s + (a.costUsd ?? 0), 0);
  const active = agents.filter((a) => a.status === 'running').length;
  const feed = agents
    .flatMap((a) => a.tools.map((t) => ({ ...t, agent: a.module })))
    .sort((x, y) => y.t - x.t)
    .slice(0, 8);

  return (
    <section className="card canvas">
      <div className="card-head">
        <div>
          <h3>Orchestration Canvas</h3>
          <div className="muted small">parallel modules · sequential steps</div>
        </div>
        <span className="pct">{Math.round(overall * 100)}%</span>
      </div>

      <div className="stage">
        <div className={`orchestrator ${running ? 'pulse' : ''}`}>
          <div>Orchestrator</div>
          <div className="small">{active} active / {state.concurrency} slots</div>
        </div>
        <div>
          <div className="label">MODULE AGENTS</div>
          <div className="agents">
            {agents.map((a) => (
              <AgentCard key={a.agentId} a={a} now={now} selected={selected === a.agentId}
                onSelect={() => onSelect(selected === a.agentId ? undefined : a.agentId)} />
            ))}
          </div>
        </div>
      </div>

      <div className="progress"><div style={{ width: `${overall * 100}%` }} /></div>
      <div className="totals mono">
        agents <b>{done}/{agents.length}</b> · elapsed <b>{fmtTime((state.finishedAt ?? now) - (state.startedAt ?? now))}</b> · tokens{' '}
        <b>~{fmtTokens(tokens)}</b> · cost <b>${cost.toFixed(2)}</b>
      </div>

      <div className="label">ACTIVITY</div>
      <ul className="feed mono">
        {feed.map((f, i) => (
          <li key={i}><span className="tag">{f.agent}</span> {f.name} <span className="muted">{f.detail}</span></li>
        ))}
        {feed.length === 0 && <li className="muted">no tool calls yet</li>}
      </ul>

      {state.merge.length > 0 && (
        <>
          <div className="label">MERGED INTO CHECKOUT</div>
          <ul className="feed mono">
            {state.merge.map((m, i) => (
              <li key={i}>
                <span className={`badge ${m.status === 'applied' ? 'fixed' : m.status === 'unchanged' ? 'pass' : 'blocker'}`}>{m.status}</span>{' '}
                <span className="tag">{m.agentId}</span> {m.path.slice(1).join(' › ')} = {JSON.stringify(m.value)}
                {m.message && <span className="muted"> ({m.message})</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
