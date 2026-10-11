import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from '../src/config.js';
import { GuardError } from '../src/guard.js';
import { Session } from '../src/session.js';

const SPEC = `it('should run', function () {
  // -> page: m1/a1/page-3, block uid: c963ec41
  //    type: button
  //    parameters: selector: "#gone"
  cy.button("#gone");
});
`;
const PARAMS = JSON.stringify({ '&common': { 'm1/a1/page-3': { b: { selector: '#gone' } } } }, null, 4) + '\n';

// Fake `modello run`: writes a JUnit report pointing at spec.js line 5 (the cy.button line)
const FAKE_RUN = `node -e "require('fs').writeFileSync(process.argv[1], '<testsuites><testsuite name=\\\\'s\\\\'><testcase name=\\\\'t\\\\'><failure message=\\\\'not found\\\\'>at x (webpack:///./e2e/spec.js:5:3)</failure></testcase></testsuite></testsuites>')" {report}`;

let dir: string;
const cfg = (over: Partial<Config> = {}): Config => ({
  ...DEFAULTS,
  projectDir: dir,
  write: false,
  runCommand: FAKE_RUN,
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  fs.mkdirSync(path.join(dir, 'test/ui/cypress/e2e'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test/ui/cypress/e2e/spec.js'), SPEC);
  fs.writeFileSync(path.join(dir, 'test/ui/model-parameters.json'), PARAMS);
});

const KEY = ['&common', 'm1/a1/page-3', 'b', 'selector'];
const paramsPath = () => path.join(dir, 'test/ui/model-parameters.json');

describe('Session.runSpec', () => {
  it('returns failures enriched with block context', async () => {
    const r: any = await new Session(cfg()).runSpec('spec.js');
    expect(r.status).toBe('failed');
    expect(r.failures[0].context.page).toBe('m1/a1/page-3');
  });

  it('enforces the attempt limit', async () => {
    const s = new Session(cfg({ maxAttempts: 1 }));
    await s.runSpec('spec.js');
    await expect(s.runSpec('spec.js')).rejects.toThrow(/attempt limit/);
  });

  it('rejects traversal and missing specs', async () => {
    const s = new Session(cfg());
    await expect(s.runSpec('../x.js')).rejects.toThrow(GuardError);
    await expect(s.runSpec('nope.js')).rejects.toThrow(/not found/);
  });

  it('reports no_report when the command produces nothing', async () => {
    const r: any = await new Session(cfg({ runCommand: 'true' })).runSpec('spec.js');
    expect(r.status).toBe('no_report');
  });
});

describe('Session.setValue', () => {
  it('dry-run records a proposal without writing', () => {
    const s = new Session(cfg());
    s.setValue({ file: 'model-parameters.json', path: KEY, value: '#found' });
    expect(fs.readFileSync(paramsPath(), 'utf8')).toBe(PARAMS);
    expect(s.proposals).toMatchObject([{ before: '#gone', value: '#found', applied: false }]);
  });

  it('write mode changes only the targeted leaf and keeps formatting', () => {
    new Session(cfg({ write: true })).setValue({ file: 'model-parameters.json', path: KEY, value: '#found' });
    expect(fs.readFileSync(paramsPath(), 'utf8')).toBe(PARAMS.replace('#gone', '#found'));
  });

  it('refuses files outside the allowlist', () => {
    expect(() => new Session(cfg({ write: true })).setValue({ file: 'modello.config.json' as any, path: ['a'], value: 1 })).toThrow(GuardError);
  });
});

describe('Session.rebuild', () => {
  it('is refused in dry-run', async () => {
    await expect(new Session(cfg()).rebuild('m1')).rejects.toThrow(/dry-run/);
  });

  it('rejects unsafe scopes', async () => {
    await expect(new Session(cfg({ write: true })).rebuild('m1; rm -rf /')).rejects.toThrow(GuardError);
  });

  it('runs the build template with a safe scope', async () => {
    const r = await new Session(cfg({ write: true, buildCommand: 'echo built-{scope}' })).rebuild('m1');
    expect(r.exitCode).toBe(0);
    expect(r.outputTail).toContain('built-m1');
  });
});
