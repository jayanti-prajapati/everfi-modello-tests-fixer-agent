import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, type Config } from '../src/config.js';
import { preflight } from '../src/preflight.js';

let dir: string;
let bin: string;
const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULTS, projectDir: dir, write: false, local: false, ...over });
const addBin = (...names: string[]) => names.forEach((n) => fs.writeFileSync(path.join(bin, n), ''));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-'));
  fs.mkdirSync(path.join(dir, 'test/ui'), { recursive: true });
});

describe('preflight', () => {
  it('passes with ecc, yq, modello and a build-and-test workflow', () => {
    addBin('ecc', 'yq', 'modello');
    fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github/workflows/build-and-test.yml'), '');
    expect(preflight(cfg(), bin)).toEqual([]);
  });

  it('accepts regression-tests.sh instead of the workflow', () => {
    addBin('ecc', 'yq', 'modello');
    fs.writeFileSync(path.join(dir, 'test/ui/regression-tests.sh'), '');
    expect(preflight(cfg(), bin)).toEqual([]);
  });

  it('reports missing tools and missing workflow', () => {
    const p = preflight(cfg(), bin).join('\n');
    expect(p).toContain('`ecc` not found');
    expect(p).toContain('`yq` not found');
    expect(p).toContain('nothing to build');
  });

  it('does not require ecc/yq for a custom build command', () => {
    addBin('modello', 'make');
    expect(preflight(cfg({ buildCommand: 'make tests' }), bin)).toEqual([]);
  });

  it('reports a missing project directory', () => {
    expect(preflight(cfg({ projectDir: '/nope/x' }), bin).join()).toContain('project directory not found');
  });
});
