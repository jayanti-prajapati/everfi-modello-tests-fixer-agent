import path from 'node:path';

export interface Config {
  /** Course root (where `modello` is run from) */
  projectDir: string;
  /** Directory holding model-*.json, relative to projectDir */
  modelDir: string;
  write: boolean;
  /** Build against a local course server (`ecc start` running): uses ecc's test:local script */
  local: boolean;
  maxAttempts: number;
  model: string;
  maxBudgetUsd: number;
  /** Cap on agent turns (model round trips); the budget cap still applies */
  maxTurns?: number;
  /** Operator-supplied shell templates. Placeholders: {spec} (absolute path) {report} (run only) */
  runCommand: string;
  buildCommand: string;
}

export const DEFAULTS = {
  modelDir: 'test/ui',
  maxAttempts: 3,
  model: 'claude-sonnet-5-5',
  maxBudgetUsd: 5,
  maxTurns: 20,
  runCommand:
    'modello run -- cypress run --spec {spec} --reporter junit --reporter-options mochaFile={report},toConsole=false',
  /** ECC regenerates every test defined in .github/workflows/build-and-test.yml (deletes test/ui/cypress/e2e first) */
  buildCommand: 'ecc --script test:build',
  localBuildCommand: 'ecc --script test:local',
} as const;

export const absModelDir = (c: Config) => path.resolve(c.projectDir, c.modelDir);
export const absSpecDir = (c: Config) => path.join(absModelDir(c), 'cypress', 'e2e');

/** Substitutes {placeholders}; values must already be validated by the caller. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in values)) throw new Error(`Unknown placeholder {${k}} in command template`);
    return values[k];
  });
}
