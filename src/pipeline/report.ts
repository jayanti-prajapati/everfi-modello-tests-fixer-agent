import type { MergeResult } from '../orchestrator/events.js';
import type { AgentSummary } from '../orchestrator/index.js';

export interface VerifyResult {
  agentId: string;
  spec: string;
  passed: boolean;
  /** Key paths set back because the module still failed in the checkout */
  reverted: string[][];
}

export interface PipelineReport {
  runId: string;
  project: string;
  base: string;
  model: string;
  startedAt: string;
  finishedAt?: string;
  branch?: string;
  originalBranch?: string;
  agents: AgentSummary[];
  merge: MergeResult[];
  verify: VerifyResult[];
  commit?: string;
  committedFiles: string[];
  pushed: boolean;
  prUrl?: string;
  costUsd: number;
  error?: string;
}

const STATUS_NOTE: Record<string, string> = {
  passed: 'passed, no change needed',
  fixed: 'fixed and verified',
  proposed: 'change proposed, not verified (not committed)',
  unfixable: 'needs a human',
  error: 'agent error',
  skipped: 'not run (budget)',
};

/** Modules whose fix made it into the checkout and survived the final verify. */
export function committedModules(r: PipelineReport): AgentSummary[] {
  const applied = new Set(r.merge.filter((m) => m.status === 'applied').map((m) => m.agentId));
  const failed = new Set(r.verify.filter((v) => !v.passed).map((v) => v.agentId));
  return r.agents.filter((a) => applied.has(a.agentId) && !failed.has(a.agentId));
}

const fmt = (p: { file: string; path: string[]; before: unknown; value: unknown }) =>
  `${p.file} ${JSON.stringify(p.path)}: ${JSON.stringify(p.before)} -> ${JSON.stringify(p.value)}`;

export function commitMessage(r: PipelineReport): string {
  const mods = committedModules(r);
  const lines = [
    `fix(test): modello config fixes for ${mods.map((a) => a.module).join(', ')}`,
    '',
    `Automated by the Modello Tests Fixer (local run ${r.runId}, ${r.model}).`,
    'Only test generator config (test/ui/model-*.json) is changed.',
    '',
  ];
  for (const a of mods) {
    lines.push(`- ${a.module} (${a.spec}): ${a.summary.split('\n')[0]}`);
    for (const p of a.patches) lines.push(`  ${fmt(p)}`);
  }
  lines.push(
    '',
    'Verified: each module passed after a rebuild in an isolated copy, and',
    `again in this checkout after the merged rebuild (S3, ${r.startedAt.slice(0, 10)}).`,
  );
  const open = r.agents.filter((a) => a.status !== 'passed' && !mods.includes(a));
  if (open.length) lines.push(`Not fixed here: ${open.map((a) => `${a.module} (${a.status})`).join(', ')}.`);
  return lines.join('\n');
}

export function renderReport(r: PipelineReport): string {
  const out = [
    `# Modello fix run ${r.runId}`,
    '',
    `- Course: \`${r.project}\``,
    `- Base: \`${r.base}\`; branch: ${r.branch ? `\`${r.branch}\`` : '(none)'}${r.originalBranch ? ` (you were on \`${r.originalBranch}\`)` : ''}`,
    `- Model: ${r.model}; cost: $${r.costUsd.toFixed(2)}`,
    `- Started ${r.startedAt}${r.finishedAt ? `, finished ${r.finishedAt}` : ''}`,
  ];
  if (r.error) out.push('', `**Stopped with an error:** ${r.error}`);

  out.push('', '## Modules', '', '| Module | Result | Cost | Summary |', '|---|---|---|---|');
  for (const a of r.agents) {
    const v = r.verify.find((x) => x.agentId === a.agentId);
    const result = v && !v.passed ? 'fix reverted (failed in checkout)' : (STATUS_NOTE[a.status] ?? a.status);
    out.push(`| ${a.module} | ${result} | ${a.costUsd !== undefined ? `$${a.costUsd.toFixed(2)}` : '-'} | ${a.summary.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  }

  const changes = r.agents.flatMap((a) => a.patches.map((p) => ({ a, p })));
  if (changes.length) {
    out.push('', '## Changes found by the agents', '');
    for (const { a, p } of changes) out.push(`- ${a.module}: \`${fmt(p)}\``);
  }
  if (r.merge.length) {
    out.push('', '## Merged into the checkout', '');
    for (const m of r.merge) out.push(`- ${m.agentId}: ${m.status} \`${JSON.stringify(m.path)}\`${m.message ? ` (${m.message})` : ''}`);
  }
  if (r.verify.length) {
    out.push('', '## Final verify in the checkout', '');
    for (const v of r.verify) {
      out.push(`- ${v.agentId} \`${v.spec}\`: ${v.passed ? 'passed' : `FAILED, reverted ${v.reverted.length} change(s)`}`);
    }
  }

  out.push('', '## Git', '');
  if (r.commit) {
    out.push(`- Commit \`${r.commit.slice(0, 10)}\` on \`${r.branch}\`: ${r.committedFiles.map((f) => `\`${f}\``).join(', ')}`);
    out.push(r.pushed ? '- Pushed. CI (`build and test`, runs on `test/**`) will verify it.' : `- Not pushed. To push: \`git push -u origin ${r.branch}\``);
    if (r.prUrl) out.push(`- Raise the PR when CI is green: ${r.prUrl}`);
  } else {
    out.push('- Nothing committed.');
  }

  const human = r.agents.filter((a) => ['unfixable', 'error', 'proposed', 'skipped'].includes(a.status));
  if (human.length) {
    out.push('', '## Needs a human', '');
    for (const a of human) out.push(`- **${a.module}** (${a.status}): ${a.summary}`);
  }
  return out.join('\n') + '\n';
}
