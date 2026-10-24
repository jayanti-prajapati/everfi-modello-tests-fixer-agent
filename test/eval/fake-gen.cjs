// Fake ECC test build (`ecc --script test:build`) for the evaluation fixture.
// Run with cwd = course root. Like ECC, deletes test/ui/cypress/e2e and regenerates every spec
// from test/ui/model-parameters.json: one spec per module, one block per page, in modello's
// generated-spec format (`// -> page: ..., block uid: ...` header, then the cy.* line).
const fs = require('fs');
const path = require('path');

const modelDir = path.join(process.cwd(), 'test/ui');
const outDir = path.join(modelDir, 'cypress/e2e');
const params = JSON.parse(fs.readFileSync(path.join(modelDir, 'model-parameters.json'), 'utf8'));

const byModule = new Map();
for (const [page, blocks] of Object.entries(params['&common'] || {})) {
  const module = page.split('/')[0];
  if (!byModule.has(module)) byModule.set(module, []);
  byModule.get(module).push([page, blocks]);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const [module, pages] of byModule) {
  const lines = [`describe(${JSON.stringify(module)}, () => {`];
  for (const [page, blocks] of pages) {
    lines.push(`  it(${JSON.stringify(page)}, () => {`);
    let i = 0;
    for (const [key, parameters] of Object.entries(blocks)) {
      const type = (/select_block_by_type\("(\w+)"/.exec(key) || [])[1] || 'button';
      lines.push(`    // -> page: ${page}, block uid: ${page.replace(/\W+/g, '-')}-b${i++}`);
      lines.push(`    //    type: ${type}`);
      lines.push(`    //    parameters: ${JSON.stringify(parameters)}`);
      lines.push(`    cy.button(${JSON.stringify(parameters.selector)});`);
    }
    lines.push('  });');
  }
  lines.push('});', '');
  fs.writeFileSync(path.join(outDir, `course-${module}-s3-s3.amazonaws.com.js`), lines.join('\n'));
}
console.log(`fake-gen: wrote ${byModule.size} spec(s) to ${path.relative(process.cwd(), outDir)}`);
