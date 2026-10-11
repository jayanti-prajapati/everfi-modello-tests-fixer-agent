#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runFixer } from './agent.js';
import { DEFAULTS, type Config } from './config.js';
import { preflight } from './preflight.js';

const HELP = `modello-fixer --project <course-root> [--spec <file>]... [--write] [options]

  --project <dir>        Course root containing the modello setup (required)
  --spec <file>          Generated spec to fix (repeatable). Default: all specs
  --write                Apply changes. Without it nothing is written (dry-run)
  --model-dir <dir>      Model config directory relative to project (default ${DEFAULTS.modelDir})
  --max-attempts <n>     Max Cypress runs (default ${DEFAULTS.maxAttempts})
  --max-budget-usd <n>   Spend cap for the agent (default ${DEFAULTS.maxBudgetUsd})
  --model <id>           Claude model (default ${DEFAULTS.model})
  --run-cmd <template>   Placeholders {spec} {report}
  --local                Build against a local course server (needs ecc start running): ecc --script test:local
  --build-cmd <template> Override the build command (default ecc --script test:build)

Exit codes: 0 fixed/proposed, 2 unfixable, 3 no outcome reported, 1 usage error`;

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    spec: { type: 'string', multiple: true },
    write: { type: 'boolean', default: false },
    'model-dir': { type: 'string' },
    'max-attempts': { type: 'string' },
    'max-budget-usd': { type: 'string' },
    model: { type: 'string' },
    'run-cmd': { type: 'string' },
    'build-cmd': { type: 'string' },
    local: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || !values.project) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
const config: Config = {
  projectDir: path.resolve(values.project),
  modelDir: values['model-dir'] ?? DEFAULTS.modelDir,
  write: values.write ?? false,
  local: values.local ?? false,
  maxAttempts: num(values['max-attempts'], DEFAULTS.maxAttempts),
  maxBudgetUsd: num(values['max-budget-usd'], DEFAULTS.maxBudgetUsd),
  model: values.model ?? DEFAULTS.model,
  runCommand: values['run-cmd'] ?? DEFAULTS.runCommand,
  buildCommand: values['build-cmd'] ?? (values.local ? DEFAULTS.localBuildCommand : DEFAULTS.buildCommand),
};

const problems = preflight(config);
if (problems.length) {
  console.error(`Preflight failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

const { session, costUsd } = await runFixer(config, values.spec ?? []);
const { outcome, proposals } = session;
console.log('\n--- Result ---');
console.log(outcome ? `${outcome.status}: ${outcome.summary}` : 'No outcome reported by the agent.');
for (const p of proposals) {
  console.log(`${p.applied ? 'applied' : 'proposed'}: ${p.file} ${JSON.stringify(p.path)} ${JSON.stringify(p.before)} -> ${JSON.stringify(p.value)}`);
}
if (costUsd !== undefined) console.log(`cost: $${costUsd.toFixed(2)}`);
process.exit(!outcome ? 3 : outcome.status === 'unfixable' ? 2 : 0);
