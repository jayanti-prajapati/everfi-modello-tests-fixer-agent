// Local fix pipeline for one real course checkout:
// preflight -> branch -> build course -> generate tests -> test + fix (parallel agents)
// -> final verify -> report -> commit (test generator files only) -> push (after confirmation).
// A human raises the PR and merges.
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
import { commitMessage, committedModules, renderReport, type PipelineReport, type VerifyResult } from './report.js';

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
    const stamp = now().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
    const branch = `${o.branchPrefix ?? 'test/modello-fixes-'}${stamp}`;
    report.originalBranch = await G.currentBranch(cwd);
    await stage('branch', () => G.createBranch(cwd, branch, base), () => `${branch} from ${base}`);
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

    // 4. Run every module's spec and fix in parallel (isolated copies, verified-only merge + one rebuild).
    const result = await stage('fix', () =>
      orchestrate({ config, specs: specs!, concurrency: o.concurrency, isolate: true, workspaceRoot: o.workspaceRoot, maxTotalUsd: o.maxTotalUsd, bus }),
      (r) => `${r.agents.map((a) => `${a.module} ${a.status}`).join(', ')}`,
    );
    report.agents = result!.agents;
    report.merge = result!.merge;
    report.costUsd = report.agents.reduce((s, a) => s + (a.costUsd ?? 0), 0);

    // 5. Re-run each fixed module in the real checkout (no model spend); revert fixes that fail here.
    await stage('verify', async () => {
      const fixed = report.agents.filter((a) => report.merge.some((m) => m.agentId === a.agentId && m.status === 'applied'));
      if (fixed.length === 0) return { skipped: 'nothing merged' };
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
