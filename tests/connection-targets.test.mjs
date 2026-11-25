import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONNECTION_TARGETS, DEFAULT_TARGET, connectionTarget, selectedTarget, saveSelectedTarget, targetConfiguration } from '../src/connection-targets.mjs';
import { locations, readState, updateState } from '../src/state.mjs';
import { runtimeDirectory } from '../src/runtime-layout.mjs';
import { saveConnectionSettings } from '../src/runtime.mjs';
import { control, validateInput } from '../src/control.mjs';
import { fixture } from './runtime-fixtures.mjs';

const connectionFile = () => path.join(locations().stateDir, 'connection.json');
const pairingFile = () => path.join(locations().stateDir, 'pairing.private.json');

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

test('the config action takes exactly one known target and nothing else', () => {
  for (const row of CONNECTION_TARGETS) assert.deepEqual(validateInput('config', { target: row.id }), { target: row.id });
  for (const input of [{}, { target: 'custom' }, { target: null }, { target: ['paseo'] }, { target: 'Paseo' }, { target: '' }]) {
    assert.throws(() => validateInput('config', input), { code: 'INVALID_TARGET' }, JSON.stringify(input));
  }
  for (const input of [{ target: 'paseo', url: 'https://evil.example' }, { target: 'paseo', relayEndpoint: 'evil.example:443' }, { target: 'paseo', name: 'x' }, { name: 'x' }]) {
    assert.throws(() => validateInput('config', input), { code: 'INVALID_REQUEST' }, JSON.stringify(input));
  }
  for (const input of [null, [], 'paseo', 7]) assert.throws(() => validateInput('config', input), { code: 'INVALID_REQUEST' });
});

test('a target change records the choice, withdraws stale evidence and keeps the daemon identity', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  fs.mkdirSync(loc.stateDir, { recursive: true });
  fs.mkdirSync(loc.paseoHome, { recursive: true });
  fs.writeFileSync(path.join(loc.stateDir, 'preferences.json'), '{"futurePreference":42}');
  // An older release left its pairing offer here: a bearer credential that nothing reads.
  fs.writeFileSync(pairingFile(), '{"url":"private old offer"}');
  const identity = { 'server-id': 'srv_keep_this_one', 'daemon-keypair.json': '{"keep":"this key pair"}' };
  for (const [name, content] of Object.entries(identity)) fs.writeFileSync(path.join(loc.paseoHome, name), content);
  updateState({ relayVerification: { verified: true, checkedAt: 'old' }, pairingCreatedAt: 'old', installationId: 'keep-me', phase: 'running', port: 6790 });
  const saved = await saveConnectionSettings({ target: 'woowtech' });
  assert.deepEqual(saved, { saved: true, target: 'woowtech', configurationPending: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(connectionFile(), 'utf8')), { version: 1, target: 'woowtech' });
  assert.equal(fs.statSync(connectionFile()).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(pairingFile()), false);
  const state = readState();
  assert.equal(state.configurationPending, true);
  assert.equal(state.relayVerification, null);
  assert.equal(state.pairingCreatedAt, null);
  assert.deepEqual([state.installationId, state.phase, state.port], ['keep-me', 'running', 6790]);
  assert.equal(fs.readFileSync(path.join(loc.stateDir, 'preferences.json'), 'utf8'), '{"futurePreference":42}', 'preferences.json is never written');
  for (const [name, content] of Object.entries(identity)) assert.equal(fs.readFileSync(path.join(loc.paseoHome, name), 'utf8'), content, name);
  // Saving the same target again changes nothing.
  fs.writeFileSync(pairingFile(), '{"url":"new offer"}');
  const stamp = readState().updatedAt;
  assert.deepEqual(await saveConnectionSettings({ target: 'woowtech' }), { saved: true, target: 'woowtech', configurationPending: true });
  assert.equal(fs.existsSync(pairingFile()), true);
  assert.equal(readState().updatedAt, stamp, 'no state write for an unchanged choice');
  // Every target can be chosen, and each change is a change.
  for (const row of ['apporo', 'paseo', 'woowtech']) {
    assert.equal((await saveConnectionSettings({ target: row })).target, row);
    assert.equal(selectedTarget(loc), row);
  }
});

