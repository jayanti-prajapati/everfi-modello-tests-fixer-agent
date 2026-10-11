import path from 'node:path';

export interface Config {
  /** Course root (where `modello` is run from) */
  projectDir: string;
  /** Directory holding model-*.json, relative to projectDir */
  modelDir: string;
  write: boolean;
  maxAttempts: number;
  model: string;
  maxBudgetUsd: number;
  /** Operator-supplied shell templates. Placeholders: {spec} {report} {scope} */
  runCommand: string;
  buildCommand: string;
}

export const DEFAULTS = {
  modelDir: 'test/ui',
  maxAttempts: 3,
  model: 'claude-sonnet-5-5',
  maxBudgetUsd: 5,
  runCommand:
    'modello run -- cypress run --spec {spec} --reporter junit --reporter-options mochaFile={report},toConsole=false',
  buildCommand: 'modello build --scope {scope} --platform s3 --environment s3.amazonaws.com',
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
