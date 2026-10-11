import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { absModelDir, absSpecDir, fill, type Config } from './config.js';
import { enrichFailures, parseJUnit } from './failures.js';
import { applyPatch, GuardError, resolveModelFile, serializeLike, type Patch } from './guard.js';
import { runShell } from './shell.js';

export type Outcome = { status: 'fixed' | 'proposed' | 'unfixable'; summary: string };

export interface Proposal extends Patch {
  before: unknown;
  applied: boolean;
}

const SAFE_NAME = /^[\w.-]+$/;

/** Mutable state and side effects for one fixer run. All guarded I/O goes through here. */
export class Session {
  runs = 0;
  proposals: Proposal[] = [];
  outcome?: Outcome;

  constructor(readonly config: Config) {}

  private specPath(spec: string): string {
    if (!SAFE_NAME.test(spec)) throw new GuardError(`invalid spec name "${spec}"`);
    const p = path.join(absSpecDir(this.config), spec);
    if (!fs.existsSync(p)) throw new GuardError(`spec "${spec}" not found in ${absSpecDir(this.config)}`);
    return p;
  }

  listSpecs(): string[] {
    const dir = absSpecDir(this.config);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort() : [];
  }

  async runSpec(spec: string) {
    if (this.runs >= this.config.maxAttempts) {
      throw new GuardError(`attempt limit reached (${this.config.maxAttempts} runs); stop and report`);
    }
    const specPath = this.specPath(spec);
    this.runs++;
    const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-report-')), 'junit.xml');
    // Absolute on purpose: `modello run` launches Cypress from modello's own install dir,
    // so a project-relative --spec would resolve there and match nothing.
    const cmd = fill(this.config.runCommand, { spec: path.resolve(specPath), report });
    const res = await runShell(cmd, this.config.projectDir);
    if (!fs.existsSync(report)) {
      return { status: 'no_report', exitCode: res.code, timedOut: res.timedOut, outputTail: res.output };
    }
    const failures = enrichFailures(parseJUnit(fs.readFileSync(report, 'utf8')), absSpecDir(this.config));
    return { status: failures.length === 0 && res.code === 0 ? 'passed' : 'failed', exitCode: res.code, failures };
  }

  setValue(patch: Patch) {
    const file = resolveModelFile(absModelDir(this.config), patch.file);
    const original = fs.readFileSync(file, 'utf8');
    const result = applyPatch(JSON.parse(original), patch);
    const applied = this.config.write;
    if (applied) fs.writeFileSync(file, serializeLike(original, result.json));
    this.proposals.push({ ...patch, before: result.before, applied });
    return { ...patch, before: result.before, created: result.created, applied };
  }

  /** Regenerates all specs (ECC rebuilds every test the course defines; there is no per-scope build). */
  async rebuild() {
    if (!this.config.write) throw new GuardError('rebuild is disabled in dry-run mode');
    const res = await runShell(this.config.buildCommand, this.config.projectDir);
    return { exitCode: res.code, outputTail: res.output, specsAfterBuild: this.listSpecs() };
  }
}
