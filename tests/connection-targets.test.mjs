import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONNECTION_TARGETS, connectionTarget, selectedTarget, targetConfiguration, targetEnvironment, targetPairUrl } from '../src/connection-targets.mjs';
import { locations, readState, updateState, withRuntimeLock } from '../src/state.mjs';
import { pair, saveConnectionSettings, status, verifyRelay } from '../src/runtime.mjs';
import { validateInput, publicStatus } from '../src/control.mjs';
import { fixture } from './release-fixtures.mjs';

const offerFor = (target, patch = {}) => ({ v: 2, serverId: 'srv_test12345678', daemonPublicKeyB64: 'test-public-key', relay: { endpoint: target.relayEndpoint, useTls: true }, ...patch });
const fragmentFor = offer => '#offer=' + Buffer.from(JSON.stringify(offer)).toString('base64url');
const pairingFile = () => path.join(locations().stateDir, 'pairing.private.json');
const connectionFile = () => path.join(locations().stateDir, 'connection.json');

test('the three targets bind each official app to its own TLS relay, and Paseo stays the default', () => {
  assert.deepEqual(CONNECTION_TARGETS.map(row => [row.id, row.label, row.appUrl, row.relayEndpoint]), [
    ['paseo', 'Paseo', 'https://app.paseo.sh', 'relay.paseo.sh:443'],
    ['woowtech', 'Woowtech Smart', 'https://smart.woowtech.io', 'relay.woowtech.io:443'],
    ['apporo', 'Apporo Smart', 'https://smart.apporo.ai', 'relay.apporo.ai:443'],
  ]);
  assert.equal(connectionTarget().id, 'paseo');
  for (const value of ['custom', '', 'Paseo', '__proto__', 'constructor', null, 1]) assert.throws(() => connectionTarget(value), { code: 'INVALID_TARGET' });
  for (const target of CONNECTION_TARGETS) {
    const env = targetEnvironment(target.id, 'https://keep.example, https://app.paseo.sh/,https://smart.apporo.ai');
    assert.equal(env.HERMES_PASEO_CONNECTION_TARGET, target.id);
    assert.equal(env.PASEO_APP_BASE_URL, target.appUrl);
    assert.equal(env.PASEO_RELAY_ENDPOINT, target.relayEndpoint);
    assert.equal(env.PASEO_RELAY_PUBLIC_ENDPOINT, target.relayEndpoint);
    assert.equal(env.PASEO_RELAY_USE_TLS, 'true');
    assert.equal(env.PASEO_RELAY_PUBLIC_USE_TLS, 'true');
    assert.equal(env.PASEO_RELAY_ENABLED, 'true');
    // An operator origin survives; another official app does not.
    assert.equal(env.PASEO_CORS_ORIGINS, `https://keep.example,${target.appUrl}`);
  }
});

test('daemon config for a target keeps unrelated settings and only the selected official origin', () => {
  const base = { daemon: { listen: 'localhost:6779', relay: { endpoint: 'wrong:443', enabled: false, requireProtectedSecurity: true },
    cors: { allowedOrigins: ['https://local.example', 'https://smart.apporo.ai/', 'https://app.paseo.sh'] }, mcp: { enabled: true } },
    app: { baseUrl: 'https://wrong.example' }, agents: { providers: { claude: { enabled: false } } } };
  const before = structuredClone(base);
  for (const target of CONNECTION_TARGETS) {
    const config = targetConfiguration(base, target.id);
    assert.equal(config.app.baseUrl, target.appUrl);
    assert.deepEqual({ ...config.daemon.relay, requireProtectedSecurity: undefined }, { enabled: true, endpoint: target.relayEndpoint, publicEndpoint: target.relayEndpoint, useTls: true, publicUseTls: true, requireProtectedSecurity: undefined });
    assert.deepEqual(config.daemon.cors.allowedOrigins, ['https://local.example', target.appUrl]);
    assert.equal(config.daemon.listen, 'localhost:6779');
    assert.deepEqual(config.daemon.mcp, { enabled: true });
    assert.deepEqual(config.agents, base.agents);
    // The Smart apps only speak the older relay encryption; Paseo keeps the user's choice.
    assert.equal(config.daemon.relay.requireProtectedSecurity, target.id === 'paseo' ? true : undefined);
    assert.equal('requireProtectedSecurity' in config.daemon.relay, target.id === 'paseo');
  }
  assert.deepEqual(base, before, 'the caller config is not mutated');
  assert.throws(() => targetConfiguration({ daemon: { cors: { allowedOrigins: 'https://x' } } }, 'paseo'), { code: 'CONFIG_INVALID' });
});

