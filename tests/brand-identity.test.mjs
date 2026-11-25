import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectedBrand } from '../src/brand-identity.mjs';
import { CONNECTION_TARGETS } from '../src/connection-targets.mjs';
import { patchBrandIdentitySource, applyBrandIdentityPatch, brandIdentityPatchReady, BRAND_SERVER_PATH, BRAND_HELPER_NAME,
  ORIGINAL_BRAND_SERVER_SHA256, PATCHED_BRAND_SERVER_SHA256 } from '../src/brand-identity-patch.mjs';
import { runtimeDirectory, runtimeReady, markRuntimeReady, patchInstalledRuntime, RUNTIME_REVISION } from '../src/runtime-layout.mjs';
import { locations } from '../src/state.mjs';
import { fixture, websocketServerSource } from './runtime-fixtures.mjs';

const source = websocketServerSource();
const sha = value => createHash('sha256').update(value).digest('hex');
const helperBytes = fs.readFileSync(new URL('../src/brand-identity.mjs', import.meta.url));

// Runs the frozen upstream payload builder itself, every feature flag included.
function payload(text, target) {
  const method = text.slice(text.indexOf('    buildServerInfoStatusPayload(session) {'), text.indexOf('    createServerInfoMessage(session) {'));
  const object = vm.runInNewContext('({' + method + '})', { WS_PROTOCOL_VERSION: 1, getHostName: () => 'fixture', agentConnectBrand: selectedBrand(target) });
  const daemon = { serverId: 'srv_fixture', daemonVersion: '0.11.2', daemonRuntimeConfig: {}, serverCapabilities: null, advertiseDaemonStatusRpc: true, advertiseRelayConfig: true };
  return object.buildServerInfoStatusPayload.call(daemon, { getPermissions: () => [] });
}
// An installed release holding only the server file the patch acts on.
function release(t, bytes = source) {
  const f = fixture(); t.after(() => f.close());
  const root = runtimeDirectory(locations()), server = path.join(root, BRAND_SERVER_PATH);
  fs.mkdirSync(path.dirname(server), { recursive: true });
  fs.writeFileSync(server, bytes);
  return { f, root, server, helper: path.join(path.dirname(server), BRAND_HELPER_NAME), loc: locations() };
}
const leftovers = server => fs.readdirSync(path.dirname(server)).filter(name => name.endsWith('.tmp'));

test('Smart hello regression: the patched server_info names the selected target and nothing else changes', () => {
  assert.equal(payload(source, 'woowtech').brand, undefined, 'upstream sends no brand, which the Smart apps refuse');
  const patched = patchBrandIdentitySource(source);
  for (const target of CONNECTION_TARGETS) {
    const before = payload(source, target.id), after = payload(patched, target.id);
    assert.deepEqual(JSON.parse(JSON.stringify(after.brand)), { id: target.id, name: target.label }, 'the brand is the table row');
    delete after.brand;
    assert.equal(JSON.stringify(after), JSON.stringify(before), 'identity must not change capabilities or permissions');
  }
});

test('the brand comes only from the daemon environment, fails closed, and cannot be changed by callers', () => {
  for (const row of CONNECTION_TARGETS) assert.deepEqual(selectedBrand(row.id), { id: row.id, name: row.label });
  for (const target of ['', null, '__proto__', 'constructor', 'other', 'Paseo', ' paseo']) assert.throws(() => selectedBrand(target), { code: 'INVALID_CONNECTION_TARGET' });
  assert.throws(() => { selectedBrand('apporo').id = 'woowtech'; }, TypeError);
  // The helper is copied next to the server module: it must stay self-contained.
  assert.doesNotMatch(helperBytes.toString('utf8'), /^\s*import\s/m);
});

