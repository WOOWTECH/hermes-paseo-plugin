import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { locations } from '../src/state.mjs';
import { prepare } from '../src/runtime.mjs';
import { prepareRuntimeManifest, runtimeDirectory } from '../src/runtime-layout.mjs';
import { fixture, fakeNpm } from './release-fixtures.mjs';

test('SIGKILL during either manifest copy leaves a release that prepare can retry safely', async t => {
  for (const name of ['package.json', 'package-lock.json']) {
    await t.test(name, async t => {
      const f = fixture(); t.after(() => f.close());
      const npm = fakeNpm(f), loc = locations(), root = runtimeDirectory(loc);
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs';
        import path from 'node:path';
        import { prepareRuntimeManifest } from './src/runtime-layout.mjs';
        import { locations } from './src/state.mjs';
        const copy = fs.copyFileSync;
        fs.copyFileSync = (source, destination, ...args) => {
          if (path.basename(destination) === ${JSON.stringify(name)}) {
            // The native copy's open(O_CREAT) succeeded, but no bytes were copied yet.
            fs.closeSync(fs.openSync(destination, 'wx'));
            process.kill(process.pid, 'SIGKILL');
          }
          return copy(source, destination, ...args);
        };
        prepareRuntimeManifest(locations());
      `], { cwd: new URL('..', import.meta.url), env: process.env, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.signal, 'SIGKILL', result.stderr);
      assert.ok(!fs.existsSync(root) || fs.readdirSync(root).length === 0, 'neither partial manifest is published');
      assert.equal((await prepare()).installed, true, 'an interrupted publication must not strand an unowned release');
      assert.equal(npm.calls().length, 1);
      for (const file of ['package.json', 'package-lock.json']) {
        assert.deepEqual(fs.readFileSync(path.join(root, file)), fs.readFileSync(new URL('../runtime/' + file, import.meta.url)));
      }
    });
  }
});

test('a failed copy discards its staging directory without changing neighboring data', t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations(), root = runtimeDirectory(loc), neighbor = path.join(loc.runtimeDir, 'unrelated');
  fs.mkdirSync(neighbor, { recursive: true }); fs.writeFileSync(path.join(neighbor, 'keep'), 'keep');
  t.mock.method(fs, 'copyFileSync', (_source, destination) => {
    fs.closeSync(fs.openSync(destination, 'wx'));
    throw Object.assign(new Error('copy interrupted'), { code: 'EIO' });
  });
  assert.throws(() => prepareRuntimeManifest(loc), { code: 'EIO' });
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(fs.readdirSync(loc.runtimeDir).sort(), ['releases', 'unrelated']);
  assert.equal(fs.readFileSync(path.join(neighbor, 'keep'), 'utf8'), 'keep');
});

test('manifest publication refuses foreign contents and redirected release paths', t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations(), root = runtimeDirectory(loc), outside = path.join(f.dir, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'notes.txt'), 'keep');
  assert.throws(() => prepareRuntimeManifest(loc), { code: 'RUNTIME_NOT_OWNED' });
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'keep');
  fs.rmSync(root, { recursive: true });
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'outside');
  fs.symlinkSync(outside, root);
  assert.throws(() => prepareRuntimeManifest(loc), { code: 'UNSAFE_SYMLINK' });
  assert.deepEqual(fs.readdirSync(outside), ['keep']);
});
