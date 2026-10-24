// Fake `modello run -- cypress run` for the evaluation fixture. Run with cwd = course root.
// Usage: node fake-cypress.cjs <report> <spec>
//
// For each `cy.button("<sel>")` in the spec (in order), checks that the page's
// <section data-page="..."> in app/content/<module>.html holds a matching element.
// Supported selectors: #id, [attr="v"] / [attr='v'] / [attr=v] (exact), [attr*="v"] (contains).
// Writes a JUnit report (one testcase per page; the first missing element fails its page and
// stops the spec, like Cypress) and exits 1 on failure.
//
// Rigged modules come from ../eval-behaviour.json (next to the course, outside it):
//   "environment": prints a MODULE_NOT_FOUND crash, writes no report, exits 1.
//   "flaky-once":  the first run fails (counter in ../eval-state/), later runs behave normally.
const fs = require('fs');
const path = require('path');

const [report, spec] = process.argv.slice(2);
if (!report || !spec) {
  console.error('usage: node fake-cypress.cjs <report> <spec>');
  process.exit(64);
}
const cwd = process.cwd();
const mod = (/-(m\d+)-/.exec(path.basename(spec)) || [])[1];
const behaviourFile = path.join(cwd, '..', 'eval-behaviour.json');
const behaviour = fs.existsSync(behaviourFile) ? JSON.parse(fs.readFileSync(behaviourFile, 'utf8'))[mod] : undefined;

if (behaviour === 'environment') {
  console.log('It looks like this is your first time using Cypress: 13.6.0');
  console.error("Error: Cannot find module 'x'");
  console.error('Require stack:\n- /Applications/Cypress.app/Contents/Resources/app/index.js');
  console.error("{\n  code: 'MODULE_NOT_FOUND',\n  requireStack: [ '/Applications/Cypress.app/Contents/Resources/app/index.js' ]\n}");
  process.exit(1);
}

let forceFail = false;
if (behaviour === 'flaky-once') {
  const stateDir = path.join(cwd, '..', 'eval-state');
  fs.mkdirSync(stateDir, { recursive: true });
  const counter = path.join(stateDir, `${mod}.runs`);
  const runs = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(runs + 1));
  forceFail = runs === 0;
}

const source = fs.readFileSync(spec, 'utf8');
const html = fs.existsSync(path.join(cwd, 'app/content', `${mod}.html`))
  ? fs.readFileSync(path.join(cwd, 'app/content', `${mod}.html`), 'utf8')
  : '';

function sectionOf(page) {
  const esc = page.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`<section data-page="${esc}">([\\s\\S]*?)</section>`).exec(html);
  return m ? m[1] : '';
}

/** Attribute values of `name` in `text` (double, single or unquoted). */
function attrValues(text, name) {
  const esc = name.replace(/[-]/g, '\\-');
  const re = new RegExp(`(?:^|\\s)${esc}=(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, 'g');
  return [...text.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]);
}

function matches(section, sel) {
  const id = /^#([\w-]+)$/.exec(sel);
  if (id) return attrValues(section, 'id').includes(id[1]);
  const a = /^\[([\w-]+)(\*?)=(?:"([^"]*)"|'([^']*)'|([^\]"']*))\]$/.exec(sel);
  if (a) {
    const want = a[3] ?? a[4] ?? a[5];
    return attrValues(section, a[1]).some((v) => (a[2] ? v.includes(want) : v === want));
  }
  return false; // unsupported selector: never found
}

const xmlAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Pages in order, each with its selectors.
const pages = [];
for (const line of source.split('\n')) {
  const head = /^\s*it\((".*")\s*,/.exec(line);
  if (head) pages.push({ page: JSON.parse(head[1]), sels: [] });
  const cmd = /^\s*cy\.button\((".*")\);\s*$/.exec(line);
  if (cmd && pages.length) pages[pages.length - 1].sels.push(JSON.parse(cmd[1]));
}

let failed = false;
const cases = [];
for (const { page, sels } of pages) {
  if (failed) {
    cases.push(`<testcase name="${xmlAttr(page)}" time="0"><skipped/></testcase>`);
    continue;
  }
  const section = sectionOf(page);
  const missing = sels.find((s) => forceFail || !matches(section, s));
  if (missing !== undefined) {
    failed = true;
    const message = `Timed out retrying after 10000ms: Expected to find element: \`${missing}\`, but never found it.`;
    const stack = `AssertionError: ${message}\n    at Context.eval (webpack://modello/./cypress/support/commands.js:42:8)`;
    cases.push(
      `<testcase name="${xmlAttr(page)}" time="10.2"><failure message="${xmlAttr(message)}" type="AssertionError"><![CDATA[${stack}]]></failure></testcase>`,
    );
  } else {
    cases.push(`<testcase name="${xmlAttr(page)}" time="1.1"></testcase>`);
  }
}

fs.mkdirSync(path.dirname(report), { recursive: true });
fs.writeFileSync(
  report,
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Mocha Tests"><testsuite name="${xmlAttr(mod || 's')}" tests="${pages.length}">${cases.join('')}</testsuite></testsuites>\n`,
);
console.log(`fake-cypress: ${path.basename(spec)} ${failed ? 'FAILED' : 'passed'}`);
process.exit(failed ? 1 : 0);
