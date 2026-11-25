import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONNECTION_TARGETS } from '../src/connection-targets.mjs';
import { BRAND_SERVER_PATH, BRAND_HELPER_NAME, ORIGINAL_BRAND_SERVER_SHA256, PATCHED_BRAND_SERVER_SHA256, brandIdentityPatchReady } from '../src/brand-identity-patch.mjs';
import { locations, readState } from '../src/state.mjs';
import { activate, deactivate, status, saveConnectionSettings, inheritedEnv } from '../src/runtime.mjs';
import { fixture } from './runtime-fixtures.mjs';
import { seedFakeRuntime, startLegacyDaemon, trapNpm, readTrace, stopFakeDaemons, sha256 } from './fake-runtime.mjs';

// A profile with the stand-in runtime installed the way rc.9 left it (ready, not patched) and npm as a trap.
function profile(t, options = {}) {
  const f = fixture();
  const marker = trapNpm(f.dir), trace = path.join(f.dir, 'trace.log'), loc = locations();
  const root = seedFakeRuntime(loc, { trace, ...options });
  t.after(() => { stopFakeDaemons(loc); f.close(); });
  return { f, loc, root, marker, trace, server: path.join(root, BRAND_SERVER_PATH), config: path.join(loc.paseoHome, 'config.json') };
}
const configOf = p => JSON.parse(fs.readFileSync(p.config, 'utf8'));
const serverSha = p => sha256(fs.readFileSync(p.server));
const supervisorEnv = pid => fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
const starts = p => readTrace(p.trace).filter(row => row.supervisor);
const RELAY_KEYS = ['enabled', 'endpoint', 'publicEndpoint', 'useTls', 'publicUseTls'];

test('the daemon environment names its target only when a start passes one', t => {
  const f = fixture(); t.after(() => f.close());
  process.env.HERMES_PASEO_CONNECTION_TARGET = 'apporo';
  assert.equal('HERMES_PASEO_CONNECTION_TARGET' in inheritedEnv(), false, 'a value inherited from the host is never handed on');
  for (const row of CONNECTION_TARGETS) {
    const env = inheritedEnv(row.id);
    assert.equal(env.HERMES_PASEO_CONNECTION_TARGET, row.id);
    assert.equal(Object.keys(env).some(key => /^PASEO_(APP_BASE_URL|RELAY_|CORS_ORIGINS)/.test(key)), false, 'those settings travel in config.json: a managed start strips them');
  }
  assert.throws(() => inheritedEnv('custom'), { code: 'INVALID_TARGET' });
});

for (const target of CONNECTION_TARGETS) {
  test(`a start applies ${target.id}: its config, its brand, the patched runtime, and never npm`, async t => {
    const p = profile(t);
    // A first start with the default, then the operator's own settings and a stale relay, as an installed profile has.
    await activate();
    await deactivate();
    const first = configOf(p);
    assert.equal(first.app.baseUrl, 'https://app.paseo.sh', 'the default target is written too');
    first.daemon.cors.allowedOrigins.push('https://keep.example', 'https://smart.apporo.ai');
    first.daemon.relay.endpoint = 'relay.stale.example:443';
    fs.writeFileSync(p.config, JSON.stringify(first));
    await saveConnectionSettings({ target: target.id });
    const result = await activate();
    assert.equal(result.phase, 'running');
    assert.equal(result.daemon.reachable, true);
    const config = configOf(p);
    assert.deepEqual(config.app, { baseUrl: target.appUrl });
    assert.deepEqual(config.daemon.relay, { enabled: true, endpoint: target.relayEndpoint, publicEndpoint: target.relayEndpoint, useTls: true, publicUseTls: true });
    assert.deepEqual(Object.keys(config.daemon.relay).filter(key => !RELAY_KEYS.includes(key)), []);
    assert.deepEqual(config.daemon.cors.allowedOrigins, ['https://keep.example', target.appUrl], 'an operator origin stays; no other app does');
    assert.equal(config.features.webUi.enabled, true);
    assert.deepEqual(config.features.dictation, { enabled: false });
    assert.deepEqual(config.daemon.hostnames, ['localhost', '127.0.0.1', '.localhost']);
    // The daemon came up with this target in its environment, from a runtime that was already patched.
    const [, started] = starts(p);
    assert.equal(started.target, target.id);
    assert.equal(started.serverSha256, PATCHED_BRAND_SERVER_SHA256);
    assert.equal(supervisorEnv(started.supervisor).includes(`HERMES_PASEO_CONNECTION_TARGET=${target.id}`), true);
    assert.equal(brandIdentityPatchReady(p.root), true);
    assert.equal(fs.existsSync(p.marker), false, 'a patch is not a reason to install the runtime again');
    assert.equal(readState().activeTarget, target.id);
    assert.equal(readState().configurationPending, false);
    await deactivate();
  });
}

