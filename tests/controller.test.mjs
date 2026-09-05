import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceLauncher } from '../skills/deepseek-subagent/scripts/lib/common.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const controller = path.join(root, 'skills', 'deepseek-subagent', 'scripts', 'dsh-subagent.mjs');
const fakeHeadless = path.join(root, 'tests', 'fixtures', 'fake-headless.mjs');
const fakeAcp = path.join(root, 'tests', 'fixtures', 'fake-acp.mjs');

async function git(cwd, ...args) { return await exec('git', args, { cwd }); }

async function setup(t, fake = fakeHeadless) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-test-'));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'codex-home');
  await mkdir(repo); await mkdir(path.join(home, 'deepseek-subagent'), { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Test User');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'tracked.txt'), 'base\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  await writeFile(path.join(home, 'deepseek-subagent', 'config.json'), JSON.stringify({ command: process.execPath, args: [fake] }));
  const env = { ...process.env, CODEX_HOME: home };
  delete env.DEEPSEEK_HARNESS_ROOT;
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  return { base, repo, home, env };
}

async function packet(base, goal, options = {}) {
  const file = path.join(base, `${Math.random()}.json`);
  const task = { goal, plan: [], constraints: [], acceptanceCriteria: [], relevantPaths: [], requiredChecks: [] };
  if (options.evidence) task.evidenceRequirements = { required: true, kinds: options.kinds ?? ['fact', 'citation', 'image'] };
  await writeFile(file, JSON.stringify(task));
  return file;
}

async function cli(env, ...args) {
  const result = await exec(process.execPath, [controller, ...args], { env, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}

async function waitFor(env, jobId, wanted, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let result;
  const statePath = path.join(env.CODEX_HOME, 'deepseek-subagent', 'jobs', jobId, 'state.json');
  while (Date.now() < deadline) {
    try { result = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (wanted.includes(result?.status)) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Job stayed in ${result?.status}; wanted ${wanted.join(', ')}`);
}

test('source checkout launcher uses the checkout tsconfig from delegated worktrees', async t => {
  const harnessRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-source-'));
  const cliPath = path.join(harnessRoot, 'apps', 'cli', 'src', 'bin.ts');
  const loaderPath = path.join(harnessRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const tsconfigPath = path.join(harnessRoot, 'tsconfig.json');
  await mkdir(path.dirname(cliPath), { recursive: true });
  await mkdir(path.dirname(loaderPath), { recursive: true });
  await writeFile(cliPath, '');
  await writeFile(loaderPath, '');
  await writeFile(tsconfigPath, '{}\n');
  t.after(async () => { await rm(harnessRoot, { recursive: true, force: true }); });

  const launcher = await sourceLauncher(harnessRoot);
  assert.equal(launcher.command, process.execPath);
  assert.deepEqual(launcher.args, ['--import', pathToFileURL(loaderPath).href, cliPath]);
  assert.equal(launcher.env.TSX_TSCONFIG_PATH, tsconfigPath);
});

test('headless lifecycle isolates a clean worktree and cleans it up', async t => {
  const ctx = await setup(t);
  const task = await packet(ctx.base, 'analyze');
  const spawned = await cli(ctx.env, 'spawn', '--repo', ctx.repo, '--mode', 'headless', '--task', task);
  assert.notEqual(path.resolve(spawned.worktreePath), path.resolve(ctx.repo));
  assert.equal(spawned.evidenceRequired, false);
  await waitFor(ctx.env, spawned.jobId, ['completed']);
  const result = await cli(ctx.env, 'result', '--job', spawned.jobId);
  assert.equal(result.dirty, false);
  assert.match(result.result, /^headless:/);
  assert.equal(result.evidenceStatus, 'not_required');
  assert.equal(result.correctionCount, 0);
  assert.equal(result.trace.complete, true);
  const cleaned = await cli(ctx.env, 'cleanup', '--job', spawned.jobId);
  assert.equal(cleaned.status, 'cleaned');
});

test('dirty delegated changes are preserved by cleanup', async t => {
  const ctx = await setup(t);
  const task = await packet(ctx.base, '[EDIT]');
  const spawned = await cli(ctx.env, 'spawn', '--repo', ctx.repo, '--mode', 'headless', '--task', task);
  await waitFor(ctx.env, spawned.jobId, ['completed']);
  const result = await cli(ctx.env, 'result', '--job', spawned.jobId);
  assert.equal(result.dirty, true);
  await assert.rejects(cli(ctx.env, 'cleanup', '--job', spawned.jobId), /dirty and was preserved/);
  assert.equal(await readFile(path.join(spawned.worktreePath, 'delegated.txt'), 'utf8'), 'uncommitted delegated change\n');
  await rm(path.join(spawned.worktreePath, 'delegated.txt'));
  await cli(ctx.env, 'cleanup', '--job', spawned.jobId);
});

test('ACP supports interrupt, correction, semantic events, and outside-write rejection', async t => {
  const ctx = await setup(t, fakeAcp);
  const first = await packet(ctx.base, '[HANG] [PERMISSION]');
  const correction = await packet(ctx.base, 'continue correctly');
  const spawned = await cli(ctx.env, 'spawn', '--repo', ctx.repo, '--mode', 'acp', '--task', first);
  await waitFor(ctx.env, spawned.jobId, ['running']);
  await cli(ctx.env, 'interrupt', '--job', spawned.jobId);
  await waitFor(ctx.env, spawned.jobId, ['cancelled']);
  const followup = await cli(ctx.env, 'followup', '--job', spawned.jobId, '--task', correction);
  assert.equal(followup.ok, true);
  await waitFor(ctx.env, spawned.jobId, ['idle']);
  const result = await cli(ctx.env, 'result', '--job', spawned.jobId);
  assert.equal(result.result, 'answer-2');
  assert.equal(result.correctionCount, 1);
  assert.ok(result.events.some(value => value.type === 'permission' && value.data.allowed === false));
  assert.ok(result.events.some(value => value.type === 'interrupt_requested'));
  await cli(ctx.env, 'cleanup', '--job', spawned.jobId);
});

test('concurrency is capped at three active jobs', async t => {
  const ctx = await setup(t);
  const task = await packet(ctx.base, '[SLEEP]');
  const jobs = [];
  for (let index = 0; index < 3; index += 1) jobs.push(await cli(ctx.env, 'spawn', '--repo', ctx.repo, '--mode', 'headless', '--task', task));
  await assert.rejects(cli(ctx.env, 'spawn', '--repo', ctx.repo, '--mode', 'headless', '--task', task), /three-job concurrency limit/);
  for (const job of jobs) {
    await waitFor(ctx.env, job.jobId, ['completed']);
    await cli(ctx.env, 'cleanup', '--job', job.jobId);
  }
});

test('headless timeout is recorded', async t => {
  const ctx = await setup(t);
  const task = await packet(ctx.base, '[TIMEOUT]');
  const spawned = await cli(ctx.env, 'spawn', '--repo', ctx.repo, '--mode', 'headless', '--task', task, '--timeout-ms', '1000');
  await waitFor(ctx.env, spawned.jobId, ['timed_out'], 10_000);
  await cli(ctx.env, 'cleanup', '--job', spawned.jobId);
});

test('ACP trace is captured ordered, incrementally, and without loss or duplication', async t => {
  const ctx = await setup(t, fakeAcp);
  const task = await packet(ctx.base, 'trace everything');
  const spawned = await cli(ctx.env, 'spawn', '--repo', ctx.repo, '--mode', 'acp', '--task', task);
  const seen = new Map();
  let maxSeen = 0;
  const collect = async poll => {
    assert.ok(Number.isInteger(poll.latestSeq), 'wait must expose an integer latestSeq');
    assert.ok(poll.latestSeq >= (poll.events.at(-1)?.seq ?? 0), 'latestSeq must cover every returned event');
    for (const event of poll.events) {
      assert.ok(!seen.has(event.seq), `event seq ${event.seq} returned twice across polls`);
      assert.ok(event.seq > maxSeen, `event seq ${event.seq} must be strictly increasing across polls`);
      seen.set(event.seq, event);
      maxSeen = event.seq;
    }
    return poll.events.length ? poll.nextAfter : undefined;
  };
  let after = 0;
  let final;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    final = await cli(ctx.env, 'wait', '--job', spawned.jobId, '--after', String(after), '--timeout-ms', '300');
    const nextAfter = await collect(final);
    if (nextAfter !== undefined) after = nextAfter;
    if (['idle', 'cancelled', 'failed', 'timed_out'].includes(final.status)) break;
  }
  assert.equal(final.status, 'idle', 'job never reached idle');

  // Let the worker flush the trailing prompt_finished/evidence event writes,
  // then drain once more so the snapshot is stable before result.
  await new Promise(resolve => setTimeout(resolve, 400));
  const tail = await cli(ctx.env, 'wait', '--job', spawned.jobId, '--after', String(after), '--timeout-ms', '500');
  const tailAfter = await collect(tail);
  if (tailAfter !== undefined) after = tailAfter;
  assert.equal(tail.latestSeq, tail.nextAfter, 'the event log must be drained at idle');
  assert.equal(tail.latestSeq, after, 'latestSeq must equal the last delivered nextAfter once drained');

  const result = await cli(ctx.env, 'result', '--job', spawned.jobId);
  assert.equal(result.trace.complete, true, `trace incomplete: ${JSON.stringify(result.trace)}`);
  assert.equal(result.trace.eventCount, seen.size);
  assert.deepEqual(result.trace.duplicateSeqs, []);
  assert.deepEqual(result.trace.missingSeqs, []);
  assert.equal(result.trace.outOfOrder, false);
  assert.deepEqual(result.trace.counts, {
    plan: 1,
    agent_thought_chunk: 2,
    tool_call: 1,
    tool_call_update: 1,
    agent_message_chunk: 2,
    usage_update: 1,
  });
  assert.equal(result.trace.observableEventCount, 8);
  assert.equal(result.correctionCount, 0);
  assert.equal(result.correctionLimitReached, false);
  assert.equal(result.maxCorrections, 2);
  assert.equal(result.evidenceStatus, 'not_required');
  assert.equal(result.result, 'answer-1');

  const messages = result.events
    .filter(event => event.type === 'acp_update' && event.data.sessionUpdate === 'agent_message_chunk' && event.data.content?.type === 'text')
    .map(event => event.data.content.text);
  assert.equal(messages.join(''), 'answer-1');
  const thoughts = result.events
    .filter(event => event.type === 'acp_update' && event.data.sessionUpdate === 'agent_thought_chunk')
    .map(event => event.data.content.text);
  assert.deepEqual(thoughts, ['reasoning-1-1', 'reasoning-1-2']);

  await cli(ctx.env, 'cleanup', '--job', spawned.jobId);
});

test('evidence-required ACP job validates ready evidence and scopes permission to the exact file', async t => {
  const ctx = await setup(t, fakeAcp);
  const task = await packet(ctx.base, '[EVIDENCE] [PERMISSION] prove the change', { evidence: true });
  const spawned = await cli(ctx.env, 'spawn', '--repo', ctx.repo, '--mode', 'acp', '--task', task);
  assert.equal(spawned.evidenceRequired, true);
  assert.ok(spawned.evidencePath.endsWith(path.join('artifacts', 'evidence.json')));
  await waitFor(ctx.env, spawned.jobId, ['idle']);
  const result = await cli(ctx.env, 'result', '--job', spawned.jobId);
  assert.equal(result.evidenceStatus, 'ready');
  assert.equal(result.evidence.schemaVersion, 1);
  assert.equal(result.evidence.items.length, 3);
  assert.deepEqual(result.evidence.items.map(item => item.kind).sort(), ['citation', 'fact', 'image']);
  assert.equal(result.trace.complete, true);

  const onDisk = JSON.parse(await readFile(result.evidencePath, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.items.length, 3);

  const permissions = result.events.filter(event => event.type === 'permission');
  const pathOf = event => event.data.toolCall?.rawInput?.file_path ?? event.data.toolCall?.locations?.[0]?.path;
  assert.ok(permissions.some(event => event.data.allowed === true && path.resolve(pathOf(event)) === path.resolve(result.evidencePath)),
    'permission must be granted for the exact evidence file');
  assert.ok(permissions.some(event => event.data.allowed === false && path.resolve(pathOf(event)) === path.resolve(path.dirname(result.evidencePath))),
    'permission must be refused for the artifacts directory');
  assert.ok(permissions.some(event => event.data.allowed === false && path.basename(pathOf(event) ?? '') === 'outside.txt'),
    'permission must be refused for writes outside the worktree');

  assert.equal(result.dirty, false, 'evidence must never dirty the delegated worktree');
  await cli(ctx.env, 'cleanup', '--job', spawned.jobId);
});

test('evidence-required ACP job reports invalid and missing evidence', async t => {
  const ctx = await setup(t, fakeAcp);
  const invalidTask = await packet(ctx.base, '[INVALID-EVIDENCE] write broken evidence', { evidence: true });
  const invalid = await cli(ctx.env, 'spawn', '--repo', ctx.repo, '--mode', 'acp', '--task', invalidTask);
  await waitFor(ctx.env, invalid.jobId, ['idle']);
  const invalidResult = await cli(ctx.env, 'result', '--job', invalid.jobId);
  assert.equal(invalidResult.evidenceStatus, 'invalid');
  assert.ok(invalidResult.evidence.errors.length > 0);
  await cli(ctx.env, 'cleanup', '--job', invalid.jobId);

  const missingTask = await packet(ctx.base, '[MISSING-EVIDENCE] never write evidence', { evidence: true });
  const missing = await cli(ctx.env, 'spawn', '--repo', ctx.repo, '--mode', 'acp', '--task', missingTask);
  await waitFor(ctx.env, missing.jobId, ['idle']);
  const missingResult = await cli(ctx.env, 'result', '--job', missing.jobId);
  assert.equal(missingResult.evidenceStatus, 'missing');
  assert.equal(missingResult.evidence.items.length, 0);
  await cli(ctx.env, 'cleanup', '--job', missing.jobId);
});

test('evidence-required headless spawn is rejected', async t => {
  const ctx = await setup(t);
  const task = await packet(ctx.base, 'cannot run headless with evidence', { evidence: true });
  await assert.rejects(
    cli(ctx.env, 'spawn', '--repo', ctx.repo, '--mode', 'headless', '--task', task),
    /Evidence-required tasks must run in ACP mode/,
  );
});

test('correction threshold is reported while further followups stay allowed', async t => {
  const ctx = await setup(t, fakeAcp);
  const first = await packet(ctx.base, 'plain acp task');
  const spawned = await cli(ctx.env, 'spawn', '--repo', ctx.repo, '--mode', 'acp', '--task', first);
  await waitFor(ctx.env, spawned.jobId, ['idle']);
  let result = await cli(ctx.env, 'result', '--job', spawned.jobId);
  assert.equal(result.correctionCount, 0);
  assert.equal(result.correctionLimitReached, false);
  assert.equal(result.maxCorrections, 2);

  for (let correction = 1; correction <= 2; correction += 1) {
    const followup = await cli(ctx.env, 'followup', '--job', spawned.jobId, '--task', await packet(ctx.base, `correction ${correction}`));
    assert.equal(followup.ok, true);
    await waitFor(ctx.env, spawned.jobId, ['idle']);
    result = await cli(ctx.env, 'result', '--job', spawned.jobId);
    assert.equal(result.correctionCount, correction);
    assert.equal(result.correctionLimitReached, correction >= 2);
  }

  const third = await cli(ctx.env, 'followup', '--job', spawned.jobId, '--task', await packet(ctx.base, 'user-authorized third round'));
  assert.equal(third.ok, true, 'the controller must not reject a followup past the automatic-supervision threshold');
  await waitFor(ctx.env, spawned.jobId, ['idle']);
  result = await cli(ctx.env, 'result', '--job', spawned.jobId);
  assert.equal(result.correctionCount, 3);
  assert.equal(result.correctionLimitReached, true);
  assert.equal(result.trace.complete, true);
  await cli(ctx.env, 'cleanup', '--job', spawned.jobId);
});
