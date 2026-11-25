import test from 'node:test';
import assert from 'node:assert/strict';
import { configIssuePaths, issueKeyPaths } from '../src/config-issues.mjs';

const failure = lines => new Error('[Config] Invalid config in /somewhere/config.json:\n' + lines.map(line => '  - ' + line).join('\n'));

test('the reader error is reduced to key paths: unknown keys join their parent, messages and values are dropped', () => {
  const error = failure([
    'daemon: Unrecognized key: "keepAliveSeconds"',
    'daemon: Unrecognized keys: "a", "b.c"',
    'features.voiceMode.stt.provider: Invalid option: expected one of "local"|"openai"',
    ': Invalid input: expected object, received string',
    'agents.providers.claude.enabled: Invalid input: expected boolean, received string "hunter2"',
  ]);
  assert.deepEqual(configIssuePaths(error), ['daemon.keepAliveSeconds', 'daemon.a', 'daemon.b.c', 'features.voiceMode.stt.provider', '(root)', 'agents.providers.claude.enabled']);
  assert.equal(JSON.stringify(configIssuePaths(error)).includes('hunter2'), false);
  assert.equal(JSON.stringify(configIssuePaths(error)).includes('somewhere'), false, 'not even the file path');
});

test('anything that is not an issue line yields nothing, and the list stays small and printable', () => {
  assert.deepEqual(configIssuePaths(new Error('[Config] Invalid JSON in /x/config.json: Unexpected end')), []);
  assert.deepEqual(configIssuePaths(undefined), []);
  assert.deepEqual(configIssuePaths({ message: 12 }), []);
  assert.deepEqual(configIssuePaths(failure(['daemon: Unrecognized key: "broken'])), [], 'an unreadable key name is not guessed');
  const many = configIssuePaths(failure(Array.from({ length: 50 }, (_, i) => `key${i}: Unrecognized`)));
  assert.equal(many.length, 20);
  assert.deepEqual(configIssuePaths(failure(['same: x', 'same: y'])), ['same'], 'duplicates collapse');
  const long = configIssuePaths(failure(['a'.repeat(500) + ': x']))[0];
  assert.equal(long.length, 160);
  assert.equal(configIssuePaths(failure(['we\u0000ird\u001b: x']))[0], 'weird');
});

test('structured issues name the path, and the keys an unrecognized-key issue lists', () => {
  assert.deepEqual(issueKeyPaths([
    { code: 'unrecognized_keys', keys: ['x', 'y'], path: ['daemon'] },
    { code: 'invalid_type', path: ['features', 'webUi', 'enabled'], message: 'expected boolean, received string "hunter2"' },
    { code: 'custom', path: [] },
    { code: 'invalid_type', path: ['agents', 0, 'id'] },
  ]), ['daemon.x', 'daemon.y', 'features.webUi.enabled', '(root)', 'agents.0.id']);
  assert.deepEqual(issueKeyPaths(null), []);
  assert.deepEqual(issueKeyPaths([null, 5, {}]), ['(root)']);
});
