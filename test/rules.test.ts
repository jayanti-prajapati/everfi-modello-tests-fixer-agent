import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCaseFile } from '../src/casefile.js';
import { DEFAULTS, type Config } from '../src/config.js';
import type { Failure } from '../src/failures.js';
import { extractSelector, findInSpec, findModelEntries, locate, pageEntries, type Located } from '../src/locate.js';
import {
  attributeValues,
  clearSourceCache,
  loadLedger,
  parseSelector,
  proposeFix,
  recordFix,
  similarValues,
} from '../src/recipes.js';
import { environmentProblem, failureSignature, type SpecRun } from '../src/triage.js';

const STALE_MSG = 'Timed out retrying after 10000ms: Expected to find element: `#btn2-stale`, but never found it.';

const failure = (message: string, stack = ''): Failure => ({ suite: 's', title: 'should run', message, stack });
const failedRun = (message: string, stack = ''): SpecRun => ({ status: 'failed', exitCode: 1, failures: [failure(message, stack)] });

const SPEC = `it('should run', function () {
  // -> page: m1/a1/page-2, block uid: c963ec41
  //    type: button
  //    parameters: selector: "#btn2-stale"
  cy.button("#btn2-stale");
  // -> page: m1/a1/page-3, block uid: d1
  //    type: button
  cy.button("#other");
});
`;

const PARAMS = { '&common': { 'm1/a1/page-2': { 'select_block_by_type("button";2)': { selector: '#btn2-stale' } } } };

let dirs: string[] = [];
function makeProject(params: unknown = PARAMS, map: unknown = {}): { dir: string; config: Config } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'test/ui/cypress/e2e'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test/ui/model-parameters.json'), JSON.stringify(params));
  fs.writeFileSync(path.join(dir, 'test/ui/model-map.json'), JSON.stringify(map));
  return { dir, config: { ...DEFAULTS, projectDir: dir, write: false, local: false } };
}
function addSource(dir: string, rel: string, text: string) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

beforeEach(() => clearSourceCache());
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// ---------------------------------------------------------------- triage
describe('environmentProblem', () => {
  it('reports no_report without a timeout, with the exit code', () => {
    expect(environmentProblem({ status: 'no_report', exitCode: 7 })).toBe('Cypress produced no test report (exit 7)');
    expect(environmentProblem({ status: 'no_report' })).toBe('Cypress produced no test report (exit ?)');
  });

  it('reports no_report with a timeout', () => {
    expect(environmentProblem({ status: 'no_report', timedOut: true })).toBe('Cypress timed out without producing a report');
  });

  it('detects MODULE_NOT_FOUND in the output tail, with the evidence line', () => {
    const r = environmentProblem({ status: 'no_report', outputTail: 'starting\n  Error: Cannot find module x code: MODULE_NOT_FOUND  \nbye' });
    expect(r).toBe('Cypress/Electron could not start: Error: Cannot find module x code: MODULE_NOT_FOUND');
  });

  it('detects bad option: --no-sandbox', () => {
    const r = environmentProblem({ status: 'failed', outputTail: 'electron: bad option: --no-sandbox' });
    expect(r).toMatch(/^Cypress\/Electron could not start: .*bad option: --no-sandbox/);
  });

  it('detects ECONNREFUSED inside a failure stack', () => {
    const r = environmentProblem(failedRun('Something failed', 'Error: connect ECONNREFUSED 127.0.0.1:8080\n    at foo (x.js:1:1)'));
    expect(r).toBe('course or service unreachable (network): Error: connect ECONNREFUSED 127.0.0.1:8080');
  });

  it('detects cy.visit() failed', () => {
    const r = environmentProblem(failedRun('CypressError: cy.visit() failed trying to load: http://localhost/'));
    expect(r).toMatch(/^course page did not load: /);
  });

  it('detects a missing Applitools api key', () => {
    expect(environmentProblem({ status: 'failed', outputTail: 'Error: APPLITOOLS_API_KEY is not set' })).toMatch(/^Applitools API key missing/);
    expect(environmentProblem(failedRun('Applitools: Invalid api key provided'))).toMatch(/^Applitools API key missing/);
  });

  it('returns undefined for a normal selector failure', () => {
    expect(environmentProblem(failedRun(STALE_MSG, 'AssertionError: ...\n    at Context.eval (spec.cy.js:5:7)'))).toBeUndefined();
  });
});

describe('failureSignature', () => {
  it('is undefined without failures', () => {
    expect(failureSignature({ status: 'passed' })).toBeUndefined();
  });

  it('normalizes durations and whitespace', () => {
    expect(failureSignature(failedRun(STALE_MSG))).toBe('Timed out retrying after Nms: Expected to find element: `#btn2-stale`, but never found it.');
    expect(failureSignature(failedRun('a\n\n  b 4000ms'))).toBe('a b Nms');
  });

  it('gives the same signature for different timeouts', () => {
    expect(failureSignature(failedRun(STALE_MSG))).toBe(failureSignature(failedRun(STALE_MSG.replace('10000ms', '4000ms'))));
  });
});

