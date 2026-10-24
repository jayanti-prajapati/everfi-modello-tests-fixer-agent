// Git operations for the fix pipeline. Every call uses an argument array (no shell), and the
// commit step only ever stages an explicit allowlist of paths.
import { execFile } from 'node:child_process';
import { childEnv } from '../shell.js';

export class GitError extends Error {}

/** Branches the pipeline must never commit to or push. */
const PROTECTED = new Set(['develop', 'master', 'main']);

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: childEnv(), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new GitError(`git ${args.join(' ')} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

/** Tracked files with uncommitted changes (staged or not), repo-relative, forward slashes. */
export async function changedPaths(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  const entries = out.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    paths.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') paths.push(entries[++i]); // rename/copy: source path follows
  }
  return [...new Set(paths)];
}

/** Throws if anything other than the allowed local-only files has uncommitted changes. */
export async function assertClean(cwd: string, allowDirty: string[]): Promise<void> {
  const dirty = (await changedPaths(cwd)).filter((p) => !allowDirty.includes(p));
  if (dirty.length) {
    throw new GitError(`Working tree has uncommitted changes: ${dirty.join(', ')}. Commit or stash them first.`);
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function branchExists(cwd: string, name: string): Promise<boolean> {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).then(
    () => true,
    () => false,
  );
}

export async function fetchBase(cwd: string, remote: string, branch: string): Promise<void> {
  await git(cwd, ['fetch', remote, branch]);
}

/** Creates and switches to `name` at `base`; uncommitted local-only edits carry over. */
export async function createBranch(cwd: string, name: string, base: string): Promise<void> {
  if (!/^[\w./-]+$/.test(name) || name.includes('..')) throw new GitError(`invalid branch name "${name}"`);
  if (await branchExists(cwd, name)) throw new GitError(`branch ${name} already exists`);
  await git(cwd, ['switch', '-c', name, base]);
}

/** Switches back to `original` and deletes `branch` (used when there is nothing to commit). */
export async function abandonBranch(cwd: string, original: string, branch: string): Promise<void> {
  await git(cwd, ['switch', original]);
  await git(cwd, ['branch', '-D', branch]);
}

/**
 * Commits exactly `paths` on `branch`. Refuses if HEAD is not `branch`, if the branch is
 * protected, or if any tracked change outside `paths` and `allowDirty` exists.
 * Returns the new commit sha, or undefined if none of `paths` changed.
 */
export async function commitPaths(
  cwd: string,
  branch: string,
  paths: string[],
  allowDirty: string[],
  message: string,
): Promise<string | undefined> {
  if (PROTECTED.has(branch)) throw new GitError(`refusing to commit on ${branch}`);
  if ((await currentBranch(cwd)) !== branch) throw new GitError(`expected to be on ${branch}`);
  const changed = await changedPaths(cwd);
  const unexpected = changed.filter((p) => !paths.includes(p) && !allowDirty.includes(p));
  if (unexpected.length) {
    throw new GitError(`refusing to commit: unexpected changes outside the test generator files: ${unexpected.join(', ')}`);
  }
  const toCommit = paths.filter((p) => changed.includes(p));
  if (toCommit.length === 0) return undefined;
  await git(cwd, ['add', '--', ...toCommit]);
  // Commit only these paths even if something else was staged earlier.
  await git(cwd, ['commit', '-m', message, '--', ...toCommit]);
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

export async function filesInCommit(cwd: string, sha: string): Promise<string[]> {
  return (await git(cwd, ['show', '--name-only', '--pretty=format:', sha])).split('\n').filter(Boolean);
}

export async function push(cwd: string, remote: string, branch: string): Promise<void> {
  if (PROTECTED.has(branch)) throw new GitError(`refusing to push ${branch}`);
  await git(cwd, ['push', '-u', remote, branch]);
}

/** "owner/repo" from the remote URL (ssh or https), for the PR link. */
export async function remoteSlug(cwd: string, remote: string): Promise<string | undefined> {
  const url = (await git(cwd, ['remote', 'get-url', remote]).catch(() => '')).trim();
  return /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1];
}
