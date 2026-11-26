// How the runtime is installed: free space first, npm's cache and the unused musl builds gone afterwards,
// and a failed or interrupted attempt leaving nothing behind. npm is a stand-in (release-fixtures.mjs
// fakeNpm); the volume and the libc are replaced through hostCapacity, so no test fills a disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locations, readState, processIdentity } from '../src/state.mjs';
import { activate, installSettings, prepare, status } from '../src/runtime.mjs';
import { hostCapacity, INSTALL_PEAK_MIB } from '../src/host-capacity.mjs';
import { PRIOR_RELEASES, RUNTIME_REVISION, discardPartialRuntime, pruneUnusedPriorReleases, removeUnusedLibcVariants, runtimeDirectory, runtimeReady } from '../src/runtime-layout.mjs';
import { fixture, fakeNpm, fakeSupervisor, lifecycleModules, ownedHome, seedPriorRelease } from './release-fixtures.mjs';

const R1 = PRIOR_RELEASES.find(row => row.generation === 'r1').revision;
const R2 = PRIOR_RELEASES.find(row => row.generation === 'r2').revision;
const SDK = 'node_modules/@anthropic-ai';
const REAL_CAPACITY = { ...hostCapacity };
// The volume and the libc as a test wants them; restored when the test ends.
function capacity(t, { available = () => 50000, glibc = () => true } = {}) {
  Object.assign(hostCapacity, { availableMiB: available, glibc });
  t.after(() => Object.assign(hostCapacity, REAL_CAPACITY));
}
const olderDaemon = async (f, loc) => {
  seedPriorRelease(loc, { modules: lifecycleModules('prior', { version: '0.11.2' }) });
  return fakeSupervisor(f, loc.paseoHome, { HERMES_PASEO_RUNTIME_REVISION: R2 });
};
const names = dir => fs.readdirSync(dir).sort();

test('a volume that cannot hold the install is refused before anything is created, and the old daemon is untouched', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f);
  const loc = ownedHome();
  const { child } = await olderDaemon(f, loc);
  capacity(t, { available: () => INSTALL_PEAK_MIB - 1 });
  await assert.rejects(prepare(), error => error.code === 'INSUFFICIENT_DISK' && error.details.requiredMiB === INSTALL_PEAK_MIB && error.details.availableMiB === INSTALL_PEAK_MIB - 1);
  assert.equal(npm.calls().length, 0, 'npm never started');
  assert.deepEqual(names(path.join(loc.runtimeDir, 'releases')), [R2], 'no directory for the new release, the old one is as it was');
  assert.ok(processIdentity(child.pid));
  const shown = await status();
  assert.equal(shown.installed, false);
  assert.equal(shown.daemon.running, true);
  assert.deepEqual({ ...shown.prepare, at: typeof shown.prepare.at }, { stage: 'failed', code: 'INSUFFICIENT_DISK', at: 'string', requiredMiB: INSTALL_PEAK_MIB, availableMiB: INSTALL_PEAK_MIB - 1 });
  assert.equal(JSON.stringify(shown.prepare).includes(f.dir), false, 'no paths in what the status carries');
  // Exactly the requirement is enough, and the failure record goes once the release is ready.
  capacity(t, { available: () => INSTALL_PEAK_MIB });
  assert.equal((await prepare()).prepare.stage, 'ready');
  assert.equal(readState().runtimeInstall, null);
  assert.equal(npm.calls().length, 1);
});

test('a volume whose free space cannot be read does not block the install', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f);
  capacity(t, { available: () => null });
  assert.equal((await prepare()).installed, true);
  assert.equal(npm.calls().length, 1);
});

test('the real volume check reads the nearest existing parent and a plausible size', () => {
  const free = REAL_CAPACITY.availableMiB(path.join(os.tmpdir(), 'hermes-paseo-no-such-directory', 'a', 'b'));
  assert.ok(Number.isInteger(free) && free >= 0, String(free));
  assert.equal(REAL_CAPACITY.availableMiB('/nonexistent-root-component/a'), REAL_CAPACITY.availableMiB('/'));
  assert.equal(typeof REAL_CAPACITY.glibc(), 'boolean');
});

