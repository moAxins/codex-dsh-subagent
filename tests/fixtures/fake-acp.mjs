import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import {
  agent as createAcpAgentApp, methods, ndJsonStream, PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';

let resolveCancel;
let promptCount = 0;
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
    if (text.includes('[PERMISSION]')) {
      await client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'outside', title: 'outside edit', kind: 'edit', locations: [{ path: '../outside.txt' }] },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      });
    }
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer-${promptCount}` } },
    });
    if (text.includes('[HANG]')) return await new Promise(resolve => { resolveCancel = resolve; });
    return { stopReason: 'end_turn' };
  })
  .onNotification(methods.agent.session.cancel, () => {
    resolveCancel?.({ stopReason: 'cancelled' });
    resolveCancel = undefined;
    return Promise.resolve();
  })
  .onRequest(methods.agent.session.close, () => Promise.resolve());

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
