import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { locations, readState, updateState, atomicJson, privateDirectory, withRuntimeLock, processIdentity, RuntimeError, assertSafePath } from './state.mjs';
import { findExecutable, runProcess } from './process.mjs';
import { resolveProviderLaunchers, configureProviders } from './provider-launchers.mjs';
import { providerReplyError } from './provider-reply.mjs';
import { sendVerifiedHermesMessage } from './model-selection.mjs';
import { assistantEntries, latestAssistantCursor, chatResult } from './chat-result.mjs';
import {singleFlight,daemonStatusWindow} from './single-flight.mjs';
import {usingAcceptanceAgent,usingAcceptanceWorkspace} from './acceptance-agent.mjs';
import {runtimeDirectory,runtimeReady,prepareRuntimeManifest,markRuntimeReady,priorRuntimeDirectory,pruneUnusedPriorReleases,discardPartialRuntime,removeUnusedLibcVariants,RUNTIME_REVISION,PASEO_VERSION} from './runtime-layout.mjs';
import {hostCapacity,INSTALL_PEAK_MIB,OUT_OF_SPACE_MIB} from './host-capacity.mjs';
import {demonstrablyReusedPid,linuxContainerIdentity,instanceFromPreviousContainer} from './daemon-identity.mjs';
import {managedFeatures} from './daemon-config.mjs';
import {CONNECTION_TARGETS,DEFAULT_TARGET,connectionTarget,selectedTarget,saveSelectedTarget,targetEnvironment,targetConfiguration,targetPairUrl} from './connection-targets.mjs';
export { locations, readState, updateState } from './state.mjs';
export { PASEO_VERSION };
const PROVIDERS = ['hermes', 'claude', 'codex', 'pi'];
// Bumped when the daemon environment gains settings an older daemon was started without.
const CONNECTION_PROFILE_VERSION = '1';
const REVISION_ENTRY = 'HERMES_PASEO_RUNTIME_REVISION=';
const TARGET_ENTRY = 'HERMES_PASEO_CONNECTION_TARGET=';
// 0.17.4 waits up to about 10 s for its worker, and closes each terminal worker in up to about
// 5 + 3 s, before and after its supervisor exits (procps `ps` reads the process table). 45 s
// covers the worker and four terminals; the bridge allows 120 s for the whole stop.
const DAEMON_STOP_TIMEOUT_MS = 45000;
const safeCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'RUNTIME_FAILED';
const packageRoot = (pkg, root) => path.join(root, 'node_modules/@getpaseo', pkg);
const cliPath = root => path.join(packageRoot('cli', root), 'bin/paseo');
function packageVersion(root, pkg) { try { return JSON.parse(fs.readFileSync(path.join(packageRoot(pkg, root), 'package.json'), 'utf8')).version; } catch { return null; } }
export function inheritedEnv() {
  const loc = locations(); const env = { ...process.env, HOME: loc.home, HERMES_HOME: loc.agentDir, PASEO_HOME: loc.paseoHome, NO_COLOR: '1' };
  delete env.PASEO_HOST; delete env.PASEO_AGENT_ID; delete env.PASEO_WORKSPACE_ID; delete env.PASEO_PASSWORD;
  // Web login protects the host UI; provider children do not need this credential.
  delete env.PI_WEB_PASSWORD;
  // The same rule for the Hermes host: these authenticate ITS callers — the dashboard login, the
  // auth-proxy in front of it and the web shell share one password, and the secret signs dashboard
  // sessions. The relay makes this runtime reachable from outside the tenant, so it must not carry
  // them. Kept in step with hermes_paseo.py HOST_CREDENTIALS. Provider keys stay: agents need them.
  delete env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD;
  delete env.HERMES_DASHBOARD_BASIC_AUTH_SECRET;
  delete env.API_SERVER_KEY;
  env.HERMES_PASEO_RUNTIME_REVISION=RUNTIME_REVISION;
  // The selected target: its relay and app for the CLI, its brand identity for the daemon.
  Object.assign(env, targetEnvironment(selectedTarget(loc), process.env.PASEO_CORS_ORIGINS));
  env.HERMES_PASEO_CONNECTION_PROFILE_VERSION = CONNECTION_PROFILE_VERSION;
  return env;
}
async function cli(args, options, root) {
  const result = await runProcess(process.execPath, [cliPath(root), '--home', locations().paseoHome, '--json', ...args], { env: inheritedEnv(), ...options });
  try { return JSON.parse(result); } catch { throw new RuntimeError('INVALID_COMMAND_OUTPUT'); }
}
function ownerFile() { return path.join(locations().paseoHome, '.hermes-paseo-owner.json'); }
function ensureOwnedHome() {
  const loc = locations(); const state = readState().installationId ? readState() : updateState({ phase: 'installing' });
  if (fs.existsSync(ownerFile())) {
    const marker = JSON.parse(fs.readFileSync(ownerFile(), 'utf8'));
    if (marker.installationId !== state.installationId || marker.home !== loc.paseoHome) throw new RuntimeError('DAEMON_NOT_OWNED');
  } else {
    if (fs.existsSync(loc.paseoHome) && fs.readdirSync(loc.paseoHome).length) throw new RuntimeError('DAEMON_NOT_OWNED');
    privateDirectory(loc.paseoHome); atomicJson(ownerFile(), { installationId: state.installationId, home: loc.paseoHome });
  }
  return state;
}
function ownsHome() {
  try { const marker = JSON.parse(fs.readFileSync(ownerFile(), 'utf8')); return marker.installationId === readState().installationId && marker.home === locations().paseoHome; } catch { return false; }
}
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** This home's PID record. Paseo truncates the file before rewriting it, so a blank or partial read is retried briefly. */
function readPidRecord(loc) {
  const file = path.join(loc.paseoHome, 'paseo.pid');
  for (let attempt = 0; attempt < 10; attempt++) {
    let text;
    try { assertSafePath(file); text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; text = ''; }
    try { const value = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* mid-write */ }
    pause(50);
  }
  return null;
}
// The revision of the release whose daemon holds this home's PID file, as far as the plugin can
// tell without upstream modules: on Linux the revision pinned in that live process's environment,
// elsewhere the one recorded when this plugin started that PID. 'unrecorded' when it carries none.
// It only selects control modules; ownership is still verified before any action.
function daemonRevision(loc) {
  const lock = readPidRecord(loc);
  if (!Number.isInteger(lock?.pid) || lock.pid <= 1) return null;
  if (process.platform === 'linux') {
    try {
      const env = fs.readFileSync(`/proc/${lock.pid}/environ`, 'utf8').split('\0');
      if (!env.includes(`PASEO_HOME=${loc.paseoHome}`)) return null;
      return env.find(entry => entry.startsWith(REVISION_ENTRY))?.slice(REVISION_ENTRY.length) || 'unrecorded';
    } catch { return null; }
  }
  const state = readState();
  return state.daemonPid === lock.pid && state.daemonStartedAt === lock.startedAt ? state.daemonRuntimeRevision || 'unrecorded' : null;
}
/**
 * The release whose modules control the daemon. A daemon started by a known earlier release is
 * read, verified, queried, reconfigured and stopped only through that release: an upgrade never
 * drives a 0.11.2 daemon with 0.17.4 modules. Anything else (no daemon, this release's, or an
 * unrecorded or unknown revision) uses this release once it is installed, else nothing.
 * Starting a daemon always uses this release (see activate). Resolve once per operation.
 */
