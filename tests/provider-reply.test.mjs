import test from 'node:test';
import assert from 'node:assert/strict';
import { providerReplyError } from '../src/provider-reply.mjs';

test('quota and expired login responses cannot be reported as successful chats', () => {
  assert.equal(providerReplyError("You've hit your weekly limit · resets Oct 14, 7am (UTC)"), 'PROVIDER_QUOTA_EXHAUSTED');
  assert.equal(providerReplyError('Authentication required. Please sign in.'), 'PROVIDER_AUTH_REQUIRED');
  assert.equal(providerReplyError('HERMES_PASEO_abcdef123456'), null);
  assert.equal(providerReplyError('Here is your requested code.'), null);
});

test('the observed blocked-prompt response is an error, without matching discussion of it', () => {
  const blocked = 'The tool call did not complete because the prompt was blocked.';
  assert.equal(providerReplyError(blocked), 'PROVIDER_PROMPT_BLOCKED');
  assert.equal(providerReplyError('  ' + blocked + '\n'), 'PROVIDER_PROMPT_BLOCKED');
  assert.equal(providerReplyError('The log previously said: ' + blocked + ' The next turn succeeded.'), null);
});
