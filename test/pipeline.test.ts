import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FixerHooks } from '../src/agent.js';
import { DEFAULTS, type Config } from '../src/config.js';
import type { Patch } from '../src/guard.js';
import { Bus } from '../src/orchestrator/bus.js';
import { initialState, reduce } from '../src/orchestrator/reducer.js';
import { commitPaths } from '../src/pipeline/git.js';
import { runPipeline, type PushRequest } from '../src/pipeline/index.js';

// Only the Claude call is faked: each "agent" drives its real Session in its workspace.
const fakePatches: Record<string, Omit<Patch, 'file'>> = {};
/** Specs whose module breaks again in the checkout right after the agent verified its fix */
const breakAfterFix = new Set<string>();
vi.mock('../src/agent.js', () => ({
  runFixer: async (config: Config, specs: string[], _log: unknown, hooks: FixerHooks) => {
    const s = hooks.session!;
    const spec = specs[0];
    await s.runSpec(spec);
    const p = fakePatches[spec];
    if (p) {
      s.setValue({ file: 'model-parameters.json', ...p });
      await s.rebuild();
      await s.runSpec(spec);
      if (breakAfterFix.has(spec)) fs.writeFileSync(path.join(config.projectDir, 'FAIL_IN_CHECKOUT'), '');
    }
    s.outcome = { status: p ? 'fixed' : 'proposed', summary: p ? `fixed ${spec}` : `${spec} passed` };
    return { session: s, costUsd: 0.01 };
  },
}));

const PARAMS = { '&common': { p1: { b: { selector: '#old1' } }, p2: { b: { selector: '#old2' } } } };
const SPECS = ['c-m1-s3.js', 'c-m2-s3.js'];

let root: string;
let course: string;
let origin: string;
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const paramsIn = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'test/ui/model-parameters.json'), 'utf8'));

beforeEach(() => {
  for (const k of Object.keys(fakePatches)) delete fakePatches[k];
  breakAfterFix.clear();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-')));
  origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  course = path.join(root, 'course');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'develop', origin]);
  execFileSync('git', ['init', '-q', '-b', 'develop', seed]);
  write(seed, '.github/workflows/build-and-test.yml', 'name: build and test\n');
  write(seed, '.gitignore', 'test/ui/cypress/\n');
  write(seed, 'app/content.yml', 'title: course\n');
  write(seed, 'test/ui/model-parameters.json', JSON.stringify(PARAMS, null, 4) + '\n');
  write(seed, 'test/ui/config/cypress.config.js', 'module.exports = {};\n');
  for (const [k, v] of [['user.name', 'T'], ['user.email', 't@example.com']]) sh(seed, 'config', k, v);
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-q', '-m', 'init');
  sh(seed, 'remote', 'add', 'origin', origin);
  sh(seed, 'push', '-q', 'origin', 'develop');
  execFileSync('git', ['clone', '-q', origin, course]);
  for (const [k, v] of [['user.name', 'T'], ['user.email', 't@example.com']]) sh(course, 'config', k, v);
  // Fake ECC test build: (re)generates the specs. The fake modello run is test/helpers/fake-run.cjs.
  write(root, 'gen.cjs', `const fs=require('fs');fs.mkdirSync('test/ui/cypress/e2e',{recursive:true});for(const s of ${JSON.stringify(SPECS)})fs.writeFileSync('test/ui/cypress/e2e/'+s,'// spec');`);
});

const pushes: PushRequest[] = [];
async function run(over: { confirm?: boolean; maxTotalUsd?: number; concurrency?: number } = {}) {
  pushes.length = 0;
  // Every module with a fake patch starts broken: its spec fails until the value changes.
  const broken: Record<string, [string[], unknown]> = {};
  for (const [spec, p] of Object.entries(fakePatches)) {
    broken[/-(m\d+)-/.exec(spec)![1]] = [p.path, p.path.reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k], PARAMS)];
  }
  fs.writeFileSync(path.join(root, 'broken.json'), JSON.stringify(broken));
  const bus = new Bus();
  const config: Config = {
    ...DEFAULTS,
    projectDir: course,
    write: true,
    local: false,
    buildCommand: `node ${path.join(root, 'gen.cjs')}`,
    runCommand: `node ${path.join(__dirname, 'helpers', 'fake-run.cjs')} {report} {spec} ${path.join(root, 'broken.json')}`,
  };
  const result = await runPipeline({
    config,
    concurrency: over.concurrency ?? 2,
    bus,
    reportRoot: path.join(root, 'runs'),
    courseBuildCommand: 'true',
    installCommand: 'true',
    cypressVerifyCommand: null,
    checkTools: () => [],
    workspaceRoot: path.join(root, 'ws'),
    maxTotalUsd: over.maxTotalUsd,
    confirmPush: async (req) => {
      pushes.push(req);
      return over.confirm ?? true;
    },
  });
  return { ...result, state: bus.history.reduce(reduce, initialState) };
}

