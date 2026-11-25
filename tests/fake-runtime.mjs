// A stand-in for an installed Paseo 0.11.2 runtime, small enough to read: enough of the CLI, the daemon
// modules and a supervisor process for the plugin's own lifecycle code (activate, deactivate, status, pair)
// to run against. It is not Paseo; tests/ never start the real daemon. The real websocket server source
// (tests/fixtures/paseo-0.11.2) sits in it so the brand patch acts on the real bytes, and the fake
// supervisor reports which bytes it was started with. Not a test file: `node --test tests/*.test.mjs`
// does not pick it up.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { runtimeDirectory, markRuntimeReady, RUNTIME_REVISION } from '../src/runtime-layout.mjs';
import { BRAND_SERVER_PATH, BRAND_HELPER_NAME } from '../src/brand-identity-patch.mjs';
import { runProcess } from '../src/process.mjs';
import { updateState } from '../src/state.mjs';
import { websocketServerSource } from './runtime-fixtures.mjs';

const cli = '#!/usr/bin/env node\n' + `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('0.11.2\\n'); process.exit(0); }
const home = args[args.indexOf('--home') + 1];
const words = args.filter((word, index) => word !== '--json' && word !== '--home' && args[index - 1] !== '--home');
const record = process.env.FAKE_PASEO_TRACE;
if (record) fs.appendFileSync(record, JSON.stringify({ cli: words.slice(0, 2), target: process.env.HERMES_PASEO_CONNECTION_TARGET ?? null,
  stripped: Object.keys(process.env).filter(key => /^PASEO_(APP_BASE_URL|RELAY_|CORS_ORIGINS)/.test(key)) }) + '\\n');
const here = path.dirname(fileURLToPath(import.meta.url));
if (words[0] === 'daemon' && words[1] === 'start') {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^PASEO_(APP_BASE_URL|RELAY_|CORS_ORIGINS|LISTEN)/.test(key)) delete env[key];
  const child = spawn(process.execPath, [path.join(here, 'supervisor.mjs'), home], { detached: true, stdio: 'ignore', env });
  child.unref();
  for (let attempt = 0; attempt < 200 && !fs.existsSync(path.join(home, 'paseo.pid')); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
} else if (words[0] === 'daemon' && words[1] === 'pair') {
  // What a real daemon offers: the app and relay its own configuration names.
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  const relay = config.daemon?.relay ?? {};
  const offer = { v: 2, serverId: 'srv_fake_daemon', daemonPublicKeyB64: 'fake-public-key', relay: { endpoint: relay.publicEndpoint, useTls: relay.publicUseTls } };
  process.stdout.write(JSON.stringify({ url: (config.app?.baseUrl ?? 'https://app.paseo.sh') + '/#offer=' + Buffer.from(JSON.stringify(offer)).toString('base64url'), relayEnabled: relay.enabled === true }) + '\\n');
} else { process.stdout.write('{}\\n'); }
`;

const supervisor = `
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
process.title = 'Paseo Supervisor';
const home = process.argv[2];
const server = process.env.FAKE_PASEO_SERVER_FILE;
const configFile = path.join(home, 'config.json');
fs.writeFileSync(path.join(home, 'startup-config.json'), fs.existsSync(configFile) ? fs.readFileSync(configFile) : '{}');
if (process.env.FAKE_PASEO_TRACE) fs.appendFileSync(process.env.FAKE_PASEO_TRACE, JSON.stringify({ supervisor: process.pid, target: process.env.HERMES_PASEO_CONNECTION_TARGET ?? null,
  serverSha256: server && fs.existsSync(server) ? createHash('sha256').update(fs.readFileSync(server)).digest('hex') : null }) + '\\n');
fs.writeFileSync(path.join(home, 'paseo.pid'), JSON.stringify({ pid: process.pid, uid: process.getuid(), startedAt: new Date().toISOString(), heartbeat: true, listen: '127.0.0.1:0' }));
const stop = () => { try { fs.unlinkSync(path.join(home, 'paseo.pid')); } catch {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
setInterval(() => {}, 1000);
`;

