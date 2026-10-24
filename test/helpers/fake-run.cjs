// Fake `modello run` for tests: writes a JUnit report for one spec.
// The spec fails while its module's model value is still the broken one listed in the
// broken-file ({ "m1": [[...keyPath], "<broken value>"] }), or when FAIL_IN_CHECKOUT exists in cwd.
// Usage: node fake-run.cjs <report> <spec> [broken-file]
const fs = require('fs');

const [report, spec, brokenFile] = process.argv.slice(2);
const mod = (/-(m\d+)-/.exec(spec) || [])[1];
const broken = brokenFile && fs.existsSync(brokenFile) ? JSON.parse(fs.readFileSync(brokenFile, 'utf8')) : {};

let fail = fs.existsSync('FAIL_IN_CHECKOUT');
if (broken[mod]) {
  const [keys, bad] = broken[mod];
  let v = JSON.parse(fs.readFileSync('test/ui/model-parameters.json', 'utf8'));
  for (const k of keys) v = v && v[k];
  if (v === bad) fail = true;
}
const failure = fail ? '<failure message="Expected to find element, but never found it."/>' : '';
fs.writeFileSync(report, `<testsuites><testsuite name="s"><testcase name="page 1">${failure}</testcase></testsuite></testsuites>`);