const remoteBranches = () => sh(course, 'ls-remote', '--heads', 'origin');

describe('fix-course pipeline', () => {
  it('fixes, commits only the model file on a test/ branch, and pushes when confirmed', async () => {
    fakePatches['c-m1-s3.js'] = { path: ['&common', 'p1', 'b', 'selector'], value: '#new1' };
    write(course, 'test/ui/config/cypress.config.js', 'module.exports = { local: true };\n'); // local-only edit

    const { ok, report, reportFile, state } = await run();

    expect(ok).toBe(true);
    expect(report.branch).toMatch(/^test\/modello-fixes-\d{8}-\d{6}$/);
    expect(sh(course, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(report.branch);
    expect(report.committedFiles).toEqual(['test/ui/model-parameters.json']);
    expect(paramsIn(course)['&common'].p1.b.selector).toBe('#new1');
    expect(sh(course, 'log', '-1', '--format=%s')).toBe('fix(test): modello config fixes for m1');
    // The local-only edit is still there, uncommitted.
    expect(sh(course, 'status', '--porcelain', '--untracked-files=no')).toBe('M test/ui/config/cypress.config.js');
    expect(report.pushed).toBe(true);
    expect(pushes[0].files).toEqual(['test/ui/model-parameters.json']);
    expect(remoteBranches()).toContain(`refs/heads/${report.branch}`);
    expect(report.verify).toEqual([{ agentId: 'm1', spec: 'c-m1-s3.js', passed: true, reverted: [] }]);
    expect(fs.readFileSync(reportFile, 'utf8')).toContain('fixed and verified');
    expect(state.pipeline?.status).toBe('ok');
    expect(Object.values(state.pipeline!.stages).every((s) => s.status === 'done')).toBe(true);
  });

  it('commits but does not push without confirmation', async () => {
    fakePatches['c-m2-s3.js'] = { path: ['&common', 'p2', 'b', 'selector'], value: '#new2' };
    const { ok, report, state } = await run({ confirm: false });
    expect(ok).toBe(true);
    expect(report.commit).toBeTruthy();
    expect(report.pushed).toBe(false);
    expect(remoteBranches()).not.toContain('modello-fixes');
    expect(state.pipeline?.stages.push.status).toBe('skipped');
  });

  it('refuses a dirty tree before creating a branch', async () => {
    write(course, 'app/content.yml', 'title: edited\n');
    const { ok, report, state } = await run();
    expect(ok).toBe(false);
    expect(report.error).toMatch(/uncommitted changes: app\/content.yml/);
    expect(state.pipeline?.stages.preflight.status).toBe('failed');
    expect(sh(course, 'branch', '--format=%(refname:short)')).toBe('develop');
  });

  it('deletes the branch and returns to the original one when nothing needs fixing', async () => {
    const { ok, report, state } = await run();
    expect(ok).toBe(true);
    expect(report.commit).toBeUndefined();
    expect(report.agents.map((a) => a.status)).toEqual(['passed', 'passed']);
    expect(sh(course, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
    expect(sh(course, 'branch', '--format=%(refname:short)')).toBe('develop');
    expect(state.pipeline?.stages.commit.status).toBe('skipped');
  });

  it('reverts a fix that fails again in the checkout and commits nothing', async () => {
    fakePatches['c-m1-s3.js'] = { path: ['&common', 'p1', 'b', 'selector'], value: '#new1' };
    breakAfterFix.add('c-m1-s3.js');
    const { ok, report } = await run();
    expect(ok).toBe(true);
    expect(report.verify[0]).toMatchObject({ agentId: 'm1', passed: false, reverted: [['&common', 'p1', 'b', 'selector']] });
    expect(paramsIn(course)['&common'].p1.b.selector).toBe('#old1');
    expect(report.commit).toBeUndefined();
    expect(sh(course, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
  });

  it('returns to the original branch and deletes the empty fix branch when a stage fails', async () => {
    write(root, 'fail.cjs', `console.error('Error: Could not find components'); console.log('#0 stack'); process.exit(1);`);
    const bus = new Bus();
    const res = await runPipeline({
      config: { ...DEFAULTS, projectDir: course, write: true, local: false, buildCommand: 'true', runCommand: 'true' },
      concurrency: 1,
      bus,
      reportRoot: path.join(root, 'runs'),
      installCommand: 'true',
      cypressVerifyCommand: null,
      courseBuildCommand: `node ${path.join(root, 'fail.cjs')}`,
      checkTools: () => [],
      confirmPush: async () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.report.error).toMatch(/course build failed \(exit 1\): Error: Could not find components/);
    expect(res.report.error).not.toMatch(/#0 stack/);
    expect(res.report.branch).toBeUndefined();
    expect(sh(course, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
    expect(sh(course, 'branch', '--format=%(refname:short)')).toBe('develop');
  });

  it('stops starting agents once the total budget is spent', async () => {
    fakePatches['c-m1-s3.js'] = { path: ['&common', 'p1', 'b', 'selector'], value: '#new1' };
    fakePatches['c-m2-s3.js'] = { path: ['&common', 'p2', 'b', 'selector'], value: '#new2' };
    const { report } = await run({ maxTotalUsd: 0.005, concurrency: 1 });
    expect(report.agents.map((a) => a.status)).toEqual(['fixed', 'skipped']);
  });
});

describe('fix branches', () => {
  it('removes a leftover empty fix branch it starts on and returns to develop', async () => {
    sh(course, 'switch', '-q', '-c', 'test/modello-fixes-20260101-000000', 'origin/develop');
    const { ok, report } = await run(); // nothing to fix
    expect(ok).toBe(true);
    expect(report.originalBranch).toBe('develop');
    expect(sh(course, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
    expect(sh(course, 'branch', '--format=%(refname:short)')).toBe('develop');
  });

  it('picks a new name when the branch already exists with work on it', async () => {
    fakePatches['c-m1-s3.js'] = { path: ['&common', 'p1', 'b', 'selector'], value: '#new1' };
    const first = await run({ confirm: false });
    sh(course, 'switch', '-q', 'develop');
    sh(course, 'branch', '-q', '-m', first.report.branch!, 'test/modello-fixes-keep');
    sh(course, 'branch', '-q', 'test/modello-fixes-keep-copy', 'test/modello-fixes-keep');
    // Same timestamp for both names: the second run must not collide with a branch that has a commit.
    const { uniqueBranchName } = await import('../src/pipeline/git.js');
    expect(await uniqueBranchName(course, 'test/modello-fixes-keep')).toBe('test/modello-fixes-keep-2');
  });

  it('restores the original branch after an interrupt when nothing was committed', async () => {
    const { activeRun, restoreAfterInterrupt } = await import('../src/pipeline/index.js');
    sh(course, 'switch', '-q', '-c', 'test/modello-fixes-x', 'origin/develop');
    activeRun.set(course, { original: 'develop', branch: 'test/modello-fixes-x', allowDirty: [], committed: false });
    expect(restoreAfterInterrupt()[0]).toMatch(/back on develop/);
    expect(sh(course, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop');
    expect(sh(course, 'branch', '--format=%(refname:short)')).toBe('develop');
  });
});

describe('commitPaths', () => {
  it('refuses to commit when anything outside the allowlist changed', async () => {
    sh(course, 'switch', '-q', '-c', 'test/x');
    write(course, 'test/ui/model-parameters.json', '{}\n');
    write(course, 'app/content.yml', 'title: edited\n');
    await expect(commitPaths(course, 'test/x', ['test/ui/model-parameters.json'], [], 'm')).rejects.toThrow(/app\/content.yml/);
  });

  it('refuses protected branches', async () => {
    await expect(commitPaths(course, 'develop', ['test/ui/model-parameters.json'], [], 'm')).rejects.toThrow(/refusing/);
  });
});