// ---------------------------------------------------------------- locate
describe('extractSelector', () => {
  it('reads the backtick form', () => {
    expect(extractSelector(STALE_MSG)).toBe('#btn2-stale');
    expect(extractSelector('Timed out retrying after 4000ms: `[name="x"]` is not visible')).toBe('[name="x"]');
  });

  it('reads the cy.button("...") form', () => {
    expect(extractSelector('failed at cy.button("#btn9")')).toBe('#btn9');
  });

  it('returns undefined when there is no selector', () => {
    expect(extractSelector('Something else went wrong')).toBeUndefined();
  });
});

describe('findInSpec', () => {
  it('finds the block using the selector', () => {
    const blocks = findInSpec(SPEC, '#btn2-stale');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ page: 'm1/a1/page-2', blockUid: 'c963ec41', line: 2 });
    expect(blocks[0].text).toContain('cy.button("#btn2-stale");');
    expect(blocks[0].text).not.toContain('#other');
  });

  it('finds the second block and nothing for an unknown needle', () => {
    expect(findInSpec(SPEC, '#other')).toMatchObject([{ page: 'm1/a1/page-3', blockUid: 'd1', line: 6 }]);
    expect(findInSpec(SPEC, '#nope')).toEqual([]);
  });

  it('respects max', () => {
    expect(findInSpec(SPEC, 'cy.button', 1)).toHaveLength(1);
    expect(findInSpec(SPEC, 'cy.button')).toHaveLength(2);
  });
});

describe('findModelEntries / pageEntries', () => {
  it('finds exact and contains matches', () => {
    const { config } = makeProject();
    const exact = findModelEntries(config, '#btn2-stale');
    expect(exact).toEqual([
      { file: 'model-parameters.json', path: ['&common', 'm1/a1/page-2', 'select_block_by_type("button";2)', 'selector'], value: '#btn2-stale' },
    ]);
    expect(findModelEntries(config, '#btn2')).toEqual([]);
    expect(findModelEntries(config, '#btn2', true)).toHaveLength(1);
  });

  it('returns the page subtree as compact JSON', () => {
    const { config } = makeProject();
    expect(pageEntries(config, 'm1/a1/page-2')).toBe(
      'model-parameters.json ["&common","m1/a1/page-2"]: {"select_block_by_type(\\"button\\";2)":{"selector":"#btn2-stale"}}',
    );
    expect(pageEntries(config, 'm9/a9/page-9')).toBe('');
  });

  it('truncates pageEntries at maxChars', () => {
    const { config } = makeProject();
    const t = pageEntries(config, 'm1/a1/page-2', 20);
    expect(t.startsWith('model-parameters.jso')).toBe(true);
    expect(t).toMatch(/…\(truncated\)$/);
  });
});

describe('locate', () => {
  it('ties the error message to the spec block and model entry', () => {
    const { dir, config } = makeProject();
    fs.writeFileSync(path.join(dir, 'test/ui/cypress/e2e/m1.cy.js'), SPEC);
    const loc = locate(config, 'm1.cy.js', failedRun(STALE_MSG));
    expect(loc.selector).toBe('#btn2-stale');
    expect(loc.blocks).toMatchObject([{ page: 'm1/a1/page-2', blockUid: 'c963ec41', line: 2 }]);
    expect(loc.entries).toHaveLength(1);
    expect(loc.entries[0].path.at(-1)).toBe('selector');
  });

  it('handles a missing spec file and a message without selector', () => {
    const { config } = makeProject();
    const loc = locate(config, 'missing.cy.js', failedRun(STALE_MSG));
    expect(loc.blocks).toEqual([]);
    expect(loc.entries).toHaveLength(1);
    expect(locate(config, 'm1.cy.js', failedRun('boom'))).toEqual({ blocks: [], entries: [] });
    expect(locate(config, 'm1.cy.js', { status: 'failed' })).toEqual({ blocks: [], entries: [] });
  });
});

// ---------------------------------------------------------------- recipes
describe('parseSelector', () => {
  it('parses #id', () => {
    const p = parseSelector('#btn2')!;
    expect(p).toMatchObject({ attr: 'id', value: 'btn2' });
    expect(p.render('btn3')).toBe('#btn3');
  });

  it('parses [data-*="x"] and [name=\'x\'] and keeps the quotes', () => {
    const d = parseSelector('[data-hotspot="x"]')!;
    expect(d).toMatchObject({ attr: 'data-hotspot', value: 'x' });
    expect(d.render('y')).toBe('[data-hotspot="y"]');
    const n = parseSelector("[name='x']")!;
    expect(n).toMatchObject({ attr: 'name', value: 'x' });
    expect(n.render('z')).toBe("[name='z']");
  });

  it('rejects unsupported selectors', () => {
    expect(parseSelector('.class')).toBeUndefined();
    expect(parseSelector('[class="x"]')).toBeUndefined();
    expect(parseSelector('#a .b')).toBeUndefined();
  });
});

