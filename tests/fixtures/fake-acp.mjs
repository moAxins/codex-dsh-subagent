import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  agent as createAcpAgentApp, methods, ndJsonStream, PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';

let promptCount = 0;
let cancelSignal;
let resolveCancelSignal;
let cancelPending = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function armCancel() {
  if (cancelPending) {
    cancelPending = false;
    return Promise.resolve({ stopReason: 'cancelled' });
  }
  cancelSignal = new Promise(resolve => { resolveCancelSignal = resolve; });
  return cancelSignal;
}

function fireCancel() {
  if (resolveCancelSignal) {
    resolveCancelSignal({ stopReason: 'cancelled' });
    resolveCancelSignal = undefined;
  } else cancelPending = true;
}

async function update(client, sessionId, update) {
  await client.notify(methods.client.session.update, { sessionId, update });
  await delay(30);
}

async function requestPermission(client, sessionId, toolCall) {
  await update(client, sessionId, {
    sessionUpdate: 'tool_call',
    ...toolCall,
    status: 'in_progress',
  });
  const response = await client.request(methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId: toolCall.toolCallId },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
    ],
  });
  return response?.outcome?.outcome === 'selected';
}

const outsideToolCall = {
  toolCallId: 'outside', title: 'outside edit', kind: 'edit',
  rawInput: { file_path: path.join('..', 'outside.txt') },
};

// Deterministic observable sequence for one prompt: plan, two thought chunks,
// tool call, tool call update, two message chunks, and a usage update.
async function emitObservableSequence(client, sessionId) {
  const n = promptCount;
  const toolCallId = `trace-${n}`;
  await update(client, sessionId, {
    sessionUpdate: 'plan',
    entries: [
      { content: `plan step a-${n}`, priority: 'high', status: 'in_progress' },
      { content: `plan step b-${n}`, priority: 'medium', status: 'pending' },
    ],
  });
  await update(client, sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: `reasoning-${n}-1` },
    messageId: `thought-${n}`,
  });
  await update(client, sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: `reasoning-${n}-2` },
    messageId: `thought-${n}`,
  });
  await update(client, sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: `trace search ${n}`,
    kind: 'search',
    status: 'in_progress',
  });
  await update(client, sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
  });
  await update(client, sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'answer-' },
    messageId: `message-${n}`,
  });
  await update(client, sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: String(n) },
    messageId: `message-${n}`,
  });
  await update(client, sessionId, {
    sessionUpdate: 'usage_update',
    used: 100 * n,
    size: 4096,
  });
}

function validEvidence() {
  return {
    version: 1,
    items: [
      {
        id: 'fact-1', kind: 'fact', selected: true, useLocations: ['src/example.ts'],
        claim: 'the change produces the documented behavior', sourceUrl: 'https://example.com/spec',
        publisher: 'Example Docs', publishedAt: '2026-01-01',
        verificationNotes: 'confirmed against the delegated diff', uncertainties: [],
      },
      {
        id: 'citation-1', kind: 'citation', selected: false, useLocations: [],
        claim: 'the protocol documents this field', sourceUrl: 'https://example.com/protocol',
        publisher: 'Protocol Guide', publishedAt: null,
        verificationNotes: 'quoted from the upstream schema', uncertainties: ['wording drift'],
      },
      {
        id: 'image-1', kind: 'image', selected: false, useLocations: [],
        claim: 'the diagram matches the shipped layout', sourceUrl: 'https://example.com/docs',
        publisher: 'Example Docs', publishedAt: null,
        verificationNotes: 'compared visually with the diff', uncertainties: [],
        imageUrl: 'https://example.com/diagram.png', caption: null,
      },
    ],
  };
}

function invalidEvidence() {
  return {
    version: 1,
    items: [
      {
        id: '', kind: 'fact', selected: true, useLocations: [],
        claim: '', sourceUrl: 'not an absolute url', publisher: '',
        publishedAt: '', verificationNotes: '', uncertainties: 'not an array',
      },
    ],
  };
}

function evidencePathOf(text) {
  const match = text.match(/Write the evidence file to exactly: "([^"]+)"/);
  return match ? match[1] : undefined;
}

// Request permission for the exact evidence file, then write when allowed.
// Also requests permission for the artifacts directory, which must be refused.
async function writeEvidence(client, sessionId, filePath, content) {
  const dirPath = path.dirname(filePath);
  const fileRequest = await requestPermission(client, sessionId, {
    toolCallId: randomUUID(), title: 'write evidence file', kind: 'edit', rawInput: { file_path: filePath },
  });
  if (fileRequest) {
    await mkdir(dirPath, { recursive: true });
    await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  }
  await requestPermission(client, sessionId, {
    toolCallId: randomUUID(), title: 'write artifacts directory', kind: 'edit', rawInput: { file_path: dirPath },
  });
}

const app = createAcpAgentApp({ name: 'fake-dsh' })
  .onRequest(methods.agent.initialize, () => Promise.resolve({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
    authMethods: [],
  }))
  .onRequest(methods.agent.authenticate, () => Promise.resolve())
  .onRequest(methods.agent.session.new, () => Promise.resolve({ sessionId: randomUUID() }))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    promptCount += 1;
    const text = params.prompt.map(block => block.type === 'text' ? block.text : '').join('');
    const hang = text.includes('[HANG]');
    const currentCancelSignal = hang ? armCancel() : undefined;
    if (text.includes('[PERMISSION]')) await requestPermission(client, params.sessionId, outsideToolCall);
    await emitObservableSequence(client, params.sessionId);
    const evidencePath = evidencePathOf(text);
    if (text.includes('[EVIDENCE]') && evidencePath) await writeEvidence(client, params.sessionId, evidencePath, validEvidence());
    else if (text.includes('[INVALID-EVIDENCE]') && evidencePath) await writeEvidence(client, params.sessionId, evidencePath, invalidEvidence());
    else if (text.includes('[MISSING-EVIDENCE]') && evidencePath) {
      await requestPermission(client, params.sessionId, {
        toolCallId: randomUUID(), title: 'skip evidence', kind: 'edit', rawInput: { file_path: evidencePath },
      });
      // Intentionally never writes the file.
    }
    if (hang) {
      const result = await currentCancelSignal;
      cancelSignal = undefined;
      return result;
    }
    return { stopReason: 'end_turn' };
  })
  .onNotification(methods.agent.session.cancel, () => {
    fireCancel();
    return Promise.resolve();
  })
  .onRequest(methods.agent.session.close, () => Promise.resolve());

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
