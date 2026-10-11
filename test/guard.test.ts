import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPatch, GuardError, resolveModelFile, serializeLike, validatePatch } from '../src/guard.js';

const doc = { '&common': { 'm1/a1/page-2': { 'select_block_by_type("button";2)': { selector: '#btn2' } } } };
const KEY = ['&common', 'm1/a1/page-2', 'select_block_by_type("button";2)', 'selector'];

describe('applyPatch', () => {
  it('changes only the targeted leaf and does not mutate the input', () => {
    const r = applyPatch(doc, { file: 'model-parameters.json', path: KEY, value: '#btn3' });
    expect(r.before).toBe('#btn2');
    expect(r.after).toBe('#btn3');
    expect(r.created).toBe(false);
    expect((doc as any)['&common']['m1/a1/page-2']['select_block_by_type("button";2)'].selector).toBe('#btn2');
  });

  it('creates missing intermediate objects', () => {
    const r = applyPatch({}, { file: 'model-parameters.json', path: ['a', 'b'], value: 1 });
    expect(r.json).toEqual({ a: { b: 1 } });
    expect(r.created).toBe(true);
  });

  it('refuses to replace a subtree', () => {
    expect(() => applyPatch(doc, { file: 'model-parameters.json', path: KEY.slice(0, 2), value: 'x' })).toThrow(GuardError);
  });

  it('refuses to descend through a scalar', () => {
    expect(() => applyPatch({ a: 'x' }, { file: 'model-map.json', path: ['a', 'b'], value: 'y' })).toThrow(GuardError);
  });
});

describe('validatePatch', () => {
  it('rejects unknown files, empty paths and prototype keys', () => {
    expect(() => validatePatch({ file: 'package.json' as any, path: ['a'], value: 'x' })).toThrow(GuardError);
    expect(() => validatePatch({ file: 'model-map.json', path: [], value: 'x' })).toThrow(GuardError);
    expect(() => validatePatch({ file: 'model-map.json', path: ['__proto__', 'x'], value: 'x' })).toThrow(GuardError);
    expect(() => validatePatch({ file: 'model-map.json', path: ['a'], value: { x: 1 } as any })).toThrow(GuardError);
  });
});

describe('resolveModelFile', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-'));
  fs.writeFileSync(path.join(tmp, 'model-map.json'), '{}');

  it('resolves allowed files inside the model dir', () => {
    expect(resolveModelFile(tmp, 'model-map.json')).toBe(path.join(fs.realpathSync(tmp), 'model-map.json'));
  });

  it('rejects path traversal and other files', () => {
    expect(() => resolveModelFile(tmp, '../model-map.json')).toThrow(GuardError);
    expect(() => resolveModelFile(tmp, 'modello.config.json')).toThrow(GuardError);
  });

  it('rejects a symlink pointing outside the model dir', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outside, 'x.json'), '{}');
    fs.symlinkSync(path.join(outside, 'x.json'), path.join(tmp, 'model-edges.json'));
    expect(() => resolveModelFile(tmp, 'model-edges.json')).toThrow(GuardError);
  });
});

describe('serializeLike', () => {
  it('keeps indentation and trailing newline', () => {
    expect(serializeLike('{\n    "a": 1\n}\n', { a: 2 })).toBe('{\n    "a": 2\n}\n');
    expect(serializeLike('{\n  "a": 1\n}', { a: 2 })).toBe('{\n  "a": 2\n}');
  });
});
