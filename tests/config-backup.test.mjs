import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { backupDaemonConfig, CONFIG_BACKUP_NAME } from '../src/config-backup.mjs';

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-paseo-backup-'));
  const paseoHome = path.join(dir, 'daemon');
  fs.mkdirSync(paseoHome, { mode: 0o700 });
  t.after(() => { try { fs.chmodSync(paseoHome, 0o700); } catch { /* removed */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, paseoHome, config: path.join(paseoHome, 'config.json'), backup: path.join(paseoHome, CONFIG_BACKUP_NAME) };
}
const leftovers = h => fs.readdirSync(h.paseoHome).filter(name => name.endsWith('.tmp'));

test('the first backup is a byte-for-byte private copy of a regular file and leaves no temporary file', t => {
  const h = home(t);
  const bytes = Buffer.from('{"daemon":{"relay":{"endpoint":"relay.mine.example:443"}}}\né\u0000raw bytes');
  fs.writeFileSync(h.config, bytes, { mode: 0o644 });
  assert.equal(backupDaemonConfig(h.paseoHome), true);
  assert.ok(fs.readFileSync(h.backup).equals(bytes));
  const info = fs.lstatSync(h.backup);
  assert.deepEqual([info.isFile(), info.isSymbolicLink(), info.mode & 0o777, info.nlink], [true, false, 0o600, 1]);
  assert.ok(fs.readFileSync(h.config).equals(bytes), 'the original is untouched');
  assert.deepEqual(leftovers(h), []);
});

test('an existing backup is never overwritten, whatever it is', t => {
  const h = home(t);
  fs.writeFileSync(h.config, 'new');
  fs.writeFileSync(h.backup, 'old copy', { mode: 0o640 });
  assert.equal(backupDaemonConfig(h.paseoHome), false);
  assert.equal(fs.readFileSync(h.backup, 'utf8'), 'old copy');
  assert.equal(fs.statSync(h.backup).mode & 0o777, 0o640);
  fs.rmSync(h.backup);
  fs.mkdirSync(h.backup);
  assert.equal(backupDaemonConfig(h.paseoHome), false, 'not even a directory in its place is replaced');
  assert.equal(fs.statSync(h.backup).isDirectory(), true);
  assert.deepEqual(leftovers(h), []);
});

test('a backup that appears between the check and the write is not overwritten either', t => {
  const h = home(t);
  fs.writeFileSync(h.config, 'new');
  fs.writeFileSync(h.backup, 'appeared meanwhile');
  const exists = fs.existsSync;
  // The existence checks are told the backup is not there yet, so only the write itself can notice it.
  fs.existsSync = file => file === h.backup ? false : exists(file);
  try { assert.equal(backupDaemonConfig(h.paseoHome), false); } finally { fs.existsSync = exists; }
  assert.equal(fs.readFileSync(h.backup, 'utf8'), 'appeared meanwhile');
  assert.deepEqual(leftovers(h), []);
});

test('no config.json means nothing to keep', t => {
  const h = home(t);
  assert.equal(backupDaemonConfig(h.paseoHome), false);
  assert.equal(fs.existsSync(h.backup), false);
});

test('a link at the backup name, at config.json or in front of the directory is refused and nothing is written through it', t => {
  const h = home(t);
  const elsewhere = path.join(h.dir, 'elsewhere');
  fs.writeFileSync(elsewhere, 'precious');
  fs.writeFileSync(h.config, 'config');
  fs.symlinkSync(elsewhere, h.backup);
  assert.throws(() => backupDaemonConfig(h.paseoHome), { code: 'UNSAFE_SYMLINK' });
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'precious');
  fs.unlinkSync(h.backup);
  // A dangling link is a link too.
  fs.symlinkSync(path.join(h.dir, 'missing'), h.backup);
  assert.throws(() => backupDaemonConfig(h.paseoHome), { code: 'UNSAFE_SYMLINK' });
  assert.equal(fs.existsSync(path.join(h.dir, 'missing')), false);
  fs.unlinkSync(h.backup);
  fs.renameSync(h.config, path.join(h.dir, 'real.json'));
  fs.symlinkSync(path.join(h.dir, 'real.json'), h.config);
  assert.throws(() => backupDaemonConfig(h.paseoHome), { code: 'UNSAFE_SYMLINK' });
  assert.equal(fs.existsSync(h.backup), false);
  fs.unlinkSync(h.config);
  const moved = path.join(h.dir, 'moved');
  fs.renameSync(h.paseoHome, moved);
  fs.symlinkSync(moved, h.paseoHome);
  assert.throws(() => backupDaemonConfig(h.paseoHome), { code: 'UNSAFE_SYMLINK' });
  assert.deepEqual(fs.readdirSync(moved), []);
});

test('a config.json that is not a regular file is refused without blocking', t => {
  const h = home(t);
  fs.mkdirSync(h.config);
  assert.throws(() => backupDaemonConfig(h.paseoHome), { code: 'CONFIG_CORRUPT' });
  fs.rmdirSync(h.config);
  // A FIFO must neither block the start that holds the runtime lock nor be copied. A child process, so a hang is a failed test.
  const made = spawnSync('mkfifo', [h.config]);
  if (made.status !== 0) { t.diagnostic('mkfifo is not available here'); return; }
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { backupDaemonConfig } from ${JSON.stringify(new URL('../src/config-backup.mjs', import.meta.url).href)};
    try { backupDaemonConfig(${JSON.stringify(h.paseoHome)}); console.log('copied'); } catch (error) { console.log(error.code); }`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.error, undefined, 'the call returned');
  assert.equal(run.stdout.trim(), 'CONFIG_CORRUPT');
  assert.equal(fs.existsSync(h.backup), false);
  assert.deepEqual(leftovers(h), []);
});

test('a directory the plugin cannot write to is a named failure and leaves no partial backup', { skip: process.getuid?.() === 0 && 'root writes everywhere' }, t => {
  const h = home(t);
  fs.writeFileSync(h.config, 'config');
  fs.chmodSync(h.paseoHome, 0o500);
  try { assert.throws(() => backupDaemonConfig(h.paseoHome), { code: 'CONFIG_BACKUP_FAILED' }); }
  finally { fs.chmodSync(h.paseoHome, 0o700); }
  assert.equal(fs.existsSync(h.backup), false);
  assert.deepEqual(leftovers(h), []);
});