test('pairing links keep the offer exactly and reject another app, path, relay, TLS or protected security', () => {
  for (const target of CONNECTION_TARGETS) {
    const hash = fragmentFor(offerFor(target));
    assert.equal(targetPairUrl(target.appUrl + '/' + hash, target.id), target.appUrl + '/' + hash);
    for (const url of [target.appUrl + '.evil/' + hash, target.appUrl + '/welcome' + hash, target.appUrl + '/?redirect=evil' + hash,
      target.appUrl.replace('https:', 'http:') + '/' + hash, target.appUrl + '/#opaque', 'https://user@' + target.appUrl.slice(8) + '/' + hash,
      target.appUrl + ':444/' + hash, target.appUrl + '/' + hash + ' ', 'javascript:alert(1)', 42]) {
      assert.throws(() => targetPairUrl(url, target.id), { code: 'PAIRING_ORIGIN_INVALID' }, String(url));
    }
    for (const other of CONNECTION_TARGETS.filter(row => row.id !== target.id)) assert.throws(() => targetPairUrl(target.appUrl + '/' + hash, other.id), { code: 'PAIRING_ORIGIN_INVALID' });
    for (const relay of [{ endpoint: 'other.example:443', useTls: true }, { endpoint: target.relayEndpoint, useTls: false }, { endpoint: target.relayEndpoint }]) {
      assert.throws(() => targetPairUrl(target.appUrl + '/' + fragmentFor(offerFor(target, { relay })), target.id), { code: 'PAIRING_TARGET_MISMATCH' });
    }
    assert.throws(() => targetPairUrl(target.appUrl + '/#offer=e30', target.id), { code: 'PAIRING_TARGET_MISMATCH' });
    assert.throws(() => targetPairUrl(target.appUrl + '/#offer=bm90LWpzb24', target.id), { code: 'PAIRING_OFFER_INVALID' });
    const protectedOffer = target.appUrl + '/' + fragmentFor(offerFor(target, { minimumSecurityMode: 'protected' }));
    if (target.id === 'paseo') assert.equal(targetPairUrl(protectedOffer, 'paseo'), protectedOffer);
    else assert.throws(() => targetPairUrl(protectedOffer, target.id), { code: 'PAIRING_SECURITY_UNSUPPORTED' });
  }
});

test('the saved choice lives in its own private file; anything unexpected fails closed', t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  assert.equal(selectedTarget(loc), 'paseo');
  fs.mkdirSync(loc.stateDir, { recursive: true });
  for (const record of ['{', '[]', '{"version":1,"target":"custom"}', '{"target":"apporo"}', '{"version":2,"target":"apporo"}', '{"version":1,"target":"apporo","url":"https://evil"}']) {
    fs.writeFileSync(connectionFile(), record);
    assert.throws(() => selectedTarget(loc), { code: 'CONNECTION_STATE_CORRUPT' }, record);
  }
  fs.writeFileSync(connectionFile(), '{"version":1,"target":"apporo"}');
  assert.equal(selectedTarget(loc), 'apporo');
  fs.rmSync(connectionFile());
  fs.symlinkSync(path.join(f.dir, 'elsewhere.json'), connectionFile());
  assert.throws(() => selectedTarget(loc), { code: 'UNSAFE_SYMLINK' });
});

