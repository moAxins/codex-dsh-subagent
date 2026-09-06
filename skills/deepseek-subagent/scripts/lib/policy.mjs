import path from 'node:path';
import { isInside } from './common.mjs';

export const MAX_CONCURRENT_JOBS = 3;
export const MAX_CORRECTIONS = 2;
export const COMMAND_ACK_TIMEOUT_MS = 60_000;
export const CLEANUP_GRACE_TIMEOUT_MS = 10_000;
export const FORCE_STOP_TIMEOUT_MS = 5_000;
export const DEFAULT_MODE = 'acp';
export const MODES = ['acp', 'headless'];
export const READ_ONLY_TOOL_KINDS = ['read', 'search', 'fetch', 'think'];

export function assertMode(mode) {
  if (!MODES.includes(mode)) throw new Error(`--mode must be ${MODES.join(' or ')}.`);
  return mode;
}

export function correctionLimitReached(correctionCount) {
  return correctionCount >= MAX_CORRECTIONS;
}

export function validateTask(packet) {
  const strings = ['goal'];
  const arrays = ['plan', 'constraints', 'acceptanceCriteria', 'relevantPaths', 'requiredChecks'];
  for (const field of strings) if (typeof packet[field] !== 'string' || !packet[field].trim()) throw new Error(`Task field ${field} must be a non-empty string.`);
  for (const field of arrays) if (!Array.isArray(packet[field]) || !packet[field].every(value => typeof value === 'string')) throw new Error(`Task field ${field} must be a string array.`);
  return packet;
}

function allPaths(value, key = '') {
  const found = [];
  if (typeof value === 'string' && /(^|_)(path|cwd|location)$/i.test(key)) found.push(value);
  else if (Array.isArray(value)) for (const item of value) found.push(...allPaths(item, key));
  else if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) found.push(...allPaths(child, childKey));
  return found;
}

/**
 * Decide whether an ACP tool call may proceed without user interaction.
 * Read-only tools always pass. Every mutation target must be inside the
 * worktree, or exactly the delegated job's evidence file when evidence is
 * required. Nothing else outside the worktree is reachable.
 */
export function permissionAllowed(toolCall, { worktreePath, evidencePath }) {
  const kind = toolCall?.kind ?? 'other';
  if (READ_ONLY_TOOL_KINDS.includes(kind)) return true;
  const paths = allPaths(toolCall);
  if (paths.length === 0) return false;
  return paths.every(value => {
    const target = path.isAbsolute(value) ? value : path.join(worktreePath, value);
    if (evidencePath && path.resolve(target) === path.resolve(evidencePath)) return true;
    return isInside(worktreePath, target);
  });
}
