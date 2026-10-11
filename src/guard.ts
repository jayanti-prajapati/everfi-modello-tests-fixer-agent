import fs from 'node:fs';
import path from 'node:path';

/** The only files the agent may ever modify, relative to the model directory. */
export const WRITABLE_FILES = ['model-parameters.json', 'model-map.json', 'model-edges.json'] as const;
export type WritableFile = (typeof WRITABLE_FILES)[number];

export class GuardError extends Error {}

export interface Patch {
  file: WritableFile;
  /** Key path to a leaf, e.g. ["&common", "m1/a1/page-2", "select_block_by_type(\"button\";0)", "selector"] */
  path: string[];
  value: string | number | boolean;
}

export interface PatchResult {
  json: unknown;
  before: unknown;
  after: unknown;
  created: boolean;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Resolves a model config file to an absolute path, guaranteeing it is one of the allowed
 * files directly inside modelDir (after resolving symlinks).
 */
export function resolveModelFile(modelDir: string, file: string): string {
  if (!(WRITABLE_FILES as readonly string[]).includes(file)) {
    throw new GuardError(`"${file}" is not a writable model file (allowed: ${WRITABLE_FILES.join(', ')})`);
  }
  const root = fs.realpathSync(modelDir);
  const target = path.join(root, file);
  const real = fs.existsSync(target) ? fs.realpathSync(target) : target;
  if (path.dirname(real) !== root) {
    throw new GuardError(`"${file}" resolves outside the model directory`);
  }
  return real;
}

export function validatePatch(patch: Patch): void {
  if (!(WRITABLE_FILES as readonly string[]).includes(patch.file)) {
    throw new GuardError(`"${patch.file}" is not a writable model file`);
  }
  if (patch.path.length === 0) throw new GuardError('patch path is empty');
  for (const key of patch.path) {
    if (typeof key !== 'string' || key === '') throw new GuardError('patch path contains an empty key');
    if (FORBIDDEN_KEYS.has(key)) throw new GuardError(`forbidden key "${key}" in patch path`);
  }
  if (!['string', 'number', 'boolean'].includes(typeof patch.value)) {
    throw new GuardError('patch value must be a string, number or boolean');
  }
}

/**
 * Pure: returns a new JSON document with a single leaf changed. Never replaces or deletes
 * subtrees, so unrelated entries are preserved.
 */
export function applyPatch(doc: unknown, patch: Patch): PatchResult {
  validatePatch(patch);
  const root = structuredClone(doc);
  if (!isObject(root)) throw new GuardError('model file root must be a JSON object');

  let node: Record<string, unknown> = root;
  for (const key of patch.path.slice(0, -1)) {
    const next = node[key];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
    } else if (isObject(next)) {
      node = next;
    } else {
      throw new GuardError(`"${key}" is not an object; refusing to overwrite it`);
    }
  }

  const leaf = patch.path[patch.path.length - 1];
  const before = node[leaf];
  if (isObject(before) || Array.isArray(before)) {
    throw new GuardError(`"${leaf}" holds a subtree; only leaf values may be set`);
  }
  node[leaf] = patch.value;
  return { json: root, before, after: patch.value, created: before === undefined };
}

/** Serializes JSON matching the original file's indentation and trailing newline. */
export function serializeLike(original: string, json: unknown): string {
  const indent = /^\n?([ \t]+)"/m.exec(original)?.[1] ?? '  ';
  return JSON.stringify(json, null, indent) + (original.endsWith('\n') ? '\n' : '');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
