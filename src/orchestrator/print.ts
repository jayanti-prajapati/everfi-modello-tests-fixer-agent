// Compact terminal rendering of orchestrator/pipeline events.
import type { OrchestratorEvent } from './events.js';

export function printEvent(e: OrchestratorEvent) {
  const tag = 'agentId' in e ? `[${e.agentId}]`.padEnd(7) : '       ';
  switch (e.type) {
    case 'pipeline.started':
      return console.log(`pipeline ${e.runId}: ${e.project} (base ${e.base})`);
    case 'stage':
      return e.status === 'waiting' ? undefined : console.log(`\n== ${e.stage}: ${e.status}${e.detail ? ` (${e.detail})` : ''}`);
    case 'pipeline.finished':
      return console.log(`\npipeline ${e.ok ? 'finished' : 'FAILED'}${e.branch ? `, branch ${e.branch}` : ''}${e.commit ? ` @ ${e.commit.slice(0, 8)}` : ''}${e.pushed ? ', pushed' : ''}`);
    case 'run.started':
      return console.log(`run ${e.runId} (${e.mode}, ${e.model}, ${e.write ? 'write' : 'dry-run'}, ${e.concurrency} parallel): ${e.agents.map((a) => a.agentId).join(', ')}`);
    case 'agent.started':
      return console.log(`${tag} started${e.workspace ? ` in ${e.workspace}` : ''}`);
    case 'step':
      return e.status === 'running' || e.status === 'failed' ? console.log(`${tag} ${e.step}: ${e.status}`) : undefined;
    case 'tool':
      return console.log(`${tag} → ${e.name}${e.detail ? ` ${e.detail}` : ''}`);
    case 'cases': {
      const failed = e.cases.filter((c) => c.status === 'fail').length;
      return console.log(`${tag} run ${e.run}: ${e.cases.length - failed}/${e.cases.length} passed`);
    }
    case 'proposal':
      return console.log(`${tag} ${e.applied ? 'applied' : 'proposed'} ${e.file} ${JSON.stringify(e.path)} ${JSON.stringify(e.before)} -> ${JSON.stringify(e.value)}`);
    case 'agent.finished':
      return console.log(`${tag} ${e.status.toUpperCase()}: ${e.summary}${e.costUsd !== undefined ? ` ($${e.costUsd.toFixed(2)})` : ''}`);
    case 'merge':
      return e.results.forEach((r) => console.log(`merge  [${r.agentId}] ${r.status} ${r.file} ${JSON.stringify(r.path)}${r.message ? `: ${r.message}` : ''}`));
    case 'log':
      return console.log(`${e.level}: ${e.message}`);
    case 'run.finished':
      return console.log(`done, total cost $${e.costUsd.toFixed(2)}`);
  }
}
