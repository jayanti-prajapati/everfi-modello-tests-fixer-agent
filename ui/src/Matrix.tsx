import type { RunState } from '../../src/orchestrator/reducer.js';

const BADGE: Record<string, string> = { pass: 'PASS', fail: 'FAIL', fixed: 'FIXED', proposed: 'PROPOSED', blocker: 'BLOCKER', waiting: 'WAITING' };

export function Matrix({ state, selected, onClear }: { state: RunState; selected?: string; onClear: () => void }) {
  const agents = state.order.map((id) => state.agents[id]).filter((a) => !selected || a.agentId === selected);
  const total = agents.reduce((s, a) => s + a.cases.length, 0);

  return (
    <section className="card matrix">
      <div className="card-head">
        <h3>Execution Matrix</h3>
        <span className="muted small">
          {selected && <button className="link" onClick={onClear}>show all ·</button>} {total} test cases
        </span>
      </div>
      <table>
        <thead>
          <tr><th>ID</th><th>Test case</th><th>Method</th><th>Status</th></tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <ModuleRows key={a.agentId} a={a} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ModuleRows({ a }: { a: RunState['agents'][string] }) {
  return (
    <>
      <tr className="group">
        <td colSpan={4}>
          <b>{a.module}</b> <span className="muted">{a.spec}</span>
          {a.summary && <div className="summary">{a.summary}</div>}
          {a.proposals.map((p, i) => (
            <div key={i} className="proposal mono">
              {p.applied ? 'applied' : 'proposed'} {p.file} › {p.path.slice(1).join(' › ')}: {JSON.stringify(p.before)} → {JSON.stringify(p.value)}
            </div>
          ))}
        </td>
      </tr>
      {a.cases.length === 0 && (
        <tr>
          <td className="mono muted">—</td>
          <td className="muted">{a.status === 'queued' ? 'Queued' : 'Running spec…'}</td>
          <td />
          <td><span className="badge waiting">WAITING</span></td>
        </tr>
      )}
      {a.cases.map((c) => (
        <tr key={c.id}>
          <td className="mono muted">{a.module.toUpperCase()}·{c.id}</td>
          <td>
            <div className="case">{c.title}</div>
            {c.message && <div className="muted small clip" title={c.message}>{c.message}</div>}
          </td>
          <td className={`method m-${c.method ?? 'run'}`}>{c.method === 'human' ? '⚑ Human' : c.method === 'agent' ? '✦ Agent' : '⚡ Cypress'}</td>
          <td><span className={`badge ${c.status}`}>{BADGE[c.status]}</span></td>
        </tr>
      ))}
    </>
  );
}
