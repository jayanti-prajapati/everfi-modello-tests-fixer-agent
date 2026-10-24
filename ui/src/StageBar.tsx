import { PIPELINE_STAGES } from '../../src/orchestrator/events.js';
import type { PipelineState } from '../../src/orchestrator/reducer.js';

const LABEL: Record<string, string> = {
  preflight: 'Preflight',
  branch: 'Branch',
  install: 'Install deps',
  build: 'Build course',
  generate: 'Generate tests',
  fix: 'Test & fix',
  verify: 'Final verify',
  report: 'Report',
  commit: 'Commit',
  push: 'Push',
};

const ICON: Record<string, string> = { waiting: '○', running: '◌', done: '✓', skipped: '–', failed: '✕' };

export function StageBar({ p }: { p: PipelineState }) {
  return (
    <section className="card stagebar">
      <div className="stages">
        {PIPELINE_STAGES.map((s, i) => {
          const st = p.stages[s];
          return (
            <div key={s} className={`stage ${st.status}`} title={st.detail ?? st.status}>
              <span className="stage-icon">{ICON[st.status]}</span>
              <span className="stage-name">{LABEL[s]}</span>
              {i < PIPELINE_STAGES.length - 1 && <span className="stage-arrow">→</span>}
            </div>
          );
        })}
      </div>
      <div className="stage-meta mono">
        base <b>{p.base}</b>
        {p.branch && <> · branch <b>{p.branch}</b></>}
        {p.commit && <> · commit <b>{p.commit.slice(0, 8)}</b></>}
        {p.status !== 'running' && <> · {p.pushed ? 'pushed, CI will verify' : p.commit ? 'not pushed' : 'nothing committed'}</>}
        {p.prUrl && p.pushed && (
          <> · <a href={p.prUrl} target="_blank" rel="noreferrer">raise PR when CI is green ↗</a></>
        )}
      </div>
      {PIPELINE_STAGES.filter((s) => p.stages[s].status === 'failed').map((s) => (
        <div key={s} className="error">{LABEL[s]} failed: {p.stages[s].detail}</div>
      ))}
    </section>
  );
}
