// `prepare`: install and verify the new runtime beside whatever daemon runs, never start or stop one.
// npm is a stand-in (release-fixtures.mjs fakeNpm); the 0.17.4 config loader is the real upstream code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { locations, readState, withRuntimeLock, processIdentity } from '../src/state.mjs';
import { prepare, status } from '../src/runtime.mjs';
import { validateInput, publicStatus } from '../src/control.mjs';
import { PRIOR_RELEASES, runtimeDirectory, runtimeReady } from '../src/runtime-layout.mjs';
import { fixture, fakeNpm, fakeSupervisor, handled, lifecycleModules, ownedHome, seedCurrentRelease, seedPriorRelease } from './release-fixtures.mjs';

const R2 = PRIOR_RELEASES.find(row => row.generation === 'r2').revision;
const configFile = loc => path.join(loc.paseoHome, 'config.json');
const COMPATIBLE = { version: 1 };
// A key Paseo 0.17.4's strict schema does not know: the rc.9 config cannot be loaded.
const INCOMPATIBLE = { version: 1, daemon: { name: 'injected' } };
const olderDaemon = async (f, loc) => {
  seedPriorRelease(loc, { modules: lifecycleModules('prior', { version: '0.11.2' }) });
  return fakeSupervisor(f, loc.paseoHome, { HERMES_PASEO_RUNTIME_REVISION: R2 });
};

test('prepare installs the new runtime beside a running rc.9 daemon without touching it or its config', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f, { tree: { persistedConfig: true, modules: lifecycleModules('current') } });
  const loc = ownedHome();
  const { child } = await olderDaemon(f, loc);
  fs.writeFileSync(configFile(loc), JSON.stringify(COMPATIBLE));
  const before = fs.readFileSync(configFile(loc), 'utf8');
  assert.equal((await status()).installed, false);
  const result = await prepare();
  assert.equal(result.installed, true);
  assert.equal(runtimeReady(loc), true);
  assert.equal(npm.calls().length, 1);
  assert.equal(result.daemon.running, true);
  assert.equal(result.daemon.version, '0.11.2', 'still the old daemon, still served by its own release');
  assert.equal(result.diagnosticCode, 'RESTART_REQUIRED');
  assert.equal(result.configCheck.ok, true);
  assert.equal(readState().upgradeCheck.ok, true);
  assert.equal(handled(loc, 'cli-calls'), '', 'no daemon start, pairing or reload');
  assert.equal(handled(loc, 'stopped-by'), '');
  assert.doesNotMatch(handled(loc, 'client-by') + handled(loc, 'read-by'), /current/);
  assert.ok(processIdentity(child.pid), 'the old daemon keeps running');
  assert.equal(fs.readFileSync(configFile(loc), 'utf8'), before, 'config.json is read, never rewritten');
  assert.equal(readState().desiredEnabled, true);
  assert.equal(readState().phase, 'running', 'preparing is not a start: the recorded phase is untouched');
});

test('preparing again does nothing: no npm, and no runtime lock while there is nothing to install', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f, { tree: { persistedConfig: true } });
  const loc = ownedHome();
  await olderDaemon(f, loc);
  await prepare();
  assert.equal(npm.calls().length, 1);
  // Another operation holds the lock (a start, say): an installed release must not wait for it.
  const outcome = await withRuntimeLock(() => Promise.race([prepare().then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('blocked'), 4000))]));
  assert.equal(outcome, 'done');
  assert.equal(npm.calls().length, 1);
  // The lock is held only while installing: it is free again afterwards.
  await withRuntimeLock(async () => {}, { timeoutMs: 2000 });
});

test('two prepares at once install once', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f, { tree: { persistedConfig: true } });
  ownedHome();
  const [first, second] = await Promise.all([prepare(), prepare()]);
  assert.equal(first.installed && second.installed, true);
  assert.equal(npm.calls().length, 1);
});

