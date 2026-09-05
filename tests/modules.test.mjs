import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CLEANUP_GRACE_TIMEOUT_MS, COMMAND_ACK_TIMEOUT_MS, DEFAULT_MODE, FORCE_STOP_TIMEOUT_MS,
  MAX_CONCURRENT_JOBS, MAX_CORRECTIONS, MODES, correctionLimitReached, permissionAllowed,
  validateTask,
} from '../skills/deepseek-subagent/scripts/lib/policy.mjs';
import { OBSERVABLE_UPDATES, summarize, updateKind } from '../skills/deepseek-subagent/scripts/lib/trace.mjs';
import {
  EVIDENCE_KINDS, EVIDENCE_SCHEMA_VERSION, INVALID, MISSING, NOT_REQUIRED, READY,
  readEvidence, requirements, validateItem, validateParsed,
} from '../skills/deepseek-subagent/scripts/lib/evidence.mjs';

test('policy centralizes limits, modes, and task validation', () => {
  assert.equal(MAX_CONCURRENT_JOBS, 3);
  assert.equal(MAX_CORRECTIONS, 2);
  assert.equal(COMMAND_ACK_TIMEOUT_MS, 60_000);
  assert.equal(CLEANUP_GRACE_TIMEOUT_MS, 10_000);
  assert.equal(FORCE_STOP_TIMEOUT_MS, 5_000);
  assert.equal(DEFAULT_MODE, 'acp');
  assert.deepEqual(MODES, ['acp', 'headless']);
  assert.equal(correctionLimitReached(0), false);
  assert.equal(correctionLimitReached(1), false);
  assert.equal(correctionLimitReached(2), true);
  assert.equal(correctionLimitReached(5), true);

  const task = { goal: 'g', plan: [], constraints: [], acceptanceCriteria: [], relevantPaths: [], requiredChecks: [] };
  assert.deepEqual(validateTask(task), task);
  assert.throws(() => validateTask({ ...task, goal: '  ' }), /goal/);
  assert.throws(() => validateTask({ ...task, plan: 'not-an-array' }), /plan/);
});

test('permission policy allows only the worktree and the exact evidence file', () => {
  const root = path.join(os.tmpdir(), 'policy-scope-test');
  const worktree = path.join(root, 'worktree');
  const artifacts = path.join(root, 'job', 'artifacts');
  const evidence = path.join(artifacts, 'evidence.json');
  const inside = path.join(worktree, 'src', 'a.ts');
  const outside = path.join(root, 'elsewhere.txt');

  const edit = file => ({ toolCallId: 't', title: 'edit', kind: 'edit', locations: [{ path: file }] });
  const context = { worktreePath: worktree, evidencePath: evidence };

  for (const kind of ['read', 'search', 'fetch', 'think']) {
    assert.equal(permissionAllowed({ toolCallId: 't', title: 'x', kind }, context), true, `${kind} must always pass`);
  }
  assert.equal(permissionAllowed(edit(inside), context), true, 'edits inside the worktree pass');
  assert.equal(permissionAllowed(edit(outside), context), false, 'edits outside the worktree are refused');
  assert.equal(permissionAllowed(edit(evidence), { worktreePath: worktree }), false, 'the evidence file needs an explicit grant');
  assert.equal(permissionAllowed(edit(evidence), context), true, 'the exact evidence file passes when granted');
  assert.equal(permissionAllowed(edit(artifacts), context), false, 'the artifacts directory is not granted');
  assert.equal(permissionAllowed(edit(path.join(artifacts, 'other.json')), context), false, 'no sibling of the evidence file is granted');
  assert.equal(permissionAllowed({ toolCallId: 't', title: 'run', kind: 'execute' }, context), false, 'pathless mutations are refused');
  assert.equal(permissionAllowed({ toolCallId: 't', title: 'run', kind: 'execute', cwd: worktree }, context), true, 'commands rooted in the worktree pass');
});

