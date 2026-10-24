import { spawn } from 'node:child_process';

export interface ShellResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Environment for child commands. VS Code (and other Electron hosts) set ELECTRON_RUN_AS_NODE=1;
 * inherited by Cypress it makes the Electron binary start as plain Node, and every run dies
 * with MODULE_NOT_FOUND ("bad option: --no-sandbox" in `cypress verify`).
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _drop, ...rest } = env;
  return rest;
}

/** Runs an operator-supplied command line; returns the tail of combined output. */
export function runShell(command: string, cwd: string, timeoutMs = 20 * 60_000): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd, env: childEnv() });
    let output = '';
    const collect = (d: Buffer) => {
      output = (output + d.toString()).slice(-8000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}