function controlRuntimeDirectory() {
  const loc = locations(), revision = daemonRevision(loc);
  if (revision && revision !== RUNTIME_REVISION) {
    const prior = priorRuntimeDirectory(loc, revision);
    if (prior) return prior;
  }
  return runtimeReady(loc) ? runtimeDirectory(loc) : null;
}
const controlRoot = () => controlRuntimeDirectory() || runtimeDirectory(locations());
const isCurrent = root => root === runtimeDirectory(locations());
async function serverModule(relative, root) { return import(pathToFileURL(path.join(packageRoot('server', root), relative)).href); }
async function readInstance(root) { return (await serverModule('dist/server/server/daemon-instance.js', root)).readDaemonInstance(locations().paseoHome); }
async function currentInstance(root) { if (!root || !ownsHome()) return null; return readInstance(root); }
function instanceNeedsRuntimeRestart(instance) {
  if (process.platform !== 'linux') {
    const state = readState();
    return state.daemonPid !== instance.pid || state.daemonStartedAt !== instance.startedAt || state.daemonRuntimeRevision !== RUNTIME_REVISION;
  }
  try {
    const env = fs.readFileSync(`/proc/${instance.pid}/environ`, 'utf8').split('\0');
    return !env.includes(REVISION_ENTRY + RUNTIME_REVISION) || !env.includes(`HERMES_PASEO_CONNECTION_PROFILE_VERSION=${CONNECTION_PROFILE_VERSION}`);
  } catch { return true; }
}
/** The target a running daemon serves, or null when it cannot be told. */
function daemonTarget(instance) {
  if (process.platform === 'linux') {
    try {
      const env = fs.readFileSync(`/proc/${instance.pid}/environ`, 'utf8').split('\0');
      const value = env.find(entry => entry.startsWith(TARGET_ENTRY))?.slice(TARGET_ENTRY.length);
      // A daemon started before targets existed only ever served Paseo's relay and app.
      if (value === undefined) return DEFAULT_TARGET;
      return CONNECTION_TARGETS.some(row => row.id === value) ? value : null;
    } catch { /* Not readable here: use the plugin's own record below. */ }
  }
  const state = readState();
  return state.daemonPid === instance.pid && state.daemonStartedAt === instance.startedAt ? state.activeTarget || DEFAULT_TARGET : null;
}
async function verifyInstanceOwnership(instance, root) {
  if (!ownsHome() || !instance || !processIdentity(instance.pid)) throw new RuntimeError('DAEMON_NOT_OWNED');
  if (instance.uid !== (process.getuid?.() ?? instance.uid)) throw new RuntimeError('DAEMON_NOT_OWNED');
  // Linux metadata additionally checks argv and the home actually inherited by this PID.
  if (process.platform === 'linux') {
    try {
      const args = fs.readFileSync(`/proc/${instance.pid}/cmdline`, 'utf8').split('\0');
      const env = fs.readFileSync(`/proc/${instance.pid}/environ`, 'utf8').split('\0');
      const entry = path.join(packageRoot('server', root), 'dist/scripts/supervisor-entrypoint.js');
      const executable = fs.realpathSync(`/proc/${instance.pid}/exe`);
      const expectedNode = fs.realpathSync(process.execPath);
      // Paseo sets process.title, which replaces its original argv on Linux.
      const supervisor = args.includes(entry) || args[0] === 'Paseo Supervisor';
      if (!supervisor || executable !== expectedNode || instance.heartbeat !== true || !env.includes(`PASEO_HOME=${locations().paseoHome}`)) throw new RuntimeError('DAEMON_NOT_OWNED');
    } catch { throw new RuntimeError('DAEMON_NOT_OWNED'); }
  }
}
async function releaseReusedPid(instance, root) {
  // Caller holds the runtime lock. Do not signal a process that reused a PID
  // from a previous container; only retire this profile's unchanged stale lock.
  const stale = value => instanceFromPreviousContainer(value, readState()) || demonstrablyReusedPid(value);
  if (!ownsHome() || instance?.uid !== process.getuid?.() || !stale(instance)) return false;
  const file = path.join(locations().paseoHome, 'paseo.pid');
  assertSafePath(file);
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.()) return false;
  const locks = await serverModule('dist/server/server/pid-lock.js', root);
  const current = await locks.getPidLockInfo(locations().paseoHome);
  if (!current || current.pid !== instance.pid || current.startedAt !== instance.startedAt || !stale(current)) return false;
  await locks.releasePidLock(locations().paseoHome, { ownerPid: current.pid, startedAt: current.startedAt });
  return (await locks.getPidLockInfo(locations().paseoHome)) === null;
}
// How long `npm ci` may run. A setting, not a constant, so a test can shorten it.
export const installSettings = { npmTimeoutMs: 300000 };
// npm's cache lives inside the release directory being installed and goes with the attempt: about 0.4 GB
// that would otherwise stay in the persistent HOME for good.
const NPM_CACHE_DIRECTORY = '.npm-cache';
const INSTALL_FAILURES = new Set(['COMMAND_FAILED', 'COMMAND_OUTPUT_LIMIT', 'COMMAND_UNAVAILABLE', 'COMMAND_ABORTED']);
/** The version, files and brand patch of an installed release, which a ready one is also checked against on every start. */
async function verifyRuntime(root) {
  const version = await runProcess(process.execPath, [cliPath(root), '--version'], { env: inheritedEnv() });
  if (version.trim() !== PASEO_VERSION || packageVersion(root, 'cli') !== PASEO_VERSION || packageVersion(root, 'server') !== PASEO_VERSION) throw new RuntimeError('VERSION_MISMATCH');
  if (!fs.existsSync(path.join(packageRoot('server', root), 'dist/server/web-ui/index.html'))) throw new RuntimeError('WEB_UI_MISSING');
}
/** What a failed install is called: the caller sees a stable code, never npm's output. */
function installFailure(error, availableMiB) {
  if (error?.code === 'COMMAND_TIMEOUT') return new RuntimeError('RUNTIME_INSTALL_TIMEOUT');
  if (!INSTALL_FAILURES.has(error?.code)) return error;
  if (typeof availableMiB === 'number' && availableMiB < OUT_OF_SPACE_MIB) {
    return new RuntimeError('INSUFFICIENT_DISK', 'INSUFFICIENT_DISK', { requiredMiB: INSTALL_PEAK_MIB, availableMiB });
  }
  return new RuntimeError('RUNTIME_INSTALL_FAILED');
}
/**
 * A new install of this release, from nothing. Whatever an earlier attempt left is discarded first (it
 * carries no receipt, so it never counted as a release), unless a running daemon claims this very
 * directory. The volume must hold the install's peak before anything is created. A failed attempt
 * removes everything it made, so the next one starts clean and nothing that looks ready is left behind.
 */
