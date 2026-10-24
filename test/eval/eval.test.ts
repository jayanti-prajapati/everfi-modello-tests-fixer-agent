// Evaluation, rule-based part (no Claude): the fixture course runs through the real orchestrator
// with budget 0, so only triage rules (environment, flaky) and deterministic recipes may act.
// Agents must never start; modules that would need one end `skipped` with their model untouched.
// The paid counterpart (real agents) is test/eval/run.ts (`npm run eval -- --yes`).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, type Config } from '../../src/config.js';
import { Bus } from '../../src/orchestrator/bus.js';
import { orchestrate, type OrchestrateResult } from '../../src/orchestrator/index.js';
import { CASES, SPEC_OF, expectedFinal } from './cases.js';
import { createFixtureCourse, FAKE_CYPRESS, FAKE_GEN, selectorIn } from './fixture.js';

const agentCalls: string[] = [];
vi.mock('../../src/agent.js', () => ({
  runFixer: async (_config: unknown, specs: string[]) => {
    agentCalls.push(...specs);
    throw new Error('eval: no agent may start when maxTotalUsd is 0');
  },
}));

let course: string;
let result: OrchestrateResult;
let bus: Bus;

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modello-eval-'));
  course = createFixtureCourse(root);
  const config: Config = {
    ...DEFAULTS,
    projectDir: course,
    write: true,
    local: false,
    buildCommand: `node ${FAKE_GEN}`,
    runCommand: `node ${FAKE_CYPRESS} {report} {spec}`,
  };
  // The orchestrator tests the specs that exist; ECC would have generated them already.
  execFileSync('node', [FAKE_GEN], { cwd: course });
  bus = new Bus();
  // A fresh, empty fix ledger, so earlier verified fixes cannot answer for the recipes.
  const ledgerFile = path.join(root, 'fix-ledger.json');
  result = await orchestrate({ config, specs: [], concurrency: 2, isolate: false, bus, maxTotalUsd: 0, ledgerFile });
}, 60_000);

const agentFor = (module: string) => result.agents.find((a) => a.module === module);

describe('eval: rules and recipes only (budget 0)', () => {
  it('plans one agent per module spec', () => {
    expect(result.agents.map((a) => a.spec).sort()).toEqual(CASES.map((c) => SPEC_OF(c.module)).sort());
  });

  it('never starts an agent', () => {
    expect(agentCalls).toEqual([]);
    for (const a of result.agents) expect(a.costUsd ?? 0).toBe(0);
  });

  for (const c of CASES) {
    describe(`${c.module}: ${c.title}`, () => {
      it(`ends ${c.expectRules}`, () => {
        const a = agentFor(c.module);
        expect(a, `no result for ${c.module}`).toBeDefined();
        expect({ module: c.module, status: a!.status, summary: a!.summary }).toMatchObject({ module: c.module, status: c.expectRules });
      });

      it(c.expectSelector === 'unchanged' ? 'leaves the model selector unchanged' : `sets the selector to ${c.expectSelector}`, () => {
        expect(selectorIn(course, c.page)).toBe(expectedFinal(c));
      });

      if (c.expectMethod && c.expectRules !== 'skipped' && c.expectRules !== 'passed') {
        it(`is handled by a ${c.expectMethod}`, () => {
          expect((agentFor(c.module) as { method?: string } | undefined)?.method).toBe(c.expectMethod);
        });
      }

      if (c.expectSummary) {
        it('explains why in the summary', () => {
          expect(agentFor(c.module)?.summary).toMatch(c.expectSummary!);
        });
      }
    });
  }

  it('touches only model-parameters.json among the model files', () => {
    expect(fs.readFileSync(path.join(course, 'test/ui/model-map.json'), 'utf8')).toBe('{}\n');
    expect(fs.readFileSync(path.join(course, 'test/ui/model-edges.json'), 'utf8')).toBe('{}\n');
  });

  it('leaves the regenerated specs green for every fixed module', () => {
    for (const c of CASES.filter((x) => x.expectRules === 'fixed')) {
      const spec = fs.readFileSync(path.join(course, 'test/ui/cypress/e2e', SPEC_OF(c.module)), 'utf8');
      expect(spec).toContain(`cy.button(${JSON.stringify(c.expectSelector)})`);
    }
  });

  it('closes the run on the bus', () => {
    expect(bus.history.at(-1)?.type).toBe('run.finished');
  });
});
