import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONNECTION_TARGETS } from '../src/connection-targets.mjs';
import { BRAND_SERVER_PATH, BRAND_HELPER_NAME, ORIGINAL_BRAND_SERVER_SHA256, PATCHED_BRAND_SERVER_SHA256, brandIdentityPatchReady } from '../src/brand-identity-patch.mjs';
import { CONFIG_BACKUP_NAME } from '../src/config-backup.mjs';
import { runtimeDirectory, runtimeReady } from '../src/runtime-layout.mjs';
import { locations, readState, updateState } from '../src/state.mjs';
import { activate, deactivate, status, pair, verifyRelay, saveConnectionSettings, inheritedEnv } from '../src/runtime.mjs';
import { publicStatus } from '../src/control.mjs';
import { fixture } from './runtime-fixtures.mjs';
import { seedFakeRuntime, installingNpm, startLegacyDaemon, trapNpm, readTrace, stopFakeDaemons, sha256, treeDigest } from './fake-runtime.mjs';

// A profile with the stand-in runtime installed the way rc.9 left it (ready, not patched) and npm as a trap.
function profile(t, options = {}) {
  const f = fixture();
  const marker = trapNpm(f.dir), trace = path.join(f.dir, 'trace.log'), loc = locations();
  const root = seedFakeRuntime(loc, { trace, ...options });
  t.after(() => { stopFakeDaemons(loc); f.close(); });
  return { f, loc, root, marker, trace, server: path.join(root, BRAND_SERVER_PATH), config: path.join(loc.paseoHome, 'config.json') };
}
// A profile with no runtime at all and an npm that installs the stand-in one, recording every call.
function installing(t, { editedServer = false } = {}) {
  const f = fixture(), trace = path.join(f.dir, 'trace.log'), loc = locations();
  const marker = installingNpm(f.dir, trace), root = runtimeDirectory(loc);
  process.env.FAKE_PASEO_SERVER_FILE = path.join(root, BRAND_SERVER_PATH);
  if (editedServer) process.env.FAKE_NPM_EDITED_SERVER = '1';
  t.after(() => { stopFakeDaemons(loc); f.close(); });
  return { f, loc, root, marker, trace, server: path.join(root, BRAND_SERVER_PATH), config: path.join(loc.paseoHome, 'config.json') };
}
const configOf = p => JSON.parse(fs.readFileSync(p.config, 'utf8'));
const configBytes = p => fs.readFileSync(p.config);
const editConfig = (p, change) => { const config = configOf(p); change(config); fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n'); };
const serverSha = p => sha256(fs.readFileSync(p.server));
const helperPath = p => path.join(path.dirname(p.server), BRAND_HELPER_NAME);
const backupPath = p => path.join(p.loc.paseoHome, CONFIG_BACKUP_NAME);
const connectionPath = p => path.join(p.loc.stateDir, 'connection.json');
const supervisorEnv = pid => fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
const starts = p => readTrace(p.trace).filter(row => row.supervisor);
const npmRuns = p => fs.existsSync(p.marker) ? fs.readFileSync(p.marker, 'utf8').trim().split('\n').filter(Boolean).length : 0;
const RELAY_KEYS = ['enabled', 'endpoint', 'publicEndpoint', 'useTls', 'publicUseTls'];
const SMART = CONNECTION_TARGETS.filter(row => row.id !== 'paseo');

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

// ---- legacy mode: nobody saved a target, so an update from rc.9 changes nothing ----

test('before a target is saved a start is rc.9\'s: no relay, app or CORS setting, no brand, no patch, no backup', async t => {
  const p = profile(t);
  const runtimeBefore = treeDigest(p.root);
  const result = await activate();
  assert.equal(result.phase, 'running');
  assert.deepEqual([result.selectedTarget, result.targetSaved, result.activeTarget, result.configurationPending, result.connectionCode], ['paseo', false, 'paseo', false, null]);
  const config = configOf(p);
  assert.deepEqual(config.daemon.relay, { enabled: true }, 'the relay is whatever the operator or Paseo\'s defaults say');
  assert.equal(config.app, undefined, 'app.baseUrl is not written');
  assert.equal(config.daemon.cors, undefined, 'CORS is not written');
  const [started] = starts(p);
  assert.equal(started.target, null, 'the daemon environment names no target');
  assert.equal(supervisorEnv(started.supervisor).some(entry => entry.startsWith('HERMES_PASEO_CONNECTION_TARGET=')), false);
  assert.equal(started.serverSha256, ORIGINAL_BRAND_SERVER_SHA256, 'the daemon started from the server as published');
  assert.deepEqual(treeDigest(p.root), runtimeBefore, 'not one byte of the runtime directory changed');
  assert.equal(fs.existsSync(helperPath(p)), false);
  assert.equal(fs.existsSync(backupPath(p)), false);
  assert.equal(fs.existsSync(connectionPath(p)), false, 'starting never records a choice');
  assert.equal(readState().configBackup, undefined);
  assert.equal(readState().activeTarget, undefined);
  assert.equal(readState().configurationPending, undefined);
  assert.equal(fs.existsSync(p.marker), false, 'npm never ran');
});

test('a restart in legacy mode leaves config.json and the runtime directory byte-identical', async t => {
  const p = profile(t);
  await activate(); await deactivate();
  // The operator's own relay, app and CORS settings: legacy mode keeps them and writes none of its own.
  editConfig(p, config => {
    config.daemon.relay.endpoint = 'relay.mine.example:443'; config.daemon.relay.useTls = true;
    config.daemon.cors = { allowedOrigins: ['https://mine.example', 'https://smart.apporo.ai'] };
    config.app = { baseUrl: 'https://app.mine.example' };
  });
  await activate(); await deactivate();
  const [config, runtime, server] = [configBytes(p), treeDigest(p.root), serverSha(p)];
  for (let round = 0; round < 3; round++) {
    const result = await activate();
    assert.equal(result.phase, 'running');
    await deactivate();
    assert.ok(configBytes(p).equals(config), `config.json is the same after restart ${round + 1}`);
    assert.deepEqual(treeDigest(p.root), runtime, `the runtime directory is the same after restart ${round + 1}`);
  }
  assert.equal(serverSha(p), server);
  assert.deepEqual(configOf(p).daemon.cors, { allowedOrigins: ['https://mine.example', 'https://smart.apporo.ai'] }, 'the operator\'s origins, a Smart app among them, stay as they were');
  assert.equal(configOf(p).app.baseUrl, 'https://app.mine.example');
  assert.equal(fs.existsSync(backupPath(p)), false);
  assert.equal(fs.existsSync(connectionPath(p)), false);
  assert.equal(fs.existsSync(p.marker), false);
});

test('a daemon rc.9 left running is left alone, and stays so across restarts until a target is saved', async t => {
  const p = profile(t);
  await activate(); await deactivate();
  const legacy = await startLegacyDaemon(p.loc);
  assert.equal(serverSha(p), ORIGINAL_BRAND_SERVER_SHA256);
  const config = configBytes(p), runtime = treeDigest(p.root), clientCalls = readTrace(p.trace).length;
  const result = await activate();
  assert.equal(result.phase, 'running');
  assert.equal(result.daemon.pid, legacy.pid, 'the same daemon');
  assert.equal(starts(p).length, 2, 'nothing was started again (one start by the setup activation, one legacy start)');
  assert.deepEqual(treeDigest(p.root), runtime, 'the runtime is not touched under a running daemon');
  assert.equal(fs.existsSync(p.marker), false, 'npm never ran');
  assert.ok(configBytes(p).equals(config), 'the configuration is what rc.9 wrote');
  assert.ok(readTrace(p.trace).slice(clientCalls).some(row => row.rpc === 'reloadDaemonConfig'), 'rc.9\'s own path still ran: the config is written and reloaded');
  assert.equal(readState().lastError, null);
  // A restart in legacy mode applies nothing new either.
  await deactivate();
  const again = await activate();
  assert.equal(again.phase, 'running');
  assert.notEqual(again.daemon.pid, legacy.pid);
  assert.deepEqual(treeDigest(p.root), runtime);
  assert.ok(configBytes(p).equals(config));
  assert.equal(starts(p).at(-1).target, null);
  // Only a saved target is applied at a restart, and for a Smart target the runtime is patched in place right before it.
  await deactivate();
  await saveConnectionSettings({ target: 'apporo' });
  assert.equal(serverSha(p), ORIGINAL_BRAND_SERVER_SHA256, 'saving patches nothing');
  const switched = await activate();
  assert.equal(switched.phase, 'running');
  assert.equal(serverSha(p), PATCHED_BRAND_SERVER_SHA256);
  assert.deepEqual(configOf(p).daemon.relay, { enabled: true, endpoint: 'relay.apporo.ai:443', publicEndpoint: 'relay.apporo.ai:443', useTls: true, publicUseTls: true });
  assert.equal(starts(p).at(-1).serverSha256, PATCHED_BRAND_SERVER_SHA256);
  assert.equal(fs.existsSync(p.marker), false, 'still no npm');
});

for (const mode of ['legacy', 'saved Paseo']) {
  test(`an edited websocket-server.js never stops the default Paseo (${mode})`, async t => {
    const p = profile(t);
    fs.appendFileSync(p.server, '\n// local edit\n');
    const edited = fs.readFileSync(p.server);
    if (mode === 'saved Paseo') await saveConnectionSettings({ target: 'paseo' });
    const result = await activate();
    assert.equal(result.phase, 'running');
    assert.equal(result.activeTarget, 'paseo');
    assert.ok(fs.readFileSync(p.server).equals(edited), 'the file is as the operator left it');
    assert.equal(fs.existsSync(helperPath(p)), false, 'no helper was written for a patch that is not needed');
    assert.equal(starts(p).length, 1);
    assert.equal(fs.existsSync(p.marker), false);
    await deactivate();
    const again = await activate();
    assert.equal(again.phase, 'running', 'and it keeps starting');
    assert.ok(fs.readFileSync(p.server).equals(edited));
  });

  test(`an unreadable websocket-server.js never stops the default Paseo (${mode})`, { skip: process.getuid?.() === 0 && 'root reads every file' }, async t => {
    const p = profile(t);
    if (mode === 'saved Paseo') await saveConnectionSettings({ target: 'paseo' });
    fs.chmodSync(p.server, 0);
    try {
      const result = await activate();
      assert.equal(result.phase, 'running');
      assert.equal(fs.statSync(p.server).mode & 0o777, 0, 'the file was not touched');
      assert.equal(fs.existsSync(helperPath(p)), false);
    } finally { fs.chmodSync(p.server, 0o644); }
  });
}

test('a runtime that is already patched is left alone by a start for Paseo', async t => {
  const p = profile(t, { patched: true });
  assert.equal(serverSha(p), PATCHED_BRAND_SERVER_SHA256);
  const runtime = treeDigest(p.root);
  await saveConnectionSettings({ target: 'paseo' });
  const result = await activate();
  assert.equal(result.phase, 'running');
  assert.deepEqual(treeDigest(p.root), runtime, 'neither unpatched nor patched again');
  assert.equal(starts(p).at(-1).target, 'paseo');
  assert.equal(starts(p).at(-1).serverSha256, PATCHED_BRAND_SERVER_SHA256);
  assert.equal(brandIdentityPatchReady(p.root), true);
});

for (const target of SMART) {
  test(`a start for ${target.id} refuses a runtime whose server it does not recognise, and leaves it as it found it`, async t => {
    const p = profile(t);
    fs.appendFileSync(p.server, '\n// local edit\n');
    const edited = fs.readFileSync(p.server);
    await saveConnectionSettings({ target: target.id });
    await assert.rejects(activate(), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' });
    assert.ok(fs.readFileSync(p.server).equals(edited));
    assert.equal(fs.existsSync(helperPath(p)), false);
    assert.equal(starts(p).length, 0, 'no daemon was started');
    assert.equal(fs.existsSync(p.marker), false);
    const s = await status();
    assert.deepEqual([s.phase, s.diagnosticCode === null, s.state.lastError.code], ['error', true, 'BRAND_IDENTITY_SOURCE_MISMATCH']);
    // The way out is Paseo, which needs no patch: the same runtime starts for it.
    await saveConnectionSettings({ target: 'paseo' });
    assert.equal((await activate()).phase, 'running');
  });
}

// ---- managed mode: an explicit save switches the plugin's own settings on ----

for (const target of CONNECTION_TARGETS) {
  test(`a start for a saved ${target.id} applies its config and its brand, patches only where the app needs it, and never runs npm`, async t => {
    const p = profile(t);
    // A first start in legacy mode, then the operator's own settings and a stale relay, as an installed profile has.
    await activate(); await deactivate();
    editConfig(p, config => {
      config.daemon.cors = { allowedOrigins: ['https://keep.example', 'https://smart.apporo.ai'] };
      config.daemon.relay.endpoint = 'relay.stale.example:443';
      config.app = { baseUrl: 'https://app.stale.example' };
    });
    const operator = configBytes(p);
    assert.equal((await saveConnectionSettings({ target: target.id })).saved, true);
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
    // The daemon came up with this target in its environment.
    const started = starts(p).at(-1);
    assert.equal(started.target, target.id);
    assert.equal(supervisorEnv(started.supervisor).includes(`HERMES_PASEO_CONNECTION_TARGET=${target.id}`), true);
    // Only the Smart apps need the brand, so only they get a patched runtime.
    const smart = target.id !== 'paseo';
    assert.equal(started.serverSha256, smart ? PATCHED_BRAND_SERVER_SHA256 : ORIGINAL_BRAND_SERVER_SHA256);
    assert.equal(brandIdentityPatchReady(p.root), smart);
    assert.equal(fs.existsSync(helperPath(p)), smart);
    assert.equal(fs.existsSync(p.marker), false, 'a patch is not a reason to install the runtime again');
    assert.equal(readState().activeTarget, target.id);
    assert.notEqual(readState().configurationPending, true);
    // The operator's file before the first rewrite was kept.
    assert.ok(fs.readFileSync(backupPath(p)).equals(operator));
    await deactivate();
  });
}

test('saving Paseo explicitly ends legacy mode: its settings are written at the next start, the runtime is not patched', async t => {
  const p = profile(t);
  await activate(); await deactivate();
  assert.deepEqual(configOf(p).daemon.relay, { enabled: true });
  assert.deepEqual(await saveConnectionSettings({ target: 'paseo' }), { saved: true, target: 'paseo', configurationPending: false });
  let s = await status();
  assert.deepEqual([s.targetSaved, s.selectedTarget, s.configurationPending], [true, 'paseo', false]);
  assert.deepEqual(configOf(p).daemon.relay, { enabled: true }, 'saving writes no daemon setting');
  const result = await activate();
  assert.deepEqual([result.phase, result.activeTarget], ['running', 'paseo']);
  assert.deepEqual(configOf(p).app, { baseUrl: 'https://app.paseo.sh' });
  assert.deepEqual(configOf(p).daemon.relay, { enabled: true, endpoint: 'relay.paseo.sh:443', publicEndpoint: 'relay.paseo.sh:443', useTls: true, publicUseTls: true });
  assert.deepEqual(configOf(p).daemon.cors, { allowedOrigins: ['https://app.paseo.sh'] });
  assert.equal(serverSha(p), ORIGINAL_BRAND_SERVER_SHA256, 'Paseo needs no brand');
  assert.equal(fs.existsSync(helperPath(p)), false);
  assert.equal(starts(p).at(-1).target, 'paseo');
  assert.equal(starts(p).at(-1).serverSha256, ORIGINAL_BRAND_SERVER_SHA256);
  assert.equal(fs.existsSync(backupPath(p)), true);
  assert.equal(fs.existsSync(p.marker), false);
});

test('saving Paseo while rc.9\'s daemon runs changes nothing until it is restarted', async t => {
  const p = profile(t);
  await activate(); await deactivate();
  const legacy = await startLegacyDaemon(p.loc);
  const config = configBytes(p);
  assert.deepEqual(await saveConnectionSettings({ target: 'paseo' }), { saved: true, target: 'paseo', configurationPending: false });
  let s = await status();
  assert.deepEqual([s.targetSaved, s.activeTarget, s.configurationPending, s.daemon.pid], [true, 'paseo', false, legacy.pid]);
  assert.ok(configBytes(p).equals(config));
  assert.equal(starts(p).length, 2);
  // The running daemon cannot reload relay settings, so activating it writes none of the saved target's.
  s = await activate();
  assert.equal(s.daemon.pid, legacy.pid);
  assert.deepEqual(configOf(p).daemon.relay, { enabled: true });
  assert.equal(fs.existsSync(backupPath(p)), false, 'nothing was rewritten for a saved target yet');
  await deactivate();
  s = await activate();
  assert.equal(s.phase, 'running');
  assert.deepEqual(configOf(p).app, { baseUrl: 'https://app.paseo.sh' });
  assert.equal(starts(p).at(-1).target, 'paseo');
  assert.equal(fs.existsSync(backupPath(p)), true);
});

// ---- the one-time backup of the operator's config.json ----

test('the first managed rewrite keeps the operator\'s config.json once, as a private regular file, and never again', async t => {
  const p = profile(t);
  await activate(); await deactivate();
  assert.equal(fs.existsSync(backupPath(p)), false, 'legacy starts keep nothing');
  editConfig(p, config => { config.daemon.relay.endpoint = 'relay.mine.example:443'; });
  const original = configBytes(p);
  await saveConnectionSettings({ target: 'apporo' });
  assert.equal(fs.existsSync(backupPath(p)), false, 'saving writes nothing to the daemon\'s directory');
  await activate();
  assert.ok(fs.readFileSync(backupPath(p)).equals(original), 'a byte-for-byte copy of the file as it was before the first rewrite');
  const info = fs.lstatSync(backupPath(p));
  assert.deepEqual([info.isFile(), info.isSymbolicLink(), info.mode & 0o777, info.nlink], [true, false, 0o600, 1]);
  const recorded = readState().configBackup;
  assert.deepEqual([recorded.copied, typeof recorded.at], [true, 'string']);
  assert.ok(!configBytes(p).equals(original), 'the live file was rewritten');
  await deactivate();
  editConfig(p, config => { config.daemon.name = 'later edit'; });
  await saveConnectionSettings({ target: 'woowtech' });
  await activate(); await deactivate(); await activate();
  assert.ok(fs.readFileSync(backupPath(p)).equals(original), 'the first copy is kept, never replaced by a later one');
  assert.deepEqual(readState().configBackup, recorded);
  assert.deepEqual(fs.readdirSync(p.loc.paseoHome).filter(name => name.includes('pre-agent-connect')), [CONFIG_BACKUP_NAME], 'no temporary file is left behind');
});

test('an existing backup is never overwritten, whatever it holds', async t => {
  const p = profile(t);
  await activate(); await deactivate();
  fs.writeFileSync(backupPath(p), 'the operator\'s own copy', { mode: 0o640 });
  await saveConnectionSettings({ target: 'woowtech' });
  assert.equal((await activate()).phase, 'running');
  assert.equal(fs.readFileSync(backupPath(p), 'utf8'), 'the operator\'s own copy');
  assert.equal(fs.statSync(backupPath(p)).mode & 0o777, 0o640, 'not even its mode');
  assert.equal(readState().configBackup.copied, false);
});

test('a link where the backup belongs is refused, and nothing is rewritten, started or installed', async t => {
  const p = profile(t);
  await activate(); await deactivate();
  const elsewhere = path.join(p.f.dir, 'elsewhere.json');
  fs.writeFileSync(elsewhere, 'precious');
  fs.symlinkSync(elsewhere, backupPath(p));
  const config = configBytes(p), runtime = treeDigest(p.root);
  await saveConnectionSettings({ target: 'apporo' });
  await assert.rejects(activate(), { code: 'UNSAFE_SYMLINK' });
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'precious');
  assert.ok(configBytes(p).equals(config), 'config.json is untouched');
  assert.equal(starts(p).length, 1, 'no daemon was started');
  assert.deepEqual(treeDigest(p.root), runtime, 'and the runtime was not patched');
  assert.equal(readState().configBackup, undefined, 'it is tried again once the link is gone');
  fs.unlinkSync(backupPath(p));
  assert.equal((await activate()).phase, 'running');
  assert.ok(fs.readFileSync(backupPath(p)).equals(config));
});

test('a config.json that is a link is refused before the first managed rewrite', async t => {
  const p = profile(t);
  await activate(); await deactivate();
  const elsewhere = path.join(p.f.dir, 'real-config.json');
  fs.renameSync(p.config, elsewhere);
  fs.symlinkSync(elsewhere, p.config);
  const real = fs.readFileSync(elsewhere);
  await saveConnectionSettings({ target: 'apporo' });
  await assert.rejects(activate(), { code: 'UNSAFE_SYMLINK' });
  assert.ok(fs.readFileSync(elsewhere).equals(real), 'nothing was written through the link');
  assert.equal(fs.existsSync(backupPath(p)), false);
  assert.equal(starts(p).length, 1);
});

test('with no config.json there is nothing to keep, and that is not asked again', async t => {
  const p = profile(t);
  await saveConnectionSettings({ target: 'paseo' });
  assert.equal(fs.existsSync(p.config), false);
  assert.equal((await activate()).phase, 'running');
  assert.equal(fs.existsSync(backupPath(p)), false);
  const recorded = readState().configBackup;
  assert.equal(recorded.copied, false);
  await deactivate();
  assert.equal((await activate()).phase, 'running');
  assert.equal(fs.existsSync(backupPath(p)), false, 'the file written by the first start is the plugin\'s, not the operator\'s');
  assert.deepEqual(readState().configBackup, recorded);
});

// ---- installing the runtime is separate from patching it ----

test('a Smart target patches the installed runtime in place; a second start installs nothing', async t => {
  const p = installing(t);
  await saveConnectionSettings({ target: 'woowtech' });
  const result = await activate();
  assert.equal(result.phase, 'running');
  assert.equal(npmRuns(p), 1, 'the runtime was installed once');
  assert.equal(serverSha(p), PATCHED_BRAND_SERVER_SHA256);
  assert.equal(starts(p)[0].serverSha256, PATCHED_BRAND_SERVER_SHA256, 'the daemon started from the patched file');
  assert.equal(runtimeReady(p.loc), true);
  await deactivate();
  // Paseo leaves the patched runtime as it is; switching to the other Smart app needs nothing from npm either.
  await saveConnectionSettings({ target: 'paseo' });
  assert.equal((await activate()).phase, 'running');
  assert.equal(serverSha(p), PATCHED_BRAND_SERVER_SHA256);
  await deactivate();
  await saveConnectionSettings({ target: 'apporo' });
  assert.equal((await activate()).phase, 'running');
  assert.equal(starts(p).at(-1).target, 'apporo');
  assert.equal(npmRuns(p), 1, 'npm ci ran exactly once for all of this');
});

test('a patch that fails after the install does not make the next attempt install again', async t => {
  const p = installing(t, { editedServer: true });
  await saveConnectionSettings({ target: 'apporo' });
  await assert.rejects(activate(), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' });
  assert.equal(npmRuns(p), 1);
  assert.equal(runtimeReady(p.loc), true, 'the install itself finished: the runtime is ready');
  assert.equal(fs.existsSync(helperPath(p)), false);
  assert.equal(starts(p).length, 0);
  await assert.rejects(activate(), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' });
  assert.equal(npmRuns(p), 1, 'the second attempt did not run npm ci again');
  // Paseo needs no patch, so the very same runtime starts for it.
  await saveConnectionSettings({ target: 'paseo' });
  const result = await activate();
  assert.deepEqual([result.phase, result.activeTarget], ['running', 'paseo']);
  assert.equal(npmRuns(p), 1);
});

test('installing the runtime for the default Paseo never patches it', async t => {
  const p = installing(t);
  const result = await activate();
  assert.equal(result.phase, 'running');
  assert.equal(npmRuns(p), 1);
  assert.equal(serverSha(p), ORIGINAL_BRAND_SERVER_SHA256);
  assert.equal(fs.existsSync(helperPath(p)), false);
  assert.equal(starts(p)[0].target, null);
});

// ---- switching targets ----

const identityFiles = () => ({ 'server-id': 'srv_keep_this_one', 'daemon-keypair.json': '{"keep":"this key pair"}' });
const seedIdentity = loc => { for (const [name, content] of Object.entries(identityFiles())) fs.writeFileSync(path.join(loc.paseoHome, name), content); };
const identityIntact = loc => Object.entries(identityFiles()).every(([name, content]) => fs.readFileSync(path.join(loc.paseoHome, name), 'utf8') === content);
const pairCalls = p => readTrace(p.trace).filter(row => row.cli?.[0] === 'daemon' && row.cli?.[1] === 'pair');
const rpc = (p, name) => readTrace(p.trace).filter(row => row.rpc === name).length;

test('status names the saved target, whether one was saved, the one the daemon runs, and whether the two differ', async t => {
  const f = fixture(); t.after(() => f.close());
  let s = await status();
  assert.deepEqual([s.selectedTarget, s.targetSaved, s.activeTarget, s.configurationPending, s.connectionCode], ['paseo', false, null, false, null], 'nothing saved, nothing running: Paseo, nothing pending');
  assert.deepEqual(Object.keys(publicStatus(s)).filter(key => /target|pending|connection/i.test(key)).sort(), ['activeTarget', 'configurationPending', 'connectionCode', 'selectedTarget', 'targetSaved']);
  await saveConnectionSettings({ target: 'apporo' });
  s = await status();
  assert.deepEqual([s.selectedTarget, s.targetSaved, s.activeTarget, s.configurationPending], ['apporo', true, null, true], 'stopped: it applies at the next start');
  assert.deepEqual([publicStatus(s).selectedTarget, publicStatus(s).targetSaved, publicStatus(s).activeTarget, publicStatus(s).configurationPending], ['apporo', true, null, true]);
});

test('a damaged choice is named with its own code, and saving the target on screen repairs it', async t => {
  const p = profile(t);
  fs.mkdirSync(p.loc.stateDir, { recursive: true });
  fs.writeFileSync(connectionPath(p), '{broken');
  let s = await status();
  assert.equal(s.diagnosticCode, 'CONNECTION_STATE_CORRUPT', 'named, not read as Paseo silently');
  assert.deepEqual([s.connectionCode, s.selectedTarget, s.targetSaved], ['CONNECTION_STATE_CORRUPT', 'paseo', true]);
  assert.equal(publicStatus(s).connectionCode, 'CONNECTION_STATE_CORRUPT');
  await assert.rejects(activate(), { code: 'CONNECTION_STATE_CORRUPT' });
  assert.equal(fs.existsSync(p.marker), false, 'it stops before anything is installed or written');
  assert.equal(starts(p).length, 0);
  await assert.rejects(pair(), { code: 'CONNECTION_STATE_CORRUPT' });
  // Saving the displayed target (Paseo) replaces the record: nothing else is needed to get out. What the lost record had
  // asked for is unknown, so with no daemon running the next start is what applies the new one.
  assert.deepEqual(await saveConnectionSettings({ target: 'paseo' }), { saved: true, target: 'paseo', configurationPending: true });
  s = await status();
  assert.deepEqual([s.connectionCode, s.diagnosticCode, s.targetSaved, s.selectedTarget], [null, null, true, 'paseo']);
  assert.deepEqual(JSON.parse(fs.readFileSync(connectionPath(p), 'utf8')), { version: 1, target: 'paseo' });
  s = await activate();
  assert.deepEqual([s.phase, s.activeTarget, s.configurationPending], ['running', 'paseo', false]);
});

test('a choice that is a link is named UNSAFE_SYMLINK and is not followed, replaced or repaired through the plugin', async t => {
  const p = profile(t);
  fs.mkdirSync(p.loc.stateDir, { recursive: true });
  const elsewhere = path.join(p.f.dir, 'choice.json');
  fs.writeFileSync(elsewhere, '{"version":1,"target":"apporo"}');
  fs.symlinkSync(elsewhere, connectionPath(p));
  const s = await status();
  assert.deepEqual([s.connectionCode, s.selectedTarget], ['UNSAFE_SYMLINK', 'paseo']);
  await assert.rejects(saveConnectionSettings({ target: 'paseo' }), { code: 'UNSAFE_SYMLINK' });
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), '{"version":1,"target":"apporo"}');
  assert.equal(fs.lstatSync(connectionPath(p)).isSymbolicLink(), true);
  await assert.rejects(activate(), { code: 'UNSAFE_SYMLINK' });
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
  assert.equal(serverSha(p), ORIGINAL_BRAND_SERVER_SHA256, 'the runtime is not patched under a running daemon');
  assert.equal(identityIntact(p.loc), true);
  // Stop, start: the change is applied, and the server id and key pair survived.
  await deactivate();
  s = await status();
  assert.deepEqual([s.daemon.running, s.activeTarget, s.configurationPending], [false, null, true], 'stopped, still waiting for the start');
  s = await activate();
  assert.deepEqual([s.phase, s.selectedTarget, s.activeTarget, s.configurationPending], ['running', 'woowtech', 'woowtech', false]);
  assert.equal(starts(p).at(-1).target, 'woowtech');
  assert.equal(starts(p).at(-1).serverSha256, PATCHED_BRAND_SERVER_SHA256);
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
  assert.equal(serverSha(p), ORIGINAL_BRAND_SERVER_SHA256, 'the Smart target that was saved and withdrawn patched nothing');
});

test('a pending flag left behind by a save that raced a start does not outlive the next activation of a daemon that serves the selected target', async t => {
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
  for (const row of SMART) {
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

// ---- pairing ----
const everyFile = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? everyFile(path.join(dir, entry.name)) : [path.join(dir, entry.name)]) : [];
const fragmentOf = url => new URL(url).hash.slice(7);
const offerOf = url => JSON.parse(Buffer.from(fragmentOf(url), 'base64url').toString('utf8'));

for (const target of CONNECTION_TARGETS) {
  test(`pairing on ${target.id} returns that app's link for this daemon and keeps the offer nowhere`, async t => {
    const p = profile(t);
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
  await saveConnectionSettings({ target: 'paseo' });
  await activate();
  // The fake daemon reads its config for each offer, so editing it is a daemon that offers something else.
  editConfig(p, config => { config.daemon.relay.publicEndpoint = 'relay.woowtech.io:443'; });
  await assert.rejects(pair(), { code: 'PAIRING_TARGET_MISMATCH' });
  editConfig(p, config => { config.daemon.relay.publicEndpoint = 'relay.paseo.sh:443'; config.daemon.relay.publicUseTls = false; });
  await assert.rejects(pair(), { code: 'PAIRING_TARGET_MISMATCH' });
  editConfig(p, config => { config.daemon.relay.publicUseTls = true; config.app.baseUrl = 'https://smart.woowtech.io'; });
  await assert.rejects(pair(), { code: 'PAIRING_ORIGIN_INVALID' });
  editConfig(p, config => { config.app.baseUrl = 'https://app.paseo.sh'; });
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

test('before a target is saved pairing is rc.9\'s (this app, the relay the tenant configured); once one is saved the relay must be its own', async t => {
  const p = profile(t);
  await activate();
  editConfig(p, config => { config.daemon.relay.endpoint = 'relay.tenant.example:443'; config.daemon.relay.publicEndpoint = 'relay.tenant.example:443'; config.daemon.relay.useTls = true; config.daemon.relay.publicUseTls = true; });
  const offer = await pair();
  assert.equal(offer.target, 'paseo');
  assert.deepEqual(offerOf(offer.url).relay, { endpoint: 'relay.tenant.example:443', useTls: true }, 'the tenant\'s own relay is not second-guessed');
  assert.equal((await verifyRelay()).target, 'paseo');
  editConfig(p, config => { config.app = { baseUrl: 'https://smart.woowtech.io' }; });
  await assert.rejects(pair(), { code: 'PAIRING_ORIGIN_INVALID' }, 'the app is checked in every mode');
  editConfig(p, config => { delete config.app; });
  await saveConnectionSettings({ target: 'paseo' });
  await assert.rejects(pair(), { code: 'PAIRING_TARGET_MISMATCH' }, 'a saved target means that target\'s relay');
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

test('an offer left in pairing.private.json by an older release stays until a target is saved, then goes; only a regular file', async t => {
  const p = profile(t);
  fs.mkdirSync(p.loc.stateDir, { recursive: true });
  const leftover = path.join(p.loc.stateDir, 'pairing.private.json');
  fs.writeFileSync(leftover, '{"url":"https://app.paseo.sh/#offer=OLD-BEARER-CREDENTIAL","createdAt":"x"}');
  await activate();
  assert.equal(fs.existsSync(leftover), true, 'a legacy start deletes nothing it did not delete before');
  await deactivate();
  await saveConnectionSettings({ target: 'paseo' });
  assert.equal(fs.existsSync(leftover), false, 'saving withdraws it');
  fs.writeFileSync(leftover, '{"url":"https://app.paseo.sh/#offer=OLD-BEARER-CREDENTIAL","createdAt":"y"}');
  await activate();
  assert.equal(fs.existsSync(leftover), false, 'and so does a start in managed mode');
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
