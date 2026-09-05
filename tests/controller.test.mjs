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

async function packet(base, goal) {
  const file = path.join(base, `${Math.random()}.json`);
  await writeFile(file, JSON.stringify({ goal, plan: [], constraints: [], acceptanceCriteria: [], relevantPaths: [], requiredChecks: [] }));
  return file;
}

async function cli(env, ...args) {
  const result = await exec(process.execPath, [controller, ...args], { env, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}

async function waitFor(env, jobId, wanted, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let result;
  while (Date.now() < deadline) {
    result = await cli(env, 'wait', '--job', jobId, '--timeout-ms', '500');
    if (wanted.includes(result.status)) return result;
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
  await waitFor(ctx.env, spawned.jobId, ['completed']);
  const result = await cli(ctx.env, 'result', '--job', spawned.jobId);
  assert.equal(result.dirty, false);
  assert.match(result.result, /^headless:/);
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
