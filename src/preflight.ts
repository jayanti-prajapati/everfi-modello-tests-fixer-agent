import fs from 'node:fs';
import path from 'node:path';
import { absModelDir, type Config } from './config.js';

const onPath = (bin: string, env = process.env.PATH ?? ''): boolean =>
  env.split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));

/** Returns human-readable problems that would make a run fail late or confusingly. */
export function preflight(config: Config, pathEnv?: string): string[] {
  const problems: string[] = [];
  const firstWord = (cmd: string) => cmd.trim().split(/\s+/)[0];
  const need = (bin: string, why: string) => {
    if (!onPath(bin, pathEnv)) problems.push(`\`${bin}\` not found on PATH (${why})`);
  };

  if (!fs.existsSync(config.projectDir)) problems.push(`project directory not found: ${config.projectDir}`);
  if (!fs.existsSync(absModelDir(config))) problems.push(`model directory not found: ${absModelDir(config)}`);
  need(firstWord(config.runCommand), 'run command');

  if (firstWord(config.buildCommand) === 'ecc') {
    need('ecc', 'build command; install from the EverFi Content Compiler');
    need('yq', 'ECC reads build-and-test.yml with yq; `brew install yq`');
    need('modello', 'ECC calls modello build');
    const workflow = path.join(config.projectDir, '.github/workflows/build-and-test.yml');
    const regression = path.join(absModelDir(config), 'regression-tests.sh');
    if (!fs.existsSync(workflow) && !fs.existsSync(regression)) {
      problems.push('neither .github/workflows/build-and-test.yml nor test/ui/regression-tests.sh exists; ECC has nothing to build');
    }
  } else {
    need(firstWord(config.buildCommand), 'build command');
  }
  return problems;
}
