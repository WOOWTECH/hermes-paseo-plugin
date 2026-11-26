import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { websocketServerSource, fixtureProvenance } from './runtime-fixtures.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const lock = JSON.parse(fs.readFileSync(new URL('../runtime/package-lock.json', import.meta.url), 'utf8'));

test('the vendored websocket server is byte for byte the file of the pinned @getpaseo/server release', () => {
  const provenance = fixtureProvenance(), source = websocketServerSource();
  assert.equal(provenance.package, '@getpaseo/server');
  assert.equal(provenance.version, '0.11.2');
  assert.equal(sha256(source), provenance.websocketServer.sha256);
  assert.equal(Buffer.byteLength(source), provenance.websocketServer.bytes);
  // The tarball the file came from is the one npm ci installs: same version, same integrity.
  const pinned = lock.packages['node_modules/@getpaseo/server'];
  assert.equal(pinned.version, provenance.version);
  assert.equal(pinned.integrity, provenance.tarballIntegrity);
  assert.equal(pinned.resolved, 'https://registry.npmjs.org/@getpaseo/server/-/server-0.11.2.tgz');
  assert.match(provenance.tarballIntegrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
});

test('the fixture keeps the single hello site the brand identity patch depends on', () => {
  const source = websocketServerSource();
  const site = '            status: "server_info",';
  assert.equal(source.split(site).length, 2, 'exactly one server_info status payload');
  assert.doesNotMatch(source, /\bbrand\s*:/, 'upstream 0.11.2 sends no brand identity');
});
