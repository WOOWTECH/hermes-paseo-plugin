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
import {runtimeDirectory,runtimeReady,prepareRuntimeManifest,markRuntimeReady,patchInstalledRuntime,priorRuntimeDirectory,pruneUnusedPriorReleases,discardPartialRuntime,removeUnusedLibcVariants,RUNTIME_REVISION} from './runtime-layout.mjs';
import {hostCapacity,INSTALL_PEAK_MIB,OUT_OF_SPACE_MIB} from './host-capacity.mjs';
import {daemonRevision} from './runtime-processes.mjs';
import {demonstrablyReusedPid,linuxContainerIdentity,instanceFromPreviousContainer} from './daemon-identity.mjs';
import {managedFeatures} from './daemon-config.mjs';
import {CONNECTION_TARGETS,DEFAULT_TARGET,connectionTarget,savedConnection,saveSelectedTarget,requiresBrand,targetConfiguration,targetPairUrl} from './connection-targets.mjs';
import {backupDaemonConfig} from './config-backup.mjs';
export { locations, readState, updateState } from './state.mjs';
export const PASEO_VERSION = '0.11.2';
const PROVIDERS = ['hermes', 'claude', 'codex', 'pi'];
const safeCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'RUNTIME_FAILED';
function packageRoot(pkg = 'cli', root = controlRoot()) { return path.join(root, 'node_modules/@getpaseo', pkg); }
function cliPath(root) { const file=path.join(packageRoot('cli',root),'bin/paseo');assertSafePath(file);return file; }
function packageVersion(root, pkg) { try { return JSON.parse(fs.readFileSync(path.join(packageRoot(pkg, root), 'package.json'), 'utf8')).version; } catch { return null; } }
export function inheritedEnv(target) {
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
  // The target a daemon starts with names its brand in the hello (see brand-identity.mjs). Only a start passes
  // one; a stray value inherited from the host is never handed on. Not a PASEO_ name: a managed `daemon start`
  // strips those, and the relay, app and CORS settings reach the daemon through its config.json instead.
  delete env.HERMES_PASEO_CONNECTION_TARGET;
  if (target !== undefined) env.HERMES_PASEO_CONNECTION_TARGET = connectionTarget(target).id;
  return env;
}
async function cli(args, options = {}, root = controlRoot()) {
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
/** Resolve only the exact live revision. Sharing a Paseo version does not make releases interchangeable. */
function controlRuntimeDirectory() {
 const loc=locations(), revision=daemonRevision(loc);
 if(revision&&revision!==RUNTIME_REVISION) {
  const prior=priorRuntimeDirectory(loc,revision);
  if(!prior)throw new RuntimeError('DAEMON_NOT_OWNED');
  return prior;
 }
 if(revision&&!runtimeReady(loc))throw new RuntimeError('RUNTIME_NOT_READY');
 return runtimeReady(loc)?runtimeDirectory(loc):null;
}
const controlRoot=()=>{const root=controlRuntimeDirectory();if(!root)throw new RuntimeError('RUNTIME_NOT_READY');return root;};
async function serverModule(relative, root = controlRoot()) {
 const file=path.join(packageRoot('server',root),relative);assertSafePath(file);
 return import(pathToFileURL(file).href);
}
async function controlModule(root = controlRoot()) { return serverModule('dist/server/server/daemon-instance.js',root); }
async function currentInstance(root = controlRuntimeDirectory()) { if(!root||!ownsHome())return null; return (await controlModule(root)).readDaemonInstance(locations().paseoHome); }
function instanceNeedsRuntimeRestart(instance) {
 if(process.platform!=='linux')return readState().daemonRuntimeRevision!==RUNTIME_REVISION;
 try{return !fs.readFileSync(`/proc/${instance.pid}/environ`,'utf8').split('\0').includes(`HERMES_PASEO_RUNTIME_REVISION=${RUNTIME_REVISION}`);}catch{return true;}
}
const TARGET_ENTRY = 'HERMES_PASEO_CONNECTION_TARGET=';
/**
 * The target a running daemon was started with, read from its environment (state.json where /proc is not available).
 * A daemon started before this plugin knew targets has none recorded and only ever served Paseo's relay and app, so it
 * counts as Paseo. null: it cannot be told, which is never taken for the saved target.
 */
function daemonTarget(instance) {
  if (process.platform === 'linux') {
    try {
      const env = fs.readFileSync(`/proc/${instance.pid}/environ`, 'utf8').split('\0');
      const value = env.find(entry => entry.startsWith(TARGET_ENTRY))?.slice(TARGET_ENTRY.length);
      if (value === undefined) return DEFAULT_TARGET;
      return CONNECTION_TARGETS.some(row => row.id === value) ? value : null;
    } catch { /* not readable here: use this plugin's own record below */ }
  }
  const state = readState();
  return state.daemonPid === instance.pid && state.daemonStartedAt === instance.startedAt ? state.activeTarget ?? DEFAULT_TARGET : null;
}
/** The target served by the daemon running from this profile: undefined when none runs, null when it cannot be told. No daemon is asked anything. */
async function runningTarget() {
  try {
    const instance = await currentInstance();
    if (!instance) return undefined;
    await verifyInstanceOwnership(instance);
    return daemonTarget(instance);
  } catch { return null; }
}
// What waits to be applied. A running daemon decides by itself: it serves the saved target or it does not. With none
// running, a saved change is pending until the next start applies it (activate clears the flag).
const configurationPending = (state, running, target) => running === undefined ? state.configurationPending === true : running !== target;
// A start leaves nothing pending. The flag is cleared only where it exists, so a profile that never saved a target keeps the state file it had.
const settledPending = () => readState().configurationPending === undefined ? {} : { configurationPending: false };
async function verifyInstanceOwnership(instance, root = controlRoot()) {
  if (!ownsHome() || !instance || !processIdentity(instance.pid)) throw new RuntimeError('DAEMON_NOT_OWNED');
  if (instance.uid !== (process.getuid?.() ?? instance.uid)) throw new RuntimeError('DAEMON_NOT_OWNED');
  // Linux metadata additionally checks argv and the home actually inherited by this PID.
  if (process.platform === 'linux') {
    try {
      const args = fs.readFileSync(`/proc/${instance.pid}/cmdline`, 'utf8').split('\0');
      const env = fs.readFileSync(`/proc/${instance.pid}/environ`, 'utf8').split('\0');
      const entry = path.join(packageRoot('server',root), 'dist/scripts/supervisor-entrypoint.js');
      const executable = fs.realpathSync(`/proc/${instance.pid}/exe`);
      const expectedNode = fs.realpathSync(process.execPath);
      // Paseo sets process.title, which replaces its original argv on Linux.
      const supervisor = args.includes(entry) || args[0] === 'Paseo Supervisor';
      if (!supervisor || executable !== expectedNode || instance.heartbeat !== true || !env.includes(`PASEO_HOME=${locations().paseoHome}`) || !env.includes(`HERMES_PASEO_RUNTIME_REVISION=${path.basename(root)}`)) throw new RuntimeError('DAEMON_NOT_OWNED');
    } catch { throw new RuntimeError('DAEMON_NOT_OWNED'); }
  }
}
async function releaseReusedPid(instance) {
  // Caller holds the runtime lock. Do not signal a process that reused a PID
  // from a previous container; only retire this profile's unchanged stale lock.
  const stale = value => instanceFromPreviousContainer(value, readState()) || demonstrablyReusedPid(value);
  if (!ownsHome() || instance?.uid !== process.getuid?.() || !stale(instance)) return false;
  const file = path.join(locations().paseoHome, 'paseo.pid');
  assertSafePath(file);
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.()) return false;
  const locks = await serverModule('dist/server/server/pid-lock.js');
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
/** The version and files of an installed release, which a ready one is also checked against on every start. */
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
    assertSafePath(cache);fs.rmSync(cache, { recursive: true, force: true });
    removeUnusedLibcVariants(root);
    await verifyRuntime(root);
    markRuntimeReady(loc);
  } catch (error) {
    const left = hostCapacity.availableMiB(loc.runtimeDir); // measured with the partial tree still on the volume
    try { discardPartialRuntime(loc); } catch { /* the next attempt discards it */ }
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
    try { await verifyRuntime(runtimeDirectory(loc)); }
    catch(error) {updateState({runtimeInstall:{revision:RUNTIME_REVISION,ok:false,code:safeCode(error),at:new Date().toISOString()}});throw error;}
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
// `target` is given only for a start in managed mode (a target was saved): it is applied at that start. A running
// daemon keeps the relay, app and CORS settings it started with (they are not live-reloadable), and before anything was
// saved the operator's settings are never touched; in both cases no target is given and the file is written as in rc.9.
async function writeConfig(port, launchers, target) {
  const loc = locations(); const file = path.join(loc.paseoHome, 'config.json');
  let config = {};
  if (fs.existsSync(file)) { try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new RuntimeError('CONFIG_CORRUPT'); } }
  const providers = configureProviders(config.agents?.providers, launchers, loc, inheritedEnv());
  let name=config.daemon?.name;
  try {
    const preferences=JSON.parse(fs.readFileSync(path.join(loc.stateDir,'preferences.json'),'utf8'));
    if(typeof preferences.name!=='string'||preferences.name.length>100||/[\x00-\x1f]/.test(preferences.name))throw new RuntimeError('CONFIG_INVALID');
    name=preferences.name;
  } catch(error) {if(error.code!=='ENOENT')throw new RuntimeError('CONFIG_INVALID');}
  const providersChanged = JSON.stringify(config.agents?.providers || {}) !== JSON.stringify(providers);
  config = {
    ...config, $schema: 'https://paseo.sh/schemas/paseo.config.v1.json', version: 1,
    daemon: { ...config.daemon, ...(name?{name}:{}), listen: `127.0.0.1:${port}`, hostnames: ['localhost', '127.0.0.1', '.localhost'], relay: { ...config.daemon?.relay, enabled: true }, mcp: { ...config.daemon?.mcp, enabled: true } },
    agents: { ...config.agents, providers, metadataGeneration: config.agents?.metadataGeneration || { providers: [] } },
    features: managedFeatures(config.features),
    log: { ...config.log, console: { level: 'warn' }, file: { level: 'warn', path: 'daemon.log', rotate: { maxSize: '5m', maxFiles: 2 } } },
  };
  if (target !== undefined) {
    config = targetConfiguration(config, target);
    // The first rewrite for a saved target keeps the operator's file once. Nothing is written if that cannot be done.
    if (!readState().configBackup) updateState({ configBackup: { at: new Date().toISOString(), copied: backupDaemonConfig(loc.paseoHome) } });
  }
  const { savePersistedConfig } = await serverModule('dist/server/server/config.js');
  try { savePersistedConfig(loc.paseoHome, config); fs.chmodSync(file, 0o600); } catch { throw new RuntimeError('CONFIG_INVALID'); }
  updateState({ port, providerLaunchers: launchers });
  return providersChanged;
}
function safeProvider(entry) {
  return { provider: entry.provider, label: entry.label || entry.provider, status: entry.status || (entry.available === true ? 'ready' : entry.available === false ? 'unavailable' : 'unknown'), enabled: entry.enabled !== false, defaultModeId: entry.defaultModeId || null, modes: (entry.modes || []).map(mode => ({ id: mode.id, label: mode.label || mode.id })), chatVerified: readState().acceptance?.providers?.some(row => row.provider === entry.provider && row.passed) || false };
}
async function withClient(fn, timeoutMs = 30000) {
  const root=controlRoot();
  await verifyInstanceOwnership(await currentInstance(root),root);
  const file=path.join(packageRoot('cli',root),'dist/utils/client.js');assertSafePath(file);
  const { connectToDaemon } = await import(pathToFileURL(file).href);
  const client = await connectToDaemon({ target: { kind: 'instance', home: locations().paseoHome }, timeout: 5000 });
  let timer;
  try {
    return await Promise.race([fn(client), new Promise((_, reject) => { timer = setTimeout(() => { void client.close().catch(() => {}); reject(new RuntimeError('DAEMON_REQUEST_TIMEOUT')); }, timeoutMs); timer.unref(); })]);
  } catch (error) { throw new RuntimeError(safeCode(error)); }
  finally { clearTimeout(timer); await client.close().catch(() => {}); }
}
/** Install/verify only: no ownership marker, config, target patch, daemon start/stop or enabled intent changes. */
export async function prepare() {
 if(runtimeReady(locations()))await installRuntime();
 else await withRuntimeLock(installRuntime,{timeoutMs:120000});
 return status();
}
export async function activate(options = {}) {
  return withRuntimeLock(async () => {
    ensureOwnedHome();
    let before=await currentInstance();
    if(before) {
      try {await verifyInstanceOwnership(before);} catch(error) {if(await releaseReusedPid(before))before=null;else throw error;}
    }
    if(before) {
      if(instanceNeedsRuntimeRestart(before)) {await installRuntime();return status();}
    }
    updateState({ desiredEnabled: true, phase: 'installing', lastError: null });
    try {
      if (Number(process.versions.node.split('.')[0]) < 22) throw new RuntimeError('NODE_VERSION_UNSUPPORTED');
      // A damaged choice stops here, before minutes of npm; the choice is read again where it is applied. Until a target
      // is saved (legacy mode) a start does what rc.9's did and nothing else: no relay, app or CORS settings, no runtime
      // patch, nothing deleted that it did not touch before.
      if (savedConnection(locations()).saved) removePairingFile(locations());
      await installRuntime();
      let existing = await currentInstance(); const launchers = await detectLaunchers({ installMissing: false });
      if (existing) {
        try { await verifyInstanceOwnership(existing); }
        catch (error) { if (await releaseReusedPid(existing)) existing = null; else throw error; }
      }
      if (existing) {
        await verifyInstanceOwnership(existing);
        if(instanceNeedsRuntimeRestart(existing)) {
          updateState({phase:'restart_required',lastError:{code:'RESTART_REQUIRED',at:new Date().toISOString()}});
          return status();
        }
        // The daemon serves another target than the selected one: nothing is written for it or asked of it. Its next stop
        // and start applies the saved target.
        const choice = savedConnection(locations());
        if (daemonTarget(existing) !== choice.target) {
          updateState({ phase: 'restart_required', lastError: { code: 'CONFIGURATION_PENDING', at: new Date().toISOString() } });
          return status();
        }
        const pending = readState().providerReloadPending;
        const needsApply = await writeConfig(locations().port, launchers) || (pending?.pid === existing.pid && pending?.startedAt === existing.startedAt);
        updateState({ providerReloadPending: { pid: existing.pid, startedAt: existing.startedAt } });
        try {
          const reload = await withClient(client => client.reloadDaemonConfig());
          if (!Array.isArray(reload?.appliedPaths) || !Array.isArray(reload?.restartRequiredPaths) || !Array.isArray(reload?.overrideControlledPaths) ||
              reload.restartRequiredPaths.length || reload.overrideControlledPaths.some(p => p === 'agents.providers' || p.startsWith('agents.providers.')) ||
              (needsApply && !reload.appliedPaths.includes('agents.providers'))) throw new RuntimeError('RESTART_REQUIRED');
        } catch { throw new RuntimeError('RESTART_REQUIRED'); }
        // The daemon serves the selected target (checked above), so a pending flag left by a save that raced a start is
        // stale. Where none was ever set (legacy mode) nothing is written.
        updateState({ phase: 'running', providerReloadPending: null, daemonPid: existing.pid, daemonStartedAt: existing.startedAt, daemonContainerIdentity: linuxContainerIdentity(), ...settledPending() });
      } else {
        // Managed mode (a target was saved) applies it here and only here: its relay, app and CORS settings go into
        // config.json, its brand into the daemon's environment, and for a Smart target the runtime is patched while no
        // daemon runs from it. Legacy mode starts exactly as rc.9 did. The patch comes first: a runtime it cannot patch
        // stops the start before config.json is backed up or rewritten, and a patch that is already in place is harmless.
        const choice = savedConnection(locations()), target = choice.saved ? choice.target : undefined;
        const port = await choosePort(locations().port);
        if (target !== undefined && requiresBrand(target)) patchInstalledRuntime(locations());
        await writeConfig(port, launchers, target);
        updateState({ phase: 'starting' });
        await cli(['daemon', 'start', '--timeout', '90'], target === undefined ? { timeoutMs: 105000 } : { timeoutMs: 105000, env: inheritedEnv(target) },runtimeDirectory(locations()));
        const instance = await currentInstance(); await verifyInstanceOwnership(instance);
        updateState({ phase: 'running', providerReloadPending: null, daemonPid: instance.pid, daemonStartedAt: instance.startedAt, daemonRuntimeRevision:RUNTIME_REVISION, daemonContainerIdentity: linuxContainerIdentity(), ...(target === undefined ? {} : { activeTarget: target }), ...settledPending() });
      }
      const result = await status();
      if (!result.daemon.reachable) throw new RuntimeError('DAEMON_UNREACHABLE');
      pruneUnusedPriorReleases(locations());
      updateState({ lastDiagnostic: { checkedAt: new Date().toISOString(), daemonReachable: true, providers: result.providers.map(row => ({ provider: row.provider, status: row.status })) } });
      return status();
    } catch (error) { updateState({ phase: error.code === 'RESTART_REQUIRED' ? 'restart_required' : 'error', lastError: { code: safeCode(error), at: new Date().toISOString() } }); throw new RuntimeError(safeCode(error)); }
  }, { timeoutMs: options.lockTimeoutMs || 360000 });
}
export async function deactivate() {
  return withRuntimeLock(async () => {
    let instance = await currentInstance();
    if (instance) {
      try { await verifyInstanceOwnership(instance); }
      catch (error) { if (await releaseReusedPid(instance)) instance = null; else throw error; }
    }
    if (instance) {
      await verifyInstanceOwnership(instance);
      const control = await controlModule();
      // The official lifecycle rechecks PID plus startedAt immediately before signaling.
      try { await control.stopDaemonInstance(locations().paseoHome, { instance, timeoutMs: 20000, force: false }); }
      catch (error) { throw new RuntimeError(safeCode(error)); }
    }
    updateState({ desiredEnabled:false, phase: 'disabled', daemonRuntimeRevision:null, daemonPid: null, daemonStartedAt: null, daemonContainerIdentity: null });
    return status();
  });
}
export async function status() {
  return singleFlight(`status:${locations().paseoHome}`,readStatus);
}
async function readStatus() {
  const state = readState(); const installed = runtimeReady(locations()); const owned = ownsHome();
  let providers = [], diagnosticCode = state.lastError?.code === 'RESTART_REQUIRED' ? 'RESTART_REQUIRED' : null;
  let target = DEFAULT_TARGET, activeTarget = null, targetSaved = false, connectionCode = null;
  // A record that exists but cannot be read is named (connectionCode) and shown as Paseo; saving a target replaces it.
  try { ({ target, saved: targetSaved } = savedConnection(locations())); }
  catch (error) { connectionCode = diagnosticCode = safeCode(error); targetSaved = true; }
  // Relay evidence counts only for the target it was taken on; a record from before targets existed was Paseo's.
  const verified = state.relayVerification?.verified === true && (state.relayVerification.target ?? DEFAULT_TARGET) === target;
  const daemon = { running: false, reachable: false, owned, pid: null, listen: null, relayEnabled: false, relayConnected: null, relayVerified: verified, relayVerifiedAt: verified ? state.relayVerification.checkedAt || null : null };
  if (owned) {
    try {
      const instance = await currentInstance();
      if (instance) {
        await verifyInstanceOwnership(instance); daemon.running = true; daemon.version=PASEO_VERSION; daemon.runtimeRevision=path.basename(controlRoot()); daemon.pid = instance.pid; daemon.listen = instance.listen;
        activeTarget = daemonTarget(instance);
        if(instanceNeedsRuntimeRestart(instance))diagnosticCode='RESTART_REQUIRED';
        const key=JSON.stringify([locations().paseoHome,instance.pid,instance.startedAt,state.updatedAt]);
        const sample = await daemonStatusWindow(key,()=>withClient(client => client.getDaemonStatus({ timeout: 5000 }), 8000));
        const result=sample.value;
        daemon.statusCheckedAt=new Date(sample.checkedAt).toISOString();daemon.statusMaxAgeMs=3000;
        daemon.reachable = true; daemon.workerPid = result.pid; daemon.relayEnabled = result.relay?.enabled === true; daemon.relayConnected = typeof result.relay?.connected === 'boolean' ? result.relay.connected : null;
        providers = (result.providers || []).filter(row => PROVIDERS.includes(row.provider)).map(safeProvider);
      }
    } catch (error) { diagnosticCode = safeCode(error); }
  }
  // A start interrupted by a Dashboard restart is as stuck as 'running' with no daemon:
  // the persisted phase stays 'installing'/'starting' forever, and the host adapter's
  // unattended recovery accepts only 'not_installed' / 'stopped'.
  const stalled = ['running', 'installing', 'starting'].includes(state.phase);
  const phase = stalled && !daemon.running ? 'stopped' : state.phase || 'not_installed';
  const failure=state.runtimeInstall?.revision===RUNTIME_REVISION&&state.runtimeInstall.ok===false?state.runtimeInstall:null;
  return { installed: installed&&!failure, prepare:{stage:failure?'failed':installed?'ready':'pending',code:failure?.code||null,...(failure?{at:failure.at}:{}),...(failure?.requiredMiB===undefined?{}:{requiredMiB:failure.requiredMiB,availableMiB:failure.availableMiB})}, version: installed ? PASEO_VERSION : null, enabled: state.desiredEnabled === true, phase, daemon, providers, chatVerified: state.acceptance?.passed === true, pairingAvailable: typeof state.pairingCreatedAt === 'string', diagnosticCode,
    selectedTarget: target, targetSaved, connectionCode, activeTarget: daemon.running ? activeTarget : null, configurationPending: configurationPending(state, daemon.running ? activeTarget : undefined, target), state };
}
export async function diagnose() {
  const snapshot = await status(); const launchers = await detectLaunchers();
  let providers = snapshot.providers;
  if (snapshot.daemon.reachable) {
    try { providers = await withClient(async client => (await client.getProvidersSnapshot()).entries.filter(row => PROVIDERS.includes(row.provider)).map(safeProvider), 150000); }
    catch (error) { snapshot.diagnosticCode = safeCode(error); }
  }
  const loc = locations();
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
async function readModels(provider) {
  return withClient(async client => {
    const result = await client.listProviderModels(provider);
    const snapshot = await client.getProvidersSnapshot(); const entry = snapshot.entries.find(row => row.provider === provider);
    if (result.error) throw new RuntimeError('PROVIDER_MODELS_UNAVAILABLE');
    return { ...safeProvider(entry || { provider, status: 'unknown' }), models: (result.models || []).map(model => ({ id: model.id, label: model.label || model.id, isDefault: model.isDefault === true, defaultThinkingOptionId: model.defaultThinkingOptionId || null, thinkingOptions: (model.thinkingOptions || []).map(option => ({ id: option.id, label: option.label || option.id, isDefault: option.isDefault === true })) })) };
  }, 150000);
}
/**
 * A pairing offer from the running daemon for `target` only. Throws unless it is that target's app, and, once a target is
 * saved, its relay and TLS as well. Before that (legacy) the relay is whatever the daemon is configured with, as in rc.9.
 */
async function relayOffer(target, { legacy = false } = {}) {
  const offer = await cli(['daemon', 'pair', '--relay'], { timeoutMs: 15000 });
  if (!offer.url || !offer.relayEnabled) throw new RuntimeError('PAIRING_UNAVAILABLE');
  return { relayEnabled: true, url: targetPairUrl(offer.url, target, { legacy }), target };
}
/**
 * The selected target's pairing link, lock-free (the daemon is only asked for it) and never stored: the offer
 * is a bearer credential, so it goes to the caller and nowhere else. Only that it was made is recorded.
 */
export async function pair() {
  const { saved, target } = savedConnection(locations());
  const result = await status(); if (!result.daemon.reachable) throw new RuntimeError('DAEMON_UNREACHABLE');
  // A saved target is not offered until the daemon has been stopped and started with it.
  if (result.configurationPending || result.activeTarget !== target) throw new RuntimeError('CONFIGURATION_PENDING');
  const offer = await relayOffer(target, { legacy: !saved });
  const pairing = { url: offer.url, target, createdAt: new Date().toISOString() };
  updateState({ pairingCreatedAt: pairing.createdAt });
  return pairing;
}
// Earlier releases kept the pairing offer here. It is a bearer credential that nothing ever read back, so
// it is removed instead of kept: a regular file only, and never through a link.
function removePairingFile(loc) {
  const file = path.join(loc.stateDir, 'pairing.private.json');
  try { if (assertSafePath(file)?.isFile()) fs.unlinkSync(file); } catch { /* absent, a link, or not ours to remove */ }
}
/**
 * Records the connection target and nothing else: no daemon is asked anything, and the choice reaches the
 * daemon at its next stop and start. A change marks the configuration pending, withdraws the relay evidence
 * of the previous target and the pairing offer an older release left behind, and keeps the daemon's key pair
 * and server id, so devices paired to the same target keep working. Saving the target again changes nothing.
 */
export async function saveConnectionSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'target') || typeof input.target !== 'string') throw new RuntimeError('INVALID_TARGET');
  const target = connectionTarget(input.target).id, loc = locations();
  let previous = null, recorded = false;
  try { ({ target: previous, saved: recorded } = savedConnection(loc)); } catch (error) { if (error.code !== 'CONNECTION_STATE_CORRUPT') throw error; }
  // The first explicit save, Paseo included, is what ends legacy mode: from the next start the plugin writes the target's
  // settings. It is not a change of target, so it withdraws nothing and leaves nothing pending.
  if (!recorded || previous !== target) {
    if (previous !== target) {
      // Pending is published before the new choice, so a partial write never offers the new app while the old
      // daemon still owns the connection.
      updateState({ configurationPending: true, relayVerification: null, pairingCreatedAt: null });
    }
    removePairingFile(loc);
    saveSelectedTarget(loc, target);
  }
  // Pending unless the daemon that runs already serves it (a change undone before the next start is no change).
  // Only its files and environment are read; nothing is asked of it.
  const running = await runningTarget(), state = readState();
  if (running === target && state.configurationPending === true) updateState({ configurationPending: false });
  return { saved: true, target, configurationPending: configurationPending(readState(), running, target) };
}
async function connectViaOffer(url, work, timeoutMs = 30000) {
  const root=controlRoot();
  const file=path.join(packageRoot('cli',root),'dist/utils/client.js');assertSafePath(file);
  const { connectToDaemon } = await import(pathToFileURL(file).href);
  // An endpoint target keeps its client id under $PASEO_HOME; use the managed home, never ~/.paseo.
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
 * host, enters through the relay and completes the encrypted handshake with this daemon, like the Paseo
 * app does. The offer is a credential; it stays in memory and is never stored, logged or returned.
 * `deps` lets tests replace the daemon, the offer and the connection.
 */
export async function verifyRelay(deps = {}) {
  return singleFlight(`relay:${locations().paseoHome}`, () => readRelay(deps));
}
async function readRelay({ daemon = async () => { const result = await status(); return { ...result.daemon, configurationPending: result.configurationPending }; }, offer = relayOffer, connect = connectViaOffer } = {}) {
  const current = await daemon();
  if (!current.reachable) throw new RuntimeError('DAEMON_UNREACHABLE');
  // A daemon still serving the previous target says nothing about the saved one.
  if (current.configurationPending === true) throw new RuntimeError('CONFIGURATION_PENDING');
  const { saved, target } = savedConnection(locations());
  const checkedAt = new Date().toISOString();
  try {
    const { url } = await offer(target, { legacy: !saved });
    await connect(url, client => client.getDaemonStatus({ timeout: 10000 }));
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
  for (const provider of selectedProviders) {
    const row = { provider, passed: false, firstReply: false, followup: false, model: null, modeId: null, agentId: null };
    try {
      const catalog = await listModels(provider);
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
      }, timeoutMs * 2 + 30000);
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
  const catalog = await listModels(provider); const cwd = chatCwd(options.cwd);
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
    }, timeoutMs + 30000);
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
