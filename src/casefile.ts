// The "case file": everything the orchestrator already knows about a failure, handed to the
// agent in its first message so it starts at deciding, not exploring.
import type { Config } from './config.js';
import { pageEntries, type Located } from './locate.js';
import type { SpecRun } from './triage.js';

const MAX = 7000;

export function buildCaseFile(config: Config, spec: string, run: SpecRun, loc: Located, notes: string[] = []): string {
  const out: string[] = [`Spec: ${spec}`, `Test-phase result (already run in the course folder): ${run.status}`];
  for (const [i, f] of (run.failures ?? []).slice(0, 3).entries()) {
    out.push(`Failure ${i + 1}: ${f.title}`, `  message: ${f.message.slice(0, 400)}`);
    const frames = f.stack.split('\n').filter((l) => /\bat\b|\.js:\d+/.test(l)).slice(0, 6);
    if (frames.length) out.push(`  top frames:\n${frames.map((l) => `    ${l.trim()}`).join('\n')}`);
  }
  if (loc.selector) out.push(`Failing selector: ${loc.selector}`);
  if (loc.blocks.length) {
    out.push('Generated spec block(s) using it:');
    for (const b of loc.blocks) out.push(`  (line ${b.line})\n${b.text.split('\n').map((l) => `    ${l}`).join('\n')}`);
  } else if (loc.selector) {
    out.push('The selector does not appear in the generated spec (it likely comes from modello support code).');
  }
  if (loc.entries.length) {
    out.push('Model entries holding the selector:');
    for (const e of loc.entries) out.push(`  ${e.file} ${JSON.stringify(e.path)} = ${JSON.stringify(e.value)}`);
  }
  for (const page of [...new Set(loc.blocks.map((b) => b.page))].slice(0, 2)) {
    const entries = pageEntries(config, page);
    if (entries) out.push(`Model entries for page ${page}:\n  ${entries}`);
  }
  if (notes.length) out.push('Already checked by the orchestrator:', ...notes.map((n) => `  - ${n}`));
  const text = out.join('\n');
  return text.length > MAX ? `${text.slice(0, MAX)}\n…(case file truncated)` : text;
}