test('the unused musl SDK builds are removed on glibc only, and readiness does not depend on them', async t => {
  for (const glibc of [true, false]) {
    const f = fixture(); t.after(() => f.close());
    fakeNpm(f);
    capacity(t, { glibc: () => glibc });
    const loc = locations();
    await prepare();
    const root = runtimeDirectory(loc);
    assert.deepEqual(names(path.join(root, SDK)), glibc
      ? ['claude-agent-sdk', 'claude-agent-sdk-linux-x64']
      : ['claude-agent-sdk', 'claude-agent-sdk-linux-arm64-musl', 'claude-agent-sdk-linux-x64', 'claude-agent-sdk-linux-x64-musl'], 'glibc ' + glibc);
    assert.equal(runtimeReady(loc), true);
    assert.doesNotMatch(fs.readFileSync(path.join(root, '.hermes-paseo-runtime.json'), 'utf8'), /musl|claude-agent-sdk/);
    assert.equal((await prepare()).installed, true, 'a ready release is verified again without them');
  }
});

test('only the musl builds of the Claude SDK are removed, and a link is never followed', t => {
  const f = fixture(); t.after(() => f.close());
  const root = path.join(f.dir, 'release'), scope = path.join(root, SDK), outside = path.join(f.dir, 'outside');
  for (const name of ['claude-agent-sdk-linux-x64-musl', 'claude-agent-sdk-linux-arm64-musl', 'claude-agent-sdk-linux-x64', 'other-package-musl', 'claude-agent-sdk']) {
    fs.mkdirSync(path.join(scope, name), { recursive: true });
    fs.writeFileSync(path.join(scope, name, 'file'), 'x');
  }
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'precious'), 'x');
  fs.symlinkSync(outside, path.join(scope, 'claude-agent-sdk-evil-musl'));
  fs.writeFileSync(path.join(scope, 'claude-agent-sdk-file-musl'), 'x');
  assert.deepEqual(removeUnusedLibcVariants(root, { glibc: false }), []);
  assert.equal(names(scope).length, 7, 'nothing is removed without glibc');
  assert.deepEqual(removeUnusedLibcVariants(root, { glibc: true }).sort(), ['claude-agent-sdk-linux-arm64-musl', 'claude-agent-sdk-linux-x64-musl']);
  assert.deepEqual(names(scope), ['claude-agent-sdk', 'claude-agent-sdk-evil-musl', 'claude-agent-sdk-file-musl', 'claude-agent-sdk-linux-x64', 'other-package-musl']);
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'x');
  assert.deepEqual(removeUnusedLibcVariants(path.join(f.dir, 'no-such-release'), { glibc: true }), []);
});

test('npm caches inside the release being installed, and the cache is gone afterwards, success or failure', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f);
  const loc = locations(), root = runtimeDirectory(loc), cache = path.join(root, '.npm-cache');
  npm.mode('fail');
  await assert.rejects(prepare(), { code: 'RUNTIME_INSTALL_FAILED' });
  assert.equal(fs.existsSync(cache), false);
  npm.mode('ok');
  await prepare();
  const [failed, installed] = npm.calls();
  for (const call of [failed, installed]) {
    assert.equal(call.defaultCache, false, 'an explicit cache, never the persistent HOME');
    assert.equal(call.cache, cache);
    assert.deepEqual(call.argv.slice(0, 2), ['ci', '--prefix']);
    assert.ok(call.argv.includes('--omit=dev') && call.argv.includes('--no-audit') && call.argv.includes('--no-fund'));
  }
  assert.equal(fs.existsSync(cache), false, 'removed after the install, before the release counts as ready');
  assert.equal(fs.existsSync(path.join(loc.home, '.npm')), false, 'nothing in the persistent HOME');
  assert.equal(runtimeReady(loc), true);
});

test('a failed install leaves nothing that looks ready, and the next attempt starts from nothing', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f);
  const loc = locations(), root = runtimeDirectory(loc);
  npm.mode('fail');
  await assert.rejects(prepare(), { code: 'RUNTIME_INSTALL_FAILED' });
  assert.equal(fs.existsSync(root), false, 'the partial tree is removed at once, not kept on the volume');
  assert.equal(runtimeReady(loc), false);
  let shown = await status();
  assert.equal(shown.installed, false);
  assert.deepEqual([shown.prepare.stage, shown.prepare.code], ['failed', 'RUNTIME_INSTALL_FAILED']);
  assert.equal(shown.phase, 'not_installed', 'preparing is not a start: no error phase');
  // A process killed mid-install leaves a tree with this plugin's manifest and no receipt.
  fs.mkdirSync(path.join(root, 'node_modules/leftover'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'hermes-paseo-managed-runtime' }));
  fs.writeFileSync(path.join(root, 'node_modules/leftover/file'), 'x');
  npm.mode('ok');
  const done = await prepare();
  assert.equal(npm.calls().at(-1).existedBefore, false, 'npm saw no node_modules from the earlier attempt');
  assert.equal(fs.existsSync(path.join(root, 'node_modules/leftover')), false);
  assert.equal(done.prepare.stage, 'ready');
  assert.equal(readState().runtimeInstall, null);
});

