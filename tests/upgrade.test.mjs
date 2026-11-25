// The rc.9 -> 0.2.0 upgrade: a 0.11.2 daemon keeps being controlled by its own release until a
// stop and start; config.json is loaded by the real 0.17.4 loader before it is rewritten.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { locations, readState, updateState, processIdentity } from '../src/state.mjs';
import { activate, deactivate, status, writeDaemonConfig, checkDaemonConfig, saveConnectionSettings } from '../src/runtime.mjs';
import { RUNTIME_REVISION, PRIOR_RELEASES, pruneUnusedPriorReleases, priorRuntimeDirectory, runtimeDirectory } from '../src/runtime-layout.mjs';
import { saveSelectedTarget, CONNECTION_TARGETS } from '../src/connection-targets.mjs';
import { validateInput, publicStatus } from '../src/control.mjs';
import { fixture, lifecycleModules, seedCurrentRelease, seedPriorRelease, fakeSupervisor, providerlessPath } from './release-fixtures.mjs';

const R2 = PRIOR_RELEASES.find(row => row.generation === 'r2').revision;
const R1 = PRIOR_RELEASES.find(row => row.generation === 'r1').revision;
const PORT = 6779;
const LOOPBACK = `127.0.0.1:${PORT}`;
const CURRENT_ENV = { HERMES_PASEO_RUNTIME_REVISION: RUNTIME_REVISION, HERMES_PASEO_CONNECTION_PROFILE_VERSION: '1' };

function owned() {
  const loc = locations(), state = updateState({ desiredEnabled: true, phase: 'running' });
  fs.mkdirSync(loc.paseoHome, { recursive: true });
  fs.writeFileSync(path.join(loc.paseoHome, '.hermes-paseo-owner.json'), JSON.stringify({ installationId: state.installationId, home: loc.paseoHome }));
  return loc;
}
const handled = (loc, name) => { try { return fs.readFileSync(path.join(loc.paseoHome, name), 'utf8'); } catch { return ''; } };
const gone = async child => { for (let i = 0; i < 200 && processIdentity(child.pid); i++) await new Promise(resolve => setTimeout(resolve, 10)); return !processIdentity(child.pid); };
const realLoader = root => import(pathToFileURL(path.join(root, 'node_modules/@getpaseo/server/dist/server/server/persisted-config.js')).href);

// What 0.1.4-rc.9 wrote for its 0.11.2 daemon, plus settings a Paseo client may have added:
// 0.11.2 accepted all of it; 0.17.4's strict schema accepts it only after its own normalization.
const rc9Config = () => ({
  $schema: 'https://paseo.sh/schemas/paseo.config.v1.json', version: 1,
  daemon: { listen: LOOPBACK, hostnames: ['localhost', '127.0.0.1', '.localhost'], relay: { enabled: true }, mcp: { enabled: true },
    cors: { allowedOrigins: ['http://keep.example'] } },
  providers: { openai: { apiKey: 'fixture-not-a-key', stt: { baseUrl: 'https://stt.example' } } },
  agents: { providers: {
    hermes: { enabled: true, command: ['/old/hermes', 'acp'], env: { HERMES_HOME: '/old', HOME: '/old-home', HERMES_PASEO_ACP_CHILD: '1' }, extends: 'acp', label: 'Hermes', description: 'Hermes Agent using the current profile and official ACP' },
    claude: { enabled: false, env: { HOME: '/old-home' } }, copilot: { enabled: false }, antigravity: { enabled: false }, muse: { enabled: false } },
    metadataGeneration: { providers: [] } },
  features: { dictation: { enabled: false, stt: { language: 'zh' } }, voiceMode: { enabled: false, stt: { provider: 'local', confidenceThreshold: 0.5 } }, webUi: { enabled: true } },
  log: { console: { level: 'warn' }, file: { level: 'warn', path: 'daemon.log', rotate: { maxSize: '5m', maxFiles: 2 } } },
});
const launchers = { hermes: { startup: 'ready', command: '/usr/bin/hermes-fixture' } };