describe('attributeValues', () => {
  const texts = ['<button id="btn2">Go</button>', 'id: btn3\nother: x', '{"data-hotspot": "budget"}'];
  it('collects ids from html and yaml forms', () => {
    expect([...attributeValues(texts, 'id')].sort()).toEqual(['btn2', 'btn3']);
  });
  it('collects data-* attributes from json', () => {
    expect([...attributeValues(texts, 'data-hotspot')]).toEqual(['budget']);
  });
  // Known bug (src/recipes.ts attributeValues): `\b` before the name matches after '-', so a
  // prefixed attribute (data-id, data-name) is counted as id/name.
  it('does not count data-id as id', () => {
    expect([...attributeValues(['<div data-id="foo">'], 'id')]).toEqual([]);
  });
});

describe('similarValues', () => {
  it('matches a dropped -suffix (affix rule)', () => {
    expect(similarValues('btn2-stale', ['btn2', 'btn3', 'other'])).toEqual(['btn2']);
    expect(similarValues('btn2', ['btn2_new', 'zzz'])).toEqual(['btn2_new']);
  });
  it('matches small edits for values longer than 3 chars', () => {
    expect(similarValues('budget', ['budgte', 'budgets', 'savings'])).toEqual(['budgets', 'budgte']);
    expect(similarValues('ab', ['ac'])).toEqual([]);
  });
  it('never returns the stale value itself', () => {
    expect(similarValues('btn2-stale', ['btn2-stale', 'btn2'])).toEqual(['btn2']);
  });
});

