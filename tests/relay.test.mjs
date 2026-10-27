import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { locations, readState } from '../src/state.mjs';
import { runtimeDirectory } from '../src/runtime-layout.mjs';
import { status, verifyRelay } from '../src/runtime.mjs';
import { validateInput } from '../src/control.mjs';

const OFFER = 'https://app.paseo.sh/#offer=SECRET-OFFER-FRAGMENT';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-paseo-relay-'));
  const saved = Object.fromEntries(['HOME','HERMES_HOME','HERMES_PASEO_STATE_DIR','HERMES_PASEO_RUNTIME_DIR','HERMES_PASEO_PORT','PASEO_HOME'].map(key => [key, process.env[key]]));
  process.env.HOME = path.join(dir, 'home'); process.env.HERMES_HOME = path.join(dir, 'agent');
  process.env.HERMES_PASEO_STATE_DIR = path.join(dir, 'state'); process.env.HERMES_PASEO_RUNTIME_DIR = path.join(dir, 'runtime');
  delete process.env.HERMES_PASEO_PORT; delete process.env.PASEO_HOME;
  return { dir, close() { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; fs.rmSync(dir, { recursive: true, force: true }); } };
}
const up = async () => ({ reachable: true });
const offer = async () => ({ url: OFFER, relayEnabled: true });
const relayState = () => readState().relayVerification;

test('a client that reaches the daemon through the relay marks it verified without storing the offer', async () => {
  const f = fixture(); try {
    const seen = [];
    const result = await verifyRelay({ daemon: up, offer, connect: async (url, work) => { seen.push(url); return work({ getDaemonStatus: async () => ({ pid: 1 }) }); } });
    assert.deepEqual(seen, [OFFER]);
    assert.equal(result.verified, true);
    assert.equal(relayState().verified, true);
    assert.equal(relayState().checkedAt, result.checkedAt);
    const state = fs.readFileSync(path.join(locations().stateDir, 'state.json'), 'utf8');
    assert.equal(state.includes('SECRET-OFFER-FRAGMENT'), false);
    const s = await status();
    assert.equal(s.daemon.relayVerified, true);
    assert.equal(s.daemon.relayVerifiedAt, result.checkedAt);
  } finally { f.close(); }
});

test('a relay that cannot reach the daemon is reported without leaking the offer, and a later success flips it back', async () => {
  const f = fixture(); try {
    const broken = async url => { throw new Error('relay refused ' + url); };
    await assert.rejects(verifyRelay({ daemon: up, offer, connect: broken }), e => e.code === 'RELAY_UNVERIFIED' && !String(e.message).includes('SECRET-OFFER-FRAGMENT'));
    assert.equal(relayState().verified, false);
    assert.equal(relayState().code, 'RELAY_UNVERIFIED');
    assert.equal(JSON.stringify(readState()).includes('SECRET-OFFER-FRAGMENT'), false);
    let s = await status();
    assert.equal(s.daemon.relayVerified, false);
    assert.equal(s.daemon.relayVerifiedAt, null, 'a failed check is not a verification time');
    await verifyRelay({ daemon: up, offer, connect: (url, work) => work({ getDaemonStatus: async () => ({}) }) });
    assert.equal((await status()).daemon.relayVerified, true);
    await assert.rejects(verifyRelay({ daemon: up, offer, connect: broken }), e => e.code === 'RELAY_UNVERIFIED');
    assert.equal((await status()).daemon.relayVerified, false);
  } finally { f.close(); }
});

test('no offer, a stopped daemon or a daemon that never answers are different outcomes', async () => {
  const f = fixture(); try {
    await assert.rejects(verifyRelay({ daemon: async () => ({ reachable: false }), offer, connect: () => assert.fail('must not connect') }), e => e.code === 'DAEMON_UNREACHABLE');
    assert.equal(relayState(), undefined, 'a stopped daemon says nothing about the relay');
    const noOffer = async () => { const error = new Error('pairing unavailable'); error.code = 'PAIRING_UNAVAILABLE'; throw error; };
    await assert.rejects(verifyRelay({ daemon: up, offer: noOffer, connect: () => assert.fail('must not connect') }), e => e.code === 'RELAY_UNVERIFIED');
    assert.equal(relayState().verified, false);
    await assert.rejects(verifyRelay({ daemon: up, offer, connect: (url, work) => work({ getDaemonStatus: async () => { throw new Error('timeout'); } }) }), e => e.code === 'RELAY_UNVERIFIED');
  } finally { f.close(); }
});

test('overlapping checks share one connection through the relay', async () => {
  const f = fixture(); try {
    let connections = 0;
    const connect = async (url, work) => { connections += 1; await new Promise(resolve => setTimeout(resolve, 30)); return work({ getDaemonStatus: async () => ({}) }); };
    await Promise.all([verifyRelay({ daemon: up, offer, connect }), verifyRelay({ daemon: up, offer, connect })]);
    assert.equal(connections, 1);
  } finally { f.close(); }
});

test('the default connection targets the offer as an endpoint, uses the managed home and always closes', async () => {
  const f = fixture(); try {
    const root = path.join(runtimeDirectory(locations()), 'node_modules/@getpaseo/cli');
    fs.mkdirSync(path.join(root, 'dist/utils'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@getpaseo/cli', type: 'module', version: '0.11.2' }));
    const log = path.join(f.dir, 'client.log'), failFile = path.join(f.dir, 'fail');
    // ES modules are cached per URL, so the fake reads its behaviour from a file on every call.
    fs.writeFileSync(path.join(root, 'dist/utils/client.js'), `
import fs from 'node:fs';
export async function connectToDaemon(options) {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: options.target.kind, host: options.target.host, home: process.env.PASEO_HOME, timeout: options.timeout }) + '\\n');
  return {
    getDaemonStatus: async () => { if (fs.existsSync(${JSON.stringify(failFile)})) throw new Error('no answer'); return { pid: 7 }; },
    close: async () => fs.appendFileSync(${JSON.stringify(log)}, 'closed\\n'),
  };
}
`);
    await verifyRelay({ daemon: up, offer });
    const [connect, closed] = fs.readFileSync(log, 'utf8').trim().split('\n');
    const call = JSON.parse(connect);
    assert.equal(call.kind, 'endpoint');
    assert.equal(call.host, OFFER);
    assert.equal(call.home, locations().paseoHome);
    assert.equal(closed, 'closed');
    assert.equal(process.env.PASEO_HOME, undefined, 'the temporary home override does not leak into the process');
    fs.writeFileSync(failFile, '');
    await assert.rejects(verifyRelay({ daemon: up, offer }), e => e.code === 'RELAY_UNVERIFIED');
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').filter(line => line === 'closed').length, 2, 'the client is closed after a failed call as well');
  } finally { f.close(); }
});

test('the control action takes no input', () => {
  assert.deepEqual(validateInput('relay', {}), {});
  assert.throws(() => validateInput('relay', { url: OFFER }), e => e.code === 'INVALID_REQUEST');
});
