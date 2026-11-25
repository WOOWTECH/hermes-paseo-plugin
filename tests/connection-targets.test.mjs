import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONNECTION_TARGETS, DEFAULT_TARGET, connectionTarget, selectedTarget, saveSelectedTarget } from '../src/connection-targets.mjs';
import { locations } from '../src/state.mjs';
import { fixture } from './runtime-fixtures.mjs';

const connectionFile = () => path.join(locations().stateDir, 'connection.json');

test('the three targets bind each web app to its own TLS relay, and Paseo stays the default', () => {
  assert.deepEqual(CONNECTION_TARGETS.map(row => [row.id, row.label, row.appUrl, row.relayEndpoint]), [
    ['paseo', 'Paseo', 'https://app.paseo.sh', 'relay.paseo.sh:443'],
    ['woowtech', 'Woowtech Smart', 'https://smart.woowtech.io', 'relay.woowtech.io:443'],
    ['apporo', 'Apporo Smart', 'https://smart.apporo.ai', 'relay.apporo.ai:443'],
  ]);
  assert.equal(DEFAULT_TARGET, 'paseo');
  assert.ok(Object.isFrozen(CONNECTION_TARGETS) && CONNECTION_TARGETS.every(row => Object.isFrozen(row)));
  for (const row of CONNECTION_TARGETS) assert.equal(connectionTarget(row.id), row);
});

test('an unknown id is INVALID_TARGET, never mapped to another row, and a missing id is not Paseo', t => {
  const f = fixture(); t.after(() => f.close());
  for (const value of ['custom', '', 'Paseo', ' paseo', 'paseo ', '__proto__', 'constructor', 'toString', null, undefined, 1, ['paseo'], { id: 'paseo' }]) {
    assert.throws(() => connectionTarget(value), { code: 'INVALID_TARGET' }, String(value));
  }
  assert.throws(() => saveSelectedTarget(locations(), 'custom'), { code: 'INVALID_TARGET' });
});

test('nothing stored means Paseo, without creating anything', t => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(selectedTarget(locations()), 'paseo');
  assert.equal(fs.existsSync(locations().stateDir), false, 'reading is not writing');
});

test('the choice is saved in its own private file and read back; preferences.json is never touched', t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  fs.mkdirSync(loc.stateDir, { recursive: true });
  // rc.9 reads this file and refuses to start on a record without a display name.
  fs.writeFileSync(path.join(loc.stateDir, 'preferences.json'), '{"futurePreference":42}');
  for (const row of CONNECTION_TARGETS) {
    saveSelectedTarget(loc, row.id);
    assert.equal(selectedTarget(loc), row.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(connectionFile(), 'utf8')), { version: 1, target: row.id });
    assert.equal(fs.statSync(connectionFile()).mode & 0o777, 0o600);
  }
  assert.equal(fs.readFileSync(path.join(loc.stateDir, 'preferences.json'), 'utf8'), '{"futurePreference":42}');
  assert.deepEqual(fs.readdirSync(loc.stateDir).filter(name => name.endsWith('.tmp')), [], 'the atomic write leaves no temporary file');
});

test('a damaged or foreign record fails closed instead of reading as Paseo', t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  fs.mkdirSync(loc.stateDir, { recursive: true });
  const records = ['{', '', '[]', 'null', '"paseo"', '{"version":1,"target":"custom"}', '{"version":1,"target":null}', '{"target":"apporo"}',
    '{"version":2,"target":"apporo"}', '{"version":"1","target":"apporo"}', '{"version":1,"target":"apporo","url":"https://evil.example"}',
    '{"version":1,"target":"__proto__"}', JSON.stringify({ version: 1, target: 'apporo', pad: 'x'.repeat(5000) })];
  for (const record of records) {
    fs.writeFileSync(connectionFile(), record);
    assert.throws(() => selectedTarget(loc), { code: 'CONNECTION_STATE_CORRUPT' }, record.slice(0, 60));
  }
  fs.rmSync(connectionFile());
  fs.mkdirSync(connectionFile());
  assert.throws(() => selectedTarget(loc), { code: 'CONNECTION_STATE_CORRUPT' }, 'a directory is not a record');
  fs.rmdirSync(connectionFile());
  fs.writeFileSync(connectionFile(), '{"version":1,"target":"apporo"}');
  assert.equal(selectedTarget(loc), 'apporo');
});

test('a link in place of the record, or in front of it, is refused', t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  fs.mkdirSync(loc.stateDir, { recursive: true });
  const elsewhere = path.join(f.dir, 'elsewhere.json');
  fs.writeFileSync(elsewhere, '{"version":1,"target":"apporo"}');
  fs.symlinkSync(elsewhere, connectionFile());
  assert.throws(() => selectedTarget(loc), { code: 'UNSAFE_SYMLINK' });
  assert.throws(() => saveSelectedTarget(loc, 'woowtech'), { code: 'UNSAFE_SYMLINK' });
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), '{"version":1,"target":"apporo"}', 'nothing was written through the link');
  fs.rmSync(connectionFile());
  const moved = path.join(f.dir, 'moved-state');
  fs.renameSync(loc.stateDir, moved);
  fs.symlinkSync(moved, loc.stateDir);
  assert.throws(() => selectedTarget(loc), { code: 'UNSAFE_SYMLINK' });
});