test('the config action goes through control and answers with the saved target only', async t => {
  const f = fixture(); t.after(() => f.close());
  assert.deepEqual(await control('config', { target: 'apporo' }), { saved: true, target: 'apporo', configurationPending: true });
  await assert.rejects(control('config', { target: 'nowhere' }), { code: 'INVALID_TARGET' });
  assert.equal(selectedTarget(locations()), 'apporo');
});

test('a link named like the old pairing file is neither followed nor removed', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  fs.mkdirSync(loc.stateDir, { recursive: true });
  const elsewhere = path.join(f.dir, 'elsewhere.json');
  fs.writeFileSync(elsewhere, 'precious');
  fs.symlinkSync(elsewhere, pairingFile());
  assert.equal((await saveConnectionSettings({ target: 'apporo' })).target, 'apporo');
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'precious');
  assert.equal(fs.lstatSync(pairingFile()).isSymbolicLink(), true, 'left alone');
});

test('invalid input or extra fields never write anything or clear a pairing', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  fs.mkdirSync(loc.stateDir, { recursive: true });
  saveSelectedTarget(loc, 'apporo');
  fs.writeFileSync(pairingFile(), '{"url":"keep-private"}');
  updateState({ relayVerification: { verified: true, checkedAt: 'x', target: 'apporo' } });
  const before = [fs.readFileSync(connectionFile(), 'utf8'), fs.readFileSync(path.join(loc.stateDir, 'state.json'), 'utf8')];
  for (const input of [{ target: 'custom' }, { target: null }, {}, { target: 'paseo', name: 'x' }, { target: ['paseo'] }, null, [], 'paseo', undefined]) {
    await assert.rejects(saveConnectionSettings(input), { code: 'INVALID_TARGET' }, JSON.stringify(input));
  }
  assert.deepEqual([fs.readFileSync(connectionFile(), 'utf8'), fs.readFileSync(path.join(loc.stateDir, 'state.json'), 'utf8')], before);
  assert.equal(fs.existsSync(pairingFile()), true);
});

test('a damaged choice is replaced by the next save, which counts as a change', async t => {
  const f = fixture(); t.after(() => f.close());
  fs.mkdirSync(locations().stateDir, { recursive: true });
  fs.writeFileSync(connectionFile(), '{broken');
  assert.deepEqual(await saveConnectionSettings({ target: 'paseo' }), { saved: true, target: 'paseo', configurationPending: true });
  assert.equal(selectedTarget(locations()), 'paseo');
});

test('saving asks the daemon nothing: the client is never loaded, and no runtime has to exist', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  assert.equal((await saveConnectionSettings({ target: 'woowtech' })).saved, true, 'works with nothing installed');
  const trace = path.join(f.dir, 'client-trace.log');
  const client = path.join(runtimeDirectory(loc), 'node_modules/@getpaseo/cli/dist/utils/client.js');
  fs.mkdirSync(path.dirname(client), { recursive: true });
  fs.writeFileSync(path.join(runtimeDirectory(loc), 'node_modules/@getpaseo/cli/package.json'), JSON.stringify({ version: '0.11.2', type: 'module' }));
  fs.writeFileSync(client, `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(trace)},'loaded\\n');export async function connectToDaemon(){fs.appendFileSync(${JSON.stringify(trace)},'connected\\n');throw new Error('no daemon here');}`);
  updateState({ phase: 'running', desiredEnabled: true, daemonPid: process.pid });
  assert.equal((await saveConnectionSettings({ target: 'apporo' })).target, 'apporo');
  assert.equal(fs.existsSync(trace), false, 'the daemon client was neither imported nor called');
});

