import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contextAtLine, enrichFailures, parseJUnit, stackFrames } from '../src/failures.js';

const SPEC = `describe('x', function () {
  it('should run', function () {
    // -> page: m1/a1/page-2, block uid: b8576e06
    //    type: modal
    //    parameters: openModalSelector: "#btn1", closeModalSelector: "#modal1Btn"
    cy.modal("#btn1", "#modal1Btn");
    // -> page: m1/a1/page-3, block uid: c963ec41
    //    type: button
    //    replacement: button.js
    cy.button("#gone");
  });
});
`;

const XML = `<?xml version="1.0"?>
<testsuites><testsuite name="digital-banking-m1" tests="1" failures="1">
<testcase name="digital-banking-m1 should run" classname="should run">
<failure message="Timed out retrying after 4000ms: Expected to find element: &#39;#gone&#39;, but never found it." type="AssertionError"><![CDATA[AssertionError: Timed out
    at Context.eval (webpack:///./test/ui/cypress/e2e/spec-m1.js:9:7)]]></failure>
</testcase>
<testcase name="ok test" classname="x"></testcase>
</testsuite></testsuites>`;

describe('parseJUnit', () => {
  it('returns only failing testcases with decoded text', () => {
    const f = parseJUnit(XML);
    expect(f).toHaveLength(1);
    expect(f[0].suite).toBe('digital-banking-m1');
    expect(f[0].message).toContain("'#gone'");
    expect(f[0].stack).toContain('spec-m1.js:9:7');
  });
});

describe('stackFrames', () => {
  it('extracts file and line', () => {
    expect(stackFrames('at a (webpack:///./x/spec-m1.js:9:7)')).toEqual([{ file: 'webpack:///./x/spec-m1.js', line: 9 }]);
  });
});

describe('contextAtLine', () => {
  it('maps a line to the nearest preceding block comment', () => {
    const c = contextAtLine(SPEC, 9, 'spec.js')!;
    expect(c.page).toBe('m1/a1/page-3');
    expect(c.type).toBe('button');
    expect(c.replacement).toBe('button.js');
    expect(c.command).toBe('cy.button("#gone");');
  });

  it('includes parameters', () => {
    const c = contextAtLine(SPEC, 6, 'spec.js')!;
    expect(c.parameters).toContain('openModalSelector');
  });

  it('returns undefined before any block comment', () => {
    expect(contextAtLine(SPEC, 2, 'spec.js')).toBeUndefined();
  });
});

describe('enrichFailures', () => {
  it('resolves the stack frame to a spec file in specDir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specs-'));
    fs.writeFileSync(path.join(dir, 'spec-m1.js'), SPEC);
    const [f] = enrichFailures(parseJUnit(XML), dir);
    expect(f.context?.page).toBe('m1/a1/page-3');
  });
});
