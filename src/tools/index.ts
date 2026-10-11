import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { WRITABLE_FILES } from '../guard.js';
import type { Session } from '../session.js';

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (data: unknown): Result => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown): Result => ({
  content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});
const guarded = <A>(fn: (a: A) => Promise<unknown> | unknown) => async (args: A): Promise<Result> => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

export const SERVER_NAME = 'fixer';
export const TOOL_NAMES = ['list_specs', 'run_cypress', 'set_model_value', 'rebuild_spec', 'report_outcome'].map(
  (n) => `mcp__${SERVER_NAME}__${n}`,
);

export function createFixerServer(s: Session) {
  return createSdkMcpServer({
    name: SERVER_NAME,
    tools: [
      tool('list_specs', 'List generated Cypress spec files available to run.', {}, guarded(() => s.listSpecs()), {
        annotations: { readOnlyHint: true },
      }),
      tool(
        'run_cypress',
        'Run one generated spec (file name only) and return structured failures. Each failure carries the page, block type, parameters and cy.* command it came from when it could be resolved. Limited number of runs.',
        { spec: z.string().describe('Spec file name, e.g. digital-banking-m1-s3-s3.amazonaws.com.js') },
        guarded(({ spec }) => s.runSpec(spec)),
      ),
      tool(
        'set_model_value',
        'Set ONE leaf value in a model config file. path is the list of JSON keys from the file root to the leaf (keys may contain spaces, quotes, slashes). Never replaces subtrees. In dry-run mode this only records the proposal.',
        {
          file: z.enum(WRITABLE_FILES),
          path: z.array(z.string()).min(1),
          value: z.union([z.string(), z.number(), z.boolean()]),
        },
        guarded((p) => s.setValue(p)),
      ),
      tool(
        'rebuild_spec',
        'Regenerate ALL course specs through ECC after a model config change (slow; it deletes and recreates cypress/e2e). Returns the spec files present afterwards. Only available with --write.',
        {},
        guarded(() => s.rebuild()),
      ),
      tool(
        'report_outcome',
        'Call exactly once, last. fixed = spec now passes; proposed = dry-run change(s) recorded; unfixable = ambiguous, not a model-config problem, or limit hit.',
        { status: z.enum(['fixed', 'proposed', 'unfixable']), summary: z.string() },
        guarded((o) => {
          s.outcome = o;
          return 'recorded';
        }),
      ),
    ],
  });
}
