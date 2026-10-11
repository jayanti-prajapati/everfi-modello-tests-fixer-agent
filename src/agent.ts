import path from 'node:path';
import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { type Config } from './config.js';
import { Session } from './session.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { createFixerServer, SERVER_NAME, TOOL_NAMES } from './tools/index.js';

const READ_ONLY = new Set(['Read', 'Grep', 'Glob']);

/** Permission gate: only our tools plus read-only built-ins, and never outside the project or into .env files. */
export function makeCanUseTool(projectDir: string): CanUseTool {
  const root = path.resolve(projectDir);
  return async (toolName, input) => {
    if (toolName.startsWith(`mcp__${SERVER_NAME}__`)) return { behavior: 'allow', updatedInput: input };
    if (READ_ONLY.has(toolName)) {
      const target = String(input.file_path ?? input.path ?? root);
      const abs = path.resolve(root, target);
      const inside = abs === root || abs.startsWith(root + path.sep);
      if (!inside) return { behavior: 'deny', message: 'Reads are limited to the project directory.' };
      if (path.basename(abs).startsWith('.env')) return { behavior: 'deny', message: '.env files are off limits.' };
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: `${toolName} is not available to this agent.` };
  };
}

export interface RunResult {
  session: Session;
  costUsd?: number;
  finalText?: string;
}

export async function runFixer(config: Config, specs: string[], log: (s: string) => void = console.log): Promise<RunResult> {
  const session = new Session(config);
  const prompt =
    `Project: ${config.projectDir}\nModel directory: ${config.modelDir}\nMode: ${config.write ? 'WRITE (changes will be applied)' : 'DRY-RUN (record proposals only)'}\n` +
    `Max Cypress runs: ${config.maxAttempts}\n` +
    (specs.length ? `Fix these specs: ${specs.join(', ')}` : 'Run every spec from list_specs and fix any that fail.');

  const result: RunResult = { session };
  for await (const msg of query({
    prompt,
    options: {
      model: config.model,
      cwd: config.projectDir,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { [SERVER_NAME]: createFixerServer(session) },
      allowedTools: [...TOOL_NAMES, ...READ_ONLY],
      disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
      permissionMode: 'default',
      canUseTool: makeCanUseTool(config.projectDir),
      settingSources: [],
      maxBudgetUsd: config.maxBudgetUsd,
    },
  })) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text.trim()) log(block.text.trim());
        if (block.type === 'tool_use') log(`→ ${block.name}`);
      }
    } else if (msg.type === 'result') {
      result.costUsd = msg.total_cost_usd;
      if (msg.subtype === 'success') result.finalText = msg.result;
      else log(`agent stopped: ${msg.subtype}`);
    }
  }
  return result;
}
