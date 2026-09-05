#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  acquireLock, ensureRoots, git, isTerminal, jobDir, jobsRoot, listJobIds, loadState,
  parseArgs, processAlive, readJson, stateFile, worktreesRoot, writeJsonAtomic,
} from './lib/common.mjs';

const workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
const activeStates = new Set(['starting', 'running', 'idle', 'cancelling', 'cancelled']);

function required(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing --${name}.`);
  return value;
}

async function taskPacket(file) {
  const packet = await readJson(path.resolve(file));
  const strings = ['goal'];
  const arrays = ['plan', 'constraints', 'acceptanceCriteria', 'relevantPaths', 'requiredChecks'];
  for (const field of strings) if (typeof packet[field] !== 'string' || !packet[field].trim()) throw new Error(`Task field ${field} must be a non-empty string.`);
  for (const field of arrays) if (!Array.isArray(packet[field]) || !packet[field].every(value => typeof value === 'string')) throw new Error(`Task field ${field} must be a string array.`);
  return packet;
}

async function activeJobCount() {
  let count = 0;
  for (const id of await listJobIds()) {
    try {
      const state = await loadState(id);
      if (activeStates.has(state.status) && processAlive(state.workerPid)) count += 1;
    } catch { /* Ignore incomplete job directories. */ }
  }
  return count;
}

async function spawnJob(options) {
  const repoInput = path.resolve(required(options, 'repo'));
  const mode = options.mode ?? 'acp';
  if (!['acp', 'headless'].includes(mode)) throw new Error('--mode must be acp or headless.');
  const packet = await taskPacket(required(options, 'task'));
  const timeoutMs = Number(options['timeout-ms'] ?? 3_600_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('--timeout-ms must be an integer of at least 1000.');

  const top = (await git(['rev-parse', '--show-toplevel'], repoInput)).stdout.trim();
  const repo = path.resolve(top);
  const jobId = randomUUID();
  const dir = jobDir(jobId);
  const worktreePath = path.join(worktreesRoot, jobId);

  return await acquireLock('capacity', async () => {
    if (await activeJobCount() >= 3) throw new Error('The three-job concurrency limit is already in use.');
    await mkdir(path.join(dir, 'commands'), { recursive: true });
    await mkdir(path.join(dir, 'acks'), { recursive: true });
    await writeJsonAtomic(path.join(dir, 'task.json'), packet);
    await git(['worktree', 'add', '--detach', worktreePath, 'HEAD'], repo);
    const initial = {
      version: 1, jobId, mode, status: 'starting', repo, worktreePath, timeoutMs,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      workerPid: null, sessionId: null, eventSeq: 0, result: null, error: null,
    };
    await writeJsonAtomic(stateFile(jobId), initial);

    const stdoutFd = openSync(path.join(dir, 'worker.stdout.log'), 'a');
    const stderrFd = openSync(path.join(dir, 'worker.stderr.log'), 'a');
    let child;
    try {
      child = spawn(process.execPath, [workerFile, '--job', jobId], {
        detached: true, windowsHide: true, stdio: ['ignore', stdoutFd, stderrFd], env: process.env,
      });
      child.unref();
    } finally { closeSync(stdoutFd); closeSync(stderrFd); }
    initial.workerPid = child.pid;
    initial.updatedAt = new Date().toISOString();
    await writeJsonAtomic(stateFile(jobId), initial);
    return { jobId, mode, status: initial.status, worktreePath, repo };
  });
}

async function readEvents(jobId, after = 0) {
  try {
    const content = await readFile(path.join(jobDir(jobId), 'events.ndjson'), 'utf8');
    return content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(event => event.seq > after);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function waitJob(options) {
  const jobId = required(options, 'job');
  const after = Number(options.after ?? 0);
  const timeoutMs = Math.min(Number(options['timeout-ms'] ?? 30_000), 60_000);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    const state = await loadState(jobId);
    const events = await readEvents(jobId, after);
    if (events.length || isTerminal(state.status) || state.status === 'idle' || state.status === 'cancelled') {
      return { jobId, status: state.status, sessionId: state.sessionId, events, nextAfter: events.at(-1)?.seq ?? after };
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  const state = await loadState(jobId);
  return { jobId, status: state.status, sessionId: state.sessionId, events: [], nextAfter: after, timedOut: true };
}

async function sendCommand(jobId, type, data = {}, waitMs = 10_000) {
  const state = await loadState(jobId);
  if (!processAlive(state.workerPid)) throw new Error(`Job worker is not running; current status is ${state.status}.`);
  const commandId = randomUUID();
  await writeJsonAtomic(path.join(jobDir(jobId), 'commands', `${Date.now()}-${commandId}.json`), { commandId, type, data });
  const ackFile = path.join(jobDir(jobId), 'acks', `${commandId}.json`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try { return await readJson(ackFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${type} acknowledgement.`);
}

async function resultJob(jobId) {
  const state = await loadState(jobId);
  const status = await git(['status', '--porcelain=v1'], state.worktreePath, true);
  const diff = await git(['diff', '--stat', '--'], state.worktreePath, true);
  return { ...state, dirty: Boolean(status.stdout.trim()), gitStatus: status.stdout, diffStat: diff.stdout, events: await readEvents(jobId, 0) };
}

async function cleanupJob(jobId) {
  let state = await loadState(jobId);
  const status = await git(['status', '--porcelain=v1'], state.worktreePath, true);
  if (status.stdout.trim()) throw new Error(`Worktree is dirty and was preserved at ${state.worktreePath}.`);
  if (processAlive(state.workerPid)) {
    await sendCommand(jobId, 'shutdown', {}, 10_000);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && processAlive(state.workerPid)) await new Promise(resolve => setTimeout(resolve, 100));
    if (processAlive(state.workerPid)) throw new Error('Worker did not stop; the worktree was preserved.');
  }
  await git(['worktree', 'remove', state.worktreePath], state.repo);
  state = await loadState(jobId);
  state.status = 'cleaned'; state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(stateFile(jobId), state);
  return { jobId, status: 'cleaned', worktreePath: state.worktreePath };
}

async function main() {
  await ensureRoots();
  const { operation, options } = parseArgs(process.argv.slice(2));
  let output;
  if (operation === 'spawn') output = await spawnJob(options);
  else if (operation === 'wait') output = await waitJob(options);
  else if (operation === 'followup') {
    const packet = await taskPacket(required(options, 'task'));
    output = await sendCommand(required(options, 'job'), 'followup', { packet });
  } else if (operation === 'interrupt') output = await sendCommand(required(options, 'job'), 'interrupt');
  else if (operation === 'result') output = await resultJob(required(options, 'job'));
  else if (operation === 'cleanup') output = await cleanupJob(required(options, 'job'));
  else throw new Error('Operation must be spawn, wait, followup, interrupt, result, or cleanup.');
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
});
