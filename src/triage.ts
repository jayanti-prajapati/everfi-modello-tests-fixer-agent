// Rule-based triage of a spec run, before any AI: environment failures are not model-config
// problems, so they go straight to a human with the line that proves it.
import type { Failure } from './failures.js';

export interface SpecRun {
  status: string;
  exitCode?: number | null;
  timedOut?: boolean;
  outputTail?: string;
  failures?: Failure[];
}

const ENVIRONMENT: { re: RegExp; reason: string }[] = [
  { re: /MODULE_NOT_FOUND|bad option: --no-sandbox|ELECTRON_RUN_AS_NODE/, reason: 'Cypress/Electron could not start' },
  { re: /Cypress could not verify|Cypress failed to start|The cypress npm package is installed, but the Cypress binary is missing/i, reason: 'Cypress binary problem' },
  { re: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|net::ERR_[A-Z_]+/, reason: 'course or service unreachable (network)' },
  { re: /cy\.visit\(\) failed|failed trying to load:/i, reason: 'course page did not load' },
  { re: /\b(401|403)\b.*(Unauthorized|Forbidden)|status code (401|403)/i, reason: 'authentication or permission failure' },
  { re: /APPLITOOLS_API_KEY|Applitools.{0,40}api ?key/i, reason: 'Applitools API key missing (disable Applitools locally or set the key)' },
  { re: /ENOSPC|no space left on device/i, reason: 'disk full' },
];

/** The first line of `text` that matches `re`, trimmed, for evidence. */
function evidence(text: string, re: RegExp): string {
  const line = text.split('\n').find((l) => re.test(l)) ?? '';
  return line.trim().slice(0, 240);
}

/**
 * Returns a human-readable reason when the run failed for environmental reasons, else undefined
 * (the failure may be a model-config problem and goes on to recipes or an agent).
 */
export function environmentProblem(run: SpecRun): string | undefined {
  const texts = [run.outputTail ?? '', ...(run.failures ?? []).map((f) => `${f.message}\n${f.stack}`)];
  for (const { re, reason } of ENVIRONMENT) {
    for (const t of texts) if (re.test(t)) return `${reason}: ${evidence(t, re)}`;
  }
  if (run.status === 'no_report') {
    return run.timedOut ? 'Cypress timed out without producing a report' : `Cypress produced no test report (exit ${run.exitCode ?? '?'})`;
  }
  return undefined;
}

/** Signature used to group the same failure across modules and to look fixes up in the ledger. */
export function failureSignature(run: SpecRun): string | undefined {
  const f = run.failures?.[0];
  if (!f) return undefined;
  return f.message.replace(/\d+ms/g, 'Nms').replace(/\s+/g, ' ').slice(0, 300);
}