test('an rc.9 daemon is read, queried and reported through its own 0.11.2 release, before and after this release is installed', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = owned();
  seedPriorRelease(loc, { modules: lifecycleModules('prior', { version: '0.11.2' }) });
  const { child } = await fakeSupervisor(f, loc.paseoHome, { HERMES_PASEO_RUNTIME_REVISION: R2 });
  for (const installed of [false, true]) {
    if (installed) seedCurrentRelease(loc, { modules: lifecycleModules('current') });
    const s = await status();
    assert.equal(s.installed, installed);
    assert.equal(s.daemon.running, true);
    assert.equal(s.daemon.reachable, true);
    assert.equal(s.daemon.version, '0.11.2');
    assert.equal(s.diagnosticCode, 'RESTART_REQUIRED');
    assert.equal(s.activeTarget, 'paseo', 'a daemon started before targets serves Paseo');
    assert.equal(s.configurationPending, false);
    assert.doesNotMatch(handled(loc, 'read-by') + handled(loc, 'client-by'), /current/);
  }
  assert.ok(processIdentity(child.pid));
});

test('only an exact known prior revision reaches 0.11.2 modules; unrecorded, unknown and newer revisions never do', async t => {
  for (const env of [{}, { HERMES_PASEO_RUNTIME_REVISION: '0.18.0-r1-0123456789ab' }, { HERMES_PASEO_RUNTIME_REVISION: R1 }]) {
    const f = fixture(); t.after(() => f.close());
    const loc = owned();
    seedPriorRelease(loc, { modules: lifecycleModules('prior') });
    const { child } = await fakeSupervisor(f, loc.paseoHome, env);
    // Without this release there is nothing safe to read it with.
    assert.equal((await status()).daemon.running, false);
    assert.equal(handled(loc, 'read-by'), '');
    seedCurrentRelease(loc, { modules: lifecycleModules('current') });
    const s = await status();
    assert.equal(s.daemon.running, true);
    assert.equal(s.diagnosticCode, 'RESTART_REQUIRED');
    assert.match(handled(loc, 'read-by'), /current/);
    assert.doesNotMatch(handled(loc, 'read-by'), /prior/);
    assert.ok(processIdentity(child.pid));
  }
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  seedPriorRelease(loc);
  assert.equal(priorRuntimeDirectory(loc, R1), null, 'r2 is never handed out for r1');
  assert.equal(priorRuntimeDirectory(loc, 'unrecorded'), null);
  const receipt = path.join(loc.runtimeDir, 'releases', R2, '.hermes-paseo-runtime.json');
  fs.writeFileSync(receipt, JSON.stringify({ lockSha256: '0'.repeat(64), revision: R2 }));
  assert.equal(priorRuntimeDirectory(loc, R2), null, 'a release without its own receipt is not trusted');
});

test('a PID record caught mid-rewrite is read again instead of being taken for no daemon', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = owned();
  seedPriorRelease(loc, { modules: lifecycleModules('prior') });
  seedCurrentRelease(loc, { modules: lifecycleModules('current') });
  const { record } = await fakeSupervisor(f, loc.paseoHome, { HERMES_PASEO_RUNTIME_REVISION: R2 });
  const file = path.join(loc.paseoHome, 'paseo.pid');
  fs.writeFileSync(file, '');
  const writer = spawn(process.execPath, ['-e', `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(file)},${JSON.stringify(JSON.stringify(record))}),150)`], { stdio: 'ignore' });
  f.children.push(writer);
  await new Promise(resolve => setTimeout(resolve, 20));
  const s = await status();
  assert.equal(s.daemon.running, true);
  assert.equal(s.diagnosticCode, 'RESTART_REQUIRED');
  assert.match(handled(loc, 'read-by'), /prior/, 'routed by the revision once the record is readable');
});

