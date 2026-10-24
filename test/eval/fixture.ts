// Builds a throwaway course for the evaluation from CASES.
//
// Layout (root is a temp dir; the course is root/course):
//   course/test/ui/model-parameters.json   {"&common": {"<page>": {"select_block_by_type(\"button\";0)": {"selector": ...}}}}
//   course/test/ui/model-map.json          {}
//   course/test/ui/model-edges.json        {}
//   course/.github/workflows/build-and-test.yml
//   course/app/content/<module>.html       <section data-page="<page>"> ...elements... </section>
//   root/eval-behaviour.json               {"m4": "environment", "m5": "flaky-once"}  (outside the course,
//                                          so an agent cannot read which module is rigged)
//   root/eval-state/                       run counters for flaky modules
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCK_KEY, CASES, type EvalCase } from './cases.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_GEN = path.join(HERE, 'fake-gen.cjs');
export const FAKE_CYPRESS = path.join(HERE, 'fake-cypress.cjs');

function write(dir: string, rel: string, text: string) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

/** Creates the course under `root` and returns its absolute path (root/course). */
export function createFixtureCourse(root: string, cases: EvalCase[] = CASES): string {
  const course = path.join(fs.realpathSync(root), 'course');
  fs.mkdirSync(course, { recursive: true });

  const common: Record<string, unknown> = {};
  for (const c of cases) common[c.page] = { [BLOCK_KEY]: { selector: c.initial } };
  write(course, 'test/ui/model-parameters.json', JSON.stringify({ '&common': common }, null, 4) + '\n');
  write(course, 'test/ui/model-map.json', '{}\n');
  write(course, 'test/ui/model-edges.json', '{}\n');
  write(
    course,
    '.github/workflows/build-and-test.yml',
    [
      'name: build and test',
      'on: [push]',
      'jobs:',
      '  call-build-and-test-course:',
      '    uses: EVERFI-Content/workflows/.github/workflows/build-and-test-course.yml@main',
      '    with:',
      '      generate-tests-script: modello generate',
      '',
    ].join('\n'),
  );
  write(course, '.gitignore', 'test/ui/cypress/\n');

  const byModule = new Map<string, EvalCase[]>();
  for (const c of cases) byModule.set(c.module, [...(byModule.get(c.module) ?? []), c]);
  for (const [module, list] of byModule) {
    const sections = list.map((c) => `<section data-page="${c.page}">\n    ${c.dom}\n</section>`).join('\n\n');
    write(course, `app/content/${module}.html`, `<!-- ${module} -->\n${sections}\n`);
  }

  const behaviour: Record<string, string> = {};
  for (const c of cases) if (c.behaviour) behaviour[c.module] = c.behaviour;
  fs.writeFileSync(path.join(path.dirname(course), 'eval-behaviour.json'), JSON.stringify(behaviour, null, 2) + '\n');
  fs.rmSync(path.join(path.dirname(course), 'eval-state'), { recursive: true, force: true });
  return course;
}

/** The `selector` leaf for `page` in the course's model-parameters.json. */
export function selectorIn(course: string, page: string): string | undefined {
  const json = JSON.parse(fs.readFileSync(path.join(course, 'test/ui/model-parameters.json'), 'utf8'));
  return json?.['&common']?.[page]?.[BLOCK_KEY]?.selector;
}
