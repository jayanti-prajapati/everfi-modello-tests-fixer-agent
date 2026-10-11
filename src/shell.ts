import { spawn } from 'node:child_process';

export interface ShellResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Runs an operator-supplied command line; returns the tail of combined output. */
export function runShell(command: string, cwd: string, timeoutMs = 20 * 60_000): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd });
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