async function installFresh(loc) {
  const npm = findExecutable('npm'); if (!npm) throw new RuntimeError('NPM_UNAVAILABLE');
  const root = runtimeDirectory(loc);
  if (daemonRevision(loc) === RUNTIME_REVISION) throw new RuntimeError('RUNTIME_IN_USE');
  discardPartialRuntime(loc);
  const available = hostCapacity.availableMiB(loc.runtimeDir);
  if (typeof available === 'number' && available < INSTALL_PEAK_MIB) {
    throw new RuntimeError('INSUFFICIENT_DISK', 'INSUFFICIENT_DISK', { requiredMiB: INSTALL_PEAK_MIB, availableMiB: available });
  }
  privateDirectory(loc.runtimeDir);
  prepareRuntimeManifest(loc);
  const cache = path.join(root, NPM_CACHE_DIRECTORY);
  try {
    await runProcess(npm, ['ci', '--prefix', root, '--omit=dev', '--no-audit', '--no-fund', '--cache', cache], { timeoutMs: installSettings.npmTimeoutMs, env: inheritedEnv() });
    fs.rmSync(cache, { recursive: true, force: true });
    removeUnusedLibcVariants(root);
    await verifyRuntime(root);
    markRuntimeReady(loc);
  } catch (error) {
    const left = hostCapacity.availableMiB(loc.runtimeDir); // measured with the partial tree still on the volume
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the next attempt discards it */ }
    throw installFailure(error, left);
  }
}
/**
 * Installs this release beside any earlier one; an earlier release is never modified. The outcome of
 * an install is kept in the state so the status can say why a release is not ready.
 */
