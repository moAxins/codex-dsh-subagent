#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  acquireLock, ensureRoots, git, isTerminal, jobDir, jobsRoot, listJobIds, loadState,
  parseArgs, processAlive, readJson, stateFile, worktreesRoot, writeJsonAtomic,
} from './lib/common.mjs';
import {
  assertMode, CLEANUP_GRACE_TIMEOUT_MS, COMMAND_ACK_TIMEOUT_MS, DEFAULT_MODE,
  FORCE_STOP_TIMEOUT_MS, MAX_CONCURRENT_JOBS, validateTask,
} from './lib/policy.mjs';
import { NOT_REQUIRED, readEvidence, requirements } from './lib/evidence.mjs';
import { summarize } from './lib/trace.mjs';

const workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
const activeStates = new Set(['starting', 'running', 'idle', 'cancelling', 'cancelled']);
const ARTIFACTS_DIR = 'artifacts';
const EVIDENCE_FILE = 'evidence.json';

function required(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing --${name}.`);
  return value;
}

async function taskPacket(file) {
  const packet = await readJson(path.resolve(file));
  validateTask(packet);
  requirements(packet); // Validates optional evidenceRequirements when present.
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

function evidencePaths(dir) {
  const artifactsPath = path.join(dir, ARTIFACTS_DIR);
  return { artifactsPath, evidencePath: path.join(artifactsPath, EVIDENCE_FILE) };
}

async function spawnJob(options) {
  const repoInput = path.resolve(required(options, 'repo'));
  const mode = assertMode(options.mode ?? DEFAULT_MODE);
  const packet = await taskPacket(required(options, 'task'));
  const evidence = requirements(packet);
  if (mode === 'headless' && evidence.required) throw new Error('Evidence-required tasks must run in ACP mode, not headless.');
  const timeoutMs = Number(options['timeout-ms'] ?? 3_600_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('--timeout-ms must be an integer of at least 1000.');

  const top = (await git(['rev-parse', '--show-toplevel'], repoInput)).stdout.trim();
  const repo = path.resolve(top);
  const jobId = randomUUID();
  const dir = jobDir(jobId);
  const worktreePath = path.join(worktreesRoot, jobId);
  const { artifactsPath, evidencePath } = evidencePaths(dir);

  return await acquireLock('capacity', async () => {
    if (await activeJobCount() >= MAX_CONCURRENT_JOBS) throw new Error('The three-job concurrency limit is already in use.');
    await mkdir(path.join(dir, 'commands'), { recursive: true });
    await mkdir(path.join(dir, 'acks'), { recursive: true });
    await mkdir(artifactsPath, { recursive: true });
    await writeJsonAtomic(path.join(dir, 'task.json'), packet);
    await git(['worktree', 'add', '--detach', worktreePath, 'HEAD'], repo);
    const initial = {
      version: 2, jobId, mode, status: 'starting', repo, worktreePath, timeoutMs,
      artifactsPath, evidencePath, evidenceRequired: evidence.required, evidenceKinds: evidence.kinds,
      evidenceStatus: evidence.required ? 'missing' : NOT_REQUIRED, corrections: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      workerPid: null, harnessPid: null, sessionId: null, eventSeq: 0, result: null, error: null,
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
    return { jobId, mode, status: initial.status, worktreePath, repo, artifactsPath, evidencePath, evidenceRequired: evidence.required };
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
    const lastSeq = events.at(-1)?.seq ?? 0;
    const latestSeq = Math.max(state.eventSeq ?? 0, lastSeq);
    const nextAfter = lastSeq || after;
    if (events.length || isTerminal(state.status) || state.status === 'idle' || state.status === 'cancelled') {
      return { jobId, status: state.status, sessionId: state.sessionId, latestSeq, events, nextAfter };
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  const state = await loadState(jobId);
  const events = await readEvents(jobId, after);
  const lastSeq = events.at(-1)?.seq ?? 0;
  const latestSeq = Math.max(state.eventSeq ?? 0, lastSeq);
  return { jobId, status: state.status, sessionId: state.sessionId, latestSeq, events, nextAfter: lastSeq || after, timedOut: true };
}

async function sendCommand(jobId, type, data = {}, waitMs = COMMAND_ACK_TIMEOUT_MS) {
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
  const events = await readEvents(jobId, 0);
  const eventSeq = Math.max(state.eventSeq ?? 0, events.at(-1)?.seq ?? 0);
  const trace = summarize(events, eventSeq);
  const evidence = state.evidenceRequired
    ? await readEvidence(state.evidencePath, state.evidenceKinds)
    : { status: NOT_REQUIRED, schemaVersion: null, items: [], errors: [] };
  return {
    ...state,
    dirty: Boolean(status.stdout.trim()), gitStatus: status.stdout, diffStat: diff.stdout,
    events,
    trace,
    correctionCount: trace.corrections.count,
    correctionLimitReached: trace.corrections.limitReached,
    maxCorrections: trace.corrections.max,
    evidenceStatus: evidence.status,
    evidence,
  };
}

async function cleanupJob(jobId) {
  let state = await loadState(jobId);
  const status = await git(['status', '--porcelain=v1'], state.worktreePath, true);
  if (status.stdout.trim()) throw new Error(`Worktree is dirty and was preserved at ${state.worktreePath}.`);
  if (processAlive(state.workerPid)) {
    try {
      await sendCommand(jobId, 'shutdown', {}, CLEANUP_GRACE_TIMEOUT_MS);
    } catch (error) {
      if (!error.message.includes('Timed out waiting for shutdown acknowledgement') && processAlive(state.workerPid)) throw error;
    }
    let deadline = Date.now() + CLEANUP_GRACE_TIMEOUT_MS;
    while (Date.now() < deadline && processAlive(state.workerPid)) await new Promise(resolve => setTimeout(resolve, 100));
    if (processAlive(state.workerPid)) {
      for (const pid of [state.harnessPid, state.workerPid]) {
        if (!processAlive(pid)) continue;
        try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      deadline = Date.now() + FORCE_STOP_TIMEOUT_MS;
      while (Date.now() < deadline && processAlive(state.workerPid)) await new Promise(resolve => setTimeout(resolve, 100));
    }
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
