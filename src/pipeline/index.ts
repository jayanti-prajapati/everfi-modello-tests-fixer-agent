// Local fix pipeline for one real course checkout:
// preflight -> branch -> build course -> generate tests -> test + fix (parallel agents)
// -> final verify -> report -> commit (test generator files only) -> push (after confirmation).
// A human raises the PR and merges.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { absModelDir, type Config } from '../config.js';
import { WRITABLE_FILES } from '../guard.js';
import type { Bus } from '../orchestrator/bus.js';
import type { PipelineStage } from '../orchestrator/events.js';
import { orchestrate } from '../orchestrator/index.js';
import { revertPatches } from '../orchestrator/merger.js';
import { runPool } from '../orchestrator/scheduler.js';
import { preflight } from '../preflight.js';
import { Session } from '../session.js';
import { runShell } from '../shell.js';
import * as G from './git.js';
import { commitMessage, committedModules, renderReport, verifiedFixes, type PipelineReport, type VerifyResult } from './report.js';

/** Branch state of a pipeline in progress, so a Ctrl-C handler can put the checkout back. */
export const activeRun = new Map<string, { original: string; branch: string; allowDirty: string[]; committed: boolean }>();

/**
 * For an interrupted run (sync, for a signal handler): if nothing was committed and only allowed
 * local-only files are dirty, switch back to the original branch and delete the fix branch.
 * Returns a message describing what happened.
 */
export function restoreAfterInterrupt(): string[] {
  const notes: string[] = [];
  for (const [cwd, r] of activeRun) {
    if (r.committed) {
      notes.push(`${cwd}: left on ${r.branch} (it has a commit).`);
      continue;
    }
    try {
      const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd, encoding: 'utf8' })
        .split('\n')
        .map((l) => l.slice(3).trim())
        .filter((p) => p && !r.allowDirty.includes(p));
      if (dirty.length) {
        notes.push(`${cwd}: left on ${r.branch}; uncommitted changes in ${dirty.join(', ')}.`);
        continue;
      }
      G.abandonBranchSync(cwd, r.original, r.branch);
      notes.push(`${cwd}: back on ${r.original}; deleted ${r.branch}.`);
    } catch (e) {
      notes.push(`${cwd}: could not restore ${r.original} (${e instanceof Error ? e.message : e}); you are on ${r.branch}.`);
    }
  }
  activeRun.clear();
  return notes;
}

/** Edits developers keep locally and that must never block a run or be committed. */
export const LOCAL_ONLY = ['test/ui/config/cypress.config.js'];

export interface PushRequest {
  branch: string;
  files: string[];
  message: string;
  remote: string;
}

export interface PipelineOptions {
  /** Course checkout; must be the git repo root. write is forced on. */
  config: Config;
  concurrency: number;
  bus: Bus;
  /** Where report.md/json go (a folder per run is created inside) */
  reportRoot: string;
  /** Returns true to push. The CLI asks y/N; tests answer directly. */
  confirmPush: (req: PushRequest) => Promise<boolean>;
  remote?: string;
  baseBranch?: string;
  branchPrefix?: string;
  courseBuildCommand?: string;
  skipCourseBuild?: boolean;
  /** Dependency install (ECC needs the course's components resolvable); default yarn with the committed lockfile */
  installCommand?: string;
  skipInstall?: boolean;
  allowDirty?: string[];
  maxTotalUsd?: number;
  workspaceRoot?: string;
  /** Tool checks before any spend; defaults to the fixer's preflight (ecc, yq, modello, workflow file) */
  checkTools?: (c: Config) => string[];
  now?: () => Date;
}

export interface PipelineResult {
  ok: boolean;
  report: PipelineReport;
  reportFile: string;
}

class StageError extends Error {}

export const DEFAULT_INSTALL = 'yarn install --frozen-lockfile --prefer-offline';

