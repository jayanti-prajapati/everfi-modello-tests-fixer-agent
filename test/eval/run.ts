// Paid evaluation: `npm run eval -- --yes [--max-total-usd 1] [--model <id>] [--concurrency 2] [--verbose]`
// Builds the fixture course in a temp dir and runs the real orchestrator on it with real agents
// (fake ECC build and fake Cypress, so only the Claude calls cost money). Prints, per module,
// expected vs actual status, whether the final selector is right, the method and the cost.
// Exit codes: 0 all as expected, 1 any wrong change to the model, 2 other mismatches, 64 usage.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULTS, type Config } from '../../src/config.js';
import { Bus } from '../../src/orchestrator/bus.js';
import { orchestrate } from '../../src/orchestrator/index.js';
import { printEvent } from '../../src/orchestrator/print.js';
import { CASES, expectedFinal } from './cases.js';
import { createFixtureCourse, FAKE_CYPRESS, FAKE_GEN, selectorIn } from './fixture.js';

const { values } = parseArgs({
  options: {
    yes: { type: 'boolean', default: false },
    'max-total-usd': { type: 'string', default: '1' },
    // Same model as fix-course/orchestrate, so the eval measures what actually runs.
    model: { type: 'string', default: 'claude-sonnet-4-5' },
    concurrency: { type: 'string', default: '2' },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

const maxTotalUsd = Number(values['max-total-usd']);
const concurrency = Number(values.concurrency);
if (values.help || !Number.isFinite(maxTotalUsd) || maxTotalUsd < 0 || !(concurrency >= 1)) {
  console.log('usage: npm run eval -- --yes [--max-total-usd 1] [--model <id>] [--concurrency 2] [--verbose]');
  process.exit(values.help ? 0 : 64);
}

const plan = [
  `Modello Tests Fixer evaluation (${CASES.length} modules)`,
  `  model: ${values.model}   total budget: $${maxTotalUsd}   per agent: $${Math.min(DEFAULTS.maxBudgetUsd, maxTotalUsd)}`,
  '  course: a fixture in a new temp dir; build = test/eval/fake-gen.cjs, run = test/eval/fake-cypress.cjs',
  '  cases:',
  ...CASES.map((c) => `    ${c.module}  ${c.title.padEnd(48)} expect ${c.expectAgent}${c.expectSelector === 'unchanged' ? '' : ` -> ${c.expectSelector}`}`),
];
if (!values.yes) {
  console.log(plan.join('\n'));
  console.log('\nThis starts real Claude agents and spends money (up to the total budget). Re-run with --yes to go ahead.');
  process.exit(64);
}
console.log(plan.join('\n') + '\n');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modello-eval-'));
const course = createFixtureCourse(root);
execFileSync('node', [FAKE_GEN], { cwd: course, stdio: 'ignore' });
const config: Config = {
  ...DEFAULTS,
  projectDir: course,
  write: true,
  local: false,
  model: values.model!,
  maxBudgetUsd: Math.min(DEFAULTS.maxBudgetUsd, maxTotalUsd),
  buildCommand: `node ${FAKE_GEN}`,
  runCommand: `node ${FAKE_CYPRESS} {report} {spec}`,
};

const bus = new Bus({ logDir: path.join(root, 'runs') });
if (values.verbose) bus.subscribe(printEvent);
else bus.subscribe((e) => e.type === 'agent.finished' && console.log(`  ${e.agentId}: ${e.status}`));

// A fresh, empty fix ledger, so earlier verified fixes cannot answer for the agents.
const ledgerFile = path.join(root, 'fix-ledger.json');
const started = Date.now();
const result = await orchestrate({ config, specs: [], concurrency, isolate: false, bus, maxTotalUsd, ledgerFile });

type Row = { module: string; expected: string; actual: string; statusOk: boolean; selector: string; selectorOk: boolean; wrongChange: boolean; method: string; cost: number };
const rows: Row[] = CASES.map((c) => {
  const a = result.agents.find((x) => x.module === c.module);
  const final = selectorIn(course, c.page) ?? '(missing)';
  const want = expectedFinal(c);
  const actual = a?.status ?? '(none)';
  return {
    module: c.module,
    expected: c.expectAgent,
    actual,
    statusOk: actual === c.expectAgent,
    selector: final,
    selectorOk: final === want,
    // A change to anything other than the expected value (including any change where none is expected).
    wrongChange: final !== c.initial && final !== want,
    method: (a as { method?: string } | undefined)?.method ?? '-',
    cost: a?.costUsd ?? 0,
  };
});

const cols = ['module', 'expected', 'actual', 'status', 'selector ok', 'final selector', 'method', 'cost'];
const table = rows.map((r) => [
  r.module,
  r.expected,
  r.actual,
  r.statusOk ? 'ok' : 'WRONG',
  r.wrongChange ? 'WRONG CHANGE' : r.selectorOk ? 'yes' : 'no (unchanged)',
  r.selector,
  r.method,
  `$${r.cost.toFixed(3)}`,
]);
const widths = cols.map((h, i) => Math.max(h.length, ...table.map((t) => t[i].length)));
const line = (cells: string[]) => cells.map((s, i) => s.padEnd(widths[i])).join('  ');
console.log('\n' + line(cols));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const t of table) console.log(line(t));

const total = rows.reduce((s, r) => s + r.cost, 0);
const good = rows.filter((r) => r.statusOk && r.selectorOk).length;
const wrong = rows.filter((r) => r.wrongChange);
console.log(
  `\n${good}/${rows.length} as expected; ${wrong.length} wrong change(s); cost $${total.toFixed(3)}; ${((Date.now() - started) / 1000).toFixed(0)}s`,
);
console.log(`course: ${course}\nlog: ${bus.logFile}`);
if (wrong.length) console.log(`FAIL: wrong change in ${wrong.map((r) => r.module).join(', ')}`);
process.exit(wrong.length ? 1 : good === rows.length ? 0 : 2);