test('activation beside a running rc.9 daemon installs nothing new on it, never starts another and checks the next config', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = owned();
  const savedPath = process.env.PATH; process.env.PATH = providerlessPath(f); t.after(() => { process.env.PATH = savedPath; });
  seedPriorRelease(loc, { modules: lifecycleModules('prior', { version: '0.11.2' }) });
  seedCurrentRelease(loc, { persistedConfig: true, modules: lifecycleModules('current') });
  fs.writeFileSync(path.join(loc.paseoHome, 'config.json'), JSON.stringify(rc9Config()));
  const { child } = await fakeSupervisor(f, loc.paseoHome, { HERMES_PASEO_RUNTIME_REVISION: R2 });
  const result = await activate();
  assert.equal(result.phase, 'restart_required');
  assert.equal(result.diagnosticCode, 'RESTART_REQUIRED');
  assert.equal(readState().upgradeCheck.ok, true);
  assert.equal(handled(loc, 'cli-calls'), '', 'no daemon start or other CLI command');
  assert.equal(handled(loc, 'stopped-by'), '');
  assert.ok(processIdentity(child.pid));
  // The check is in memory: the file rc.9 wrote is unchanged until this release's daemon starts.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(loc.paseoHome, 'config.json'), 'utf8')), rc9Config());
});

test('stopping an rc.9 daemon goes through its own release; with this release installed its config must load first', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = owned();
  seedPriorRelease(loc, { modules: lifecycleModules('prior') });
  const first = await fakeSupervisor(f, loc.paseoHome, { HERMES_PASEO_RUNTIME_REVISION: R2 });
  // Not installed yet: nothing can check the config, and the user's stop is honoured.
  assert.equal((await deactivate()).phase, 'disabled');
  assert.equal(handled(loc, 'stopped-by'), 'prior');
  assert.ok(await gone(first.child));

  fs.rmSync(path.join(loc.paseoHome, 'stopped-by'));
  const root = seedCurrentRelease(loc, { persistedConfig: true, modules: lifecycleModules('current') });
  const config = path.join(loc.paseoHome, 'config.json');
  const incompatible = { ...rc9Config(), daemon: { ...rc9Config().daemon, keepAliveSeconds: 30 } };
  fs.writeFileSync(config, JSON.stringify(incompatible));
  const second = await fakeSupervisor(f, loc.paseoHome, { HERMES_PASEO_RUNTIME_REVISION: R2 });
  await assert.rejects(deactivate(), { code: 'CONFIG_INCOMPATIBLE' });
  assert.ok(processIdentity(second.child.pid), 'the old daemon keeps serving');
  assert.equal(readState().desiredEnabled, true, 'a refused stop records no stop intent');
  assert.equal(handled(loc, 'stopped-by'), '');
  assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), incompatible, 'nothing was rewritten');
  const reported = await status();
  assert.equal(reported.diagnosticCode, 'CONFIG_INCOMPATIBLE');
  assert.equal(reported.daemon.running, true);
  await assert.rejects(checkDaemonConfig(), { code: 'CONFIG_INCOMPATIBLE' });

  // A config 0.17.4 can normalize is accepted, and the stop proceeds through the old release.
  fs.writeFileSync(config, JSON.stringify(rc9Config()));
  assert.equal((await deactivate()).phase, 'disabled');
  assert.equal(handled(loc, 'stopped-by'), 'prior');
  assert.ok(await gone(second.child));
  assert.equal(readState().upgradeCheck.ok, true);
  assert.ok(fs.existsSync(path.join(root, 'node_modules/@getpaseo/server/dist/server/server/persisted-config.js')));
});

