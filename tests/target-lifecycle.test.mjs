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
