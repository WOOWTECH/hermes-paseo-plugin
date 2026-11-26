// Isolated 0.11.2 release fixtures; lifecycle modules record the revision handling control.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { runtimeDirectory, markRuntimeReady, PASEO_VERSION, LEGACY_PASEO_VERSION, PRIOR_RELEASES } from '../src/runtime-layout.mjs';
import { locations, updateState } from '../src/state.mjs';

const fixtures = new URL('./fixtures/paseo-0.11.2/', import.meta.url);
export const websocketServerSource = () => gunzipSync(fs.readFileSync(new URL('websocket-server.js.gz', fixtures))).toString();
const SERVER = 'node_modules/@getpaseo/server';
const CLI = 'node_modules/@getpaseo/cli';

export function fixture(prefix = 'hermes-paseo-release-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const keys = ['HOME', 'HERMES_HOME', 'HERMES_PASEO_STATE_DIR', 'HERMES_PASEO_RUNTIME_DIR', 'HERMES_PASEO_PORT', 'PASEO_HOME'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.HOME = path.join(dir, 'home'); process.env.HERMES_HOME = path.join(dir, 'agent');
  process.env.HERMES_PASEO_STATE_DIR = path.join(dir, 'state'); process.env.HERMES_PASEO_RUNTIME_DIR = path.join(dir, 'runtime');
  delete process.env.HERMES_PASEO_PORT; delete process.env.PASEO_HOME;
  const children = [], cleanups = [];
  return {
    dir, children,
    /** Runs `fn` when the fixture closes (before its directory is removed). */
    onClose(fn) { cleanups.push(fn); },
    close() {
      for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
      for (const fn of cleanups.splice(0).reverse()) { try { fn(); } catch {} }
      for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Lifecycle stand-ins. `mark` names the release in files they leave in PASEO_HOME. */
export function lifecycleModules(mark, { version = PASEO_VERSION, stopError = null } = {}) {
  return {
    [`${SERVER}/dist/server/server/daemon-instance.js`]: `import fs from "node:fs";
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function readDaemonInstance(home) {
  try { fs.appendFileSync(home + "/read-by", ${JSON.stringify(mark)} + "\\n"); const lock = JSON.parse(fs.readFileSync(home + "/paseo.pid", "utf8")); return alive(lock.pid) ? lock : null; } catch { return null; }
}
export async function stopDaemonInstance(home, options) {
  fs.writeFileSync(home + "/stopped-by", ${JSON.stringify(mark)});
  process.kill(options.instance.pid, "SIGTERM");
  for (let i = 0; i < 200 && alive(options.instance.pid); i++) await new Promise(resolve => setTimeout(resolve, 10));
  fs.rmSync(home + "/paseo.pid", { force: true });
  ${stopError ? `throw Object.assign(new Error("cleanup"), { code: ${JSON.stringify(stopError)} });` : 'return { action: "stopped" };'}
}
`,
    [`${SERVER}/dist/server/server/pid-lock.js`]: `import fs from "node:fs";
export async function getPidLockInfo(home) { try { return JSON.parse(fs.readFileSync(home + "/paseo.pid", "utf8")); } catch { return null; } }
export async function releasePidLock(home, expected) { const lock = await getPidLockInfo(home); if (lock && lock.pid === expected.ownerPid && lock.startedAt === expected.startedAt) fs.unlinkSync(home + "/paseo.pid"); }
`,
    [`${CLI}/dist/utils/client.js`]: `import fs from "node:fs";
export async function connectToDaemon(options) {
  const home = options.target.home ?? process.env.PASEO_HOME;
  fs.appendFileSync(home + "/client-by", ${JSON.stringify(mark)} + "\\n");
  return {
    getDaemonStatus: async () => ({ pid: process.pid, version: ${JSON.stringify(version)}, relay: { enabled: true, connected: true }, providers: [] }),
    reloadDaemonConfig: async () => ({ appliedPaths: [], restartRequiredPaths: [], overrideControlledPaths: [] }),
    close: async () => {},
  };
}
`,
  };
}

/** The files `npm ci` leaves for this release (original upstream server source), without a receipt. */
export function writeCurrentTree(root, { modules = {} } = {}) {
  fs.mkdirSync(root, { recursive: true });
  write(root, 'package.json', JSON.stringify({ name: 'hermes-paseo-managed-runtime' }));
  write(root, `${SERVER}/package.json`, JSON.stringify({ name: '@getpaseo/server', type: 'module', version: PASEO_VERSION }));
  write(root, `${SERVER}/dist/server/server/websocket-server.js`, websocketServerSource());
  write(root, `${SERVER}/dist/server/web-ui/index.html`, '<!doctype html>');
  write(root, `${CLI}/package.json`, JSON.stringify({ name: '@getpaseo/cli', type: 'module', version: PASEO_VERSION }));
  // Answers --version; any other command is recorded in PASEO_HOME and fails, so a test sees
  // every daemon start or pairing request this release's CLI was asked to make.
  write(root, `${CLI}/bin/paseo`, `import fs from "node:fs";
if (process.argv.includes("--version")) { process.stdout.write(${JSON.stringify(PASEO_VERSION + '\n')}); process.exit(0); }
fs.appendFileSync(process.env.PASEO_HOME + "/cli-calls", process.argv.slice(2).join(" ") + "\\n");
process.exit(3);
`);
  for (const [relative, source] of Object.entries(modules)) write(root, relative, source);
  return root;
}

/** This release, ready: original upstream server source, without a brand patch. */
export function seedCurrentRelease(loc, options = {}) {
  const root = runtimeDirectory(loc);
  writeCurrentTree(root, options);
  markRuntimeReady(loc);
  return root;
}

/** PATH with failing stand-ins for every provider CLI, so detection never runs a real one. */
export function providerlessPath(f) {
  const bin = path.join(f.dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'codex', 'hermes', 'pi']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  return [bin, '/usr/bin', '/bin'].join(path.delimiter);
}

/** An earlier 0.11.2 release as 0.1.2-0.1.4 installed it, with its receipt. */
export function seedPriorRelease(loc, { generation = 'r2', modules = {} } = {}) {
  const release = PRIOR_RELEASES.find(row => row.generation === generation);
  const root = path.join(loc.runtimeDir, 'releases', release.revision);
  write(root, `${SERVER}/package.json`, JSON.stringify({ name: '@getpaseo/server', type: 'module', version: LEGACY_PASEO_VERSION }));
  write(root, `${CLI}/package.json`, JSON.stringify({ name: '@getpaseo/cli', type: 'module', version: LEGACY_PASEO_VERSION }));
  write(root, 'package.json', JSON.stringify({ name: 'hermes-paseo-managed-runtime' }));
  write(root, '.hermes-paseo-runtime.json', JSON.stringify({ lockSha256: release.lockSha256, revision: release.revision }));
  for (const [relative, source] of Object.entries(modules)) write(root, relative, source);
  return { root, revision: release.revision };
}

/** A process that looks like a Paseo supervisor of `home` started by `revision`. */
export async function fakeSupervisor(f, home, env = {}) {
  const child = spawn(process.execPath, ['-e', 'process.title="Paseo Supervisor";setInterval(()=>{},1000)'], {
    stdio: 'ignore', env: { ...process.env, PASEO_HOME: home, ...env },
  });
  f.children.push(child);
  for (let i = 0; i < 100; i++) {
    try { if (fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').startsWith('Paseo Supervisor')) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  fs.mkdirSync(home, { recursive: true });
  const record = { pid: child.pid, uid: process.getuid(), hostname: 'fixture', startedAt: new Date().toISOString(), heartbeat: true, listen: '127.0.0.1:1' };
  fs.writeFileSync(path.join(home, 'paseo.pid'), JSON.stringify(record));
  return { child, record };
}

/** An installation that owns its (empty) Paseo home, as after a first start. */
export function ownedHome() {
  const loc = locations(), state = updateState({ desiredEnabled: true, phase: 'running' });
  fs.mkdirSync(loc.paseoHome, { recursive: true });
  fs.writeFileSync(path.join(loc.paseoHome, '.hermes-paseo-owner.json'), JSON.stringify({ installationId: state.installationId, home: loc.paseoHome }));
  return loc;
}
/** What a stand-in recorded in PASEO_HOME (empty when it was never called). */
export const handled = (loc, name) => { try { return fs.readFileSync(path.join(loc.paseoHome, name), 'utf8'); } catch { return ''; } };

// A stand-in `npm` for the install. `ci` copies a ready-made 0.11.2 tree into <prefix>/node_modules and
// writes about 1 MiB into the cache directory it was given (or HOME/.npm without one), so a test sees
// where the cache went. Modes: ok | fail (partial tree, exit 1) | hang (never finishes).
const FAKE_NPM = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
const value = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const prefix = value('--prefix'), cache = value('--cache') || path.join(process.env.HOME, '.npm');
const mode = process.env.FAKE_NPM_MODE || 'ok';
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ argv, mode, cache, defaultCache: !value('--cache'),
  existedBefore: fs.existsSync(path.join(prefix, 'node_modules')) }) + '\\n');
fs.mkdirSync(path.join(cache, '_cacache'), { recursive: true });
fs.writeFileSync(path.join(cache, '_cacache', 'blob'), Buffer.alloc(1 << 20, 7));
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
fs.cpSync(path.join(process.env.FAKE_NPM_TREE, 'node_modules'), path.join(prefix, 'node_modules'), { recursive: true });
if (mode === 'fail') { fs.rmSync(path.join(prefix, 'node_modules/@getpaseo/cli/bin'), { recursive: true, force: true }); process.exit(1); }
`;
/**
 * Puts a stand-in `npm` first on PATH for this fixture. `tree` is passed to writeCurrentTree;
 * the tree also carries glibc and musl stand-ins for the Claude SDK's native binary.
 */
export function fakeNpm(f, { tree = {} } = {}) {
  const bin = path.join(f.dir, 'npm-bin'), source = path.join(f.dir, 'npm-tree'), log = path.join(f.dir, 'npm-calls.jsonl');
  fs.mkdirSync(bin, { recursive: true });
  writeCurrentTree(source, tree);
  for (const name of ['claude-agent-sdk-linux-x64', 'claude-agent-sdk-linux-x64-musl', 'claude-agent-sdk-linux-arm64-musl']) {
    write(source, `node_modules/@anthropic-ai/${name}/claude`, Buffer.alloc(1 << 18, 3));
  }
  write(source, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json', '{"name":"@anthropic-ai/claude-agent-sdk"}');
  fs.writeFileSync(path.join(bin,'package.json'), '{"type":"commonjs"}');
  fs.writeFileSync(path.join(bin, 'npm'), FAKE_NPM, { mode: 0o755 });
  const saved = Object.fromEntries(['PATH', 'FAKE_NPM_LOG', 'FAKE_NPM_TREE', 'FAKE_NPM_MODE'].map(key => [key, process.env[key]]));
  process.env.PATH = [bin, process.env.PATH].join(path.delimiter);
  Object.assign(process.env, { FAKE_NPM_LOG: log, FAKE_NPM_TREE: source, FAKE_NPM_MODE: 'ok' });
  f.onClose(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  return {
    mode(value) { process.env.FAKE_NPM_MODE = value; },
    calls() { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
  };
}