test('a daemon rc.9 left running is left alone: no patch, no restart, no install, no new settings it cannot reload', async t => {
  const p = profile(t);
  await activate(); await deactivate();
  const legacy = await startLegacyDaemon(p.loc);
  assert.equal(serverSha(p), ORIGINAL_BRAND_SERVER_SHA256);
  const clientCalls = readTrace(p.trace).length;
  const result = await activate();
  assert.equal(result.phase, 'running');
  assert.equal(result.daemon.pid, legacy.pid, 'the same daemon');
  assert.equal(starts(p).length, 2, 'nothing was started again (one start by the setup activation, one legacy start)');
  assert.equal(serverSha(p), ORIGINAL_BRAND_SERVER_SHA256, 'the runtime is not patched under a running daemon');
  assert.equal(fs.existsSync(path.join(path.dirname(p.server), BRAND_HELPER_NAME)), false);
  assert.equal(fs.existsSync(p.marker), false, 'npm never ran');
  const config = configOf(p);
  assert.deepEqual(config.daemon.relay, { enabled: true }, 'a running daemon cannot reload relay settings: none were written');
  assert.equal(config.app, undefined);
  assert.ok(readTrace(p.trace).slice(clientCalls).some(row => row.rpc === 'reloadDaemonConfig'), 'rc.9\'s own path still ran: the config is written and reloaded');
  assert.equal(readState().lastError, null);
  // Only a stop and start applies the plugin's settings and patches the runtime.
  const stopped = await deactivate();
  assert.equal(stopped.daemon.running, false);
  assert.equal(serverSha(p), ORIGINAL_BRAND_SERVER_SHA256, 'stopping patches nothing either');
  const again = await activate();
  assert.equal(again.phase, 'running');
  assert.notEqual(again.daemon.pid, legacy.pid);
  assert.equal(serverSha(p), PATCHED_BRAND_SERVER_SHA256, 'patched in place, right before the start');
  assert.deepEqual(configOf(p).daemon.relay, { enabled: true, endpoint: 'relay.paseo.sh:443', publicEndpoint: 'relay.paseo.sh:443', useTls: true, publicUseTls: true });
  assert.equal(starts(p).at(-1).serverSha256, PATCHED_BRAND_SERVER_SHA256);
  assert.equal(fs.existsSync(p.marker), false, 'still no npm');
  assert.equal(path.basename(p.root), `0.11.2-r2-${p.root.split('-r2-')[1]}`, 'the same release directory');
});

