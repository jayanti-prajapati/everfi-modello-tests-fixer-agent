#!/usr/bin/env node
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULTS, type Config } from './config.js';
import { Bus } from './orchestrator/bus.js';
import { printEvent } from './orchestrator/print.js';
import { activeWorkspaces, removeWorkspace } from './orchestrator/workspace.js';
import { LOCAL_ONLY, runPipeline, type PushRequest } from './pipeline/index.js';
import { startServer } from './server/index.js';

const MODEL = 'claude-sonnet-4-5';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `fix-course --project <course-root> [options]

Local fix pipeline for a real course checkout:
  preflight -> branch (test/modello-fixes-<time> from origin/develop) -> install deps (yarn, lockfile)
  -> build course (ecc build --split)
  -> generate tests (ecc --script test:build) -> run + fix every module (parallel agents, isolated copies)
  -> final verify in the checkout -> report -> commit ONLY test/ui/model-*.json -> push after y/N.
CI (build and test, on test/**) verifies the pushed branch. You raise the PR and merge.

  --project <dir>          Course checkout (git repo root, clean tree) (required)
  --concurrency <n>        Module agents in parallel (default 2)
  --push                   Push without asking (default: ask y/N; never pushes without a TTY)
  --serve                  Show the live UI on http://localhost:<port> while it runs
  --port <n>               UI port (default 4317)
  --skip-install           Do not run the dependency install
  --install-cmd <c>        Dependency install (default "yarn install --frozen-lockfile --prefer-offline")
  --skip-course-build      Reuse the existing compiled course in public/
  --course-build-cmd <c>   Course build command (default "ecc build --split")
  --build-cmd <c>          Test generation command (default "${DEFAULTS.buildCommand}")
  --base <branch>          Base branch on origin (default develop)
  --allow-dirty <path>     Extra local-only file that may be modified (repeatable; default ${LOCAL_ONLY.join(', ')})
  --max-budget-usd <n>     Spend cap per agent (default ${DEFAULTS.maxBudgetUsd})
  --max-total-usd <n>      Stop starting agents once this much is spent
  --max-attempts <n>       Cypress runs per agent (default ${DEFAULTS.maxAttempts})
  --model <id>             Claude model (default ${MODEL})
  --model-dir <dir>, --run-cmd <c>: as in modello-fixer

Report: runs/<runId>/report.md. Exit codes: 0 completed and every module passed or was fixed,
2 completed but some modules need a human, 1 a stage failed or usage error.`;

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    concurrency: { type: 'string' },
    push: { type: 'boolean', default: false },
    serve: { type: 'boolean', default: false },
    port: { type: 'string' },
    'skip-course-build': { type: 'boolean', default: false },
    'skip-install': { type: 'boolean', default: false },
    'install-cmd': { type: 'string' },
    'course-build-cmd': { type: 'string' },
    'build-cmd': { type: 'string' },
    base: { type: 'string' },
    'allow-dirty': { type: 'string', multiple: true },
    'max-budget-usd': { type: 'string' },
    'max-total-usd': { type: 'string' },
    'max-attempts': { type: 'string' },
    model: { type: 'string' },
    'model-dir': { type: 'string' },
    'run-cmd': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || !values.project) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

const num = (v: string | undefined, d?: number) => (v === undefined ? d : Number(v));
const config: Config = {
  projectDir: path.resolve(values.project),
  modelDir: values['model-dir'] ?? DEFAULTS.modelDir,
  write: true,
  local: false,
  maxAttempts: num(values['max-attempts'], DEFAULTS.maxAttempts)!,
  maxBudgetUsd: num(values['max-budget-usd'], DEFAULTS.maxBudgetUsd)!,
  model: values.model ?? MODEL,
  runCommand: values['run-cmd'] ?? DEFAULTS.runCommand,
  buildCommand: values['build-cmd'] ?? DEFAULTS.buildCommand,
};

const bus = new Bus({ logDir: path.join(REPO, 'runs') });
bus.subscribe(printEvent);

if (values.serve) {
  const port = num(values.port, 4317)!;
  const ui = startServer({
    port,
    staticDir: path.join(REPO, 'ui', 'dist'),
    logDir: path.join(REPO, 'runs'),
    liveAvailable: false,
    info: { model: config.model, runtime: 'claude-agent-sdk', project: config.projectDir, write: true, concurrency: num(values.concurrency, 2), problems: ['started by fix-course'] },
    start: async () => {},
  });
  ui.attach(bus);
  console.log(`Live UI: http://localhost:${port}`);
}

// Ctrl-C: remove the isolated copies; the branch is left as is and reported.
process.once('SIGINT', () => {
  for (const ws of activeWorkspaces) removeWorkspace(ws);
  console.error('\nInterrupted. Workspaces removed. The course checkout may be on the fix branch; check `git status` there.');
  process.exit(130);
});

async function confirmPush(req: PushRequest): Promise<boolean> {
  console.log(`\nReady to push branch ${req.branch} to ${req.remote}.`);
  console.log(`Files: ${req.files.join(', ')}`);
  console.log(`\n${req.message.replace(/^/gm, '  ')}\n`);
  if (values.push) return true;
  if (!process.stdin.isTTY) {
    console.log('No terminal to confirm; not pushing (use --push to push without asking).');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Push to ${req.remote}? [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

const { ok, report, reportFile } = await runPipeline({
  config,
  concurrency: num(values.concurrency, 2)!,
  bus,
  reportRoot: path.join(REPO, 'runs'),
  confirmPush,
  baseBranch: values.base,
  courseBuildCommand: values['course-build-cmd'],
  skipCourseBuild: values['skip-course-build'],
  skipInstall: values['skip-install'],
  installCommand: values['install-cmd'],
  allowDirty: [...LOCAL_ONLY, ...(values['allow-dirty'] ?? [])],
  maxTotalUsd: num(values['max-total-usd']),
});

console.log(`\nReport: ${reportFile}`);
if (report.commit && !report.pushed) console.log(`Push later: git -C ${config.projectDir} push -u origin ${report.branch}`);
if (report.pushed && report.prUrl) console.log(`CI will run on the pushed branch. Raise the PR when it is green: ${report.prUrl}`);
if (values.serve) console.log('UI still running; Ctrl-C to exit.');
const needsHuman = report.agents.some((a) => !['passed', 'fixed'].includes(a.status)) || report.verify.some((v) => !v.passed);
const code = !ok ? 1 : needsHuman ? 2 : 0;
if (!values.serve) process.exit(code);
process.exitCode = code;
