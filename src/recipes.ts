// Deterministic fix recipes, tried before any AI. A recipe proposes a change only when there is
// exactly one candidate; the orchestrator still has to see a rebuild + passing run before it stays.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { Patch, WritableFile } from './guard.js';
import type { Located } from './locate.js';

export type RecipeName = 'ledger' | 'translation-markup' | 'stale-selector';

export interface RecipeFix {
  recipe: RecipeName;
  patch: Patch;
  before: string;
  /** Why this value: shown in the report and handed to an agent if verification fails */
  evidence: string;
}

export interface Proposal {
  fix?: RecipeFix;
  /** Why no recipe applied (goes into the agent's case file) */
  note: string;
}

// ---------- Fix ledger: verified fixes by course + selector, reused before anything else.

export interface Ledger {
  entries: Record<string, { value: string; at: string; recipe: string }>;
}

const ledgerKey = (course: string, selector: string) => `${course}::${selector}`;

export function loadLedger(file?: string): Ledger {
  try {
    return file && fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Ledger) : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

export function recordFix(file: string | undefined, course: string, selector: string, value: string, recipe: string): void {
  if (!file) return;
  const ledger = loadLedger(file);
  ledger.entries[ledgerKey(course, selector)] = { value, at: new Date().toISOString(), recipe };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n');
}

// ---------- Selector parsing and candidate values from the course source.

interface ParsedSelector {
  attr: string; // 'id' for #x, else the attribute name
  value: string;
  render: (v: string) => string;
}

export function parseSelector(sel: string): ParsedSelector | undefined {
  const id = /^#([A-Za-z][\w-]*)$/.exec(sel);
  if (id) return { attr: 'id', value: id[1], render: (v) => `#${v}` };
  const attr = /^\[([\w-]+)=(["']?)([^"'\]]+)\2\]$/.exec(sel);
  if (attr && (attr[1] === 'id' || attr[1] === 'name' || attr[1].startsWith('data-'))) {
    const [, name, q] = attr;
    return { attr: name, value: attr[3], render: (v) => `[${name}=${q}${v}${q}]` };
  }
  return undefined;
}

const SOURCE_DIRS = ['app', 'public/content'];
const SOURCE_EXT = /\.(hbs|html|ya?ml|json|js)$/;
const SKIP_DIR = /(^|\/)(node_modules|assets|vendor|images|fonts|videos)(\/|$)/;
const MAX_FILE = 2 * 1024 * 1024;

const sourceCache = new Map<string, string[]>();

/** Text of the course files that can hold element attributes (cached per course). */
export function courseSources(courseDir: string): string[] {
  const hit = sourceCache.get(courseDir);
  if (hit) return hit;
  const texts: string[] = [];
  const visit = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (SKIP_DIR.test(path.relative(courseDir, p))) continue;
      if (e.isDirectory()) visit(p);
      else if (SOURCE_EXT.test(e.name) && fs.statSync(p).size <= MAX_FILE) texts.push(fs.readFileSync(p, 'utf8'));
    }
  };
  for (const d of SOURCE_DIRS) visit(path.join(courseDir, d));
  sourceCache.set(courseDir, texts);
  return texts;
}

export function clearSourceCache(): void {
  sourceCache.clear();
}

/** Distinct values of `attr` found in the sources (`id="x"`, `id: x`, `"data-hotspot": "x"`...). */
export function attributeValues(texts: string[], attr: string): Set<string> {
  const name = attr.replace(/[-]/g, '\\-');
  // Not \b: it also matches after a hyphen, so `data-id` would count as `id`.
  const re = new RegExp(`(?:^|[^\\w-])["']?${name}["']?\\s*[:=]\\s*["']?([A-Za-z0-9][\\w-]*)`, 'gm');
  const values = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(re)) values.add(m[1]);
  return values;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** Values that look like a renamed version of `stale`: a -/_ suffix added or dropped, or a small edit. */
export function similarValues(stale: string, values: Iterable<string>): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v === stale) continue;
    const affix = (a: string, b: string) => a.startsWith(b) && /^[-_]/.test(a.slice(b.length));
    const close = Math.min(v.length, stale.length) > 3 && editDistance(v, stale) <= 2;
    if (affix(stale, v) || affix(v, stale) || close) out.push(v);
  }
  return out.sort();
}

/**
 * Proposes one deterministic fix for a located failure, or explains why none applies.
 * Requires exactly one model entry holding the failing selector.
 */
export function proposeFix(config: Config, loc: Located, opts: { course: string; ledger?: Ledger } = { course: '' }): Proposal {
  const sel = loc.selector;
  if (!sel) return { note: 'No selector in the error message.' };
  if (loc.entries.length === 0) return { note: `Selector ${sel} is not set in the model files (it may come from modello support code).` };
  if (loc.entries.length > 1) {
    return { note: `Selector ${sel} is set in ${loc.entries.length} model entries; which one the failing block uses needs judgement.` };
  }
  const entry = loc.entries[0];
  const patchFor = (value: string): Patch => ({ file: entry.file as WritableFile, path: entry.path, value });

  const known = opts.ledger?.entries[ledgerKey(opts.course, sel)];
  if (known) {
    return { fix: { recipe: 'ledger', patch: patchFor(known.value), before: sel, evidence: `Verified fix from an earlier run (${known.at.slice(0, 10)}).` }, note: '' };
  }

  // Translation-edit markup wraps attribute values (name="<span ...>formField1</span>"), so an
  // exact [name='x'] never matches; a contains-match does.
  const exactName = /^\[name=(["'])([^"']+)\1\]$/.exec(sel);
  if (exactName) {
    const value = `[name*=${exactName[1]}${exactName[2]}${exactName[1]}]`;
    return { fix: { recipe: 'translation-markup', patch: patchFor(value), before: sel, evidence: 'Exact [name=...] match; translation-edit markup wraps names, so match with *= instead.' }, note: '' };
  }

  const parsed = parseSelector(sel);
  if (!parsed) return { note: `Selector ${sel} is not a simple #id or [attr=value] selector; no recipe.` };
  const values = attributeValues(courseSources(config.projectDir), parsed.attr);
  if (values.has(parsed.value)) {
    return { note: `"${parsed.value}" still exists in the course source, so the selector is not simply stale (timing, visibility or page flow?).` };
  }
  const similar = similarValues(parsed.value, values);
  if (similar.length === 1) {
    const value = parsed.render(similar[0]);
    return {
      fix: { recipe: 'stale-selector', patch: patchFor(value), before: sel, evidence: `"${parsed.value}" no longer exists in the course source; the only similar ${parsed.attr} is "${similar[0]}".` },
      note: '',
    };
  }
  return {
    note: similar.length
      ? `Several similar ${parsed.attr} values in the course source: ${similar.slice(0, 8).join(', ')}; choosing needs judgement.`
      : `No similar ${parsed.attr} value in the course source for "${parsed.value}".`,
  };
}
