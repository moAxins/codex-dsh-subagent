#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, readdir, rename } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import process from 'node:process';
import {
  client as createAcpClientApp, methods, ndJsonStream, PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import {
  appendJsonLine, discoverHarness, isInside, jobDir, loadState,
  readJson, stateFile, writeJsonAtomic,
} from './lib/common.mjs';

const jobFlag = process.argv.indexOf('--job');
const jobId = jobFlag >= 0 ? process.argv[jobFlag + 1] : undefined;
if (!jobId) throw new Error('Worker requires --job.');
const dir = jobDir(jobId);
let state;
let writeQueue = Promise.resolve();

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function mutate(changes) {
  writeQueue = writeQueue.then(async () => {
    state = { ...state, ...changes, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(stateFile(jobId), state);
  });
  return await writeQueue;
}

async function event(type, data = {}) {
  writeQueue = writeQueue.then(async () => {
    state.eventSeq += 1;
    const record = { seq: state.eventSeq, time: new Date().toISOString(), type, data };
    await appendJsonLine(path.join(dir, 'events.ndjson'), record);
    state.updatedAt = record.time;
    await writeJsonAtomic(stateFile(jobId), state);
  });
  return await writeQueue;
}

function taskPrompt(packet, followup = false) {
  return [
    followup ? 'Continue the current delegated task using this correction packet.' : 'Complete this delegated task in the current Git worktree.',
    'Keep every file change inside the current worktree. Leave useful changes uncommitted for Codex to review.',
    'Return a concise account of changes, checks, and unresolved issues.',
    JSON.stringify(packet, null, 2),
  ].join('\n\n');
}

function commandLine(command, args) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) return { command, args };
  const quote = value => `"${String(value).replaceAll('"', '""')}"`;
  return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', [quote(command), ...args.map(quote)].join(' ')] };
}