test('a start refuses a runtime whose server it does not recognise, and leaves it as it found it', async t => {
  const p = profile(t);
  fs.appendFileSync(p.server, '\n// local edit\n');
  const edited = fs.readFileSync(p.server);
  await assert.rejects(activate(), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' });
  assert.ok(fs.readFileSync(p.server).equals(edited));
  assert.equal(starts(p).length, 0, 'no daemon was started');
  assert.equal(fs.existsSync(p.marker), false);
  assert.equal((await status()).phase, 'error');
});

// ---- switching targets (item 4) ----
import { publicStatus } from '../src/control.mjs';
import { pair, verifyRelay } from '../src/runtime.mjs';
import { updateState } from '../src/state.mjs';

const identityFiles = loc => ({ 'server-id': 'srv_keep_this_one', 'daemon-keypair.json': '{"keep":"this key pair"}' });
const seedIdentity = loc => { for (const [name, content] of Object.entries(identityFiles(loc))) fs.writeFileSync(path.join(loc.paseoHome, name), content); };
const identityIntact = loc => Object.entries(identityFiles(loc)).every(([name, content]) => fs.readFileSync(path.join(loc.paseoHome, name), 'utf8') === content);
const pairCalls = p => readTrace(p.trace).filter(row => row.cli?.[0] === 'daemon' && row.cli?.[1] === 'pair');
const rpc = (p, name) => readTrace(p.trace).filter(row => row.rpc === name).length;

test('status names the saved target, the one the daemon runs, and whether the two differ', async t => {
  const f = fixture(); t.after(() => f.close());
  let s = await status();
  assert.deepEqual([s.selectedTarget, s.activeTarget, s.configurationPending], ['paseo', null, false], 'nothing saved, nothing running: Paseo, nothing pending');
  assert.deepEqual(Object.keys(publicStatus(s)).filter(key => /Target|Pending/.test(key)).sort(), ['activeTarget', 'configurationPending', 'selectedTarget']);
  await saveConnectionSettings({ target: 'apporo' });
  s = await status();
  assert.deepEqual([s.selectedTarget, s.activeTarget, s.configurationPending], ['apporo', null, true], 'stopped: it applies at the next start');
  assert.deepEqual([publicStatus(s).selectedTarget, publicStatus(s).activeTarget, publicStatus(s).configurationPending], ['apporo', null, true]);
  fs.writeFileSync(path.join(locations().stateDir, 'connection.json'), '{broken');
  s = await status();
  assert.equal(s.diagnosticCode, 'CONNECTION_STATE_CORRUPT', 'a damaged choice is named, not read as Paseo silently');
});

test('a target saved while the daemon runs waits for a stop and start; nothing is written, reloaded or paired meanwhile', async t => {
  const p = profile(t);
  await activate();
  seedIdentity(p.loc);
  let s = await status();
  assert.deepEqual([s.selectedTarget, s.activeTarget, s.configurationPending], ['paseo', 'paseo', false]);
  const config = fs.readFileSync(p.config, 'utf8'), pid = s.daemon.pid;
  updateState({ relayVerification: { verified: true, checkedAt: 'old', target: 'paseo' }, pairingCreatedAt: 'old' });
  assert.equal((await status()).daemon.relayVerified, true);
  assert.deepEqual(await saveConnectionSettings({ target: 'woowtech' }), { saved: true, target: 'woowtech', configurationPending: true });
  s = await status();
  assert.deepEqual([s.selectedTarget, s.activeTarget, s.configurationPending, s.daemon.running, s.daemon.pid], ['woowtech', 'paseo', true, true, pid]);
  assert.equal(s.daemon.relayVerified, false, 'the evidence of the old target is gone, and says nothing about the new');
  assert.equal(readState().pairingCreatedAt, null);
  // Neither pairing nor the relay check goes near the daemon while the change is pending.
  const asked = readTrace(p.trace).length;
  await assert.rejects(pair(), { code: 'CONFIGURATION_PENDING' });
  await assert.rejects(verifyRelay(), { code: 'CONFIGURATION_PENDING' });
  assert.equal(readTrace(p.trace).length, asked, 'no pairing offer was asked for, nothing was dialled');
  // Activating again does not rewrite or reload anything for the running daemon: it names the pending change.
  const again = await activate();
  assert.equal(again.phase, 'restart_required');
  assert.equal(again.configurationPending, true);
  assert.equal(again.daemon.pid, pid);
  assert.equal(fs.readFileSync(p.config, 'utf8'), config, 'config.json untouched');
  assert.equal(rpc(p, 'reloadDaemonConfig'), 0);
  assert.equal(starts(p).length, 1);
  assert.equal(identityIntact(p.loc), true);
  // Stop, start: the change is applied, and the server id and key pair survived.
  await deactivate();
  s = await status();
  assert.deepEqual([s.daemon.running, s.activeTarget, s.configurationPending], [false, null, true], 'stopped, still waiting for the start');
  s = await activate();
  assert.deepEqual([s.phase, s.selectedTarget, s.activeTarget, s.configurationPending], ['running', 'woowtech', 'woowtech', false]);
  assert.equal(starts(p).at(-1).target, 'woowtech');
  assert.equal(configOf(p).app.baseUrl, 'https://smart.woowtech.io');
  assert.equal(identityIntact(p.loc), true, 'previously paired devices of the same target keep working');
  assert.equal(readState().configurationPending, false);
});

test('choosing the running target again before the restart leaves nothing pending', async t => {
  const p = profile(t);
  await activate();
  await saveConnectionSettings({ target: 'apporo' });
  assert.equal((await status()).configurationPending, true);
  assert.deepEqual(await saveConnectionSettings({ target: 'paseo' }), { saved: true, target: 'paseo', configurationPending: false });
  const s = await status();
  assert.deepEqual([s.selectedTarget, s.activeTarget, s.configurationPending], ['paseo', 'paseo', false]);
  assert.equal(readState().configurationPending, false, 'the flag is cleared too, so a later stop does not announce a change');
  await deactivate();
  assert.equal((await status()).configurationPending, false);
  const after = await activate();
  assert.deepEqual([after.activeTarget, after.configurationPending], ['paseo', false]);
});

test('a pending flag left behind by a save that raced a start does not outlive the next activation of a daemon that serves the saved target', async t => {
  const p = profile(t);
  await activate();
  updateState({ configurationPending: true });
  assert.equal((await status()).configurationPending, false, 'a running daemon decides by itself');
  const result = await activate();
  assert.equal(result.phase, 'running');
  assert.equal(readState().configurationPending, false);
  await deactivate();
  assert.equal((await status()).configurationPending, false, 'so a later stop does not announce a change that is not there');
});

test('a daemon started before this version counts as Paseo, and pairs as Paseo until another target is saved', async t => {
  const p = profile(t);
  await activate(); await deactivate();
  const legacy = await startLegacyDaemon(p.loc);
  let s = await status();
  assert.deepEqual([s.daemon.running, s.daemon.pid, s.activeTarget, s.selectedTarget, s.configurationPending], [true, legacy.pid, 'paseo', 'paseo', false]);
  assert.equal(supervisorEnv(legacy.pid).some(entry => entry.startsWith('HERMES_PASEO_CONNECTION_TARGET=')), false, 'it records no target');
  const offer = await pair();
  assert.equal(offer.url.startsWith('https://app.paseo.sh/#offer='), true);
  await saveConnectionSettings({ target: 'apporo' });
  s = await status();
  assert.deepEqual([s.activeTarget, s.configurationPending], ['paseo', true]);
  await assert.rejects(pair(), { code: 'CONFIGURATION_PENDING' });
  assert.deepEqual(await saveConnectionSettings({ target: 'paseo' }), { saved: true, target: 'paseo', configurationPending: false });
  assert.equal(starts(p).length, 2, 'the legacy daemon was never restarted by any of this');
});

test('relay evidence belongs to the target it was taken on, and the check dials the relay the offer names', async t => {
  const p = profile(t);
  await activate();
  const dials = () => readTrace(p.trace).filter(row => row.dial);
  assert.equal((await verifyRelay()).target, 'paseo');
  assert.deepEqual(readState().relayVerification.target, 'paseo');
  assert.deepEqual(dials().map(row => [row.dial, row.relay, row.useTls]), [['https://app.paseo.sh', 'relay.paseo.sh:443', true]]);
  assert.equal((await status()).daemon.relayVerified, true);
  // A record from before targets existed was Paseo's; it is never another target's evidence.
  updateState({ relayVerification: { verified: true, checkedAt: 'rc9' } });
  assert.equal((await status()).daemon.relayVerified, true);
  for (const row of CONNECTION_TARGETS.filter(row => row.id !== 'paseo')) {
    await saveConnectionSettings({ target: row.id });
    await deactivate();
    updateState({ relayVerification: { verified: true, checkedAt: 'rc9' } });
    assert.equal((await status()).daemon.relayVerified, false, 'rc.9 evidence is not evidence for ' + row.id);
    await activate();
    const result = await verifyRelay();
    assert.equal(result.target, row.id);
    assert.deepEqual(readState().relayVerification, { verified: true, checkedAt: result.checkedAt, target: row.id });
    assert.deepEqual(dials().at(-1), { dial: row.appUrl, relay: row.relayEndpoint, useTls: true }, `the check for ${row.id} dials ${row.relayEndpoint}`);
    assert.equal((await status()).daemon.relayVerified, true);
    await saveConnectionSettings({ target: 'paseo' });
    assert.equal((await status()).daemon.relayVerified, false, 'switching withdraws it');
  }
});

// ---- pairing (item 5) ----
const everyFile = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? everyFile(path.join(dir, entry.name)) : [path.join(dir, entry.name)]) : [];
const fragmentOf = url => new URL(url).hash.slice(7);
const offerOf = url => JSON.parse(Buffer.from(fragmentOf(url), 'base64url').toString('utf8'));

