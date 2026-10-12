import test from 'node:test';
import assert from 'node:assert/strict';
import { chatResult, latestAssistantCursor } from '../src/chat-result.mjs';

function message(seq, text = 'remembered marker') {
  return { seqStart: seq, seqEnd: seq, turnId: `turn-${seq}`, timestamp: `time-${seq}`, item: { type: 'assistant_message', text } };
}
function client(entries, status = 'idle') {
  return { waitForFinish: async () => ({ status }), fetchAgentTimeline: async () => ({ entries }) };
}

test('a follow-up in a full 50-message timeline window returns the new reply', async () => {
  const before = Array.from({ length: 50 }, (_, n) => message(n + 1));
  const after = [...before.slice(1), message(51)];
  const result = await chatResult(client(after), 'agent', 'pi', 'model', 1000, latestAssistantCursor(before));
  assert.equal(result.status, 'completed');
  assert.equal(result.reply, 'remembered marker');
});

test('idle without a new assistant message cannot return the previous reply as success', async () => {
  const entries = [message(10, 'stale reply')];
  const result = await chatResult(client(entries), 'agent', 'codex', 'model', 1000, latestAssistantCursor(entries));
  assert.equal(result.status, 'error');
  assert.equal(result.reply, '');
});

test('a provider quota response is an error while timeout remains pending', async () => {
  const quota = await chatResult(client([message(1, "You've hit your weekly limit")]), 'agent', 'claude', 'model', 1000);
  assert.equal(quota.code, 'PROVIDER_QUOTA_EXHAUSTED');
  assert.equal(quota.status, 'error');
  assert.equal((await chatResult(client([], 'timeout'), 'agent', 'pi', 'model', 1000)).status, 'pending');
});
