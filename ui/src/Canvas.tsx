import { useEffect, useState } from "react";
import { STEPS } from "../../src/orchestrator/events.js";
import {
  progress,
  type AgentState,
  type RunState,
} from "../../src/orchestrator/reducer.js";
import {
  AGENT,
  Icon,
  MERGE,
  STEP,
  StateLabel,
  StatusIcon,
  fmtClock,
  fmtTime,
  fmtTokens,
  type Tone,
} from "./status";

const STEP_LABEL: Record<string, string> = {
  run: "Run",
  diagnose: "Diagnose",
  fix: "Fix",
  rebuild: "Rebuild",
  verify: "Verify",
  report: "Report",
};

function Ring({ value, tone }: { value: number; tone: Tone }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className={`ring fg-${tone}`}
      viewBox="0 0 40 40"
      width="40"
      height="40"
      role="img"
      aria-label={`${Math.round(value * 100)}% complete`}
    >
      <circle cx="20" cy="20" r={r} className="track" />
      <circle
        cx="20"
        cy="20"
        r={r}
        className="bar"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value)}
        transform="rotate(-90 20 20)"
      />
      <text x="20" y="24" textAnchor="middle">
        {Math.round(value * 100)}
      </text>
    </svg>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function AgentRow({
  a,
  now,
  selected,
  onSelect,
}: {
  a: AgentState;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const look = AGENT[a.status];
  const last = a.tools[a.tools.length - 1];
  const elapsed = a.startedAt ? (a.finishedAt ?? now) - a.startedAt : 0;
  const ticker =
    a.status === "queued"
      ? "Waiting for a free slot"
      : last
        ? `${last.name}${last.detail ? `  ${last.detail}` : ""}`
        : "Starting";
  return (
    <button
      className={`agent ${selected ? "selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="agent-icon">
        <StatusIcon look={look} />
      </span>
      <span className="agent-main">
        <span className="agent-title">
          <b>{a.module}</b>
          <StateLabel look={look} small />
          <span className="agent-spec truncate">{a.spec}</span>
        </span>
        <span className="steps">
          {STEPS.map((s) => (
            <span
              key={s}
              className={`step is-${a.steps[s]}`}
              title={`${STEP_LABEL[s]}: ${STEP[a.steps[s]].label}`}
            >
              {a.steps[s] === "running" && <Icon name="spin" size={10} />}
              {STEP_LABEL[s]}
            </span>
          ))}
        </span>
        <span className="ticker truncate" title={ticker}>
          {ticker}
        </span>
        <span className="agent-meta">
          <span>{fmtTime(elapsed)}</span>
          <span>{a.toolCount} tool calls</span>
          <span>{fmtTokens(a.inputTokens + a.outputTokens)} tokens</span>
          {a.costUsd !== undefined && <span>${a.costUsd.toFixed(2)}</span>}
        </span>
      </span>
      <Ring value={progress(a)} tone={look.tone} />
    </button>
  );
}

export function Canvas({
  state,
  selected,
  onSelect,
}: {
  state: RunState;
  selected?: string;
  onSelect: (id?: string) => void;
}) {
  const running = state.status === "running";
  const now = useNow(running);
  const agents = state.order.map((id) => state.agents[id]);
  const done = agents.filter(
    (a) => !["queued", "running"].includes(a.status),
  ).length;
  const active = agents.filter((a) => a.status === "running").length;
  const tokens = agents.reduce((s, a) => s + a.inputTokens + a.outputTokens, 0);
  const cost =
    state.costUsd ?? agents.reduce((s, a) => s + (a.costUsd ?? 0), 0);
  const elapsed = (state.finishedAt ?? now) - (state.startedAt ?? now);
  // Segmented bar: each agent contributes its progress, colored by its status tone.
  const segments = agents.map((a) => ({
    id: a.agentId,
    tone: AGENT[a.status].tone,
    width: (progress(a) / Math.max(agents.length, 1)) * 100,
  }));
  const feed = agents
    .flatMap((a) => a.tools.map((t) => ({ ...t, agent: a.module })))
    .sort((x, y) => y.t - x.t)
    .slice(0, 8);

  return (
    <div>
      <section className="box">
        <div className="box-header">
          <h2 className="box-title">
            Agents <span className="counter">{agents.length}</span>
          </h2>
          <span className="muted small">
            parallel modules · sequential steps
          </span>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Agents done</div>
            <div className="stat-value">
              {done}/{agents.length}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Elapsed</div>
            <div className="stat-value">{fmtTime(elapsed)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Tokens</div>
            <div className="stat-value">{fmtTokens(tokens)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Cost</div>
            <div className="stat-value">${cost.toFixed(2)}</div>
          </div>
        </div>
        <div className="orch">
          <span className={`orch-mark ${running ? "pulse" : ""}`}>
            <Icon name="sparkle" />
          </span>
          <span className="orch-text">
            <b>Agents</b>{" "}
            <span className="muted small">
              {active} of {state.concurrency ?? "-"} slots active ·{" "}
              {state.model}
            </span>
            <div className="progress" style={{ marginTop: 6 }} aria-hidden>
              {segments.map((s) => (
                <span
                  key={s.id}
                  className={`p-${s.tone}`}
                  style={{ width: `${s.width}%` }}
                />
              ))}
            </div>
          </span>
        </div>
        {agents.map((a) => (
          <AgentRow
            key={a.agentId}
            a={a}
            now={now}
            selected={selected === a.agentId}
            onSelect={() =>
              onSelect(selected === a.agentId ? undefined : a.agentId)
            }
          />
        ))}
      </section>

      <section className="box">
        <div className="box-header">
          <h2 className="box-title">Activity</h2>
          <span className="muted small">latest tool calls</span>
        </div>
        {feed.length === 0 ? (
          <div className="empty-row">No tool calls yet.</div>
        ) : (
          <ul className="list">
            {feed.map((f, i) => (
              <li key={i}>
                <span className="time">{fmtClock(f.t)}</span>
                <span className="who">{f.agent}</span>
                <span className="what">{f.name}</span>
                <span className="muted truncate mono">{f.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {state.merge.length > 0 && (
        <section className="box">
          <div className="box-header">
            <h2 className="box-title">
              Merged into checkout{" "}
              <span className="counter">{state.merge.length}</span>
            </h2>
          </div>
          <ul className="list">
            {state.merge.map((m, i) => (
              <li key={i}>
                <StateLabel look={MERGE[m.status]} small />
                <span className="who">{m.agentId}</span>
                <span className="mono truncate" title={m.message}>
                  {m.path.slice(1).join(" › ")} = {JSON.stringify(m.value)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
