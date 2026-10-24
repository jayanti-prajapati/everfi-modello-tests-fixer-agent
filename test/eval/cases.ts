// Evaluation cases: one module per case, each with one page and one button block.
// fixture.ts builds the course from this table; eval.test.ts and run.ts score against it.

export type EvalStatus = 'passed' | 'fixed' | 'flaky' | 'unfixable' | 'skipped';
export type EvalMethod = 'rule' | 'recipe' | 'agent';

/** Special behaviour of the fake `modello run` for a module (see fake-cypress.cjs). */
export type Behaviour = 'environment' | 'flaky-once';

export interface EvalCase {
  module: string;
  title: string;
  page: string;
  /** Selector in model-parameters.json before the run */
  initial: string;
  /** The page's "DOM": the elements inside its <section data-page="..."> in app/content/<module>.html */
  dom: string;
  behaviour?: Behaviour;
  /** Selector expected in model-parameters.json after the run; 'unchanged' = must equal `initial` */
  expectSelector: string | 'unchanged';
  /** Expected status when no agent may start (budget 0): rules and recipes only */
  expectRules: EvalStatus;
  /** Expected status when real agents are allowed */
  expectAgent: EvalStatus;
  /** Expected method (where one is expected); undefined = not checked */
  expectMethod?: EvalMethod;
  /** Regex the summary must match (both modes) */
  expectSummary?: RegExp;
}

export const SPEC_OF = (module: string) => `course-${module}-s3-s3.amazonaws.com.js`;
export const BLOCK_KEY = 'select_block_by_type("button";0)';

export const CASES: EvalCase[] = [
  {
    module: 'm1',
    title: 'stale id (one similar id in the source)',
    page: 'm1/a1/page-2',
    initial: '#btn2-stale',
    dom: '<button id="btn2">Next</button>\n    <button id="btn9">Skip</button>',
    expectSelector: '#btn2',
    expectRules: 'fixed',
    expectAgent: 'fixed',
    expectMethod: 'recipe',
  },
  {
    module: 'm2',
    title: 'renamed data attribute',
    page: 'm2/a3/page-1',
    initial: '[data-hotspot="budget-old"]',
    dom: '<button data-hotspot="budget">Budget</button>\n    <button data-hotspot="savings">Savings</button>',
    expectSelector: '[data-hotspot="budget"]',
    expectRules: 'fixed',
    expectAgent: 'fixed',
    expectMethod: 'recipe',
  },
  {
    module: 'm3',
    title: 'translation-edit markup in name attribute',
    page: 'm3/a2/page-4',
    initial: "[name='formField1']",
    dom: `<input name="<span data-forgeaction='editlocale'>formField1</span>" />\n    <button id="submit-form">Submit</button>`,
    expectSelector: "[name*='formField1']",
    expectRules: 'fixed',
    expectAgent: 'fixed',
    expectMethod: 'recipe',
  },
  {
    module: 'm4',
    title: 'environment failure (Cypress cannot start, no report)',
    page: 'm4/a1/page-1',
    initial: '#begin',
    dom: '<button id="begin">Begin</button>',
    behaviour: 'environment',
    expectSelector: 'unchanged',
    expectRules: 'unfixable',
    expectAgent: 'unfixable',
    expectMethod: 'rule',
    expectSummary: /MODULE_NOT_FOUND|could not start|environment/i,
  },
  {
    module: 'm5',
    title: 'flaky (fails on the first run only)',
    page: 'm5/a1/page-3',
    initial: '#continue',
    dom: '<button id="continue">Continue</button>',
    behaviour: 'flaky-once',
    expectSelector: 'unchanged',
    expectRules: 'flaky',
    expectAgent: 'flaky',
    expectMethod: 'rule',
  },
  {
    module: 'm6',
    title: 'ambiguous (two equally plausible replacements)',
    page: 'm6/a2/page-5',
    initial: '#next-old',
    dom: '<button id="next-a">Next</button>\n    <button id="next-b">Next</button>',
    expectSelector: 'unchanged',
    expectRules: 'skipped',
    expectAgent: 'unfixable',
  },
  {
    module: 'm7',
    title: 'passing control',
    page: 'm7/a1/page-1',
    initial: '#start',
    dom: '<button id="start">Start</button>',
    expectSelector: 'unchanged',
    expectRules: 'passed',
    expectAgent: 'passed',
  },
];

/** The selector the case should end with. */
export const expectedFinal = (c: EvalCase) => (c.expectSelector === 'unchanged' ? c.initial : c.expectSelector);