for (const target of CONNECTION_TARGETS) {
  test(`pairing on ${target.id} returns that app's link for this daemon and keeps the offer nowhere`, async t => {
    const p = profile(t);
    await activate(); await deactivate();
    await saveConnectionSettings({ target: target.id });
    await activate();
    const pairing = await pair();
    assert.deepEqual(Object.keys(pairing).sort(), ['createdAt', 'target', 'url']);
    assert.equal(pairing.target, target.id);
    const url = new URL(pairing.url);
    assert.deepEqual([url.origin, url.pathname, url.search, url.hash.startsWith('#offer=')], [target.appUrl, '/', '', true]);
    assert.deepEqual(offerOf(pairing.url), { v: 2, serverId: 'srv_fake_daemon', daemonPublicKeyB64: 'fake-public-key', relay: { endpoint: target.relayEndpoint, useTls: true } });
    assert.equal(pairCalls(p).length, 1);
    // The offer is a bearer credential: it goes to the caller and is written nowhere.
    assert.equal(fs.existsSync(path.join(p.loc.stateDir, 'pairing.private.json')), false);
    for (const file of everyFile(p.f.dir)) {
      if (file.includes(`${path.sep}bin${path.sep}`) || file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('paseo')) continue;
      assert.equal(fs.readFileSync(file, 'utf8').includes(fragmentOf(pairing.url)), false, `${path.relative(p.f.dir, file)} must not hold the offer`);
    }
    const s = await status();
    assert.equal(s.pairingAvailable, true);
    assert.equal(s.state.pairingCreatedAt, pairing.createdAt);
    assert.equal(JSON.stringify(publicStatus(s)).includes(fragmentOf(pairing.url)), false);
    await deactivate();
  });
}

