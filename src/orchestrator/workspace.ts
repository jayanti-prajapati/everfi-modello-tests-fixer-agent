import fs from 'node:fs';
import path from 'node:path';

/** Workspaces not yet removed, so an interrupted run (Ctrl-C) can clean up. */
export const activeWorkspaces = new Set<string>();

/** Not needed to build or run tests, and large. */
const SKIP = [/^\.git$/, /(^|\/)cypress\/(screenshots|videos)$/];

/**
 * Creates an isolated copy of a course for one agent, so parallel agents never share
 * `cypress/e2e` (ECC deletes and regenerates it) or the model files. Files are cloned
 * copy-on-write where the filesystem supports it (APFS), so this is fast and cheap.
 * `node_modules` directories are symlinked to the originals rather than copied.
 */
export function createWorkspace(sourceDir: string, root: string, name: string): string {
  const src = path.resolve(sourceDir);
  fs.mkdirSync(root, { recursive: true });
  const dest = fs.mkdtempSync(path.join(root, `${name.replace(/[^\w.-]/g, '_')}-`));
  try {
    fs.cpSync(src, dest, {
      recursive: true,
      mode: fs.constants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
      filter: (from, to) => {
        const rel = path.relative(src, from);
        if (SKIP.some((re) => re.test(rel))) return false;
        // lstat: a node_modules that is itself a (possibly dangling) symlink is copied as a link.
        if (path.basename(from) === 'node_modules' && fs.lstatSync(from).isDirectory()) {
          // cpSync has already created the parent directory by the time it visits a child.
          fs.symlinkSync(from, to, 'dir');
          return false;
        }
        return true;
      },
    });
  } catch (e) {
    removeWorkspace(dest);
    throw e;
  }
  activeWorkspaces.add(dest);
  return dest;
}

/**
 * Throws unless the agent's model directory resolves inside its workspace. An absolute
 * --model-dir, or a model dir symlinked to the real checkout, would let parallel agents
 * write the real files directly and bypass the merge.
 */
export function assertInside(workspace: string, modelDir: string): void {
  const ws = fs.realpathSync(workspace);
  const md = fs.realpathSync(modelDir);
  if (md !== ws && !md.startsWith(ws + path.sep)) {
    throw new Error(`Model directory ${modelDir} resolves outside the agent workspace (${md}); refusing to run isolated.`);
  }
  for (const f of fs.readdirSync(md)) {
    if (!/^model-.*\.json$/.test(f)) continue;
    const real = fs.realpathSync(path.join(md, f));
    if (!real.startsWith(ws + path.sep)) throw new Error(`${f} in the workspace links outside it (${real}); refusing to run isolated.`);
  }
}

export function removeWorkspace(dir: string): void {
  // Symlinked node_modules are removed as links; their targets are untouched.
  fs.rmSync(dir, { recursive: true, force: true });
  activeWorkspaces.delete(dir);
}