const instanceModule = `
import fs from 'node:fs';
import path from 'node:path';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function readDaemonInstance(home) {
  try { const value = JSON.parse(fs.readFileSync(path.join(home, 'paseo.pid'), 'utf8')); return alive(value.pid) ? value : null; } catch { return null; }
}
export async function stopDaemonInstance(home, { instance }) {
  process.kill(instance.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 200 && alive(instance.pid); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
  try { fs.unlinkSync(path.join(home, 'paseo.pid')); } catch {}
}
`;

// What Paseo 0.11.2's strict schema accepts for the keys this plugin writes (persisted-config.js).
const configModule = `
import fs from 'node:fs';
import path from 'node:path';
const strict = (value, allowed, where) => { for (const key of Object.keys(value ?? {})) if (!allowed.includes(key)) throw new Error('Unrecognized key ' + where + '.' + key); };
export function savePersistedConfig(home, config) {
  strict(config.daemon?.relay, ['enabled', 'endpoint', 'publicEndpoint', 'useTls', 'publicUseTls'], 'daemon.relay');
  strict(config.daemon?.cors, ['allowedOrigins'], 'daemon.cors');
  strict(config.app, ['baseUrl'], 'app');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config, null, 2) + '\\n');
}
`;

// getDaemonStatus answers like a daemon; reloadDaemonConfig applies Paseo's rule: a changed key outside the
// live-reloadable ones, compared with the file the daemon started from, needs a restart.
const clientModule = `
import fs from 'node:fs';
import path from 'node:path';
const RELOADABLE = ['daemon.relay.enabled', 'daemon.mcp.enabled', 'daemon.mcp.injectIntoAgents', 'daemon.browserTools.enabled', 'daemon.hostnames',
  'daemon.cors.allowedOrigins', 'daemon.trustedProxies', 'daemon.autoArchiveAfterMerge', 'daemon.enableTerminalAgentHooks', 'daemon.appendSystemPrompt',
  'daemon.terminalProfiles', 'daemon.agentProfiles', 'app.baseUrl', 'agents.providers', 'agents.catalogRefreshTimeoutMs', 'agents.metadataGeneration',
  'agents.skills.selection', 'pluginsEnabled'];
const leaves = (value, prefix = '') => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? prefix + '.' + key : key)) : [[prefix, JSON.stringify(value)]];
export async function connectToDaemon({ target }) {
  const trace = entry => process.env.FAKE_PASEO_TRACE && fs.appendFileSync(process.env.FAKE_PASEO_TRACE, JSON.stringify(entry) + '\\n');
  return {
    getDaemonStatus: async () => { trace({ rpc: 'getDaemonStatus' }); return { pid: 1, relay: { enabled: true, connected: true }, providers: [] }; },
    reloadDaemonConfig: async () => {
      trace({ rpc: 'reloadDaemonConfig' });
      const started = new Map(leaves(JSON.parse(fs.readFileSync(path.join(target.home, 'startup-config.json'), 'utf8'))));
      const now = new Map(leaves(JSON.parse(fs.readFileSync(path.join(target.home, 'config.json'), 'utf8'))));
      const changed = [...new Set([...started.keys(), ...now.keys()])].filter(key => started.get(key) !== now.get(key));
      const owner = key => RELOADABLE.find(path => key === path || key.startsWith(path + '.'));
      return { appliedPaths: [...new Set(changed.map(owner).filter(Boolean))], restartRequiredPaths: changed.filter(key => !owner(key)), overrideControlledPaths: [] };
    },
    close: async () => {},
  };
}
`;

const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

/**
 * Installs the stand-in runtime where the plugin expects release `RUNTIME_REVISION`, ready (receipt written).
 * `patched` applies the brand patch as a fresh install does; without it the runtime is what rc.9 left behind.
 * Returns its root. Environment variables the stand-in reads are set on process.env and restored by `restore`.
 */
