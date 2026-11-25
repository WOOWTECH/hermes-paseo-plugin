// Seeds managed runtime releases for tests. The 0.17.4 config loader is the real upstream code
// (tests/fixtures/paseo-0.17.4/persisted-config.tar.gz, see provenance.json); lifecycle modules
// are small stand-ins that record which release handled a call.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { runtimeDirectory, markRuntimeReady, PASEO_VERSION, LEGACY_PASEO_VERSION, PRIOR_RELEASES } from '../../src/runtime-layout.mjs';

const fixtures = new URL('../fixtures/paseo-0.17.4/', import.meta.url);
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
  const children = [];
  return {
    dir, children,
    close() {
      for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
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

/** This release, ready: original upstream server source patched by markRuntimeReady. */
export function seedCurrentRelease(loc, { persistedConfig = false, modules = {} } = {}) {
  const root = runtimeDirectory(loc);
  fs.mkdirSync(root, { recursive: true });
  if (persistedConfig) {
    const result = spawnSync('tar', ['-xzf', new URL('persisted-config.tar.gz', fixtures).pathname, '-C', root], { stdio: 'ignore' });
    if (result.status !== 0) throw new Error('fixture extraction failed');
  } else write(root, `${SERVER}/package.json`, JSON.stringify({ name: '@getpaseo/server', type: 'module', version: PASEO_VERSION }));
  write(root, `${SERVER}/dist/server/server/websocket-server.js`, websocketServerSource());
  write(root, `${CLI}/package.json`, JSON.stringify({ name: '@getpaseo/cli', type: 'module', version: PASEO_VERSION }));
  for (const [relative, source] of Object.entries(modules)) write(root, relative, source);
  markRuntimeReady(loc);
  return root;
}

/** An earlier 0.11.2 release as 0.1.2-0.1.4 installed it, with its receipt. */
export function seedPriorRelease(loc, { generation = 'r2', modules = {} } = {}) {
  const release = PRIOR_RELEASES.find(row => row.generation === generation);
  const root = path.join(loc.runtimeDir, 'releases', release.revision);
  write(root, `${SERVER}/package.json`, JSON.stringify({ name: '@getpaseo/server', type: 'module', version: LEGACY_PASEO_VERSION }));
  write(root, `${CLI}/package.json`, JSON.stringify({ name: '@getpaseo/cli', type: 'module', version: LEGACY_PASEO_VERSION }));
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