test('the real 0.17.4 loader normalizes an rc.9 config; every target is written valid and round-trips', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = owned();
  const root = seedCurrentRelease(loc, { persistedConfig: true });
  const loader = await realLoader(root);
  const file = path.join(loc.paseoHome, 'config.json');
  assert.equal(loader.PersistedConfigSchema.safeParse(rc9Config()).success, false, 'raw rc.9 configs fail the strict 0.17.4 schema');
  for (const target of CONNECTION_TARGETS) {
    fs.writeFileSync(file, JSON.stringify({ ...rc9Config(), daemon: { ...rc9Config().daemon, relay: { enabled: true, requireProtectedSecurity: true } } }));
    saveSelectedTarget(loc, target.id);
    await writeDaemonConfig(PORT, launchers);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const written = loader.readPersistedConfig(loc.paseoHome);
    assert.equal(loader.PersistedConfigSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8'))).success, true);
    assert.equal(written.app.baseUrl, target.appUrl);
    assert.deepEqual({ ...written.daemon.relay, requireProtectedSecurity: undefined }, { enabled: true, endpoint: target.relayEndpoint, publicEndpoint: target.relayEndpoint, useTls: true, publicUseTls: true, requireProtectedSecurity: undefined });
    assert.equal(written.daemon.relay.requireProtectedSecurity, target.id === 'paseo' ? true : undefined, 'Smart targets never require protected security');
    assert.deepEqual(written.daemon.cors.allowedOrigins, ['http://keep.example', target.appUrl]);
    assert.deepEqual(written.features.dictation, { enabled: false, stt: { provider: 'local', language: 'zh' } });
    assert.deepEqual(written.features.voiceMode.stt, { provider: 'local' });
    assert.equal(written.providers?.openai, undefined);
    assert.deepEqual(written.agents.providers.hermes, { label: 'Hermes', command: ['/usr/bin/hermes-fixture', 'acp'], env: { HERMES_HOME: loc.agentDir, HOME: loc.home, HERMES_PASEO_ACP_CHILD: '1' }, enabled: true });
    assert.equal(written.daemon.listen, LOOPBACK);
    assert.equal(written.daemon.name, undefined);
    // The next activation compares against what the daemon saved: nothing to apply.
    assert.equal(await writeDaemonConfig(PORT, launchers), false);
  }
});

test('a config 0.17.4 cannot load is never rewritten, and broken JSON is reported as such', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = owned();
  seedCurrentRelease(loc, { persistedConfig: true });
  const file = path.join(loc.paseoHome, 'config.json');
  for (const [content, code] of [[JSON.stringify({ version: 1, daemon: { name: 'injected' } }), 'CONFIG_INCOMPATIBLE'],
    [JSON.stringify({ version: 1, features: { voiceMode: { stt: { provider: 'nonexistent' } } } }), 'CONFIG_INCOMPATIBLE'],
    ['{"version":1,', 'CONFIG_CORRUPT']]) {
    fs.writeFileSync(file, content);
    await assert.rejects(writeDaemonConfig(6779, launchers), { code });
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    await assert.rejects(checkDaemonConfig(), { code });
    assert.equal(readState().upgradeCheck.code, code);
  }
});

test('a target switch is pending only while the running daemon serves another target', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = owned();
  const savedPath = process.env.PATH; process.env.PATH = providerlessPath(f); t.after(() => { process.env.PATH = savedPath; });
  seedCurrentRelease(loc, { persistedConfig: true, modules: lifecycleModules('current') });
  const { child } = await fakeSupervisor(f, loc.paseoHome, { ...CURRENT_ENV, HERMES_PASEO_CONNECTION_TARGET: 'paseo' });
  let s = await status();
  assert.deepEqual([s.selectedTarget, s.activeTarget, s.configurationPending, s.diagnosticCode], ['paseo', 'paseo', false, null]);
  assert.equal((await saveConnectionSettings({ target: 'apporo' })).configurationPending, true);
  s = await status();
  assert.deepEqual([s.selectedTarget, s.activeTarget, s.configurationPending], ['apporo', 'paseo', true]);
  const result = await activate();
  assert.equal(result.phase, 'restart_required');
  assert.equal(readState().lastError.code, 'CONFIGURATION_PENDING');
  assert.equal(handled(loc, 'cli-calls'), '');
  // Choosing the running daemon's target again needs no restart.
  assert.equal((await saveConnectionSettings({ target: 'paseo' })).configurationPending, false);
  s = await status();
  assert.deepEqual([s.selectedTarget, s.activeTarget, s.configurationPending], ['paseo', 'paseo', false]);
  assert.ok(processIdentity(child.pid));
});