test('a target change withdraws the pairing link and relay evidence, keeps the rest of the state, and stays pending', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  fs.mkdirSync(loc.stateDir, { recursive: true });
  fs.writeFileSync(path.join(loc.stateDir, 'preferences.json'), '{"futurePreference":42}');
  fs.writeFileSync(pairingFile(), '{"url":"private old offer"}');
  updateState({ relayVerification: { verified: true, checkedAt: 'old', target: 'paseo' }, pairingCreatedAt: 'old', activeTarget: 'paseo', installationId: 'keep-me' });
  const saved = await saveConnectionSettings({ target: 'woowtech' });
  assert.deepEqual(saved, { saved: true, target: 'woowtech', configurationPending: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(connectionFile(), 'utf8')), { version: 1, target: 'woowtech' });
  assert.equal(fs.statSync(connectionFile()).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(pairingFile()), false);
  assert.equal(readState().relayVerification, null);
  assert.equal(readState().pairingCreatedAt, null);
  assert.equal(readState().installationId, 'keep-me');
  assert.equal(fs.readFileSync(path.join(loc.stateDir, 'preferences.json'), 'utf8'), '{"futurePreference":42}', '0.1.4 reads preferences.json; it is never written');
  // Saving the same target again changes nothing.
  fs.writeFileSync(pairingFile(), '{"url":"new offer"}');
  assert.deepEqual(await saveConnectionSettings({ target: 'woowtech' }), { saved: true, target: 'woowtech', configurationPending: true });
  assert.equal(fs.existsSync(pairingFile()), true);
  // Pairing and the relay check wait for the daemon to restart with the new target.
  const snapshot = await status();
  assert.equal(snapshot.selectedTarget, 'woowtech');
  assert.equal(snapshot.activeTarget, null);
  assert.equal(snapshot.configurationPending, true);
  assert.equal(publicStatus(snapshot).configurationPending, true);
  await assert.rejects(pair(), { code: 'DAEMON_UNREACHABLE' });
  await assert.rejects(verifyRelay({ daemon: async () => ({ reachable: true, configurationPending: true }), offer: () => assert.fail('no offer'), connect: () => assert.fail('no connection') }), { code: 'CONFIGURATION_PENDING' });
});

test('invalid targets or extra fields never write anything or clear a pairing', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  fs.mkdirSync(loc.stateDir, { recursive: true });
  fs.writeFileSync(connectionFile(), '{"version":1,"target":"apporo"}');
  fs.writeFileSync(pairingFile(), '{"url":"keep-private"}');
  const before = fs.readFileSync(connectionFile(), 'utf8');
  for (const input of [{ target: 'custom' }, { target: null }, {}, { target: 'paseo', name: 'x' }, { target: ['paseo'] }, null, [], 'paseo']) {
    await assert.rejects(saveConnectionSettings(input), { code: 'INVALID_TARGET' });
    assert.equal(fs.readFileSync(connectionFile(), 'utf8'), before);
    assert.equal(fs.existsSync(pairingFile()), true);
  }
  for (const input of [{ target: 'custom' }, {}, { target: 'paseo', url: 'https://evil.example' }]) assert.throws(() => validateInput('config', input));
  assert.deepEqual(validateInput('config', { target: 'apporo' }), { target: 'apporo' });
});

test('a damaged choice is replaced by the next save, which treats it as a change', async t => {
  const f = fixture(); t.after(() => f.close());
  fs.mkdirSync(locations().stateDir, { recursive: true });
  fs.writeFileSync(connectionFile(), '{broken');
  assert.equal((await status()).diagnosticCode, 'CONNECTION_STATE_CORRUPT');
  assert.deepEqual(await saveConnectionSettings({ target: 'paseo' }), { saved: true, target: 'paseo', configurationPending: true });
  assert.equal(selectedTarget(locations()), 'paseo');
});

test('saving waits for the runtime lock that activation and pairing hold', async t => {
  const f = fixture(); t.after(() => f.close());
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const held = new Promise(resolve => { entered = resolve; });
  const operation = withRuntimeLock(async () => { entered(); await blocked; });
  await held;
  let done = false;
  const save = saveConnectionSettings({ target: 'apporo' }).then(result => { done = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(done, false);
  assert.equal(fs.existsSync(connectionFile()), false);
  release(); await operation;
  assert.equal((await save).target, 'apporo');
});