test('saving is not held up by the runtime lock an activation holds', async t => {
  const f = fixture(); t.after(() => f.close());
  const { withRuntimeLock } = await import('../src/state.mjs');
  let release; const blocked = new Promise(resolve => { release = resolve; });
  let entered; const held = new Promise(resolve => { entered = resolve; });
  const operation = withRuntimeLock(async () => { entered(); await blocked; });
  await held;
  const started = Date.now();
  assert.equal((await saveConnectionSettings({ target: 'apporo' })).target, 'apporo');
  assert.ok(Date.now() - started < 2000, 'an activation can hold the lock for minutes while npm runs; the choice is only recorded');
  assert.equal(selectedTarget(locations()), 'apporo');
  release(); await operation;
});

// The keys Paseo 0.11.2's strict schema accepts for what a target writes (persisted-config.js: daemon.relay, daemon.cors, app).
const RELAY_KEYS = ['enabled', 'endpoint', 'publicEndpoint', 'useTls', 'publicUseTls'];

test('daemon config for a target: its app, relay and origin, TLS stated, everything else kept', () => {
  const base = { daemon: { listen: 'localhost:6779', hostnames: ['localhost'], relay: { endpoint: 'wrong:443', enabled: false },
    cors: { allowedOrigins: ['https://local.example', 'https://smart.apporo.ai/', 'https://app.paseo.sh', ' https://smart.woowtech.io//'] }, mcp: { enabled: true } },
    app: { baseUrl: 'https://wrong.example' }, agents: { providers: { claude: { enabled: false } } }, features: { webUi: { enabled: true } } };
  const before = structuredClone(base);
  for (const target of CONNECTION_TARGETS) {
    const config = targetConfiguration(base, target.id);
    assert.deepEqual(config.app, { baseUrl: target.appUrl });
    assert.deepEqual(config.daemon.relay, { enabled: true, endpoint: target.relayEndpoint, publicEndpoint: target.relayEndpoint, useTls: true, publicUseTls: true });
    assert.deepEqual(Object.keys(config.daemon.relay).filter(key => !RELAY_KEYS.includes(key)), [], 'only keys the 0.11.2 schema knows');
    assert.equal('requireProtectedSecurity' in config.daemon.relay, false, 'not in 0.11.2\'s strict schema: it would make the file invalid');
    assert.deepEqual(config.daemon.cors.allowedOrigins, ['https://local.example', target.appUrl], 'an unmanaged origin stays; the other apps and slash variants go');
    assert.deepEqual([config.daemon.listen, config.daemon.hostnames, config.daemon.mcp], ['localhost:6779', ['localhost'], { enabled: true }]);
    assert.deepEqual([config.agents, config.features], [base.agents, base.features]);
  }
  assert.deepEqual(base, before, 'the caller config is not mutated');
});

test('daemon config for a target also works from nothing, and refuses origins it cannot read', () => {
  for (const target of CONNECTION_TARGETS) {
    const config = targetConfiguration({}, target.id);
    assert.deepEqual(config.daemon.cors.allowedOrigins, [target.appUrl]);
    assert.equal(config.daemon.relay.publicEndpoint, target.relayEndpoint);
    assert.equal(config.daemon.relay.publicUseTls, true);
  }
  for (const allowedOrigins of ['https://x', { 0: 'https://x' }, [1], [null], ['https://ok.example', {}]]) {
    assert.throws(() => targetConfiguration({ daemon: { cors: { allowedOrigins } } }, 'paseo'), { code: 'CONFIG_INVALID' }, JSON.stringify(allowedOrigins));
  }
  assert.throws(() => targetConfiguration({}, 'custom'), { code: 'INVALID_TARGET' });
  assert.throws(() => targetConfiguration({}), { code: 'INVALID_TARGET' });
});

test('switching from one target to another overwrites a custom relay and app URL of the earlier one', () => {
  const custom = { app: { baseUrl: 'https://my.app.example' }, daemon: { relay: { enabled: true, endpoint: 'relay.my.example:443', publicEndpoint: 'relay.my.example:443', useTls: false, publicUseTls: false } } };
  for (const target of CONNECTION_TARGETS) {
    const config = targetConfiguration(custom, target.id);
    assert.equal(config.app.baseUrl, target.appUrl);
    assert.deepEqual([config.daemon.relay.endpoint, config.daemon.relay.useTls], [target.relayEndpoint, true]);
  }
});
