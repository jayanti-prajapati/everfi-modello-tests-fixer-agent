// Finds where a failure lives without AI: the selector in the error message, the generated
// spec block that uses it (page, block uid, command) and the model entries that hold it.
import fs from 'node:fs';
import path from 'node:path';
import { absModelDir, absSpecDir, type Config } from './config.js';
import { WRITABLE_FILES } from './guard.js';
import type { SpecRun } from './triage.js';

export interface SpecBlock {
  page: string;
  blockUid: string;
  line: number;
  /** The header comments and the cy.* line, as in the generated spec */
  text: string;
}

export interface ModelEntry {
  file: string;
  path: string[];
  value: string | number | boolean;
}

export interface Located {
  selector?: string;
  blocks: SpecBlock[];
  /** Leaves whose value is exactly the selector */
  entries: ModelEntry[];
}

const SELECTOR_PATTERNS = [
  /Expected to find element: `([^`]+)`/,
  /Timed out retrying[^`]*`([^`]+)`/,
  /cy\.\w+\(\s*["'`]([^"'`]+)["'`]/,
];

export function extractSelector(message: string): string | undefined {
  for (const re of SELECTOR_PATTERNS) {
    const m = re.exec(message);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** Blocks in a generated spec whose cy.* line or parameters mention `needle`. */
export function findInSpec(source: string, needle: string, max = 5): SpecBlock[] {
  const lines = source.split('\n');
  const blocks: SpecBlock[] = [];
  for (let i = 0; i < lines.length && blocks.length < max; i++) {
    const head = /^\s*\/\/ -> page: (.*?), block uid: (.*)$/.exec(lines[i]);
    if (!head) continue;
    let j = i + 1;
    while (j < lines.length && /^\s*\/\/ {2,}/.test(lines[j])) j++;
    const text = lines.slice(i, j + 1).map((l) => l.trim()).join('\n');
    if (text.includes(needle)) blocks.push({ page: head[1], blockUid: head[2].trim(), line: i + 1, text });
  }
  return blocks;
}

function walk(node: unknown, at: string[], visit: (path: string[], value: string | number | boolean) => void) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) walk(v, [...at, k], visit);
  } else if (['string', 'number', 'boolean'].includes(typeof node)) {
    visit(at, node as string | number | boolean);
  }
}

export function readModel(config: Config, file: string): unknown {
  const p = path.join(absModelDir(config), file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : undefined;
}

/** Model leaves whose value equals `value` (exact) or contains it (`contains`). */
export function findModelEntries(config: Config, value: string, contains = false): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const file of WRITABLE_FILES) {
    walk(readModel(config, file), [], (p, v) => {
      if (typeof v === 'string' && (contains ? v.includes(value) : v === value)) out.push({ file, path: p, value: v });
    });
  }
  return out;
}

/** The model-parameters / model-map subtrees for one page, as compact JSON (capped). */
export function pageEntries(config: Config, page: string, maxChars = 2500): string {
  const parts: string[] = [];
  for (const file of WRITABLE_FILES) {
    const doc = readModel(config, file) as Record<string, unknown> | undefined;
    if (!doc) continue;
    for (const [section, body] of Object.entries(doc)) {
      const sub = body && typeof body === 'object' ? (body as Record<string, unknown>)[page] : undefined;
      if (sub !== undefined) parts.push(`${file} ["${section}","${page}"]: ${JSON.stringify(sub)}`);
    }
  }
  const text = parts.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)} …(truncated)` : text;
}

export function locate(config: Config, spec: string, run: SpecRun): Located {
  const message = run.failures?.[0]?.message ?? '';
  const selector = extractSelector(message);
  if (!selector) return { blocks: [], entries: [] };
  const specFile = path.join(absSpecDir(config), spec);
  const source = fs.existsSync(specFile) ? fs.readFileSync(specFile, 'utf8') : '';
  return { selector, blocks: findInSpec(source, selector), entries: findModelEntries(config, selector) };
}
