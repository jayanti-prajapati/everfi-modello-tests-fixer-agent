import { PIPELINE_STAGES } from '../../src/orchestrator/events.js';
import type { PipelineState } from '../../src/orchestrator/reducer.js';
import { Icon, STEP, StatusIcon } from './status';

const LABEL: Record<string, string> = {
  preflight: 'Preflight',
  branch: 'Branch',
  install: 'Install deps',
  build: 'Build course',
  generate: 'Generate tests',
  test: 'Run tests',
  fix: 'Fix (one by one)',
  verify: 'Final verify',
  report: 'Report',
  commit: 'Commit',
  push: 'Push',
};

/** Pipeline stages, laid out like a GitHub Actions run summary. */
export function StageBar({ p }: { p: PipelineState }) {
  const failed = PIPELINE_STAGES.filter((s) => p.stages[s].status === 'failed');
  return (
    <section className="box">
      <div className="box-header">
        <h2 className="box-title">Pipeline</h2>
        <span className="muted small">base <span className="mono">{p.base}</span></span>
      </div>
      <div className="stages">
        {PIPELINE_STAGES.map((s) => {
          const st = p.stages[s];
          return (
            <div key={s} className={`stage is-${st.status}`} title={st.detail ?? STEP[st.status].label}>
              <span className="stage-icon"><StatusIcon look={STEP[st.status]} size={20} /></span>
              <span className="stage-name">{LABEL[s]}</span>
              {st.detail && st.status !== 'failed' && <span className="stage-detail truncate">{st.detail}</span>}
            </div>
          );
        })}
      </div>
      {failed.map((s) => (
        <div key={s} className="flash" style={{ margin: '0 16px 12px' }}>
          <Icon name="x" />
          <span><b>{LABEL[s]} failed.</b> <span className="mono">{p.stages[s].detail}</span></span>
        </div>
      ))}
      <div className="stage-meta">
        {p.branch ? <span className="label mono"><b>{p.branch}</b></span> : <span>no branch</span>}
        {p.commit && <span className="label mono">commit <b>{p.commit.slice(0, 8)}</b></span>}
        {p.status !== 'running' && <span>{p.pushed ? 'Pushed; CI will verify the branch.' : p.commit ? 'Committed, not pushed.' : 'Nothing committed.'}</span>}
        {p.prUrl && p.pushed && <a href={p.prUrl} target="_blank" rel="noreferrer">Raise PR when CI is green ↗</a>}
      </div>
    </section>
  );
}