test('trace summary detects duplicates, gaps, and out-of-order records', () => {
  assert.deepEqual(OBSERVABLE_UPDATES, ['plan', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk', 'usage_update']);
  assert.equal(updateKind({ sessionUpdate: 'agent_thought_chunk' }), 'agent_thought_chunk');
  assert.equal(updateKind({ sessionUpdate: 'compaction_update' }), undefined);
  assert.equal(updateKind(undefined), undefined);

  const record = (seq, type = 'started', data = {}) => ({ seq, type, data });
  const contiguous = [record(1), record(2, 'acp_update', { sessionUpdate: 'plan' }), record(3)];
  const summary = summarize(contiguous, 3);
  assert.equal(summary.complete, true);
  assert.deepEqual(summary.duplicateSeqs, []);
  assert.deepEqual(summary.missingSeqs, []);

  const withGap = summarize([record(1), record(2), record(4)], 4);
  assert.equal(withGap.complete, false);
  assert.deepEqual(withGap.missingSeqs, [3]);

  const withDuplicate = summarize([record(1), record(1), record(2)], 2);
  assert.equal(withDuplicate.complete, false);
  assert.deepEqual(withDuplicate.duplicateSeqs, [1]);

  const withReorder = summarize([record(1), record(3), record(2)], 3);
  assert.equal(withReorder.complete, false);
  assert.equal(withReorder.outOfOrder, true);

  const empty = summarize([], 0);
  assert.equal(empty.complete, false);
  assert.equal(empty.firstSeq, null);
});

test('trace summary reports per-kind counts and correction totals', () => {
  const events = [
    { seq: 1, type: 'started', data: {} },
    { seq: 2, type: 'acp_update', data: { sessionUpdate: 'plan' } },
    { seq: 3, type: 'acp_update', data: { sessionUpdate: 'agent_thought_chunk' } },
    { seq: 4, type: 'acp_update', data: { sessionUpdate: 'agent_thought_chunk' } },
    { seq: 5, type: 'acp_update', data: { sessionUpdate: 'tool_call' } },
    { seq: 6, type: 'acp_update', data: { sessionUpdate: 'tool_call_update' } },
    { seq: 7, type: 'acp_update', data: { sessionUpdate: 'agent_message_chunk' } },
    { seq: 8, type: 'acp_update', data: { sessionUpdate: 'usage_update' } },
    { seq: 9, type: 'acp_update', data: { sessionUpdate: 'available_commands_update' } },
    { seq: 10, type: 'prompt_started', data: { correction: true } },
    { seq: 11, type: 'prompt_started', data: { correction: true } },
    { seq: 12, type: 'prompt_started', data: { correction: false } },
  ];
  const summary = summarize(events, 12);
  assert.equal(summary.complete, true);
  assert.equal(summary.observableEventCount, 7);
  assert.deepEqual(summary.counts, {
    plan: 1, agent_thought_chunk: 2, tool_call: 1, tool_call_update: 1, agent_message_chunk: 1, usage_update: 1,
  });
  assert.equal(summary.corrections.count, 2);
  assert.equal(summary.corrections.max, 2);
  assert.equal(summary.corrections.limitReached, true);
});

test('evidence requirements normalize and validate the packet field', () => {
  assert.deepEqual(requirements({}), { required: false, kinds: [] });
  assert.deepEqual(requirements({ evidenceRequirements: { required: false } }), { required: false, kinds: [] });
  const required = requirements({ evidenceRequirements: { required: true } });
  assert.equal(required.required, true);
  assert.deepEqual(required.kinds, EVIDENCE_KINDS);
  assert.deepEqual(requirements({ evidenceRequirements: { required: true, kinds: ['fact'] } }).kinds, ['fact']);
  assert.throws(() => requirements({ evidenceRequirements: { required: 'yes' } }), /required/);
  assert.throws(() => requirements({ evidenceRequirements: { kinds: ['guess'] } }), /kinds/);
});

function validItem(overrides = {}) {
  return {
    id: 'fact-1', kind: 'fact', selected: true, useLocations: ['src/a.ts'],
    claim: 'observable claim', sourceUrl: 'https://example.com/spec', publisher: 'Example Docs',
    publishedAt: '2026-01-01', verificationNotes: 'verified', uncertainties: [],
    ...overrides,
  };
}

test('evidence schema version 1 validates fact, citation, and image items', () => {
  assert.equal(EVIDENCE_SCHEMA_VERSION, 1);
  assert.deepEqual(EVIDENCE_KINDS, ['fact', 'citation', 'image']);

  const base = validItem();
  for (const kind of ['fact', 'citation']) {
    assert.deepEqual(validateItem({ ...base, id: `${kind}-1`, kind }), []);
  }
  const image = {
    ...base, id: 'image-1', kind: 'image', selected: false, useLocations: [],
    publishedAt: null, imageUrl: 'https://example.com/x.png', caption: null,
  };
  assert.deepEqual(validateItem(image), []);

  assert.ok(validateItem({ ...base, claim: '' }).some(error => /claim/.test(error)));
  assert.ok(validateItem({ ...base, sourceUrl: 'not-absolute' }).some(error => /sourceUrl/.test(error)));
  assert.ok(validateItem({ ...base, selected: true, useLocations: [] }).some(error => /at least one useLocation/.test(error)));
  assert.ok(validateItem({ ...base, kind: 'image', selected: false, useLocations: [], imageUrl: 'relative.png', caption: '' }).some(error => /imageUrl/.test(error)));
  assert.ok(validateItem({ ...base, uncertainties: 'nope' }).some(error => /uncertainties/.test(error)));
  assert.ok(validateItem({ ...base, id: '' }).some(error => /id/.test(error)));
});

test('evidence parsed validation reports version, shape, and duplicate-id errors', () => {
  const item = validItem();
  assert.deepEqual(validateParsed({ version: 1, items: [item] }).errors, []);
  assert.ok(validateParsed({ version: 2, items: [item] }).errors.some(error => /version/.test(error)));
  assert.ok(validateParsed({ version: 1, items: 'nope' }).errors.some(error => /items/.test(error)));
  const duplicated = validateParsed({ version: 1, items: [item, { ...item, kind: 'citation' }] });
  assert.ok(duplicated.errors.some(error => /duplicated/.test(error)));
  assert.deepEqual(validateParsed({ items: [item] }).errors, ['evidence file version must be 1']);
});

test('readEvidence reports missing, invalid, and ready file states', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'evidence-read-'));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const file = path.join(base, 'evidence.json');

  const missing = await readEvidence(file);
  assert.equal(missing.status, MISSING);
  assert.deepEqual(missing.items, []);

  await writeFile(file, '{ not json', 'utf8');
  const malformed = await readEvidence(file);
  assert.equal(malformed.status, INVALID);
  assert.ok(malformed.errors.some(error => /not valid JSON/.test(error)));

  await writeFile(file, JSON.stringify({ version: 1, items: [validItem(), { ...validItem(), id: 'image-1', kind: 'image', selected: false, useLocations: [], imageUrl: 'https://example.com/x.png', caption: null }] }), 'utf8');
  const ready = await readEvidence(file);
  assert.equal(ready.status, READY);
  assert.equal(ready.schemaVersion, 1);
  assert.equal(ready.items.length, 2);

  const missingKind = await readEvidence(file, ['citation']);
  assert.equal(missingKind.status, INVALID);
  assert.deepEqual(missingKind.items, []);
  assert.ok(missingKind.errors.some(error => /missing required kind "citation"/.test(error)));

  await writeFile(file, JSON.stringify({ version: 1, items: [validItem({ claim: '' })] }), 'utf8');
  const invalid = await readEvidence(file);
  assert.equal(invalid.status, INVALID);
  assert.ok(invalid.errors.length > 0);
  assert.equal(NOT_REQUIRED, 'not_required');
});