async function installRuntime() {
  const loc = locations();
  if (!runtimeReady(loc)) {
    try { await installFresh(loc); }
    catch (error) {
      try { updateState({ runtimeInstall: { revision: RUNTIME_REVISION, ok: false, code: safeCode(error), at: new Date().toISOString(), ...error.details } }); } catch { /* the original failure is the one to report */ }
      throw error;
    }
  } else {
    // An installed release is verified again, never reinstalled or removed here: a daemon may run from it.
    await verifyRuntime(runtimeDirectory(loc));
    markRuntimeReady(loc);
  }
  updateState({ installedVersion: PASEO_VERSION, installedRuntimeRevision: RUNTIME_REVISION, runtimeInstall: null });
}
async function choosePort(preferred) {
  for (let port = preferred; port <= Math.min(65535, preferred + 50); port++) {
    const free = await new Promise(resolve => { const server = net.createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
    if (free) return port;
  }
  throw new RuntimeError('PORT_UNAVAILABLE');
}
async function detectLaunchers({ installMissing = false } = {}) {
  return resolveProviderLaunchers(locations(), { installMissing, env: inheritedEnv() });
}
// Key order is not meaningful: the daemon saves its parsed form, in schema order.
function canonical(value) {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
}
const persistedConfig = root => serverModule('dist/server/server/persisted-config.js', root);
/**
 * config.json as `root`'s Paseo loads it: through that release's own reader, which applies its
 * compatibility normalization (0.17.4 folds legacy speech and OpenAI settings) before its strict
 * schema. A file that release cannot load is CONFIG_INCOMPATIBLE and is never rewritten.
 */
async function loadDaemonConfig(root) {
  const loc = locations(), file = path.join(loc.paseoHome, 'config.json');
  assertSafePath(file);
  if (!fs.existsSync(file)) return {};
  try { JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new RuntimeError('CONFIG_CORRUPT'); }
  const { readPersistedConfig } = await persistedConfig(root);
  try { return readPersistedConfig(loc.paseoHome); } catch { throw new RuntimeError('CONFIG_INCOMPATIBLE'); }
}
/** The config this plugin runs `root`'s daemon with: the loaded file plus the managed keys. */
async function buildDaemonConfig(root, port, launchers) {
  const loc = locations();
  let config = await loadDaemonConfig(root);
  const providers = configureProviders(config.agents?.providers, launchers, loc, inheritedEnv());
  // Paseo's strict daemon schema (0.11.2 and 0.17.4) rejects daemon.name; a stored one is removed.
  const daemon = { ...config.daemon };
  delete daemon.name;
  const providersChanged = canonical(config.agents?.providers || {}) !== canonical(providers);
  config = {
    ...config, $schema: 'https://paseo.sh/schemas/paseo.config.v1.json', version: 1,
    daemon: { ...daemon, listen: `127.0.0.1:${port}`, hostnames: ['localhost', '127.0.0.1', '.localhost'], relay: { ...daemon.relay, enabled: true }, mcp: { ...daemon.mcp, enabled: true } },
    agents: { ...config.agents, providers, metadataGeneration: config.agents?.metadataGeneration || { providers: [] } },
    features: managedFeatures(config.features),
    log: { ...config.log, console: { level: 'warn' }, file: { level: 'warn', path: 'daemon.log', rotate: { maxSize: '5m', maxFiles: 2 } } },
  };
  // Relay, app and CORS for the selected target; other origins and keys are kept.
  return { config: targetConfiguration(config, selectedTarget(loc)), providersChanged };
}
/** Written for this release's daemon: the one about to start, or a running one of this revision. */
export async function writeDaemonConfig(port, launchers) {
  const loc = locations(), root = runtimeDirectory(loc), file = path.join(loc.paseoHome, 'config.json');
  const { config, providersChanged } = await buildDaemonConfig(root, port, launchers);
  const { savePersistedConfig } = await persistedConfig(root);
  try { savePersistedConfig(loc.paseoHome, config); fs.chmodSync(file, 0o600); } catch { throw new RuntimeError('CONFIG_INVALID'); }
  updateState({ port, providerLaunchers: launchers });
  return providersChanged;
}
/**
 * Whether this release can run with the current config.json, decided in memory before an
 * earlier release's daemon is stopped for the upgrade. Throws CONFIG_INCOMPATIBLE otherwise.
 */
export async function checkDaemonConfig() {
  const loc = locations(), root = runtimeDirectory(loc);
  if (!runtimeReady(loc)) return false;
  const checkedAt = new Date().toISOString();
  try {
    const { config } = await buildDaemonConfig(root, loc.port, readState().providerLaunchers || {});
    const { PersistedConfigSchema } = await persistedConfig(root);
    if (!PersistedConfigSchema.safeParse(config).success) throw new RuntimeError('CONFIG_INCOMPATIBLE');
  } catch (error) {
    const code = ['CONFIG_CORRUPT', 'CONFIG_INCOMPATIBLE'].includes(error.code) ? error.code : 'CONFIG_INCOMPATIBLE';
    updateState({ upgradeCheck: { revision: RUNTIME_REVISION, ok: false, code, checkedAt } });
    throw new RuntimeError(code);
  }
  updateState({ upgradeCheck: { revision: RUNTIME_REVISION, ok: true, checkedAt } });
  return true;
}
function safeProvider(entry) {
  return { provider: entry.provider, label: entry.label || entry.provider, status: entry.status || (entry.available === true ? 'ready' : entry.available === false ? 'unavailable' : 'unknown'), enabled: entry.enabled !== false, defaultModeId: entry.defaultModeId || null, modes: (entry.modes || []).map(mode => ({ id: mode.id, label: mode.label || mode.id })), chatVerified: readState().acceptance?.providers?.some(row => row.provider === entry.provider && row.passed) || false };
}
async function withClient(fn, timeoutMs = 30000, root = controlRoot()) {
  const { connectToDaemon } = await import(pathToFileURL(path.join(packageRoot('cli', root), 'dist/utils/client.js')).href);
  const client = await connectToDaemon({ target: { kind: 'instance', home: locations().paseoHome }, timeout: 5000 });
  let timer;
  try {
    return await Promise.race([fn(client), new Promise((_, reject) => { timer = setTimeout(() => { void client.close().catch(() => {}); reject(new RuntimeError('DAEMON_REQUEST_TIMEOUT')); }, timeoutMs); timer.unref(); })]);
  } catch (error) { throw new RuntimeError(safeCode(error)); }
  finally { clearTimeout(timer); await client.close().catch(() => {}); }
}
export async function activate(options = {}) {
  return withRuntimeLock(async () => {
    ensureOwnedHome(); updateState({ desiredEnabled: true, phase: 'installing', lastError: null });
    try {
      if (Number(process.versions.node.split('.')[0]) < 22) throw new RuntimeError('NODE_VERSION_UNSUPPORTED');
      const target = selectedTarget(locations());
      await installRuntime();
      let root = controlRuntimeDirectory();
      let existing = await currentInstance(root); const launchers = await detectLaunchers({ installMissing: false });
      if (existing) {
        try { await verifyInstanceOwnership(existing, root); }
        catch (error) { if (await releaseReusedPid(existing, root)) existing = null; else throw error; }
      }
      if (existing) {
        await verifyInstanceOwnership(existing, root);
        // A daemon started by an earlier release keeps serving through that release until the
        // user stops and starts it; it is never restarted behind an active conversation. The
        // config this release will need is checked now, while the old daemon still serves.
        if(instanceNeedsRuntimeRestart(existing)) {
          let code = 'RESTART_REQUIRED';
          try { await checkDaemonConfig(); } catch (error) { code = safeCode(error); }
          updateState({phase:'restart_required',lastError:{code,at:new Date().toISOString()}});
          return status();
        }
        if (readState().configurationPending === true || daemonTarget(existing) !== target) {
          updateState({ phase: 'restart_required', lastError: { code: 'CONFIGURATION_PENDING', at: new Date().toISOString() } });
          return status();
        }
        const pending = readState().providerReloadPending;
        const needsApply = await writeDaemonConfig(locations().port, launchers) || (pending?.pid === existing.pid && pending?.startedAt === existing.startedAt);
        updateState({ providerReloadPending: { pid: existing.pid, startedAt: existing.startedAt } });
        try {
          const reload = await withClient(client => client.reloadDaemonConfig(), 30000, root);
          if (!Array.isArray(reload?.appliedPaths) || !Array.isArray(reload?.restartRequiredPaths) || !Array.isArray(reload?.overrideControlledPaths) ||
              reload.restartRequiredPaths.length || reload.overrideControlledPaths.some(p => p === 'agents.providers' || p.startsWith('agents.providers.')) ||
              (needsApply && !reload.appliedPaths.includes('agents.providers'))) throw new RuntimeError('RESTART_REQUIRED');
        } catch { throw new RuntimeError('RESTART_REQUIRED'); }
        updateState({ phase: 'running', providerReloadPending: null, daemonPid: existing.pid, daemonStartedAt: existing.startedAt, daemonContainerIdentity: linuxContainerIdentity() });
      } else {
        const port = await choosePort(locations().port); await writeDaemonConfig(port, launchers);
        updateState({ phase: 'starting' });
        // Always this release. `daemon start` returns an already running supervisor instead of
        // starting a second one; that case is caught below and never recorded as this release.
        await cli(['daemon', 'start', '--timeout', '90'], { timeoutMs: 105000 }, runtimeDirectory(locations()));
        root = controlRuntimeDirectory();
        const instance = await currentInstance(root); await verifyInstanceOwnership(instance, root);
        if (!isCurrent(root) || instanceNeedsRuntimeRestart(instance)) throw new RuntimeError('RESTART_REQUIRED');
        updateState({ phase: 'running', providerReloadPending: null, daemonPid: instance.pid, daemonStartedAt: instance.startedAt, daemonContainerIdentity: linuxContainerIdentity(), daemonRuntimeRevision: RUNTIME_REVISION, activeTarget: target, configurationPending: false, upgradeCheck: null });
      }
      const result = await status();
      if (!result.daemon.reachable) throw new RuntimeError('DAEMON_UNREACHABLE');
      updateState({ lastDiagnostic: { checkedAt: new Date().toISOString(), daemonReachable: true, providers: result.providers.map(row => ({ provider: row.provider, status: row.status })) } });
      // This release's daemon answers: older releases nothing runs on can go (the newest 0.11.2 stays).
      if (!existing) pruneUnusedPriorReleases(locations());
      return status();
    } catch (error) { updateState({ phase: error.code === 'RESTART_REQUIRED' ? 'restart_required' : 'error', lastError: { code: safeCode(error), at: new Date().toISOString() } }); throw new RuntimeError(safeCode(error)); }
  }, { timeoutMs: options.lockTimeoutMs || 360000 });
}
export async function deactivate() {
  return withRuntimeLock(async () => {
    updateState({ desiredEnabled: false });
    // Read, verify and stop through one release: an earlier daemon is stopped by its own modules.
    const root = controlRuntimeDirectory();
    let instance = await currentInstance(root);
    if (instance) {
      try { await verifyInstanceOwnership(instance, root); }
      catch (error) { if (await releaseReusedPid(instance, root)) instance = null; else throw error; }
    }
    if (instance) {
      await verifyInstanceOwnership(instance, root);
      // Stopping an earlier release's daemon is the first half of the upgrade. When this release
      // is installed, its config must load first: otherwise Paseo would stay down after the stop.
      if (instanceNeedsRuntimeRestart(instance) && runtimeReady(locations())) {
        // Refused: the daemon keeps serving, so the recorded intent stays enabled.
        try { await checkDaemonConfig(); } catch (error) { updateState({ desiredEnabled: true }); throw error; }
      }
      const control = await serverModule('dist/server/server/daemon-instance.js', root);
      const identity = processIdentity(instance.pid);
      // The official lifecycle rechecks PID plus startedAt immediately before signaling.
      try { await control.stopDaemonInstance(locations().paseoHome, { instance, timeoutMs: DAEMON_STOP_TIMEOUT_MS, force: false }); }
      catch (error) {
        // 0.17.4 confirms terminal workers only after the supervisor exited and released its
        // lock. When both are proven, the stop happened; the unconfirmed cleanup is a warning
        // that the next stop retries.
        const locks = await serverModule('dist/server/server/pid-lock.js', root);
        const lock = await locks.getPidLockInfo(locations().paseoHome).catch(() => undefined);
        const released = lock === null || (lock && (lock.pid !== instance.pid || lock.startedAt !== instance.startedAt));
        if (error?.code !== 'TERMINAL_CLEANUP_NOT_CONFIRMED' || !released || (identity && processIdentity(instance.pid) === identity)) throw new RuntimeError(safeCode(error));
        updateState({ stopWarning: { code: 'TERMINAL_CLEANUP_NOT_CONFIRMED', at: new Date().toISOString() } });
      }
    }
    updateState({ phase: 'disabled', daemonPid: null, daemonStartedAt: null, daemonContainerIdentity: null });
    return status();
  });
}
// The longest a prepare waits for the runtime lock: a start or another prepare may be installing, after
// which this release is ready and there is nothing left to do.
const PREPARE_LOCK_TIMEOUT_MS = 120000;
/**
 * Installs and verifies this release beside whatever daemon is running, then checks the current
 * config.json with this release's own reader. It never starts, stops, reloads or reconfigures a daemon
 * and never rewrites config.json, so an earlier release can keep serving through it. Idempotent: an
 * installed release is not touched. The runtime lock is held only while installing.
 * A config this release cannot load is a result, not a failure: it is reported by the status.
 */
export async function prepare() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new RuntimeError('NODE_VERSION_UNSUPPORTED');
  if (!runtimeReady(locations())) await withRuntimeLock(() => installRuntime(), { timeoutMs: PREPARE_LOCK_TIMEOUT_MS });
  try { await checkDaemonConfig(); } catch (error) { if (!['CONFIG_CORRUPT', 'CONFIG_INCOMPATIBLE'].includes(error.code)) throw error; }
  return status();
}
export async function status() {
  return singleFlight(`status:${locations().paseoHome}`,readStatus);
}
const semver = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/.test(value) ? value : null;
async function readStatus() {
  const loc = locations(); const state = readState(); const installed = runtimeReady(loc); const owned = ownsHome();
  const verification = state.relayVerification;
  let diagnosticCode = ['RESTART_REQUIRED', 'CONFIG_INCOMPATIBLE'].includes(state.lastError?.code) ? state.lastError.code : null;
  let target = DEFAULT_TARGET, activeTarget = null;
  try { target = selectedTarget(loc); } catch (error) { diagnosticCode = safeCode(error); }
  // Relay evidence counts only for the target it was taken on; older records were Paseo's.
  const verified = verification?.verified === true && (verification.target ?? DEFAULT_TARGET) === target;
  const daemon = { running: false, reachable: false, owned, pid: null, listen: null, version: null, relayEnabled: false, relayConnected: null, relayVerified: verified, relayVerifiedAt: verified ? verification.checkedAt || null : null };
  let providers = [];
  const root = controlRuntimeDirectory();
  if (root && owned) {
    try {
      const instance = await readInstance(root);
      if (instance) {
        await verifyInstanceOwnership(instance, root); daemon.running = true; daemon.pid = instance.pid; daemon.listen = instance.listen;
        activeTarget = daemonTarget(instance);
        if (instanceNeedsRuntimeRestart(instance)) {
          // An earlier release's daemon: the upgrade waits for a stop and start, unless this
          // release found that it cannot load the current config.
          const check = state.upgradeCheck;
          diagnosticCode = check?.revision === RUNTIME_REVISION && check.ok === false ? 'CONFIG_INCOMPATIBLE' : 'RESTART_REQUIRED';
        }
        const key=JSON.stringify([loc.paseoHome,instance.pid,instance.startedAt,state.updatedAt]);
        const sample = await daemonStatusWindow(key,()=>withClient(client => client.getDaemonStatus({ timeout: 5000 }), 8000, root));
        const result=sample.value;
        daemon.statusCheckedAt=new Date(sample.checkedAt).toISOString();daemon.statusMaxAgeMs=3000;
        daemon.reachable = true; daemon.workerPid = result.pid; daemon.version = semver(result.version); daemon.relayEnabled = result.relay?.enabled === true; daemon.relayConnected = typeof result.relay?.connected === 'boolean' ? result.relay.connected : null;
        providers = (result.providers || []).filter(row => PROVIDERS.includes(row.provider)).map(safeProvider);
      }
    } catch (error) { diagnosticCode = safeCode(error); }
  }
  // A start interrupted by a Dashboard restart is as stuck as 'running' with no daemon:
  // the persisted phase stays 'installing'/'starting' forever, and the host adapter's
  // unattended recovery accepts only 'not_installed' / 'stopped'.
  const stalled = ['running', 'installing', 'starting'].includes(state.phase);
  const phase = stalled && !daemon.running ? 'stopped' : state.phase || 'not_installed';
  const configurationPending = state.configurationPending === true || (daemon.running && activeTarget !== target);
  // What this release made of config.json the last time it was checked (an upgrade stop or a prepare).
  const check = state.upgradeCheck?.revision === RUNTIME_REVISION ? state.upgradeCheck : null;
  const configCheck = check ? { ok: check.ok === true, code: check.ok === true ? null : check.code || 'CONFIG_INCOMPATIBLE', checkedAt: check.checkedAt || null } : null;
  // Whether this release can be started: installed, or why the last install did not finish.
  const attempt = state.runtimeInstall?.revision === RUNTIME_REVISION && state.runtimeInstall.ok === false ? state.runtimeInstall : null;
  const prepared = installed ? { stage: 'ready' } : attempt
    ? { stage: 'failed', code: attempt.code, at: attempt.at || null, requiredMiB: attempt.requiredMiB ?? null, availableMiB: attempt.availableMiB ?? null }
    : { stage: 'pending' };
  return { installed, version: installed ? PASEO_VERSION : null, enabled: state.desiredEnabled === true, phase, daemon, providers, chatVerified: state.acceptance?.passed === true, pairingAvailable: fs.existsSync(path.join(loc.stateDir, 'pairing.private.json')), diagnosticCode, selectedTarget: target, activeTarget: daemon.running ? activeTarget : null, configurationPending, configCheck, prepare: prepared, state };
}
export async function diagnose() {
  const snapshot = await status(); const launchers = await detectLaunchers();
  let providers = snapshot.providers;
  if (snapshot.daemon.reachable) {
    try { providers = await withClient(async client => (await client.getProvidersSnapshot()).entries.filter(row => PROVIDERS.includes(row.provider)).map(safeProvider), 150000); }
    catch (error) { snapshot.diagnosticCode = safeCode(error); }
  }
  providers = PROVIDERS.map(provider => {
    const check = snapshot.state.acceptance?.providers?.find(row => row.provider === provider);
    return { ...(providers.find(row => row.provider === provider) || { provider, status: 'unknown', modes: [] }), launcher: launchers[provider], authentication: check?.passed ? 'chat_verified' : check?.code === 'PROVIDER_AUTH_REQUIRED' ? 'login_required' : 'needs_chat_verification', chatErrorCode: check?.code || null, loginHint: provider === 'hermes' ? 'Use Hermes official model settings' : provider === 'claude' ? 'claude auth login' : provider === 'codex' ? 'codex login' : 'pi /login' };
  });
  const result = { ...snapshot, providers, checkedAt: new Date().toISOString() };
  updateState({ lastDiagnostic: { checkedAt: result.checkedAt, daemonReachable: result.daemon.reachable, providers: providers.map(row => ({ provider: row.provider, status: row.status, startup: row.launcher.startup, authentication: row.authentication })) } });
  return result;
}
export async function listModels(provider) {
  if (!PROVIDERS.includes(provider)) throw new RuntimeError('INVALID_PROVIDER');
  return singleFlight(`models:${locations().paseoHome}:${provider}`,()=>readModels(provider));
}
async function readModels(provider, root = controlRoot()) {
  return withClient(async client => {
    const result = await client.listProviderModels(provider);
    const snapshot = await client.getProvidersSnapshot(); const entry = snapshot.entries.find(row => row.provider === provider);
    if (result.error) throw new RuntimeError('PROVIDER_MODELS_UNAVAILABLE');
    return { ...safeProvider(entry || { provider, status: 'unknown' }), models: (result.models || []).map(model => ({ id: model.id, label: model.label || model.id, isDefault: model.isDefault === true, defaultThinkingOptionId: model.defaultThinkingOptionId || null, thinkingOptions: (model.thinkingOptions || []).map(option => ({ id: option.id, label: option.label || option.id, isDefault: option.isDefault === true })) })) };
  }, 150000, root);
}
/** A pairing offer from the running daemon, through the release that controls it, for `target` only. */
async function relayOffer(target, root) {
  const offer = await cli(['daemon', 'pair', '--relay'], { timeoutMs: 15000 }, root);
  if (!offer.url || !offer.relayEnabled) throw new RuntimeError('PAIRING_UNAVAILABLE');
  return { relayEnabled: true, url: targetPairUrl(offer.url, target), target };
}
export async function pair() {
  return withRuntimeLock(async () => {
    const target = selectedTarget(locations()), root = controlRoot();
    const result = await status(); if (!result.daemon.reachable) throw new RuntimeError('DAEMON_UNREACHABLE');
    // A saved target is not offered until the daemon has restarted with it.
    if (result.configurationPending || result.activeTarget !== target) throw new RuntimeError('CONFIGURATION_PENDING');
    const offer = await relayOffer(target, root);
    const pairing = { url: offer.url, target, createdAt: new Date().toISOString() };
    atomicJson(path.join(locations().stateDir, 'pairing.private.json'), pairing);
    updateState({ pairingCreatedAt: pairing.createdAt });
    return pairing;
  }, { timeoutMs: 30000 });
}
/**
 * Saves the connection target. A change is applied by the next stop and start: it withdraws the
 * stored pairing link and relay evidence, keeps the daemon's server ID and key pair, and marks the
 * configuration pending unless the running daemon already serves the saved target.
 */
export async function saveConnectionSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'target') || typeof input.target !== 'string') throw new RuntimeError('INVALID_TARGET');
  const target = connectionTarget(input.target).id;
  return withRuntimeLock(async () => {
    const loc = locations();
    let previous = null;
    try { previous = selectedTarget(loc); } catch (error) { if (error.code !== 'CONNECTION_STATE_CORRUPT') throw error; }
    if (previous !== target) {
      const pairingFile = path.join(loc.stateDir, 'pairing.private.json');
      assertSafePath(pairingFile);
      // Pending is published before the new choice, so a partial write never lets the UI
      // offer the new app while the old daemon still owns the connection.
      updateState({ configurationPending: true, relayVerification: null, pairingCreatedAt: null });
      fs.rmSync(pairingFile, { force: true });
      saveSelectedTarget(loc, target);
      let running = null;
      try {
        const root = controlRuntimeDirectory(), instance = await currentInstance(root);
        if (instance) { await verifyInstanceOwnership(instance, root); running = daemonTarget(instance); }
      } catch { running = null; }
      if (running === target) updateState({ configurationPending: false });
    }
    return { saved: true, target, configurationPending: readState().configurationPending === true };
  }, { timeoutMs: 30000 });
}
async function connectViaOffer(url, work, timeoutMs = 30000, root = controlRoot()) {
  const { connectToDaemon } = await import(pathToFileURL(path.join(packageRoot('cli', root), 'dist/utils/client.js')).href);
  // An endpoint target keeps its client id under $PASEO_HOME; use the managed home, never ~/.paseo.
  // The client reads the relay endpoint and TLS choice from the offer itself, so every target's
  // relay is exercised the way its official app reaches the daemon.
  const saved = process.env.PASEO_HOME; process.env.PASEO_HOME = locations().paseoHome;
  let client;
  try { client = await connectToDaemon({ target: { kind: 'endpoint', host: url }, timeout: 20000 }); }
  finally { if (saved === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = saved; }
  let timer;
  try {
    return await Promise.race([work(client), new Promise((_, reject) => { timer = setTimeout(() => reject(new RuntimeError('DAEMON_REQUEST_TIMEOUT')), timeoutMs); timer.unref(); })]);
  } finally { clearTimeout(timer); await client.close().catch(() => {}); }
}
/**
 * Proves the hosted relay path end to end: a fresh pairing offer is used by a client that leaves this
 * host, enters through the selected target's relay and completes the encrypted handshake with this
 * daemon, like the official app does. The offer is a credential; it stays in memory and is never
 * stored, logged or returned. `deps` lets tests replace the daemon, the offer and the connection.
 */
export async function verifyRelay(deps = {}) {
  return singleFlight(`relay:${locations().paseoHome}`, () => readRelay(deps));
}
async function readRelay({ daemon = async () => { const result = await status(); return { ...result.daemon, configurationPending: result.configurationPending }; }, offer = relayOffer, connect = connectViaOffer } = {}) {
  const current = await daemon();
  if (!current.reachable) throw new RuntimeError('DAEMON_UNREACHABLE');
  // A daemon still serving the previous target says nothing about the saved one.
  if (current.configurationPending === true) throw new RuntimeError('CONFIGURATION_PENDING');
  const target = selectedTarget(locations()), root = controlRoot();
  const checkedAt = new Date().toISOString();
  try {
    const { url } = await offer(target, root);
    await connect(url, client => client.getDaemonStatus({ timeout: 10000 }), 30000, root);
  } catch {
    updateState({ relayVerification: { verified: false, checkedAt, code: 'RELAY_UNVERIFIED', target } });
    throw new RuntimeError('RELAY_UNVERIFIED');
  }
  updateState({ relayVerification: { verified: true, checkedAt, target } });
  return { verified: true, checkedAt, target };
}
/** Runs exactly two tiny turns per selected provider. Call only after user authorization. */
export async function acceptance(options = {}) {
  const selectedProviders = options.providers || ['hermes'];
  if (!Array.isArray(selectedProviders) || selectedProviders.some(provider => !PROVIDERS.includes(provider))) throw new RuntimeError('INVALID_PROVIDER');
  const timeoutMs = Math.min(Math.max(options.timeoutMs || 180000, 10000), 600000);
  const results = [];
  const previous = readState().acceptance?.providers || [];
  const cwd = options.cwd || path.join(locations().stateDir, 'acceptance-workspace'); privateDirectory(cwd);
  const root = controlRoot();
  for (const provider of selectedProviders) {
    const row = { provider, passed: false, firstReply: false, followup: false, model: null, modeId: null, agentId: null };
    try {
      const catalog = await readModels(provider, root);
      const model = options.models?.[provider] || catalog.models.find(model => model.isDefault)?.id || catalog.models[0]?.id;
      if (!model || !catalog.models.some(entry => entry.id === model)) throw new RuntimeError('NO_AVAILABLE_MODEL');
      const modeId = options.modes?.[provider] || catalog.defaultModeId || undefined;
      if (modeId && catalog.modes.length && !catalog.modes.some(mode => mode.id === modeId)) throw new RuntimeError('INVALID_MODE');
      row.model = model; row.modeId = modeId || null;
      await withClient(async client => {
        const marker = `HERMES_PASEO_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        const prompt = `Connection check only. Do not use tools or edit files. Remember ${marker}. Reply with exactly ${marker}.`;
        await usingAcceptanceWorkspace(client,{source:{kind:'directory',path:cwd}},row,async workspace=>{
        await usingAcceptanceAgent(client,{ provider, model, modeId, cwd, workspaceId: workspace.id, title: `Hermes Paseo ${provider} connection check`, ...(provider === 'hermes' ? {} : { initialPrompt: prompt }), labels: { 'hermes-paseo-acceptance': 'true' } },row,async agent=>{
        if (provider === 'hermes') await sendVerifiedHermesMessage(client, agent, model, prompt);
        const first = await client.waitForFinish(agent.id, timeoutMs);
        if (first.status !== 'idle') throw new RuntimeError(first.status === 'permission' ? 'PERMISSION_REQUIRED' : first.status === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_TURN_FAILED');
        const firstEntries = await assistantEntries(client, agent.id);
        const firstReply = firstEntries.at(-1)?.item.text || ''; row.firstReply = String(firstReply).includes(marker);
        if (providerReplyError(firstReply)) throw new RuntimeError(providerReplyError(firstReply));
        if (!row.firstReply) throw new RuntimeError('EMPTY_OR_UNEXPECTED_REPLY');
        if (provider === 'hermes') {
          const current = await client.fetchAgent({ agentId: agent.id });
          await sendVerifiedHermesMessage(client, current?.agent, model, 'What marker did I ask you to remember? Reply with that marker only. Do not use tools.');
        } else {
          await client.sendAgentMessage(agent.id, 'What marker did I ask you to remember? Reply with that marker only. Do not use tools.');
        }
        const second = await client.waitForFinish(agent.id, timeoutMs);
        if (second.status !== 'idle') throw new RuntimeError(second.status === 'permission' ? 'PERMISSION_REQUIRED' : second.status === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_TURN_FAILED');
        const secondEntries = await assistantEntries(client, agent.id);
        const followup = secondEntries.at(-1)?.item.text || ''; row.followup = latestAssistantCursor(secondEntries) !== latestAssistantCursor(firstEntries) && String(followup).includes(marker);
        if (providerReplyError(followup)) throw new RuntimeError(providerReplyError(followup));
        row.passed = row.firstReply && row.followup;
        });
        });
      }, timeoutMs * 2 + 30000, root);
    } catch (error) { row.code = safeCode(error); }
    results.push(row);
    updateState({ acceptance: { checkedAt: new Date().toISOString(), passed: false, providers: results } });
    if (options.onProgress) await options.onProgress({ ...row });
  }
  const merged = [...previous.filter(row => !selectedProviders.includes(row.provider)), ...results];
  const result = { checkedAt: new Date().toISOString(), passed: selectedProviders.every(provider => merged.some(row => row.provider === provider && row.passed && row.cleanup?.archived!==false && row.cleanup?.workspaceArchived!==false)), providers: merged };
  updateState({ acceptance: result }); return result;
}
function chatInput(message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 100000) throw new RuntimeError('INVALID_MESSAGE');
}
function chatCwd(cwd) {
  const directory = path.resolve(cwd || readState().settings?.cwd || locations().home);
  try { fs.accessSync(directory, fs.constants.R_OK); if (!fs.statSync(directory).isDirectory()) throw new Error(); }
  catch { throw new RuntimeError('INVALID_WORKSPACE'); }
  return directory;
}
export async function createChat(options = {}) {
  chatInput(options.message); const provider = options.provider;
  if (!PROVIDERS.includes(provider)) throw new RuntimeError('INVALID_PROVIDER');
  const root = controlRoot();
  const catalog = await readModels(provider, root); const cwd = chatCwd(options.cwd);
  const model = options.model || catalog.models.find(model => model.isDefault)?.id || catalog.models[0]?.id;
  if (!model || !catalog.models.some(entry => entry.id === model)) throw new RuntimeError('INVALID_MODEL');
  const modeId = options.mode || catalog.defaultModeId || undefined;
  if (modeId && !catalog.modes.some(mode => mode.id === modeId)) throw new RuntimeError('INVALID_MODE');
  const selected = catalog.models.find(entry => entry.id === model);
  const thinkingOptionId = options.thinking || selected.defaultThinkingOptionId || undefined;
  if (thinkingOptionId && !selected.thinkingOptions.some(option => option.id === thinkingOptionId)) throw new RuntimeError('INVALID_THINKING_OPTION');
  const timeoutMs = Math.min(Math.max(options.timeoutMs || 120000, 1000), 600000);
  let agentId;
  try {
    return await withClient(async client => {
      const workspace = await client.createWorkspace({ source: { kind: 'directory', path: cwd } });
      if (!workspace.workspace?.id) throw new RuntimeError('WORKSPACE_CREATE_FAILED');
      const agent = await client.createAgent({ provider, model, modeId, thinkingOptionId, cwd, workspaceId: workspace.workspace.id, title: options.title || `Hermes ${provider}`, ...(provider === 'hermes' ? {} : { initialPrompt: options.message }), labels: { 'hermes-paseo-plugin': readState().installationId } });
      agentId = agent.id;
      if (provider === 'hermes') {
        try {
          await sendVerifiedHermesMessage(client, agent, model, options.message);
        } catch (error) {
          if (error.code === 'MODEL_SELECTION_UNAVAILABLE') {
            await Promise.allSettled([client.archiveAgent(agentId), client.archiveWorkspace(workspace.workspace.id)]);
          }
          throw error;
        }
      }
      return chatResult(client, agentId, provider, model, timeoutMs);
    }, timeoutMs + 30000, root);
  } catch (error) {
    if (agentId && ['DAEMON_REQUEST_TIMEOUT', 'COMMAND_TIMEOUT'].includes(error.code)) return { agentId, provider, model, reply: '', status: 'pending' };
    throw error;
  }
}
export async function continueChat(options = {}) {
  chatInput(options.message);
  if (typeof options.agentId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(options.agentId)) throw new RuntimeError('INVALID_AGENT_ID');
  const timeoutMs = Math.min(Math.max(options.timeoutMs || 120000, 1000), 600000);
  let provider = null, model = null;
  try {
    return await withClient(async client => {
      const found = await client.fetchAgent({ agentId: options.agentId });
      if (!found?.agent) throw new RuntimeError('AGENT_NOT_FOUND');
      provider = found.agent.provider; model = found.agent.model || found.agent.config?.model || null;
      const previousCursor = latestAssistantCursor(await assistantEntries(client, options.agentId));
      if (provider === 'hermes') await sendVerifiedHermesMessage(client, found.agent, model, options.message);
      else await client.sendAgentMessage(options.agentId, options.message);
      return chatResult(client, options.agentId, provider, model, timeoutMs, previousCursor);
    }, timeoutMs + 30000);
  } catch (error) {
    if (['DAEMON_REQUEST_TIMEOUT', 'COMMAND_TIMEOUT'].includes(error.code)) return { agentId: options.agentId, provider, model, reply: '', status: 'pending' };
    throw error;
  }
}
