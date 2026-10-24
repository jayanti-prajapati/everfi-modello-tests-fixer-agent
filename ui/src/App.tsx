import { useEffect, useReducer, useState } from "react";
import type { OrchestratorEvent } from "../../src/orchestrator/events.js";
import {
  initialState,
  reduce,
  type RunState,
} from "../../src/orchestrator/reducer.js";
import { Canvas } from "./Canvas";
import { Matrix } from "./Matrix";
import { StageBar } from "./StageBar";
import { Icon, StateLabel } from "./status";

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

type Action = { kind: "event"; e: OrchestratorEvent } | { kind: "reset" };
const root = (s: RunState, a: Action) =>
  a.kind === "reset" ? initialState : reduce(s, a.e);

const LOGO = "https://everfi.com/wp-content/uploads/2025/09/favicon.png";

type Theme ="auto" | "light" | "dark";
const THEME_KEY = "orchestrator-theme";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as Theme) || "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "auto") delete el.dataset.theme;
    else el.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage unavailable (private window): theme still applies for this visit
    }
  }, [theme]);
  return [theme, setTheme];
}

export function App() {
  const [state, dispatch] = useReducer(root, initialState);
  const [info, setInfo] = useState<Info>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    fetch("/api/info")
      .then((r) => r.json())
      .then(setInfo)
      .catch(() =>
        setError(
          "Orchestrator API not reachable. Start it with: npm run orchestrate -- --serve",
        ),
      );
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => dispatch({ kind: "event", e: JSON.parse(m.data) });
    return () => es.close();
  }, []);

  const start = async (mode: "demo" | "live") => {
    setError(undefined);
    setSelected(undefined);
    const r = await fetch(`/api/runs?mode=${mode}`, { method: "POST" });
    if (!r.ok)
      setError((await r.json()).error ?? `Could not start (${r.status})`);
  };

  const running = state.status === "running";
  const model = state.model ?? info?.model ?? "claude-sonnet-4-5";
  const write = state.write ?? info?.write;
  const course = state.project?.split("/").filter(Boolean).pop();
  const failed = state.pipeline?.status === "failed";
  const runLook = running
    ? { tone: "accent" as const, icon: "spin" as const, label: "Running" }
    : failed
      ? { tone: "danger" as const, icon: "x" as const, label: "Failed" }
      : {
          tone: "success" as const,
          icon: "check" as const,
          label: "Completed",
        };

  return (
    <>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <img src={LOGO} alt="" width={20} height={20} />
          </span>
          <strong>Modello Tests Fixer</strong>
          <span className="crumb">/ control room</span>
        </div>
        <div className="header-right">
          <span className="label">
            {state.mode ?? "idle"} · <b>{write ? "write" : "dry-run"}</b>
          </span>
          <span className="label">
            <span className={`dot ${connected ? "live" : ""}`} />
            {connected ? "Live" : "Offline"}
          </span>
          <span className="label mono">
            {info?.runtime ?? "claude-agent-sdk"} · <b>{model}</b>
          </span>
          <div className="toggle-group" role="group" aria-label="Theme">
            {(["auto", "light", "dark"] as const).map((t) => (
              <button
                key={t}
                aria-pressed={theme === t}
                onClick={() => setTheme(t)}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="container">
        <div className="page-head">
          <div>
            <h1>
              {state.status === "idle"
                ? "Control room"
                : `${state.pipeline ? "Fix pipeline" : "Fixer"} · ${course}`}
              {state.status !== "idle" && <StateLabel look={runLook} />}
            </h1>
            <p>
              Modello Fixer repairs a course's Modello test configuration when
              its generated Cypress tests fail. It changes only the test
              generator files (
              <span className="mono">test/ui/model-parameters.json</span>,{" "}
              <span className="mono">model-map.json</span>,{" "}
              <span className="mono">model-edges.json</span>), never course
              content, and hands anything it cannot prove to a human.
            </p>
            <details className="how" open={state.status === "idle"}>
              <summary>How it works</summary>
              <ol>
                <li>
                  <b>Build and generate.</b> The course is built and its Cypress
                  specs are generated with ECC and Modello, the same way CI
                  does.
                </li>
                <li>
                  <b>Run every test, in parallel.</b> Each module's spec runs in
                  the course folder (
                  <span className="mono">test/ui/cypress/e2e</span>) and the
                  results are collected. Passing modules are done; no agent is
                  needed.
                </li>
                <li>
                  <b>Fix failures one at a time.</b> For each failing module a
                  Claude agent ({model}) diagnoses the failure, changes one
                  model value, rebuilds and re-runs the spec. Only one agent
                  writes at a time, so changes never collide.
                </li>
                <li>
                  <b>Only proven fixes stay.</b> A change that does not pass its
                  re-run is reverted, and all fixed modules run once more
                  together before commit. Course bugs, flaky or ambiguous
                  failures are marked <i>Needs human</i>.
                </li>
                <li>
                  <b>You stay in charge of Git.</b> The fix pipeline commits the
                  model files to a{" "}
                  <span className="mono">test/modello-fixes-*</span> branch and
                  pushes only if you confirm; CI verifies it, and you raise the
                  PR.
                </li>
              </ol>
            </details>
          </div>
          <div className="toolbar">
            <button
              className="btn btn-primary"
              disabled={running || !info?.liveAvailable}
              onClick={() => start("live")}
              title={
                info?.liveAvailable
                  ? `Live run on ${info.project}`
                  : `Live runs disabled: ${info?.problems?.join("; ") ?? ""}`
              }
            >
              <Icon name="play" /> Run Fixer
            </button>
            <button
              className="btn"
              disabled={running}
              onClick={() => start("demo")}
            >
              <Icon name="sparkle" /> Run demo
            </button>
            <button
              className="btn btn-invisible"
              disabled={running}
              onClick={() => {
                dispatch({ kind: "reset" });
                setSelected(undefined);
              }}
            >
              Reset
            </button>
          </div>
        </div>

        <div className="muted small" style={{ marginBottom: 16 }}>
          {info?.project ? (
            <>
              Project <span className="mono">{info.project}</span>
            </>
          ) : (
            "Demo only (started without --project)"
          )}{" "}
          · {info?.concurrency ?? 2} agents in parallel
        </div>

        {error && (
          <div className="flash">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        )}

        {state.status === "idle" ? (
          <div className="box blankslate">
            <Icon name="sparkle" size={32} />
            <h2>No run yet</h2>
            <p>
              Start a run to watch the agents work. The demo replays a scripted
              run of four modules: no Cypress, no spend.
            </p>
            <button className="btn" onClick={() => start("demo")}>
              <Icon name="sparkle" /> Run demo
            </button>
          </div>
        ) : (
          <>
            {state.pipeline && <StageBar p={state.pipeline} />}
            <div className="grid">
              <Canvas
                state={state}
                selected={selected}
                onSelect={setSelected}
              />
              <Matrix
                state={state}
                selected={selected}
                onClear={() => setSelected(undefined)}
              />
            </div>
          </>
        )}
      </main>
    </>
  );
}