/** The lines that say what went wrong (ECC prints the cause first, then a long stack), else the tail. */
export function failureDetail(output: string, max = 600): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((l) => /error|failed|cannot|could not|not found/i.test(l) && !/^#\d+\s/.test(l));
  return (errors.length ? errors.slice(0, 4).join(' | ') : lines.slice(-6).join(' | ')).slice(0, max);
}

export async function runPipeline(o: PipelineOptions): Promise<PipelineResult> {
  const config: Config = { ...o.config, write: true };
  const cwd = config.projectDir;
  const { bus } = o;
  const remote = o.remote ?? 'origin';
  const baseBranch = o.baseBranch ?? 'develop';
  const base = `${remote}/${baseBranch}`;
  const allowDirty = o.allowDirty ?? LOCAL_ONLY;
  const now = o.now ?? (() => new Date());
  const modelPaths = WRITABLE_FILES.map((f) => path.posix.join(config.modelDir.split(path.sep).join('/'), f));

  const report: PipelineReport = {
    runId: bus.runId,
    project: cwd,
    base,
    model: config.model,
    startedAt: now().toISOString(),
    agents: [],
    merge: [],
    verify: [],
    committedFiles: [],
    pushed: false,
    costUsd: 0,
  };
  bus.publish({ type: 'pipeline.started', project: cwd, base });

  const stage = async <T>(name: PipelineStage, fn: () => Promise<T | { skipped: string }>, detail?: (r: T) => string) => {
    bus.publish({ type: 'stage', stage: name, status: 'running' });
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'skipped' in (r as object)) {
        bus.publish({ type: 'stage', stage: name, status: 'skipped', detail: (r as { skipped: string }).skipped });
        return undefined;
      }
      bus.publish({ type: 'stage', stage: name, status: 'done', detail: detail?.(r as T) });
      return r as T;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      bus.publish({ type: 'stage', stage: name, status: 'failed', detail: msg });
      throw new StageError(`${name}: ${msg}`);
    }
  };

  let ok = false;
  try {
    // 0. Preflight: tools, repo root, clean tree, fresh base. Nothing is changed yet.
    await stage('preflight', async () => {
      const problems = (o.checkTools ?? preflight)(config);
      if (!o.skipInstall && !o.installCommand && fs.existsSync(path.join(cwd, 'package.json'))) {
        const yarn = await runShell('command -v yarn', cwd);
        if (yarn.code !== 0) problems.push('yarn not found on PATH (needed to install course dependencies; or pass --skip-install)');
      }
      if (problems.length) throw new Error(problems.join('; '));
      if (fs.realpathSync(await G.repoRoot(cwd)) !== fs.realpathSync(cwd)) throw new Error(`${cwd} is not the root of its git repo`);
      if (path.isAbsolute(config.modelDir)) throw new Error('--model-dir must be relative to the course root');
      await G.assertClean(cwd, allowDirty);
      await G.fetchBase(cwd, remote, baseBranch);
      return base;
    }, (b) => `clean tree, fetched ${b}`);

    // 1. Branch from the fresh base. CI's build-and-test runs on pushes to test/**.
    const prefix = o.branchPrefix ?? 'test/modello-fixes-';
    let branch = '';
    await stage('branch', async () => {
      // Empty, never-pushed fix branches are leftovers of interrupted runs: remove them, and
      // never treat one as "your" branch to return to.
      let current = await G.currentBranch(cwd);
      for (const b of await G.listBranches(cwd, prefix)) {
        if (!(await G.isEmptyLocalBranch(cwd, b, base, remote))) continue;
        if (b === current) {
          const fallback = (await G.branchExists(cwd, baseBranch)) ? baseBranch : undefined;
          if (!fallback) continue; // nowhere sensible to go; leave it
          await G.git(cwd, ['switch', fallback]);
          current = fallback;
        }
        await G.git(cwd, ['branch', '-D', b]);
        bus.publish({ type: 'log', level: 'info', message: `Removed leftover empty branch ${b}` });
      }
      report.originalBranch = current;
      const stamp = now().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      branch = await G.uniqueBranchName(cwd, `${prefix}${stamp}`);
      await G.createBranch(cwd, branch, base);
      activeRun.set(cwd, { original: current, branch, allowDirty, committed: false });
    }, () => `${branch} from ${base}`);
    report.branch = branch;

    // 2. Install dependencies from the committed lockfile, as CI does. ECC resolves the course's
    //    components through them; a stale .pnp.js from another checkout location breaks the build.
    await stage('install', async () => {
      if (o.skipInstall) return { skipped: '--skip-install' };
      if (!o.installCommand && !fs.existsSync(path.join(cwd, 'package.json'))) return { skipped: 'no package.json' };
      const res = await runShell(o.installCommand ?? DEFAULT_INSTALL, cwd);
      if (res.code !== 0) throw new Error(`dependency install failed (exit ${res.code}): ${failureDetail(res.output)}`);
    });

    // 3. Build the course (compiled content the test generator reads), same args as CI.
    await stage('build', async () => {
      if (o.skipCourseBuild) return { skipped: '--skip-course-build' };
      const res = await runShell(o.courseBuildCommand ?? 'ecc build --split', cwd);
      if (res.code !== 0) throw new Error(`course build failed (exit ${res.code}): ${failureDetail(res.output)}`);
    });

    // 4. Generate the specs (ECC runs the course's generate-tests-script).
    const specs = await stage('generate', async () => {
      const res = await runShell(config.buildCommand, cwd);
      if (res.code !== 0) throw new Error(`test generation failed (exit ${res.code}): ${failureDetail(res.output)}`);
      const list = new Session(config).listSpecs();
      if (list.length === 0) throw new Error('no specs were generated');
      return list;
    }, (l) => `${l.length} specs`);

    // 5/6. In the real course folder: run every spec in parallel and collect results ("test"),
    //      then fix the failing modules one agent at a time ("fix") so writes never overlap.
    bus.publish({ type: 'stage', stage: 'test', status: 'running' });
    let tested = false;
    let result;
    try {
      result = await orchestrate({
        config,
        specs: specs!,
        concurrency: o.concurrency,
        isolate: false,
        maxTotalUsd: o.maxTotalUsd,
        bus,
        onTested: (failed) => {
          tested = true;
          bus.publish({ type: 'stage', stage: 'test', status: 'done', detail: `${specs!.length - failed.length}/${specs!.length} passed` });
          bus.publish(
            failed.length
              ? { type: 'stage', stage: 'fix', status: 'running', detail: `fixing ${failed.map((f) => f.module).join(', ')} one at a time` }
              : { type: 'stage', stage: 'fix', status: 'skipped', detail: 'all specs passed' },
          );
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      bus.publish({ type: 'stage', stage: tested ? 'fix' : 'test', status: 'failed', detail: msg });
      throw new StageError(`${tested ? 'fix' : 'test'}: ${msg}`);
    }
    report.agents = result.agents;
    report.merge = result.merge;
    report.costUsd = report.agents.reduce((s, a) => s + (a.costUsd ?? 0), 0);
    if (report.agents.some((a) => a.status !== 'passed')) {
      bus.publish({ type: 'stage', stage: 'fix', status: 'done', detail: report.agents.filter((a) => a.status !== 'passed').map((a) => `${a.module} ${a.status}`).join(', ') });
    }

    // 7. Re-run all fixed modules together in the checkout (no model spend); revert fixes that fail now.
    await stage('verify', async () => {
      const fixed = verifiedFixes(report);
      if (fixed.length === 0) return { skipped: 'nothing fixed' };
      report.verify = await runPool(fixed, o.concurrency, async (a): Promise<VerifyResult> => {
        const res = await new Session({ ...config, maxAttempts: 1 }).runSpec(a.spec);
        const passed = res.status === 'passed';
        const reverted = passed ? [] : revertPatches(absModelDir(config), a.patches);
        return { agentId: a.agentId, spec: a.spec, passed, reverted };
      });
      return report.verify;
    }, (v) => v.map((x) => `${x.agentId} ${x.passed ? 'passed' : 'failed, reverted'}`).join(', '));

    // 6/7. Commit only the test generator files, after writing the report.
    const commit = async () => {
      const mods = committedModules(report);
      if (mods.length === 0) {
        await G.abandonBranch(cwd, report.originalBranch!, branch);
        report.branch = undefined;
        return { skipped: `nothing to commit; deleted ${branch}, back on ${report.originalBranch}` };
      }
      const sha = await G.commitPaths(cwd, branch, modelPaths, allowDirty, commitMessage(report));
      if (!sha) throw new Error('fixes were merged but no model file differs from the base');
      report.commit = sha;
      activeRun.get(cwd)!.committed = true;
      report.committedFiles = await G.filesInCommit(cwd, sha);
      return sha;
    };
    await stage('report', async () => writeReport(o.reportRoot, report), (f) => f);
    await stage('commit', commit, (sha) => `${String(sha).slice(0, 10)}: ${report.committedFiles.join(', ')}`);

    // 8. Push only after confirmation. Never a PR, never a merge.
    await stage('push', async () => {
      if (!report.commit) return { skipped: 'no commit' };
      const slug = await G.remoteSlug(cwd, remote);
      if (slug) report.prUrl = `https://github.com/${slug}/pull/new/${branch}`;
      const yes = await o.confirmPush({ branch, files: report.committedFiles, message: commitMessage(report), remote });
      if (!yes) return { skipped: `not confirmed; push later with: git push -u ${remote} ${branch}` };
      await G.push(cwd, remote, branch);
      report.pushed = true;
      return branch;
    }, (b) => `${remote}/${b}`);
    ok = true;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    if (!(e instanceof StageError)) bus.publish({ type: 'log', level: 'error', message: report.error });
    await leaveCleanly(cwd, report, allowDirty, bus);
  } finally {
    report.finishedAt = now().toISOString();
    activeRun.delete(cwd);
  }
  const reportFile = writeReport(o.reportRoot, report);
  bus.publish({
    type: 'pipeline.finished',
    ok,
    branch: report.branch,
    commit: report.commit,
    pushed: report.pushed,
    report: reportFile,
    prUrl: report.prUrl,
  });
  return { ok, report, reportFile };
}

/**
 * After a failure with nothing committed: if the fix branch holds no work (only allowed local-only
 * edits are dirty), go back to the original branch and delete it. Otherwise leave it for a human.
 */
async function leaveCleanly(cwd: string, report: PipelineReport, allowDirty: string[], bus: Bus): Promise<void> {
  if (!report.branch || report.commit || !report.originalBranch) return;
  try {
    const ours = (await G.changedPaths(cwd)).filter((p) => !allowDirty.includes(p));
    if (ours.length) {
      bus.publish({ type: 'log', level: 'warn', message: `Left on ${report.branch}: uncommitted changes in ${ours.join(', ')}` });
      return;
    }
    await G.abandonBranch(cwd, report.originalBranch, report.branch);
    bus.publish({ type: 'log', level: 'info', message: `Deleted empty branch ${report.branch}; back on ${report.originalBranch}.` });
    report.branch = undefined;
  } catch (e) {
    bus.publish({ type: 'log', level: 'warn', message: `Could not return to ${report.originalBranch}: ${e instanceof Error ? e.message : e}` });
  }
}

function writeReport(root: string, r: PipelineReport): string {
  const dir = path.join(root, r.runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(r, null, 2) + '\n');
  const file = path.join(dir, 'report.md');
  fs.writeFileSync(file, renderReport(r));
  return file;
}