test('an install that ran out of space is reported as such, with the numbers, and cleaned up', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f);
  let reads = 0;
  capacity(t, { available: () => ++reads === 1 ? 50000 : 10 });
  npm.mode('fail');
  await assert.rejects(prepare(), error => error.code === 'INSUFFICIENT_DISK' && error.details.availableMiB === 10 && error.details.requiredMiB === INSTALL_PEAK_MIB);
  assert.equal(fs.existsSync(runtimeDirectory(locations())), false);
  assert.equal((await status()).prepare.availableMiB, 10);
});

test('an install that takes too long is stopped, reported as a timeout and removed', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f);
  const saved = installSettings.npmTimeoutMs; installSettings.npmTimeoutMs = 400; t.after(() => { installSettings.npmTimeoutMs = saved; });
  npm.mode('hang');
  await assert.rejects(prepare(), { code: 'RUNTIME_INSTALL_TIMEOUT' });
  assert.equal(fs.existsSync(runtimeDirectory(locations())), false);
  assert.equal((await status()).prepare.code, 'RUNTIME_INSTALL_TIMEOUT');
  // The same failure through a start: the code and phase say so, and the next prepare is unaffected.
  npm.mode('ok'); installSettings.npmTimeoutMs = saved;
  assert.equal((await prepare()).installed, true);
});

test('starting reports a failed install the same way and keeps the failure for the status', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f);
  npm.mode('fail');
  await assert.rejects(activate(), { code: 'RUNTIME_INSTALL_FAILED' });
  assert.equal(readState().lastError.code, 'RUNTIME_INSTALL_FAILED');
  assert.equal(readState().runtimeInstall.code, 'RUNTIME_INSTALL_FAILED');
  assert.equal(fs.existsSync(runtimeDirectory(locations())), false);
});

test('a release directory a running daemon claims is never reinstalled over, even without its receipt', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f);
  const loc = ownedHome(), root = runtimeDirectory(loc);
  fs.mkdirSync(path.join(root, 'node_modules/live'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'hermes-paseo-managed-runtime' }));
  fs.writeFileSync(path.join(root, 'node_modules/live/file'), 'x');
  const { child } = await fakeSupervisor(f, loc.paseoHome, { HERMES_PASEO_RUNTIME_REVISION: RUNTIME_REVISION });
  await assert.rejects(prepare(), { code: 'RUNTIME_IN_USE' });
  assert.equal(npm.calls().length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'node_modules/live/file'), 'utf8'), 'x');
  assert.ok(processIdentity(child.pid));
});

test('only an empty directory or this plugin\'s own manifest may be discarded as a partial install', t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations(), root = runtimeDirectory(loc);
  assert.equal(discardPartialRuntime(loc), false, 'nothing there');
  fs.mkdirSync(root, { recursive: true });
  assert.equal(discardPartialRuntime(loc), true, 'an empty directory');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'notes.txt'), 'somebody else\'s');
  assert.throws(() => discardPartialRuntime(loc), { code: 'RUNTIME_NOT_OWNED' });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'another-project' }));
  assert.throws(() => discardPartialRuntime(loc), { code: 'RUNTIME_NOT_OWNED' });
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'somebody else\'s');
  fs.rmSync(root, { recursive: true });
  const elsewhere = path.join(f.dir, 'elsewhere'); fs.mkdirSync(elsewhere); fs.writeFileSync(path.join(elsewhere, 'keep'), 'x');
  fs.symlinkSync(elsewhere, root);
  assert.throws(() => discardPartialRuntime(loc), error => ['UNSAFE_SYMLINK', 'RUNTIME_NOT_OWNED'].includes(error.code));
  assert.equal(fs.readFileSync(path.join(elsewhere, 'keep'), 'utf8'), 'x');
});

