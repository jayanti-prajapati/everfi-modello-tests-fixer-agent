#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULTS, type Config } from './config.js';
import { Bus } from './orchestrator/bus.js';
import { replay, runDemo } from './orchestrator/demo.js';
import { orchestrate } from './orchestrator/index.js';
import { printEvent } from './orchestrator/print.js';
import { preflight } from './preflight.js';
import { startServer } from './server/index.js';

const MODEL = 'claude-sonnet-4-5';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(REPO, 'runs');

const HELP = `modello-orchestrate [--project <course-root>] [options]

In the real course folder: runs every module spec (--concurrency at a time) and collects results,
then fixes the failing modules with one agent at a time (diagnose -> fix -> rebuild -> verify -> report),
so writes never overlap. Streams events to the terminal and the UI.

  --project <dir>        Course root (required for live runs)
  --spec <file>          Spec to include (repeatable). Default: all specs
  --concurrency <n>      Agents in parallel (default 2)
  --write                Apply changes in the course (unverified changes are reverted)
  --isolate              Instead: one agent per module in parallel, each in a private copy; verified fixes merged back
  --keep-workspaces      With --isolate: do not delete the copies afterwards
  --demo                 Scripted run: no Cypress, no model spend
  --replay <file>        Replay a saved runs/*.jsonl log
  --speed <n>            Demo/replay speed (default 1)
  --serve                Start the UI server (runs are started from the browser)
  --port <n>             UI server port (default 4317)
  --model <id>           Claude model (default ${MODEL})
  --max-attempts, --max-budget-usd (per agent), --model-dir, --run-cmd, --build-cmd, --local: as in modello-fixer

Logs: runs/<runId>.jsonl. Exit codes: 0 all passed/fixed/proposed, 2 any unfixable, 3 any agent error, 1 usage.`;

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    spec: { type: 'string', multiple: true },
    concurrency: { type: 'string' },
    write: { type: 'boolean', default: false },
    isolate: { type: 'boolean', default: false },
    'keep-workspaces': { type: 'boolean', default: false },
    demo: { type: 'boolean', default: false },
    replay: { type: 'string' },
    speed: { type: 'string' },
    serve: { type: 'boolean', default: false },
    port: { type: 'string' },
    model: { type: 'string' },
    'model-dir': { type: 'string' },
    'max-attempts': { type: 'string' },
    'max-budget-usd': { type: 'string' },
    'run-cmd': { type: 'string' },
    'build-cmd': { type: 'string' },
    local: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
if (values.help || (!values.project && !values.demo && !values.replay && !values.serve)) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

const concurrency = num(values.concurrency, 2);
const speed = num(values.speed, 1);
const config: Config | undefined = values.project
  ? {
      projectDir: path.resolve(values.project),
      modelDir: values['model-dir'] ?? DEFAULTS.modelDir,
      write: values.write ?? false,
      local: values.local ?? false,
      maxAttempts: num(values['max-attempts'], DEFAULTS.maxAttempts),
      maxBudgetUsd: num(values['max-budget-usd'], DEFAULTS.maxBudgetUsd),
      model: values.model ?? MODEL,
      runCommand: values['run-cmd'] ?? DEFAULTS.runCommand,
      buildCommand: values['build-cmd'] ?? (values.local ? DEFAULTS.localBuildCommand : DEFAULTS.buildCommand),
    }
  : undefined;
const problems = config ? preflight(config) : ['no --project given'];

const live = (bus: Bus) =>
  orchestrate({ config: config!, specs: values.spec ?? [], concurrency, isolate: values.isolate ?? false, ledgerFile: path.join(REPO, 'runs', 'fix-ledger.json'), keepWorkspaces: values['keep-workspaces'], bus });

if (values.serve) {
  const port = num(values.port, 4317);
  startServer({
    port,
    staticDir: path.join(REPO, 'ui', 'dist'),
    logDir: LOG_DIR,
    liveAvailable: problems.length === 0,
    info: {
      model: config?.model ?? values.model ?? MODEL,
      runtime: 'claude-agent-sdk',
      project: config?.projectDir,
      write: config?.write ?? false,
      concurrency,
      problems,
    },
    start: (mode, bus) => (mode === 'live' ? live(bus) : runDemo({ bus, concurrency, speed, model: values.model ?? MODEL })),
  });
  console.log(`Orchestrator UI on http://localhost:${port}`);
  if (problems.length) console.log(`Live runs disabled: ${problems.join('; ')}`);
} else {
  if (!values.demo && !values.replay && problems.length) {
    console.error(`Preflight failed:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  const bus = new Bus({ logDir: LOG_DIR });
  bus.subscribe(printEvent);
  if (values.replay) await replay(path.resolve(values.replay), bus, speed);
  else if (values.demo) await runDemo({ bus, concurrency, speed, model: values.model ?? MODEL });
  else await live(bus);
  console.log(`\nlog: ${bus.logFile}`);
  const finished = bus.history.flatMap((e) => (e.type === 'agent.finished' ? [e.status] : []));
  process.exit(finished.includes('error') ? 3 : finished.includes('unfixable') ? 2 : 0);
}
