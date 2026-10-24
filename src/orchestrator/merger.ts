import fs from 'node:fs';
import { applyPatch, resolveModelFile, serializeLike, type WritableFile } from '../guard.js';
import type { Proposal } from '../session.js';
import type { MergeResult } from './events.js';

export interface AgentPatches {
  agentId: string;
  patches: Proposal[];
}

const keyOf = (p: { file: string; path: string[] }) => `${p.file}\u0000${JSON.stringify(p.path)}`;

/**
 * An agent may set the same key more than once (try, verify fails, try again). What it verified
 * is the last value; what the checkout must still hold is the value before its first change.
 */
export function collapse(patches: Proposal[]): Proposal[] {
  const byKey = new Map<string, Proposal>();
  for (const p of patches) {
    const prev = byKey.get(keyOf(p));
    byKey.set(keyOf(p), prev ? { ...p, before: prev.before } : p);
  }
  return [...byKey.values()];
}

/**
 * Replays verified leaf patches from isolated workspaces onto the real checkout through the
 * same guard the agents use. Each agent's set is all-or-nothing: if any of its patches
 * conflicts (another agent claimed the key with a different value, or the checkout no longer
 * holds the value the agent started from), none of them is written, because a partial set is
 * a combination nobody verified.
 */
export function mergeProposals(modelDir: string, sets: AgentPatches[]): MergeResult[] {
  const claimed = new Map<string, { agentId: string; value: unknown }>();
  const results: MergeResult[] = [];
  for (const { agentId, patches } of sets) {
    const planned = collapse(patches).map((p) => ({ p, ...check(modelDir, p, agentId, claimed) }));
    const blocked = planned.find((x) => x.status === 'conflict' || x.status === 'error');
    for (const x of planned) {
      const base = { agentId, file: x.p.file, path: x.p.path, value: x.p.value };
      if (blocked) {
        results.push(
          x === blocked || x.status !== 'applied'
            ? { ...base, status: x.status, message: x.message }
            : { ...base, status: 'conflict', message: 'not written: another change from this agent conflicted' },
        );
        continue;
      }
      if (x.status === 'applied') {
        try {
          const file = resolveModelFile(modelDir, x.p.file as WritableFile);
          const original = fs.readFileSync(file, 'utf8');
          const { json } = applyPatch(JSON.parse(original), { file: x.p.file, path: x.p.path, value: x.p.value, create: x.p.create });
          fs.writeFileSync(file, serializeLike(original, json));
        } catch (e) {
          results.push({ ...base, status: 'error', message: e instanceof Error ? e.message : String(e) });
          continue;
        }
      }
      claimed.set(keyOf(x.p), { agentId, value: x.p.value });
      results.push({ ...base, status: x.status });
    }
  }
  return results;
}

/**
 * Undoes merged patches (sets each key back to the value before the agent's first change),
 * but only where the checkout still holds the merged value. Returns the keys reverted.
 */
export function revertPatches(modelDir: string, patches: Proposal[]): string[][] {
  const reverted: string[][] = [];
  for (const p of collapse(patches)) {
    if (p.before === undefined) continue; // a created key: leave for a human rather than delete
    const file = resolveModelFile(modelDir, p.file as WritableFile);
    const original = fs.readFileSync(file, 'utf8');
    if (currentValue(JSON.parse(original), p.path) !== p.value) continue;
    const { json } = applyPatch(JSON.parse(original), { file: p.file, path: p.path, value: p.before as string | number | boolean });
    fs.writeFileSync(file, serializeLike(original, json));
    reverted.push(p.path);
  }
  return reverted;
}

/** Decides what merging one patch would do, without writing. */
function check(
  modelDir: string,
  p: Proposal,
  agentId: string,
  claimed: Map<string, { agentId: string; value: unknown }>,
): { status: MergeResult['status']; message?: string } {
  const prior = claimed.get(keyOf(p));
  if (prior && prior.agentId !== agentId && prior.value !== p.value) {
    return { status: 'conflict', message: `${prior.agentId} already set this key to ${JSON.stringify(prior.value)}` };
  }
  try {
    const file = resolveModelFile(modelDir, p.file as WritableFile);
    const current = currentValue(JSON.parse(fs.readFileSync(file, 'utf8')), p.path);
    if (current === p.value) return { status: 'unchanged' };
    if (current !== p.before) {
      return { status: 'conflict', message: `checkout holds ${JSON.stringify(current)}, agent started from ${JSON.stringify(p.before)}` };
    }
    return { status: 'applied' };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

function currentValue(doc: unknown, keys: string[]): unknown {
  let node = doc;
  for (const k of keys) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, k)) return undefined;
    node = (node as Record<string, unknown>)[k];
  }
  return node;
}