export function seedFakeRuntime(loc, { patched = false, trace } = {}) {
  const root = runtimeDirectory(loc), pkg = name => path.join(root, 'node_modules/@getpaseo', name);
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'hermes-paseo-managed-runtime', version: 'fake' }));
  write(path.join(pkg('cli'), 'package.json'), JSON.stringify({ name: '@getpaseo/cli', version: '0.11.2', type: 'module' }));
  write(path.join(pkg('cli'), 'bin/paseo'), cli);
  write(path.join(pkg('cli'), 'bin/supervisor.mjs'), supervisor);
  write(path.join(pkg('cli'), 'dist/utils/client.js'), clientModule);
  write(path.join(pkg('server'), 'package.json'), JSON.stringify({ name: '@getpaseo/server', version: '0.11.2', type: 'module' }));
  write(path.join(pkg('server'), 'dist/server/web-ui/index.html'), '<!doctype html>');
  write(path.join(pkg('server'), 'dist/server/server/daemon-instance.js'), instanceModule);
  write(path.join(pkg('server'), 'dist/server/server/config.js'), configModule);
  const server = path.join(root, BRAND_SERVER_PATH);
  write(server, websocketServerSource());
  process.env.FAKE_PASEO_SERVER_FILE = server;
  if (trace) process.env.FAKE_PASEO_TRACE = trace;
  markRuntimeReady(loc, { patch: patched });
  return root;
}

/** A PATH where npm is a trap (it records that it ran and fails) and no provider CLI exists. Returns the trap's marker file. */
export function trapNpm(dir) {
  const bin = path.join(dir, 'bin'), marker = path.join(dir, 'npm-ran');
  write(path.join(bin, 'npm'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\nexit 1\n`);
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  // The plugin's own locks need util-linux flock; nothing else may be found on this PATH.
  const flock = (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, 'flock')).find(file => fs.existsSync(file));
  if (flock) fs.symlinkSync(fs.realpathSync(flock), path.join(bin, 'flock'));
  process.env.PATH = bin;
  process.env.HERMES_PASEO_HERMES_COMMAND = path.join(dir, 'no-such-hermes');
  return marker;
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const readTrace = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
export const tmpDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** Stops every fake supervisor still running from this profile and forgets the stand-in's environment. */
export function stopFakeDaemons(loc) {
  try { process.kill(JSON.parse(fs.readFileSync(path.join(loc.paseoHome, 'paseo.pid'), 'utf8')).pid, 'SIGKILL'); } catch { /* none running */ }
  for (const key of ['FAKE_PASEO_SERVER_FILE', 'FAKE_PASEO_TRACE']) delete process.env[key];
}

/**
 * Starts a daemon the way rc.9 did: from a config.json without any target setting and without a target in its
 * environment, recorded in state.json. The profile must have been activated once (and stopped), so the owner
 * marker and a complete config.json exist; what only the new code writes is taken away here: the settings of
 * a target, and the brand patch of the runtime (rc.9 installed it as published).
 */
export async function startLegacyDaemon(loc) {
  const server = path.join(runtimeDirectory(loc), BRAND_SERVER_PATH);
  fs.writeFileSync(server, websocketServerSource());
  fs.rmSync(path.join(path.dirname(server), BRAND_HELPER_NAME), { force: true });
  const file = path.join(loc.paseoHome, 'config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete config.app; delete config.daemon.cors;
  config.daemon.relay = { enabled: true };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  updateState({ desiredEnabled: true });
  const env = { ...process.env, HOME: loc.home, HERMES_HOME: loc.agentDir, PASEO_HOME: loc.paseoHome, NO_COLOR: '1', HERMES_PASEO_RUNTIME_REVISION: RUNTIME_REVISION };
  delete env.HERMES_PASEO_CONNECTION_TARGET;
  const cli = path.join(runtimeDirectory(loc), 'node_modules/@getpaseo/cli/bin/paseo');
  await runProcess(process.execPath, [cli, '--home', loc.paseoHome, '--json', 'daemon', 'start', '--timeout', '90'], { env });
  const instance = JSON.parse(fs.readFileSync(path.join(loc.paseoHome, 'paseo.pid'), 'utf8'));
  updateState({ phase: 'running', daemonPid: instance.pid, daemonStartedAt: instance.startedAt, activeTarget: undefined, configurationPending: undefined });
  return instance;
}
