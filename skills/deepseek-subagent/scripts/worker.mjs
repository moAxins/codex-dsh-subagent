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
  appendJsonLine, discoverHarness, jobDir, loadState,
  readJson, stateFile, writeJsonAtomic,
} from './lib/common.mjs';
import { permissionAllowed } from './lib/policy.mjs';
import { NOT_REQUIRED, readEvidence, requirements } from './lib/evidence.mjs';
import { createRecoverableSerialQueue } from './lib/reliability.mjs';

const jobFlag = process.argv.indexOf('--job');
const jobId = jobFlag >= 0 ? process.argv[jobFlag + 1] : undefined;
if (!jobId) throw new Error('Worker requires --job.');
const dir = jobDir(jobId);
let state;
const enqueueWrite = createRecoverableSerialQueue();

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function mutate(changes) {
  return await enqueueWrite(async () => {
    state = { ...state, ...changes, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(stateFile(jobId), state);
  });
}

async function event(type, data = {}) {
  return await enqueueWrite(async () => {
    state.eventSeq += 1;
    const record = { seq: state.eventSeq, time: new Date().toISOString(), type, data };
    await appendJsonLine(path.join(dir, 'events.ndjson'), record);
    state.updatedAt = record.time;
    await writeJsonAtomic(stateFile(jobId), state);
  });
}

const EVIDENCE_SCHEMA_PROMPT = [
  'Use evidence schema version 1: a JSON object with "version": 1 and an "items" array.',
  'Each item requires: id (non-empty string); kind "fact", "citation", or "image"; selected (boolean);',
  'useLocations (array of strings); claim (non-empty string); sourceUrl (absolute http(s) URL);',
  'publisher (non-empty string); publishedAt (non-empty string or null);',
  'verificationNotes (non-empty string); uncertainties (array of strings).',
  'Image items also require imageUrl (absolute http(s) URL) and caption (non-empty string or null).',
  'A selected item requires at least one useLocation.',
].join('\n');

function taskPrompt(packet, followup = false) {
  const lines = [
    followup ? 'Continue the current delegated task using this correction packet.' : 'Complete this delegated task in the current Git worktree.',
    'Keep every file change inside the current worktree. Leave useful changes uncommitted for Codex to review.',
    'Return a concise account of changes, checks, and unresolved issues.',
    JSON.stringify(packet, null, 2),
  ];
  if (state.evidenceRequired) {
    lines.push(
      '',
      'Evidence requirements',
      `This task requires verifiable evidence. Write the evidence file to exactly: "${state.evidencePath}".`,
      'Do not write anything else outside the worktree.',
      EVIDENCE_SCHEMA_PROMPT,
    );
  }
  return lines.join('\n\n');
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

async function currentEvidenceStatus() {
  if (!state.evidenceRequired) return NOT_REQUIRED;
  return (await readEvidence(state.evidencePath, state.evidenceKinds)).status;
}

async function settleEvidence() {
  if (state.mode !== 'acp') return;
  const status = await currentEvidenceStatus();
  await mutate({ evidenceStatus: status });
  await event('evidence', { status, path: state.evidencePath });
}

async function runHeadless(launcher, packet) {
  await mutate({ status: 'running', harnessSource: launcher.source });
  await event('started', { mode: 'headless', harnessSource: launcher.source });
  const child = startHarness(launcher, ['--profile', 'headless', taskPrompt(packet)], state.worktreePath);
  await mutate({ harnessPid: child.pid });
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
  await mutate({ harnessPid: null });
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
  await mutate({ harnessPid: child.pid });
  const stderrLog = createWriteStream(path.join(dir, 'harness.stderr.log'), { flags: 'a' });
  child.stderr.pipe(stderrLog);
  let output = '';
  const toolCalls = new Map();
  const clientApp = createAcpClientApp({ name: 'codex-dsh-subagent' })
    .onNotification(methods.client.session.update, async ({ params }) => {
      const update = params.update;
      if (update.toolCallId) {
        toolCalls.set(update.toolCallId, { ...(toolCalls.get(update.toolCallId) ?? {}), ...update });
      }
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') output += update.content.text;
      await event('acp_update', update);
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      const toolCall = { ...(toolCalls.get(params.toolCall.toolCallId) ?? {}), ...params.toolCall };
      const allowed = permissionAllowed(toolCall, {
        worktreePath: state.worktreePath,
        evidencePath: state.evidenceRequired ? state.evidencePath : undefined,
      });
      const option = allowed && params.options.find(value => value.kind === 'allow_once' || value.kind === 'allow_always');
      await event('permission', { toolCall, allowed: Boolean(option) });
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
  const preparePrompt = async (packet, correction = false) => {
    output = '';
    await mutate({ status: 'running', result: null, error: null });
    await event('prompt_started', { packet, correction });
    return {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: taskPrompt(packet, correction) }],
    };
  };
  active = agent.request(methods.agent.session.prompt, await preparePrompt(firstPacket));

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
          await mutate({ corrections: (state.corrections ?? 0) + 1 });
          const prompt = await preparePrompt(command.data.packet, true);
          active = agent.request(methods.agent.session.prompt, prompt);
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
          await settleEvidence();
        } else {
          const stopReason = settled.value.stopReason;
          const status = stopReason === 'cancelled' ? 'cancelled' : 'idle';
          await mutate({ status, result: output, error: null, stopReason });
          await event('prompt_finished', { stopReason, result: output });
          await settleEvidence();
        }
      } else if (Date.now() >= deadline) {
        await agent.notify(methods.agent.session.cancel, { sessionId: created.sessionId });
        await mutate({ status: 'timed_out', result: output || null, error: 'ACP prompt timed out.' });
        await event('timed_out');
        await settleEvidence();
        active = undefined;
      }
    } else await delay(100);
  }

  try { await agent.request(methods.agent.session.close, { sessionId: created.sessionId }); } catch { /* Best effort. */ }
  child.kill(); stderrLog.end();
  await mutate({ status: 'stopped', harnessPid: null });
  await event('stopped');
}

async function main() {
  await delay(100);
  state = await loadState(jobId);
  const packet = await readJson(path.join(dir, 'task.json'));
  const evidence = requirements(packet);
  await mutate({
    workerPid: process.pid,
    evidenceRequired: evidence.required,
    evidenceKinds: evidence.kinds,
    evidenceStatus: evidence.required ? 'missing' : NOT_REQUIRED,
  });
  const launcher = await discoverHarness();
  if (state.mode === 'headless') {
    if (evidence.required) throw new Error('Evidence-required tasks must run in ACP mode, not headless.');
    await runHeadless(launcher, packet);
  } else await runAcp(launcher, packet);
}

main().catch(async error => {
  console.error(error.stack ?? error.message);
  try {
    if (!state) state = await loadState(jobId);
    await mutate({ status: 'failed', error: error.stack ?? error.message });
    await event('failed', { error: error.message });
  } catch { /* Nothing else can be persisted. */ }
  process.exitCode = 1;
});
