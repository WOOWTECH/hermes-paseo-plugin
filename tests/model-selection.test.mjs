import test from 'node:test';
import assert from 'node:assert/strict';
import { sendVerifiedHermesMessage } from '../src/model-selection.mjs';

const requested = 'llamacpp:local-model';

test('a failed ACP model switch never sends the first prompt to the default model', async () => {
  const sent = [];
  const client = { sendAgentMessage: async (...args) => sent.push(args) };
  const agent = { id: 'agent-123', runtimeInfo: { model: 'provider:default-model' } };
  await assert.rejects(sendVerifiedHermesMessage(client, agent, requested, 'first message'),
    error => error.code === 'MODEL_SELECTION_UNAVAILABLE');
  assert.deepEqual(sent, []);
});

test('missing applied-model evidence also prevents an unintended first turn', async () => {
  const client = { sendAgentMessage: async () => assert.fail('must not send') };
  await assert.rejects(sendVerifiedHermesMessage(client, { id: 'agent-123' }, requested, 'first message'),
    error => error.code === 'MODEL_SELECTION_UNAVAILABLE');
});

test('matching live ACP model sends a message, but blocks follow-up after fallback', async () => {
  const sent = [];
  const client = { sendAgentMessage: async (...args) => sent.push(args) };
  const agent = { id: 'agent-123', model: requested, runtimeInfo: { model: requested } };
  await sendVerifiedHermesMessage(client, agent, requested, 'first message');
  agent.runtimeInfo.model = 'provider:default-model';
  await assert.rejects(sendVerifiedHermesMessage(client, agent, requested, 'followup'),
    error => error.code === 'MODEL_SELECTION_UNAVAILABLE');
  assert.deepEqual(sent, [['agent-123', 'first message']]);
});
