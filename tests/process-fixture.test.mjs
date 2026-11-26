import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { locations } from '../src/state.mjs';
import { prepare } from '../src/runtime.mjs';
import { runtimeInUse } from '../src/runtime-processes.mjs';
import { discardPartialRuntime, prepareRuntimeManifest, RUNTIME_REVISION, runtimeDirectory } from '../src/runtime-layout.mjs';
import { fixture, fakeNpm } from './release-fixtures.mjs';
import { SCOPE_ENV } from './fixture-processes.mjs';

async function worker(t, options) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', ...options });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return child;
}

function denyEnvironment(t, pid) {
  const read = fs.readFileSync;
  return t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (typeof file === 'string' && file.endsWith(`/${pid}/environ`)) {
      throw Object.assign(new Error('fixture metadata is protected'), { code: 'EACCES', syscall: 'open', path: file });
    }
    return read(file, ...args);
  });
}

test('a protected same-UID process outside the fixture cannot prevent failed-install cleanup and retry', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f), loc = locations(), root = runtimeDirectory(loc);
  const child = await worker(t, { env: { ...process.env, [SCOPE_ENV]: path.join(f.dir, 'another-fixture') } });
  denyEnvironment(t, child.pid);
  // The unchanged production guard must still reject this exact inaccessible process.
  const proc = path.join(f.dir, 'protected-proc'); fs.mkdirSync(proc);
  fs.symlinkSync(`/proc/${child.pid}`, path.join(proc, String(child.pid)));
  assert.equal(runtimeInUse(root, RUNTIME_REVISION, { procRoot: proc, owner: base => fs.statSync(base).uid }), true);
  assert.equal(runtimeInUse(root, RUNTIME_REVISION), false, 'only the unit fixture excludes that ambient process');
  npm.mode('fail'); await assert.rejects(prepare(), { code: 'RUNTIME_INSTALL_FAILED' });
  assert.equal(fs.existsSync(root), false);
  npm.mode('ok'); assert.equal((await prepare()).installed, true);
  assert.equal(npm.calls().length, 2);
});

test('an owned unreadable same-UID process retains a partial tree and blocks prepare retry', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f), loc = locations(), root = prepareRuntimeManifest(loc);
  const child = await worker(t, { cwd: f.dir, env: process.env }); f.children.push(child);
  const denied = denyEnvironment(t, child.pid);
  assert.throws(() => discardPartialRuntime(loc), { code: 'RUNTIME_IN_USE' });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(prepare(), { code: 'RUNTIME_IN_USE' });
  assert.equal(fs.existsSync(path.join(root, 'package.json')), true);
  assert.equal(npm.calls().length, 0);
  denied.mock.restore();
  assert.equal((await prepare()).installed, true, 'retry succeeds only when metadata can again rule out use');
});

test('the scoped CLI includes a detached worker and selected workers never lose permission protection', async t => {
  const f = fixture(); t.after(() => f.close());
  const npm = fakeNpm(f), loc = locations(), root = prepareRuntimeManifest(loc);
  // Not registered in f.children: selection must also find the inherited exact fixture marker.
  const child = await worker(t, { cwd: root, detached: true, env: process.env });
  assert.equal(runtimeInUse(root, RUNTIME_REVISION), true);
  const denied = denyEnvironment(t, child.pid);
  assert.equal(runtimeInUse(root, RUNTIME_REVISION), true, 'once selected, EACCES must not reclassify a worker as ambient');
  denied.mock.restore();
  const run = () => spawnSync(process.execPath, ['--import', new URL('./fixture-processes.mjs', import.meta.url).href, 'bin/control.mjs', 'prepare'], {
    cwd: new URL('..', import.meta.url), input: '{}', encoding: 'utf8', timeout: 30000, env: process.env,
  });
  const blocked = run();
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).code, 'RUNTIME_IN_USE');
  assert.equal(npm.calls().length, 0);
  child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
  const done = run();
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(JSON.parse(done.stdout).installed, true);
  assert.equal(npm.calls().length, 1);
});
