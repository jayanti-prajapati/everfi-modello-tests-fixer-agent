import { describe, expect, it } from 'vitest';
import { makeCanUseTool } from '../src/agent.js';
import { createFixerServer } from '../src/tools/index.js';
import { DEFAULTS } from '../src/config.js';
import { Session } from '../src/session.js';

const gate = makeCanUseTool('/proj');
const call = (name: string, input: Record<string, unknown> = {}) => gate(name, input, {} as any);

describe('canUseTool', () => {
  it('allows fixer tools and in-project reads', async () => {
    expect((await call('mcp__fixer__run_cypress'))?.behavior).toBe('allow');
    expect((await call('Read', { file_path: '/proj/test/ui/model-map.json' }))?.behavior).toBe('allow');
    expect((await call('Grep', { path: '/proj/public' }))?.behavior).toBe('allow');
    expect((await call('ToolSearch'))?.behavior).toBe('allow');
  });

  it('denies writes, shell, and anything else', async () => {
    for (const t of ['Bash', 'Edit', 'Write', 'WebFetch']) expect((await call(t))?.behavior).toBe('deny');
  });

  it('denies reads outside the project and .env files', async () => {
    expect((await call('Read', { file_path: '/etc/passwd' }))?.behavior).toBe('deny');
    expect((await call('Read', { file_path: '/proj/../other/x' }))?.behavior).toBe('deny');
    expect((await call('Read', { file_path: '/proj/.env.local' }))?.behavior).toBe('deny');
  });
});

describe('createFixerServer', () => {
  it('builds an in-process MCP server', () => {
    const server = createFixerServer(new Session({ ...DEFAULTS, projectDir: '/proj', write: false, local: false }));
    expect(server.type).toBe('sdk');
    expect(server.name).toBe('fixer');
  });
});