function startHarness(launcher, args, cwd) {
  const actual = commandLine(launcher.command, [...launcher.args, ...args]);
  const env = { ...process.env, ...(launcher.env ?? {}) };
  return spawn(actual.command, actual.args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

function allPaths(value, key = '') {
  const found = [];
  if (typeof value === 'string' && /(^|_)(path|cwd|location)$/i.test(key)) found.push(value);
  else if (Array.isArray(value)) for (const item of value) found.push(...allPaths(item, key));
  else if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) found.push(...allPaths(child, childKey));
  return found;
}

function permissionAllowed(toolCall, worktreePath) {
  const kind = toolCall?.kind ?? 'other';
  if (['read', 'search', 'fetch'].includes(kind)) return true;
  const paths = allPaths(toolCall);
  if (paths.length === 0) return false;
  return paths.every(value => isInside(worktreePath, path.isAbsolute(value) ? value : path.join(worktreePath, value)));
}

async function nextCommands() {
  const commandDir = path.join(dir, 'commands');
  return (await readdir(commandDir)).filter(name => name.endsWith('.json')).sort();
}

async function takeCommand(name) {
  const source = path.join(dir, 'commands', name);
  const target = path.join(dir, `${name}.processing`);
  try { await rename(source, target); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const command = await readJson(target);
  command.processingFile = target;
  return command;
}

async function acknowledge(command, ok, extra = {}) {
  await writeJsonAtomic(path.join(dir, 'acks', `${command.commandId}.json`), { jobId, commandId: command.commandId, ok, ...extra });
  await rename(command.processingFile, `${command.processingFile}.done`);
}

async function runHeadless(launcher, packet) {
  await mutate({ status: 'running', harnessSource: launcher.source });
  await event('started', { mode: 'headless', harnessSource: launcher.source });
  const child = startHarness(launcher, ['--profile', 'headless', taskPrompt(packet)], state.worktreePath);
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill(), state.timeoutMs);
  const outcome = await new Promise(resolve => {
    child.on('error', error => resolve({ error }));
    child.on('close', code => resolve({ code }));
  });
  clearTimeout(timeout);
  if (Date.now() - new Date(state.createdAt).getTime() >= state.timeoutMs) {
    await mutate({ status: 'timed_out', result: stdout.trim() || null, error: 'Headless task timed out.' });
    await event('timed_out');
  } else if (outcome.error || outcome.code !== 0) {
    await mutate({ status: 'failed', result: stdout.trim() || null, error: outcome.error?.message ?? stderr.trim() ?? `Harness exited ${outcome.code}.` });
    await event('failed', { code: outcome.code, stderr: stderr.trim() });
  } else {
    await mutate({ status: 'completed', result: stdout.trim(), error: null });
    await event('completed', { result: stdout.trim() });
  }
}

async function runAcp(launcher, firstPacket) {
  const child = startHarness(launcher, ['--profile', 'acp'], state.worktreePath);
  const stderrLog = createWriteStream(path.join(dir, 'harness.stderr.log'), { flags: 'a' });
  child.stderr.pipe(stderrLog);
  let output = '';
  const clientApp = createAcpClientApp({ name: 'codex-dsh-subagent' })
    .onNotification(methods.client.session.update, async ({ params }) => {
      const update = params.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') output += update.content.text;
      await event('acp_update', update);
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      const allowed = permissionAllowed(params.toolCall, state.worktreePath);
      const option = allowed && params.options.find(value => value.kind === 'allow_once' || value.kind === 'allow_always');
      await event('permission', { toolCall: params.toolCall, allowed: Boolean(option) });
      return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
    });
  const connection = clientApp.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const agent = connection.agent;
  await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const created = await agent.request(methods.agent.session.new, { cwd: state.worktreePath, mcpServers: [] });
  await mutate({ status: 'running', sessionId: created.sessionId, harnessSource: launcher.source });
  await event('started', { mode: 'acp', sessionId: created.sessionId, harnessSource: launcher.source });

  let active;
  let shuttingDown = false;
  let deadline = Date.now() + state.timeoutMs;
  const startPrompt = packet => {
    output = '';
    mutate({ status: 'running', result: null, error: null });
    event('prompt_started', { packet });
    return agent.request(methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: taskPrompt(packet, packet !== firstPacket) }],
    });
  };
  active = startPrompt(firstPacket);

  while (!shuttingDown) {
    for (const name of await nextCommands()) {
      const command = await takeCommand(name);
      if (!command) continue;
      if (command.type === 'interrupt') {
        if (active) {
          await mutate({ status: 'cancelling' });
          await agent.notify(methods.agent.session.cancel, { sessionId: created.sessionId });
          await event('interrupt_requested');
          await acknowledge(command, true, { status: 'cancelling' });
        } else await acknowledge(command, false, { error: 'No prompt is active.' });
      } else if (command.type === 'followup') {
        if (active) await acknowledge(command, false, { error: 'Wait for the active prompt to settle before followup.' });
        else {
          active = startPrompt(command.data.packet);
          deadline = Date.now() + state.timeoutMs;
          await acknowledge(command, true, { status: 'running', sessionId: created.sessionId });
        }
      } else if (command.type === 'shutdown') {
        if (active) await agent.notify(methods.agent.session.cancel, { sessionId: created.sessionId });
        shuttingDown = true;
        await acknowledge(command, true, { status: 'stopping' });
      } else await acknowledge(command, false, { error: `Unknown command: ${command.type}` });
    }

    if (active) {
      const settled = await Promise.race([
        active.then(value => ({ value }), error => ({ error })),
        delay(100).then(() => undefined),
      ]);
      if (settled) {
        active = undefined;
        if (settled.error) {
          await mutate({ status: 'failed', result: output || null, error: settled.error.message });
          await event('prompt_failed', { error: settled.error.message });
        } else {
          const stopReason = settled.value.stopReason;
          const status = stopReason === 'cancelled' ? 'cancelled' : 'idle';
          await mutate({ status, result: output, error: null, stopReason });
          await event('prompt_finished', { stopReason, result: output });
        }
      } else if (Date.now() >= deadline) {
        await agent.notify(methods.agent.session.cancel, { sessionId: created.sessionId });
        await mutate({ status: 'timed_out', result: output || null, error: 'ACP prompt timed out.' });
        await event('timed_out');
        active = undefined;
      }
    } else await delay(100);
  }

  try { await agent.request(methods.agent.session.close, { sessionId: created.sessionId }); } catch { /* Best effort. */ }
  child.kill(); stderrLog.end();
  await mutate({ status: 'stopped' });
  await event('stopped');
}

async function main() {
  await delay(100);
  state = await loadState(jobId);
  await mutate({ workerPid: process.pid });
  const packet = await readJson(path.join(dir, 'task.json'));
  const launcher = await discoverHarness();
  if (state.mode === 'headless') await runHeadless(launcher, packet);
  else await runAcp(launcher, packet);
}

main().catch(async error => {
  try {
    if (!state) state = await loadState(jobId);
    await mutate({ status: 'failed', error: error.stack ?? error.message });
    await event('failed', { error: error.message });
  } catch { /* Nothing else can be persisted. */ }
  process.exitCode = 1;
});
