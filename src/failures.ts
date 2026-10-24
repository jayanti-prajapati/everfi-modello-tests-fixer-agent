import fs from 'node:fs';
import path from 'node:path';

export interface FailedTest {
  suite: string;
  title: string;
  message: string;
  stack: string;
}

export interface BlockContext {
  page: string;
  blockUid: string;
  type: string;
  replacement?: string;
  parameters?: string;
  /** The generated cy.* command line */
  command: string;
  specFile: string;
  line: number;
}

export interface Failure extends FailedTest {
  context?: BlockContext;
}

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
const decode = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos);|&#(\d+);/g, (m, _n, code) => (code ? String.fromCharCode(Number(code)) : ENTITIES[m]));
const unwrap = (s: string) => decode(s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, ''));

/**
 * Minimal parser for the JUnit XML that Cypress's built-in `junit` reporter writes.
 * Only the subset we need (testsuite name, testcase name, failure message/body).
 */
export function parseJUnit(xml: string): FailedTest[] {
  const failures: FailedTest[] = [];
  const suiteRe = /<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g;
  for (const [, suiteAttrs, body] of xml.matchAll(suiteRe)) {
    const suite = attr(suiteAttrs, 'name') ?? '';
    const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    for (const [, caseAttrs, caseBody = ''] of body.matchAll(caseRe)) {
      const f = /<failure\b([^>]*?)(?:\/>|>([\s\S]*?)<\/failure>)/.exec(caseBody);
      if (!f) continue;
      failures.push({
        suite,
        title: attr(caseAttrs, 'name') ?? '',
        message: attr(f[1], 'message') ?? '',
        stack: f[2] ? unwrap(f[2]) : '',
      });
    }
  }
  return failures;
}

export interface TestCaseResult {
  suite: string;
  title: string;
  passed: boolean;
  message?: string;
}

/** Every test case in the report, passed or failed (skipped cases count as passed). */
export function parseJUnitCases(xml: string): TestCaseResult[] {
  const cases: TestCaseResult[] = [];
  for (const [, suiteAttrs, body] of xml.matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g)) {
    const suite = attr(suiteAttrs, 'name') ?? '';
    for (const [, caseAttrs, caseBody = ''] of body.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const f = /<failure\b([^>]*?)(?:\/>|>)/.exec(caseBody);
      cases.push({ suite, title: attr(caseAttrs, 'name') ?? '', passed: !f, message: f ? attr(f[1], 'message') : undefined });
    }
  }
  return cases;
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? decode(m[1]) : undefined;
}

/** Finds `file.js:line:col` frames in a stack trace. */
export function stackFrames(stack: string): { file: string; line: number }[] {
  return [...stack.matchAll(/([^\s()]+\.js):(\d+):\d+/g)].map((m) => ({ file: m[1], line: Number(m[2]) }));
}

/**
 * Given a generated spec's source and a 1-based line number, returns the `// -> page:` block
 * that the line belongs to, using the metadata comments the generator emits.
 */
export function contextAtLine(source: string, line: number, specFile: string): BlockContext | undefined {
  const lines = source.split('\n');
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const head = /^\s*\/\/ -> page: (.*?), block uid: (.*)$/.exec(lines[i]);
    if (!head) continue;
    const ctx: BlockContext = { page: head[1], blockUid: head[2].trim(), type: '', command: '', specFile, line };
    let j = i + 1;
    for (; j < lines.length && /^\s*\/\/ {2,}/.test(lines[j]); j++) {
      const kv = /^\s*\/\/\s+(type|replacement|parameters): ?(.*)$/.exec(lines[j]);
      if (kv?.[1] === 'type') ctx.type = kv[2].trim();
      else if (kv?.[1] === 'replacement') ctx.replacement = kv[2].trim();
      else if (kv?.[1] === 'parameters') ctx.parameters = kv[2].trim();
    }
    ctx.command = (lines[j] ?? '').trim();
    return ctx;
  }
  return undefined;
}

/** Attaches generated-spec block context to each failure by resolving stack frames to spec files. */
export function enrichFailures(failures: FailedTest[], specDir: string): Failure[] {
  return failures.map((f) => {
    for (const frame of stackFrames(f.stack)) {
      const specFile = path.join(specDir, path.basename(frame.file));
      if (!fs.existsSync(specFile)) continue;
      const context = contextAtLine(fs.readFileSync(specFile, 'utf8'), frame.line, specFile);
      if (context) return { ...f, context };
    }
    return f;
  });
}