test('a daemon that offers another app, another relay or a demanding security mode is never paired through', async t => {
  const p = profile(t);
  await activate();
  const relayEdit = edit => { const config = configOf(p); edit(config); fs.writeFileSync(p.config, JSON.stringify(config)); };
  // The fake daemon reads its config for each offer, so editing it is a daemon that offers something else.
  relayEdit(config => { config.daemon.relay.publicEndpoint = 'relay.woowtech.io:443'; });
  await assert.rejects(pair(), { code: 'PAIRING_TARGET_MISMATCH' });
  relayEdit(config => { config.daemon.relay.publicEndpoint = 'relay.paseo.sh:443'; config.daemon.relay.publicUseTls = false; });
  await assert.rejects(pair(), { code: 'PAIRING_TARGET_MISMATCH' });
  relayEdit(config => { config.daemon.relay.publicUseTls = true; config.app.baseUrl = 'https://smart.woowtech.io'; });
  await assert.rejects(pair(), { code: 'PAIRING_ORIGIN_INVALID' });
  relayEdit(config => { config.app.baseUrl = 'https://app.paseo.sh'; });
  assert.equal((await pair()).target, 'paseo');
  assert.equal(readState().pairingCreatedAt !== null, true);
  const before = readState().pairingCreatedAt;
  await saveConnectionSettings({ target: 'apporo' }); await deactivate(); await activate();
  process.env.FAKE_PASEO_OFFER_EXTRA = '{"minimumSecurityMode":"protected"}';
  await assert.rejects(pair(), { code: 'PAIRING_SECURITY_UNSUPPORTED' });
  delete process.env.FAKE_PASEO_OFFER_EXTRA;
  assert.equal((await pair()).target, 'apporo');
  assert.notEqual(readState().pairingCreatedAt, before);
});

test('pairing never takes the runtime lock an activation holds for minutes', async t => {
  const p = profile(t);
  await activate();
  const { withRuntimeLock } = await import('../src/state.mjs');
  let release; const blocked = new Promise(resolve => { release = resolve; });
  let entered; const held = new Promise(resolve => { entered = resolve; });
  const operation = withRuntimeLock(async () => { entered(); await blocked; });
  await held;
  const started = Date.now();
  assert.equal((await pair()).target, 'paseo');
  assert.ok(Date.now() - started < 5000, 'rc.9 paired without the lock; so does this');
  release(); await operation;
});

test('an offer left in pairing.private.json by an older release is removed at the next start, and only a regular file', async t => {
  const p = profile(t);
  fs.mkdirSync(p.loc.stateDir, { recursive: true });
  const leftover = path.join(p.loc.stateDir, 'pairing.private.json');
  fs.writeFileSync(leftover, '{"url":"https://app.paseo.sh/#offer=OLD-BEARER-CREDENTIAL","createdAt":"x"}');
  await activate();
  assert.equal(fs.existsSync(leftover), false);
  await deactivate();
  // A link of that name is not ours to follow or remove.
  const elsewhere = path.join(p.f.dir, 'elsewhere.json');
  fs.writeFileSync(elsewhere, 'precious');
  fs.symlinkSync(elsewhere, leftover);
  await activate();
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'precious');
  assert.equal(fs.lstatSync(leftover).isSymbolicLink(), true);
  await deactivate();
});