test('a config the new release cannot load is reported by the result, not thrown, and is never rewritten', async t => {
  const f = fixture(); t.after(() => f.close());
  fakeNpm(f, { tree: { persistedConfig: true, modules: lifecycleModules('current') } });
  const loc = ownedHome();
  const { child } = await olderDaemon(f, loc);
  fs.writeFileSync(configFile(loc), JSON.stringify(INCOMPATIBLE));
  const result = await prepare();
  assert.equal(result.installed, true);
  assert.equal(result.configCheck.ok, false);
  assert.equal(result.configCheck.code, 'CONFIG_INCOMPATIBLE');
  assert.equal(result.diagnosticCode, 'CONFIG_INCOMPATIBLE');
  assert.equal(result.daemon.running, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile(loc), 'utf8')), INCOMPATIBLE);
  assert.equal(handled(loc, 'stopped-by'), '');
  assert.ok(processIdentity(child.pid));
  // Corrupt JSON is a result too.
  fs.writeFileSync(configFile(loc), '{"version":1,');
  assert.equal((await prepare()).configCheck.code, 'CONFIG_CORRUPT');
});

test('prepare on a fresh installation only installs: no Paseo home, no daemon, no recorded start', async t => {
  const f = fixture(); t.after(() => f.close());
  fakeNpm(f, { tree: { persistedConfig: true } });
  const loc = locations();
  const result = await prepare();
  assert.equal(result.installed, true);
  assert.equal(result.daemon.running, false);
  assert.equal(result.enabled, false);
  assert.equal(fs.existsSync(loc.paseoHome), false);
  assert.equal(readState().desiredEnabled, undefined);
  assert.equal(result.configCheck.ok, true, 'no config.json is a valid starting point');
});

test('prepare is a control action with no input, answering with the public status', async t => {
  assert.deepEqual(validateInput('prepare', {}), {});
  for (const input of [{ target: 'paseo' }, { force: true }, { provider: 'hermes' }, []]) assert.throws(() => validateInput('prepare', input), { code: 'INVALID_REQUEST' });
  const f = fixture(); t.after(() => f.close());
  fakeNpm(f, { tree: { persistedConfig: true } });
  const shown = publicStatus(await prepare());
  assert.equal(shown.installed, true);
  assert.deepEqual(Object.keys(shown.configCheck), ['ok', 'code', 'checkedAt']);
  assert.ok(!('state' in shown));
});

test('bin/control.mjs prepare: exit 0 with the status when ready, the failing code and exit 1 otherwise', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f, { tree: { persistedConfig: true } });
  const run = () => spawnSync(process.execPath, ['bin/control.mjs', 'prepare'], { cwd: new URL('..', import.meta.url), input: '{}', encoding: 'utf8', timeout: 60000, env: process.env });
  npm.mode('fail');
  const failed = run();
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).ok, false);
  assert.match(JSON.parse(failed.stdout).code, /^[A-Z][A-Z0-9_]+$/);
  assert.equal(runtimeReady(locations()), false);
  npm.mode('ok');
  const done = run();
  assert.equal(done.status, 0, done.stdout);
  const shown = JSON.parse(done.stdout);
  assert.equal(shown.installed, true);
  assert.equal(shown.daemon.running, false);
  assert.equal(fs.existsSync(runtimeDirectory(locations())), true);
  const again = run();
  assert.equal(again.status, 0);
  assert.equal(npm.calls().length, 2, 'the successful run installed once; the third run found it ready');
});

test('prepare refuses a runtime directory it does not own', async t => {
  const f = fixture(); t.after(() => f.close());
  fakeNpm(f, { tree: { persistedConfig: true } });
  const root = runtimeDirectory(locations());
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'somebody-elses-project' }));
  await assert.rejects(prepare(), { code: 'RUNTIME_NOT_OWNED' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name, 'somebody-elses-project');
});

test('an installed release needs no npm even when npm is missing', async t => {
  const f = fixture(); t.after(() => f.close());
  seedCurrentRelease(locations(), { persistedConfig: true });
  // A PATH with the lock helper and nothing else: no npm anywhere.
  const bin = path.join(f.dir, 'no-npm-bin'); fs.mkdirSync(bin);
  fs.symlinkSync(spawnSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).stdout.trim(), path.join(bin, 'flock'));
  const saved = process.env.PATH; process.env.PATH = bin; t.after(() => { process.env.PATH = saved; });
  assert.equal((await prepare()).installed, true);
  fs.rmSync(runtimeDirectory(locations()), { recursive: true });
  await assert.rejects(prepare(), { code: 'NPM_UNAVAILABLE' });
});
