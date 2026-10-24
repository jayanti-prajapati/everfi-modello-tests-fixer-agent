import type { AgentState, RunState } from '../../src/orchestrator/reducer.js';
import { AGENT, CASE, Icon, StateLabel } from './status';

export function Matrix({ state, selected, onClear }: { state: RunState; selected?: string; onClear: () => void }) {
  const agents = state.order.map((id) => state.agents[id]).filter((a) => !selected || a.agentId === selected);
  const total = agents.reduce((s, a) => s + a.cases.length, 0);

  return (
    <section className="box">
      <div className="box-header">
        <h2 className="box-title">Execution matrix <span className="counter">{total}</span></h2>
        {selected ? (
          <span className="small muted">
            Showing <b>{selected}</b> · <button className="btn-link" onClick={onClear}>show all</button>
          </span>
        ) : (
          <span className="small muted">click an agent to filter</span>
        )}
      </div>
      <table className="table">
        <thead>
          <tr><th>ID</th><th>Test case</th><th>Method</th><th>Status</th></tr>
        </thead>
        <tbody>
          {agents.map((a) => <ModuleRows key={a.agentId} a={a} />)}
        </tbody>
      </table>
    </section>
  );
}

function ModuleRows({ a }: { a: AgentState }) {
  return (
    <>
      <tr className="group">
        <td colSpan={4}>
          <div className="group-head">
            <b>{a.module}</b>
            <StateLabel look={AGENT[a.status]} small />
            <span className="mono muted truncate">{a.spec}</span>
          </div>
          {a.summary && <div className="summary">{a.summary}</div>}
          {a.proposals.map((p, i) => (
            <div key={i} className="change">
              <span className="muted">{p.applied ? 'applied' : 'proposed'} · {p.file} › {p.path.slice(1).join(' › ')}</span>
              <br />
              <span className="old">− {JSON.stringify(p.before)}</span>
              <br />
              <span className="new">+ {JSON.stringify(p.value)}</span>
            </div>
          ))}
        </td>
      </tr>
      {a.cases.length === 0 && (
        <tr>
          <td className="case-id">—</td>
          <td className="muted">{a.status === 'queued' ? 'Queued' : a.status === 'skipped' ? 'Not run' : 'Running spec…'}</td>
          <td />
          <td><StateLabel look={CASE.waiting} small /></td>
        </tr>
      )}
      {a.cases.map((c) => (
        <tr key={c.id}>
          <td className="case-id">{a.module.toUpperCase()}·{c.id}</td>
          <td>
            <div className="case-title">{c.title}</div>
            {c.message && <div className="case-msg truncate" title={c.message}>{c.message}</div>}
          </td>
          <td>
            {c.method === 'human' ? (
              <span className="method m-human"><Icon name="person" size={14} /> Human</span>
            ) : c.method === 'agent' ? (
              <span className="method m-agent"><Icon name="sparkle" size={14} /> Agent</span>
            ) : (
              <span className="method"><Icon name="play" size={14} /> Cypress</span>
            )}
          </td>
          <td><StateLabel look={CASE[c.status]} small /></td>
        </tr>
      ))}
    </>
  );
}