describe('proposeFix', () => {
  const ENTRY_PATH = ['&common', 'm1/a1/page-2', 'select_block_by_type("button";2)', 'selector'];
  const located = (config: Config, selector?: string): Located => ({
    selector,
    blocks: [],
    entries: selector ? findModelEntries(config, selector) : [],
  });

  it('needs a selector', () => {
    const { config } = makeProject();
    expect(proposeFix(config, { blocks: [], entries: [] }).note).toMatch(/No selector/);
  });

  it('needs the selector in the model', () => {
    const { config } = makeProject();
    const p = proposeFix(config, located(config, '.modal__header__close button'));
    expect(p.fix).toBeUndefined();
    expect(p.note).toMatch(/not set in the model files/);
  });

  it('declines when the selector is in two entries', () => {
    const { config } = makeProject({ '&common': { 'm1/a1/page-2': { a: { selector: '#x' } }, 'm1/a1/page-3': { b: { selector: '#x' } } } });
    const p = proposeFix(config, located(config, '#x'));
    expect(p.fix).toBeUndefined();
    expect(p.note).toMatch(/set in 2 model entries/);
  });

  it('uses a ledger hit first', () => {
    const { dir, config } = makeProject();
    const file = path.join(dir, 'ledger', 'fixes.json');
    expect(loadLedger(file)).toEqual({ entries: {} });
    recordFix(file, 'c', '#btn2-stale', '#btn2-fixed', 'stale-selector');
    const ledger = loadLedger(file);
    expect(ledger.entries['c::#btn2-stale'].value).toBe('#btn2-fixed');
    const p = proposeFix(config, located(config, '#btn2-stale'), { course: 'c', ledger });
    expect(p.fix).toMatchObject({ recipe: 'ledger', before: '#btn2-stale', patch: { file: 'model-parameters.json', path: ENTRY_PATH, value: '#btn2-fixed' } });
    // other course: no hit
    expect(proposeFix(config, located(config, '#btn2-stale'), { course: 'other', ledger }).fix?.recipe).not.toBe('ledger');
  });

  it('loadLedger tolerates a missing or corrupt file; recordFix without file is a no-op', () => {
    const { dir } = makeProject();
    expect(loadLedger()).toEqual({ entries: {} });
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    expect(loadLedger(bad)).toEqual({ entries: {} });
    expect(() => recordFix(undefined, 'c', '#a', '#b', 'x')).not.toThrow();
  });

  it("rewrites [name='formField1'] to a contains match", () => {
    const { config } = makeProject({ '&common': { 'm1/a2/page-4': { input: { selector: "[name='formField1']" } } } });
    const p = proposeFix(config, located(config, "[name='formField1']"));
    expect(p.fix).toMatchObject({ recipe: 'translation-markup', patch: { value: "[name*='formField1']", path: ['&common', 'm1/a2/page-4', 'input', 'selector'] } });
  });

  it('fixes a stale selector with exactly one similar id in the source', () => {
    const { dir, config } = makeProject();
    addSource(dir, 'app/x.hbs', '<button id="btn2">Next</button>\n<div id="intro"></div>');
    const loc = located(config, '#btn2-stale');
    const p = proposeFix(config, loc);
    expect(p.fix).toMatchObject({ recipe: 'stale-selector', before: '#btn2-stale', patch: { file: 'model-parameters.json', value: '#btn2' } });
    expect(p.fix!.patch.path).toEqual(loc.entries[0].path);
    expect(p.fix!.patch.path).toEqual(ENTRY_PATH);
  });

  it('lists candidates when two similar ids exist', () => {
    const { dir, config } = makeProject();
    addSource(dir, 'app/x.hbs', '<button id="btn2">A</button><button id="btn2-state">B</button>');
    const p = proposeFix(config, located(config, '#btn2-stale'));
    expect(p.fix).toBeUndefined();
    expect(p.note).toMatch(/Several similar id values/);
    expect(p.note).toContain('btn2');
    expect(p.note).toContain('btn2, btn2-state');
  });

  it('declines when the value still exists in the source', () => {
    const { dir, config } = makeProject();
    addSource(dir, 'app/x.hbs', '<button id="btn2-stale">A</button><button id="btn2">B</button>');
    const p = proposeFix(config, located(config, '#btn2-stale'));
    expect(p.fix).toBeUndefined();
    expect(p.note).toMatch(/still exists in the course source/);
  });

  it('reports no similar value and unsupported selectors', () => {
    const { dir, config } = makeProject({ '&common': { p: { a: { selector: '#btn2-stale' }, b: { selector: '.foo' } } } });
    addSource(dir, 'app/x.hbs', '<div id="unrelated"></div>');
    expect(proposeFix(config, located(config, '#btn2-stale')).note).toMatch(/No similar id value/);
    expect(proposeFix(config, located(config, '.foo')).note).toMatch(/not a simple #id/);
  });

  it('skips node_modules under app/', () => {
    const { dir, config } = makeProject();
    addSource(dir, 'app/node_modules/lib/x.html', '<button id="btn2">A</button>');
    expect(proposeFix(config, located(config, '#btn2-stale')).fix).toBeUndefined();
  });
});

// ---------------------------------------------------------------- casefile
describe('buildCaseFile', () => {
  it('contains spec, selector, block, model entry and notes', () => {
    const { dir, config } = makeProject();
    fs.writeFileSync(path.join(dir, 'test/ui/cypress/e2e/m1.cy.js'), SPEC);
    const run = failedRun(STALE_MSG, 'AssertionError\n    at Context.eval (webpack:///./m1.cy.js:5:7)');
    const loc = locate(config, 'm1.cy.js', run);
    const text = buildCaseFile(config, 'm1.cy.js', run, loc, ['No similar id value in the course source for "btn2-stale".']);
    expect(text).toContain('Spec: m1.cy.js');
    expect(text).toContain('Test-phase result (already run in the course folder): failed');
    expect(text).toContain('Failing selector: #btn2-stale');
    expect(text).toContain('(line 2)');
    expect(text).toContain('// -> page: m1/a1/page-2, block uid: c963ec41');
    expect(text).toContain('cy.button("#btn2-stale");');
    expect(text).toContain(
      'model-parameters.json ["&common","m1/a1/page-2","select_block_by_type(\\"button\\";2)","selector"] = "#btn2-stale"',
    );
    expect(text).toContain('Model entries for page m1/a1/page-2:');
    expect(text).toContain('Already checked by the orchestrator:');
    expect(text).toContain('  - No similar id value');
    expect(text).toContain('top frames:');
  });

  it('says when the selector is not in the generated spec', () => {
    const { config } = makeProject();
    const run = failedRun('Expected to find element: `.modal__header__close button`');
    const text = buildCaseFile(config, 'm1.cy.js', run, locate(config, 'm1.cy.js', run));
    expect(text).toContain('does not appear in the generated spec');
  });

  it('truncates at 7000 chars', () => {
    const { config } = makeProject();
    const huge = 'x'.repeat(20000);
    const run: SpecRun = { status: 'failed', failures: [failure(huge, huge)] };
    const notes = Array.from({ length: 200 }, (_, i) => `note ${i} ${'y'.repeat(60)}`);
    const text = buildCaseFile(config, 's.cy.js', run, { blocks: [], entries: [] }, notes);
    expect(text.length).toBe(7000 + '\n…(case file truncated)'.length);
    expect(text.endsWith('…(case file truncated)')).toBe(true);
  });
});