test('after this release starts, older releases go except the newest 0.11.2, and only exact owned ones', t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  const { root: r2 } = seedPriorRelease(loc, { generation: 'r2' });
  const { root: r1 } = seedPriorRelease(loc, { generation: 'r1' });
  const plenty = { availableMiB: () => 50000 };
  assert.deepEqual(pruneUnusedPriorReleases(loc, plenty), [R1]);
  assert.equal(fs.existsSync(r1), false);
  assert.equal(fs.existsSync(r2), true, 'kept for a rollback to 0.1.4');
  // A link or a directory without its receipt is not ours to delete.
  fs.mkdirSync(path.join(f.dir, 'elsewhere'));
  fs.symlinkSync(path.join(f.dir, 'elsewhere'), r1);
  assert.deepEqual(pruneUnusedPriorReleases(loc, plenty), []);
  assert.equal(fs.existsSync(path.join(f.dir, 'elsewhere')), true);
  fs.rmSync(r1);
  fs.mkdirSync(r1, { recursive: true });
  fs.writeFileSync(path.join(r1, 'keep'), 'x');
  assert.deepEqual(pruneUnusedPriorReleases(loc, plenty), []);
  assert.equal(fs.existsSync(path.join(r1, 'keep')), true);
  assert.equal(fs.existsSync(runtimeDirectory(loc)), false, 'this release is never touched');
});

test('a stop whose only failure is unconfirmed terminal cleanup after the supervisor exited is a warning', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = owned();
  seedCurrentRelease(loc, { modules: lifecycleModules('current', { stopError: 'TERMINAL_CLEANUP_NOT_CONFIRMED' }) });
  const { child } = await fakeSupervisor(f, loc.paseoHome, CURRENT_ENV);
  const result = await deactivate();
  assert.equal(result.phase, 'disabled');
  assert.equal(readState().stopWarning.code, 'TERMINAL_CLEANUP_NOT_CONFIRMED');
  assert.ok(await gone(child));
});

test('any other stop failure, or one that leaves the supervisor running, is still an error', async t => {
  const f = fixture(); t.after(() => f.close());
  const loc = owned();
  const modules = lifecycleModules('current');
  const instance = 'node_modules/@getpaseo/server/dist/server/server/daemon-instance.js';
  modules[instance] = modules[instance].replace('process.kill(options.instance.pid, "SIGTERM");', '').replace('return { action: "stopped" };', 'throw Object.assign(new Error("cleanup"), { code: "TERMINAL_CLEANUP_NOT_CONFIRMED" });').replace('fs.rmSync(home + "/paseo.pid", { force: true });', '');
  seedCurrentRelease(loc, { modules });
  const { child } = await fakeSupervisor(f, loc.paseoHome, CURRENT_ENV);
  await assert.rejects(deactivate(), { code: 'TERMINAL_CLEANUP_NOT_CONFIRMED' });
  assert.ok(processIdentity(child.pid));
  assert.equal(readState().stopWarning, undefined);
});

// A refused stop and the host turning the plugin off: the same incompatible config, two different intents.
async function refusedByConfig(t, config) {
  const f = fixture(); t.after(() => f.close());
  const loc = owned();
  seedPriorRelease(loc, { modules: lifecycleModules('prior') });
  seedCurrentRelease(loc, { persistedConfig: true, modules: lifecycleModules('current') });
  const file = path.join(loc.paseoHome, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const { child } = await fakeSupervisor(f, loc.paseoHome, { HERMES_PASEO_RUNTIME_REVISION: R2 });
  return { f, loc, file, child };
}

test('the host disabling or removing the plugin stops an older daemon even when its config could not load', async t => {
  const { loc, file, child } = await refusedByConfig(t, { version: 1, daemon: { keepAliveSeconds: 30 } });
  await assert.rejects(deactivate(), { code: 'CONFIG_INCOMPATIBLE' });
  assert.ok(processIdentity(child.pid), 'a user stop to move to the new release is refused');
  assert.equal(readState().desiredEnabled, true);
  const result = await deactivate({ reason: 'disable' });
  assert.equal(result.phase, 'disabled');
  assert.equal(handled(loc, 'stopped-by'), 'prior', 'still through the release that started it');
  assert.ok(await gone(child));
  assert.equal(readState().desiredEnabled, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, daemon: { keepAliveSeconds: 30 } }, 'nothing was rewritten');
});

