import test from 'node:test';
import assert from 'node:assert/strict';
import { providerReplyError } from '../src/provider-reply.mjs';

test('quota and expired login responses cannot be reported as successful chats', () => {
  assert.equal(providerReplyError("You've hit your weekly limit · resets Oct 14, 7am (UTC)"), 'PROVIDER_QUOTA_EXHAUSTED');
  assert.equal(providerReplyError('Authentication required. Please sign in.'), 'PROVIDER_AUTH_REQUIRED');
  assert.equal(providerReplyError('HERMES_PASEO_abcdef123456'), null);
  assert.equal(providerReplyError('Here is your requested code.'), null);
});
