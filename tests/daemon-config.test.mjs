import test from 'node:test';
import assert from 'node:assert/strict';
import {managedFeatures} from '../src/daemon-config.mjs';

test('a managed text service does not implicitly enable speech-model downloads', () => {
  const features = managedFeatures();
  assert.equal(features.dictation.enabled, false);
  assert.equal(features.voiceMode.enabled, false);
  assert.equal(features.webUi.enabled, true);
});

test('a saved speech opt-in and provider settings survive service activation', () => {
  const original = {
    dictation: { enabled: true, stt: { provider: 'openai' } },
    voiceMode: { enabled: true, tts: { provider: 'local', model: 'chosen-model' } },
    otherFeature: { value: 7 },
  };
  const before = structuredClone(original);
  const features = managedFeatures(original);
  assert.deepEqual(features.dictation, before.dictation);
  assert.deepEqual(features.voiceMode, before.voiceMode);
  assert.deepEqual(features.otherFeature, before.otherFeature);
  assert.deepEqual(original, before);
});
