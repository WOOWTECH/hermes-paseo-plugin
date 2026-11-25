import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { selectedBrand } from '../src/brand-identity.mjs';
import { targetEnvironment, CONNECTION_TARGETS } from '../src/connection-targets.mjs';
import { patchBrandIdentitySource, applyBrandIdentityPatch, brandIdentityPatchReady, BRAND_SERVER_PATH, BRAND_HELPER_NAME,
  ORIGINAL_BRAND_SERVER_SHA256, PATCHED_BRAND_SERVER_SHA256 } from '../src/brand-identity-patch.mjs';
import { runtimeDirectory, markRuntimeReady, runtimeReady, priorRuntimeDirectory } from '../src/runtime-layout.mjs';
import { fixture, seedCurrentRelease, seedPriorRelease, websocketServerSource } from './release-fixtures.mjs';
import { locations } from '../src/state.mjs';

const source = websocketServerSource();
const sha = value => createHash('sha256').update(value).digest('hex');
const provenance = JSON.parse(fs.readFileSync(new URL('./fixtures/paseo-0.17.4/provenance.json', import.meta.url), 'utf8'));

// Runs the frozen upstream payload builder itself, every feature flag included.
function payload(text, target) {
  const method = text.slice(text.indexOf('    buildServerInfoStatusPayload(session) {'), text.indexOf('    createServerInfoMessage(session) {'));
  const object = vm.runInNewContext('({' + method + '})', { WS_PROTOCOL_VERSION: 1, getHostName: () => 'fixture', hermesPaseoBrand: selectedBrand(target) });
  const daemon = { serverId: 'srv_fixture', daemonVersion: '0.17.4', providerSnapshotManager: { supportsConfigRequiredProvider: () => false } };
  return object.buildServerInfoStatusPayload.call(daemon, { getPermissions: () => [], getHostSourceId: () => 'owner' });
}

test('the fixture is the exact upstream 0.17.4 websocket server', () => {
  assert.equal(sha(source), ORIGINAL_BRAND_SERVER_SHA256);
  assert.equal(provenance.websocketServer.sha256, ORIGINAL_BRAND_SERVER_SHA256);
});

test('Smart hello regression: the patched server_info names the selected target and nothing else changes', () => {
  assert.equal(payload(source, 'woowtech').brand, undefined, 'upstream sends no brand, which the Smart apps refuse');
  const patched = patchBrandIdentitySource(source);
  for (const target of CONNECTION_TARGETS.map(row => row.id)) {
    const before = payload(source, target), after = payload(patched, target);
    assert.deepEqual(JSON.parse(JSON.stringify(after.brand)), selectedBrand(targetEnvironment(target).HERMES_PASEO_CONNECTION_TARGET));
    delete after.brand;
    assert.equal(JSON.stringify(after), JSON.stringify(before), 'identity must not change capabilities or permissions');
  }
  assert.deepEqual(selectedBrand('woowtech'), { id: 'woowtech', name: 'Woowtech Smart' });
  assert.deepEqual(selectedBrand('apporo'), { id: 'apporo', name: 'Apporo Smart' });
  assert.deepEqual(selectedBrand('paseo'), { id: 'paseo', name: 'Paseo' });
});

test('the brand comes only from the daemon environment and cannot be changed by callers', () => {
  for (const target of ['', null, '__proto__', 'constructor', 'other', 'Paseo']) assert.throws(() => selectedBrand(target), { code: 'INVALID_CONNECTION_TARGET' });
  assert.throws(() => { selectedBrand('apporo').id = 'woowtech'; }, TypeError);
  // The helper is copied next to the server module: it must stay self-contained.
  assert.doesNotMatch(fs.readFileSync(new URL('../src/brand-identity.mjs', import.meta.url), 'utf8'), /^\s*import\s/m);
});

test('a known source patches deterministically and idempotently; anything else is refused', () => {
  const patched = patchBrandIdentitySource(source);
  assert.equal(sha(patched), PATCHED_BRAND_SERVER_SHA256);
  assert.equal(patchBrandIdentitySource(patched), patched);
  assert.ok(patched.startsWith(`import {hermesPaseoBrand} from "./${BRAND_HELPER_NAME}";\n`));
  assert.equal(patched.split('brand: hermesPaseoBrand,').length, 2, 'exactly one insertion');
  assert.throws(() => patchBrandIdentitySource(source + '\n'), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' });
  assert.throws(() => patchBrandIdentitySource(source.replace('status: "server_info"', 'status: "server_info2"')), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' });
});

test('an unknown server source fails before writing either the server or the helper', t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations(), root = runtimeDirectory(loc), file = path.join(root, BRAND_SERVER_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source + '\n');
  assert.throws(() => applyBrandIdentityPatch(root), { code: 'BRAND_IDENTITY_SOURCE_MISMATCH' });
  assert.equal(fs.readFileSync(file, 'utf8'), source + '\n');
  assert.equal(fs.existsSync(path.join(path.dirname(file), BRAND_HELPER_NAME)), false);
});

test('readiness requires the patched server bytes, this helper and the receipt; marking again keeps the bytes', t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations(), root = seedCurrentRelease(loc), file = path.join(root, BRAND_SERVER_PATH);
  assert.equal(runtimeReady(loc), true);
  assert.equal(brandIdentityPatchReady(root), true);
  for (const name of [file, path.join(path.dirname(file), BRAND_HELPER_NAME)]) {
    const bytes = fs.readFileSync(name);
    fs.appendFileSync(name, '\n');
    assert.equal(brandIdentityPatchReady(root), false);
    assert.equal(runtimeReady(loc), false);
    fs.writeFileSync(name, bytes);
  }
  const before = fs.statSync(file).mtimeMs;
  markRuntimeReady(loc);
  assert.equal(fs.statSync(file).mtimeMs, before);
  const receipt = path.join(root, '.hermes-paseo-runtime.json'), value = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  delete value.brandIdentityPatchId; fs.writeFileSync(receipt, JSON.stringify(value));
  assert.equal(runtimeReady(loc), false);
});

test('an earlier 0.11.2 release stays byte for byte and is never patched', t => {
  const f = fixture(); t.after(() => f.close());
  const loc = locations();
  const { root: old, revision } = seedPriorRelease(loc);
  const oldServer = path.join(old, BRAND_SERVER_PATH);
  fs.mkdirSync(path.dirname(oldServer), { recursive: true });
  fs.writeFileSync(oldServer, 'export const upstream0112 = true;\n');
  seedCurrentRelease(loc);
  assert.equal(priorRuntimeDirectory(loc, revision), old);
  assert.equal(fs.readFileSync(oldServer, 'utf8'), 'export const upstream0112 = true;\n');
  assert.equal(fs.existsSync(path.join(path.dirname(oldServer), BRAND_HELPER_NAME)), false);
});