test('only the disable reason skips the check; any other stop input is rejected before it runs', () => {
  assert.deepEqual(validateInput('stop', {}), {});
  assert.deepEqual(validateInput('stop', { reason: 'disable' }), { reason: 'disable' });
  for (const input of [{ reason: 'upgrade' }, { reason: '' }, { reason: true }, { force: true }, { reason: 'disable', extra: 1 }]) {
    assert.throws(() => validateInput('stop', input), { code: 'INVALID_REQUEST' }, JSON.stringify(input));
  }
});

test('a refused config is named by key paths only; no value reaches the state or the status', async t => {
  const marker = 'hunter2-never-shown-anywhere';
  const { loc, child } = await refusedByConfig(t, { version: 1, daemon: { keepAliveSeconds: marker, listen: 12345 },
    agents: { providers: { claude: { enabled: marker, env: { HOME: marker } } } } });
  await assert.rejects(deactivate(), { code: 'CONFIG_INCOMPATIBLE' });
  const shown = await status();
  assert.equal(shown.configCheck.ok, false);
  assert.deepEqual([...shown.configCheck.paths].sort(), ['agents.providers.claude.enabled', 'daemon.keepAliveSeconds', 'daemon.listen']);
  const everything = JSON.stringify([readState(), shown, publicStatus(shown)]);
  assert.equal(everything.includes('hunter2'), false);
  assert.deepEqual(publicStatus(shown).configCheck.paths, shown.configCheck.paths);
  assert.ok(processIdentity(child.pid));
  assert.equal(handled(loc, 'stopped-by'), '');
});

test('an error in a managed key is named too, and a key that is merely unknown is not mistaken for its parent', async t => {
  // Valid for the loader, refused once this release adds its own managed settings: the second validation names its path.
  const { loc } = await refusedByConfig(t, { version: 1 });
  seedCurrentRelease(loc, { persistedConfig: true });
  const real = await realLoader(runtimeDirectory(loc));
  assert.equal(real.PersistedConfigSchema.safeParse({ version: 1, daemon: { a: 1, b: 2 } }).success, false);
  fs.writeFileSync(path.join(loc.paseoHome, 'config.json'), JSON.stringify({ version: 1, daemon: { a: 1, b: 2 }, extra: 1 }));
  await assert.rejects(checkDaemonConfig(), { code: 'CONFIG_INCOMPATIBLE' });
  assert.deepEqual([...readState().upgradeCheck.paths].sort(), ['daemon.a', 'daemon.b', 'extra']);
});

test('fixing config.json clears the refusal without a stop, and breaking it again brings it back', async t => {
  const { loc, file, child } = await refusedByConfig(t, { version: 1, daemon: { keepAliveSeconds: 30 } });
  await assert.rejects(deactivate(), { code: 'CONFIG_INCOMPATIBLE' });
  assert.equal((await status()).diagnosticCode, 'CONFIG_INCOMPATIBLE');
  const before = readState().upgradeCheck;
  assert.equal((await status()).diagnosticCode, 'CONFIG_INCOMPATIBLE');
  assert.deepEqual(readState().upgradeCheck, before, 'looking again writes nothing while the answer is the same');
  fs.writeFileSync(file, JSON.stringify(rc9Config()));
  const fixed = await status();
  assert.equal(fixed.configCheck.ok, true);
  assert.deepEqual(fixed.configCheck.paths, []);
  assert.equal(fixed.diagnosticCode, 'RESTART_REQUIRED');
  assert.ok(processIdentity(child.pid));
  fs.writeFileSync(file, JSON.stringify({ version: 1, other: 1 }));
  await assert.rejects(deactivate(), { code: 'CONFIG_INCOMPATIBLE' });
  assert.deepEqual((await status()).configCheck.paths, ['other']);
  assert.equal(handled(loc, 'stopped-by'), '');
});