test('the copied helper reads HERMES_PASEO_CONNECTION_TARGET at import: Paseo when unset, the target when set, nothing when invalid', t => {
  const f = fixture(); t.after(() => f.close());
  const copy = path.join(f.dir, BRAND_HELPER_NAME);
  fs.writeFileSync(copy, helperBytes);
  const run = env => spawnSync(process.execPath, ['--input-type=module', '-e', `import {agentConnectBrand} from ${JSON.stringify(copy)};process.stdout.write(JSON.stringify(agentConnectBrand));`],
    { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(run({}).stdout), { id: 'paseo', name: 'Paseo' }, 'a daemon started without the variable, as rc.9 did, is Paseo');
  for (const row of CONNECTION_TARGETS) assert.deepEqual(JSON.parse(run({ HERMES_PASEO_CONNECTION_TARGET: row.id }).stdout), { id: row.id, name: row.label });
  const bad = run({ HERMES_PASEO_CONNECTION_TARGET: 'evil' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /INVALID_CONNECTION_TARGET/);
  // A managed `daemon start` strips PASEO_* settings, so the variable must not be one.
  assert.doesNotMatch('HERMES_PASEO_CONNECTION_TARGET', /^PASEO_/);
});

test('a known source patches deterministically and idempotently; anything else is refused', () => {
  assert.equal(sha(source), ORIGINAL_BRAND_SERVER_SHA256);
  const patched = patchBrandIdentitySource(source);
  assert.equal(sha(patched), PATCHED_BRAND_SERVER_SHA256);
  assert.equal(patchBrandIdentitySource(patched), patched);
  assert.ok(patched.startsWith(`import {agentConnectBrand} from "./${BRAND_HELPER_NAME}";\n`));
  assert.equal(patched.split('brand: agentConnectBrand,').length, 2, 'exactly one insertion');
  assert.ok(patched.includes('            status: "server_info",\n            brand: agentConnectBrand,\n'), 'after status, as Agent Connect does');
  assert.throws(() => patchBrandIdentitySource(source + '\n'), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' });
  assert.throws(() => patchBrandIdentitySource(patched + '\n'), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' });
  assert.throws(() => patchBrandIdentitySource(source.replace('status: "server_info"', 'status: "server_info2"')), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' });
});

test('the transformation is Agent Connect\'s: with its helper name the same bytes, with this plugin\'s the pinned hash', () => {
  const site = '            status: "server_info",';
  const build = name => `import {agentConnectBrand} from "./${name}";\n` + source.replace(site, () => `${site}\n            brand: agentConnectBrand,`);
  // The patched hash of the Pi plugin's identical patch (WOOWTECH/pi-paseo-plugin src/brand-identity-patch.mjs), 0.11.2 server.
  assert.equal(sha(build('pi-paseo-brand-identity.mjs')), '8315add9226617d4c2c09d1481c750eff7a34fa83670725914c69892f1cd1561');
  assert.equal(sha(build(BRAND_HELPER_NAME)), PATCHED_BRAND_SERVER_SHA256);
  assert.notEqual(PATCHED_BRAND_SERVER_SHA256, '8315add9226617d4c2c09d1481c750eff7a34fa83670725914c69892f1cd1561', 'the helper file name differs, so the hash does');
});

test('an installed release is patched in place: helper beside the server, both hashes verified, mode kept, replaced atomically', t => {
  const { root, server, helper } = release(t);
  fs.chmodSync(server, 0o640);
  const before = fs.statSync(server);
  applyBrandIdentityPatch(root);
  assert.equal(sha(fs.readFileSync(server)), PATCHED_BRAND_SERVER_SHA256);
  assert.ok(fs.readFileSync(helper).equals(helperBytes));
  assert.equal(brandIdentityPatchReady(root), true);
  assert.equal(fs.statSync(server).mode & 0o777, 0o640, 'the file keeps its mode');
  assert.equal(fs.statSync(helper).mode & 0o777, 0o644);
  assert.notEqual(fs.statSync(server).ino, before.ino, 'a new file renamed over the old one, never written in place');
  assert.deepEqual(leftovers(server), []);
  // Applying again changes nothing at all.
  const settled = fs.statSync(server), settledHelper = fs.statSync(helper);
  applyBrandIdentityPatch(root);
  assert.deepEqual([fs.statSync(server).ino, fs.statSync(server).mtimeMs, fs.statSync(helper).ino, fs.statSync(helper).mtimeMs], [settled.ino, settled.mtimeMs, settledHelper.ino, settledHelper.mtimeMs]);
});

test('an unknown or tampered server fails before writing either file', t => {
  for (const [name, bytes] of [['an unknown original', source + '\n'], ['a tampered patched file', patchBrandIdentitySource(source) + '// x\n'], ['an empty file', ''], ['not text', Buffer.from([0xff, 0xfe, 0x00])]]) {
    const { root, server, helper } = release(t, bytes);
    assert.throws(() => applyBrandIdentityPatch(root), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' }, name);
    assert.ok(fs.readFileSync(server).equals(Buffer.from(bytes)), name + ': untouched');
    assert.equal(fs.existsSync(helper), false, name + ': no helper written');
    assert.equal(brandIdentityPatchReady(root), false);
    assert.deepEqual(leftovers(server), []);
  }
});

test('a link anywhere on the way is refused and nothing is written through it', t => {
  // The server file is a link to another copy of the real source.
  let r = release(t);
  const elsewhere = path.join(r.f.dir, 'elsewhere.js');
  fs.renameSync(r.server, elsewhere);
  fs.symlinkSync(elsewhere, r.server);
  assert.throws(() => applyBrandIdentityPatch(r.root), { code: 'UNSAFE_SYMLINK' });
  assert.equal(sha(fs.readFileSync(elsewhere)), ORIGINAL_BRAND_SERVER_SHA256, 'the link target is unchanged');
  assert.equal(fs.existsSync(r.helper), false);
  // A link named like the helper.
  r = release(t);
  const decoy = path.join(r.f.dir, 'decoy.mjs');
  fs.writeFileSync(decoy, 'precious');
  fs.symlinkSync(decoy, r.helper);
  assert.throws(() => applyBrandIdentityPatch(r.root), { code: 'UNSAFE_SYMLINK' });
  assert.equal(fs.readFileSync(decoy, 'utf8'), 'precious');
  assert.equal(sha(fs.readFileSync(r.server)), ORIGINAL_BRAND_SERVER_SHA256, 'the server was not patched against an unusable helper path');
  // A link in front of the directory, and in front of the release itself.
  r = release(t);
  const dir = path.dirname(r.server), moved = dir + '-moved';
  fs.renameSync(dir, moved);
  fs.symlinkSync(moved, dir);
  assert.throws(() => applyBrandIdentityPatch(r.root), { code: 'UNSAFE_SYMLINK' });
  assert.equal(sha(fs.readFileSync(path.join(moved, 'websocket-server.js'))), ORIGINAL_BRAND_SERVER_SHA256);
  r = release(t);
  const releases = path.dirname(r.root), movedRoot = r.root + '-moved';
  fs.renameSync(r.root, movedRoot);
  fs.symlinkSync(movedRoot, r.root);
  assert.throws(() => applyBrandIdentityPatch(r.root), { code: 'UNSAFE_SYMLINK' });
  assert.ok(fs.existsSync(releases));
  assert.equal(brandIdentityPatchReady(r.root), false, 'readiness never throws on a link');
});

test('a stale or damaged helper beside a patched server is rewritten, a damaged server is not', t => {
  const { root, server, helper } = release(t);
  applyBrandIdentityPatch(root);
  fs.writeFileSync(helper, 'export const agentConnectBrand = { id: "woowtech", name: "spoofed" };\n');
  assert.equal(brandIdentityPatchReady(root), false);
  applyBrandIdentityPatch(root);
  assert.ok(fs.readFileSync(helper).equals(helperBytes));
  assert.equal(brandIdentityPatchReady(root), true);
  fs.rmSync(helper);
  assert.equal(brandIdentityPatchReady(root), false);
  applyBrandIdentityPatch(root);
  assert.equal(brandIdentityPatchReady(root), true);
  fs.appendFileSync(server, '\n');
  assert.throws(() => applyBrandIdentityPatch(root), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' });
  assert.equal(brandIdentityPatchReady(root), false);
});

test('readiness stays the lock and the CLI version: an unpatched install is ready, and a patched one is ready to rc.9 as well', t => {
  const { root, server, loc } = release(t);
  const cli = path.join(root, 'node_modules/@getpaseo/cli/package.json');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, JSON.stringify({ version: '0.11.2' }));
  // What rc.9 left behind: installed, ready, not patched. It must never be installed again for lack of a patch.
  markRuntimeReady(loc, { patch: false });
  assert.equal(runtimeReady(loc), true);
  assert.equal(brandIdentityPatchReady(root), false);
  assert.equal(sha(fs.readFileSync(server)), ORIGINAL_BRAND_SERVER_SHA256);
  // rc.9's own predicate, verbatim from its src/runtime-layout.mjs: the lock hash in the receipt and the CLI version, nothing else.
  const lockSha256 = sha(fs.readFileSync(new URL('../runtime/package-lock.json', import.meta.url)));
  const rc9Ready = () => { try {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, '.hermes-paseo-runtime.json')));
    return receipt.lockSha256 === lockSha256 && JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@getpaseo/cli/package.json'))).version === '0.11.2';
  } catch { return false; } };
  assert.equal(rc9Ready(), true);
  assert.equal(RUNTIME_REVISION, '0.11.2-r2-' + lockSha256.slice(0, 12), 'the revision, and so the release directory, is the one rc.9 installed');
  patchInstalledRuntime(loc);
  assert.equal(brandIdentityPatchReady(root), true);
  assert.equal(runtimeReady(loc), true);
  assert.equal(rc9Ready(), true, 'rc.9 accepts the patched runtime');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, '.hermes-paseo-runtime.json'), 'utf8'))).sort(), ['lockSha256', 'revision'], 'the receipt keeps its two fields');
});

test('a fresh install is patched before it is declared ready; marking an installed one patches nothing', t => {
  const { root, server, loc } = release(t);
  const cli = path.join(root, 'node_modules/@getpaseo/cli/package.json');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, JSON.stringify({ version: '0.11.2' }));
  assert.equal(runtimeReady(loc), false, 'no receipt yet');
  markRuntimeReady(loc, { patch: false });
  assert.equal(sha(fs.readFileSync(server)), ORIGINAL_BRAND_SERVER_SHA256, 'an installed runtime is left alone by the receipt rewrite');
  fs.rmSync(path.join(root, '.hermes-paseo-runtime.json'));
  markRuntimeReady(loc);
  assert.equal(brandIdentityPatchReady(root), true);
  assert.equal(runtimeReady(loc), true);
  // A source npm did not install: no receipt, so it is never declared ready.
  fs.appendFileSync(server, '\n');
  fs.rmSync(path.join(root, '.hermes-paseo-runtime.json'));
  assert.throws(() => markRuntimeReady(loc), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' });
  assert.equal(runtimeReady(loc), false);
});
