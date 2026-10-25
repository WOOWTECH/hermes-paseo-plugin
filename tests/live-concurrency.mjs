#!/usr/bin/env node
/** Opt-in live verification. Importing this module never connects or calls a model. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { locations, privateDirectory, atomicJson } from '../src/state.mjs';
import { runtimeDirectory, runtimeReady } from '../src/runtime-layout.mjs';
import { assistantEntries, latestAssistantCursor } from '../src/chat-result.mjs';
import { providerReplyError } from '../src/provider-reply.mjs';

export const HELP = `Usage: node tests/live-concurrency.mjs --run --model MODEL [options]

Runs real, potentially billed Hermes conversations through the installed Paseo SDK.
Without --run, no connection or model call occurs. No model is selected implicitly.

  --help                   Show this help without connecting
  --run                    Explicitly authorize this live run
  --model MODEL            Required, or set HERMES_PASEO_LIVE_MODEL
  --concurrency N          Chats per round, 1..4 (default 3)
  --rounds N               Sequential rounds, 1..2 (default 1; at most 8 sessions)
  --timeout-ms N           Whole-turn deadline, 1000..600000 (default 180000)
  --request-timeout-ms N   Setup/cleanup deadline, 100..60000 (default 30000)
  --output-dir DIRECTORY   Parent for a unique private run directory
                          Default: <profile state directory>/live-concurrency

Each session has its own directory, workspace and agent, and exactly two turns on
success. The follow-up contains no marker. Creation and message calls are never
retried; reconnect/replay is disabled. Missing creationLifecycle support fails
before creation, because recovery requires caller-selected resource IDs.

stdout and metrics.json contain sanitized metrics only. recovery.private.json
(mode 0600, enclosing directory 0700) retains owned IDs and operation state, even
on failure. Do not publish it. Workspace directories and archived daemon history
are retained as evidence. An uncertain creation/cleanup stops subsequent rounds;
inspect the private ledger before manually recovering resources or rerunning.
Exit codes: 0 passed/skipped/help, 1 live failure, 2 invalid options.
`;

class LiveError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const codeOf = error => error instanceof LiveError ? error.code : 'SDK_REQUEST_FAILED';
const elapsed = start => Math.max(0, Math.round(performance.now() - start));
const defaults = { run: false, help: false, concurrency: 3, rounds: 1, timeoutMs: 180000, requestTimeoutMs: 30000 };
const flags = new Map([
  ['--model', 'model'], ['--concurrency', 'concurrency'], ['--rounds', 'rounds'],
  ['--timeout-ms', 'timeoutMs'], ['--request-timeout-ms', 'requestTimeoutMs'], ['--output-dir', 'outputDir'],
]);
const numeric = new Set(['concurrency', 'rounds', 'timeoutMs', 'requestTimeoutMs']);

function validateOptions(options) {
  if (!options || Object.keys(options).some(key => ![...Object.keys(defaults), 'model', 'outputDir'].includes(key))) throw new LiveError('INVALID_OPTIONS');
  const result = { ...defaults, ...options };
  if (typeof result.run !== 'boolean' || typeof result.help !== 'boolean') throw new LiveError('INVALID_OPTIONS');
  for (const [key, min, max] of [['concurrency', 1, 4], ['rounds', 1, 2], ['timeoutMs', 1000, 600000], ['requestTimeoutMs', 100, 60000]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new LiveError('INVALID_LIMIT');
  }
  if (result.concurrency * result.rounds > 8) throw new LiveError('INVALID_LIMIT');
  if (result.model !== undefined && (typeof result.model !== 'string' || !/^\S{1,256}$/u.test(result.model) || /[\x00-\x1f\x7f]/.test(result.model))) throw new LiveError('INVALID_MODEL');
  if (result.run && !result.help && !result.model) throw new LiveError('MODEL_REQUIRED');
  if (result.outputDir !== undefined && (typeof result.outputDir !== 'string' || !result.outputDir.trim() || /[\x00-\x1f\x7f]/.test(result.outputDir))) throw new LiveError('INVALID_OUTPUT_DIRECTORY');
  return result;
}

export function parseOptions(argv, env = process.env) {
  const options = { ...defaults };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new LiveError('DUPLICATE_OPTION');
    seen.add(flag);
    if (flag === '--run' || flag === '--help') { options[flag.slice(2)] = true; continue; }
    const key = flags.get(flag);
    if (!key) throw new LiveError('UNKNOWN_OPTION');
    const value = argv[++index];
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new LiveError('OPTION_VALUE_REQUIRED');
    if (numeric.has(key) && !/^[0-9]+$/.test(value)) throw new LiveError('INVALID_LIMIT');
    options[key] = numeric.has(key) ? Number(value) : value;
  }
  if (options.model === undefined && env.HERMES_PASEO_LIVE_MODEL) options.model = env.HERMES_PASEO_LIVE_MODEL;
  return validateOptions(options);
}

async function bounded(operation, timeoutMs, code = 'REQUEST_TIMEOUT') {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new LiveError(code)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Same instance targeting and credential resolution as runtime.mjs, with an
// explicit quiet SDK logger. SDK defaults otherwise log unsanitized errors.
export function webSocketConstructor(module) {
  // require.resolve uses the CommonJS export condition. Node's namespace for
  // that ws entry can contain only default, even when ESM exposes WebSocket.
  const candidate = module.WebSocket ?? module.default?.WebSocket ?? module.default;
  if (typeof candidate !== 'function') throw new LiveError('SDK_WEBSOCKET_UNAVAILABLE');
  return candidate;
}
async function connectManagedRuntime(loc, timeoutMs) {
  if (!runtimeReady(loc)) throw new LiveError('MANAGED_RUNTIME_UNAVAILABLE');
  const root = runtimeDirectory(loc);
  const require = createRequire(path.join(root, 'package.json'));
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const [{ DaemonClient }, socketModule, { waitForDaemonReady }, { resolveDaemonTarget, resolveDaemonCredential }] = await Promise.all([
    load('@getpaseo/client/internal/daemon-client'), load('ws'), load('@getpaseo/server/daemon-control'),
    import(pathToFileURL(path.join(root, 'node_modules/@getpaseo/cli/dist/utils/client.js')).href),
  ]);
  const WebSocket = webSocketConstructor(socketModule);
  const instance = await waitForDaemonReady(loc.paseoHome, { timeoutMs });
  const target = resolveDaemonTarget(instance.listen);
  const credential = resolveDaemonCredential(instance.listen, loc.paseoHome);
  const quiet = () => {};
  const client = new DaemonClient({
    url: target.url, clientId: randomUUID(), clientType: 'cli', connectTimeoutMs: timeoutMs,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet }, reconnect: { enabled: false },
    ...(credential?.kind === 'password' ? { password: credential.password } : {}),
    ...(credential?.kind === 'localCredential' ? { localCredential: () => credential.token } : {}),
    webSocketFactory: (url, config) => new WebSocket(url, config?.protocols, {
      headers: config?.headers, ...(target.type === 'ipc' ? { socketPath: target.socketPath } : {}),
    }),
  });
  try { await client.connect(); return client; }
  catch (error) { await bounded(() => client.close(), timeoutMs).catch(() => {}); throw error; }
}

function archiveConfirmed(receipt, id) {
  return Boolean(receipt && typeof receipt.archivedAt === 'string' && Number.isFinite(Date.parse(receipt.archivedAt)) && !receipt.error &&
    ['id', 'agentId', 'workspaceId'].every(key => receipt[key] === undefined || receipt[key] === id));
}

/** Dependency injection is for offline tests; the CLI always loads the managed SDK. */
export async function runLiveConcurrency(input, { connect = connectManagedRuntime, resolveLocations = locations } = {}) {
  const options = validateOptions(input); // Also protect callers bypassing the CLI parser.
  if (options.help || !options.run) return { metrics: { status: 'skipped', passed: false, modelCalls: 0 } };
  const start = performance.now();
  const loc = resolveLocations();
  const parent = path.resolve(options.outputDir || path.join(loc.stateDir, 'live-concurrency'));
  privateDirectory(parent);
  const runDirectory = fs.mkdtempSync(path.join(parent, 'run-'));
  fs.chmodSync(runDirectory, 0o700);
  const metrics = {
    version: 1, status: 'running', passed: false, concurrency: options.concurrency, rounds: options.rounds,
    totalSessions: options.concurrency * options.rounds, elapsedMs: 0, evidencePersisted: true,
    connectionClosed: false, sessions: [],
  };
  const recovery = { version: 1, completed: false, sessions: [] };
  // Generate every marker before any turn, including later rounds, so isolation
  // checks cover every other session. Neither prompts nor markers are persisted.
  const sessions = Array.from({ length: metrics.totalSessions }, (_, index) => {
    const row = {
      session: index + 1, round: Math.floor(index / options.concurrency) + 1, status: 'pending', passed: false, elapsedMs: 0,
      turns: [1, 2].map(turn => ({ turn, status: 'pending', passed: false, elapsedMs: 0 })),
      cleanup: { agent: 'not_attempted', workspace: 'not_attempted' }, recoveryRequired: false,
    };
    const owned = {
      session: row.session, workspacePath: path.join(runDirectory, `session-${row.session}`),
      workspaceId: `wks_${randomBytes(8).toString('hex')}`, agentId: randomUUID(),
      workspaceCreation: 'not_attempted', agentCreation: 'not_attempted', followup: 'not_attempted',
      workspaceOwned: false, agentOwned: false,
    };
    metrics.sessions.push(row); recovery.sessions.push(owned);
    return { row, owned, marker: `HERMES_PASEO_LIVE_${randomUUID().replaceAll('-', '')}` };
  });
  // Keep evidence writes independent from cleanup. A disk failure must not skip
  // an archive attempt, and must never be reported as a successful verification.
  function save() {
    metrics.elapsedMs = elapsed(start);
    try {
      atomicJson(path.join(runDirectory, 'recovery.private.json'), recovery);
      atomicJson(path.join(runDirectory, 'metrics.json'), metrics);
      return true;
    } catch { metrics.evidencePersisted = false; return false; }
  }
  function requireEvidence() { if (!save()) throw new LiveError('EVIDENCE_WRITE_FAILED'); }
  let client;
  async function verifySession(session) {
    const { row, owned, marker } = session;
    const started = performance.now();
    row.status = 'running';
    const request = operation => bounded(operation, options.requestTimeoutMs);
    // Creation updates can prove ownership even when the final reply is lost.
    // A requested ID alone is not proof: the daemon may reject an ID conflict.
    const observeCreation = kind => snapshot => {
      const id = owned[`${kind}Id`];
      if (snapshot?.idempotencyKey === id && snapshot[`${kind}Id`] === id && snapshot[kind]?.id === id) {
        owned[`${kind}Owned`] = true; save();
      }
    };
    try {
      privateDirectory(owned.workspacePath);
      owned.workspaceCreation = 'unconfirmed'; row.cleanup.workspace = 'pending';
      requireEvidence(); // IDs are durable before a possibly ambiguous creation.
      const workspace = await request(() => client.createWorkspace({
        workspaceId: owned.workspaceId, idempotencyKey: owned.workspaceId, onEvent: observeCreation('workspace'),
        source: { kind: 'directory', path: owned.workspacePath },
      }));
      if (workspace?.workspace?.id === owned.workspaceId) owned.workspaceOwned = true;
      if (workspace?.workspace?.id !== owned.workspaceId || workspace.error) throw new LiveError('WORKSPACE_CREATE_UNCONFIRMED');
      owned.workspaceCreation = 'confirmed'; requireEvidence();
      let previousCursor = null; let previousSequence = -1;
      for (const turn of row.turns) {
        const turnStart = performance.now();
        turn.status = 'running';
        const remaining = () => Math.max(1, Math.floor(options.timeoutMs - (performance.now() - turnStart)));
        const duringTurn = operation => {
          if (performance.now() - turnStart >= options.timeoutMs) throw new LiveError('TURN_TIMEOUT');
          return bounded(operation, remaining(), 'TURN_TIMEOUT');
        };
        try {
          if (turn.turn === 1) {
            owned.agentCreation = 'unconfirmed'; row.cleanup.agent = 'pending'; requireEvidence();
            const agent = await duringTurn(() => client.createAgent({
              agentId: owned.agentId, idempotencyKey: owned.agentId, onEvent: observeCreation('agent'),
              provider: 'hermes', model: options.model, cwd: owned.workspacePath, workspaceId: owned.workspaceId,
              title: 'Hermes Paseo live concurrency verification', labels: { 'hermes-paseo-live-verification': 'true' },
              initialPrompt: `Connection check only. Do not use tools or edit files. Remember ${marker}. Reply with exactly ${marker}.`,
            }));
            if (agent?.id !== owned.agentId) throw new LiveError('AGENT_CREATE_UNCONFIRMED');
            owned.agentOwned = true; owned.agentCreation = 'confirmed'; requireEvidence();
          } else {
            owned.followup = 'unconfirmed'; requireEvidence();
            await duringTurn(() => client.sendAgentMessage(owned.agentId,
              'What marker did I ask you to remember? Reply with that marker only. Do not use tools or edit files.'));
            owned.followup = 'acknowledged'; requireEvidence();
          }
          const finished = await duringTurn(() => client.waitForFinish(owned.agentId, remaining()));
          if (finished?.status !== 'idle' || finished.error) throw new LiveError(
            finished?.status === 'timeout' ? 'TURN_TIMEOUT' : finished?.status === 'permission' ? 'PERMISSION_REQUIRED' : 'TURN_FAILED');
          const entries = await duringTurn(() => assistantEntries(client, owned.agentId));
          const cursor = latestAssistantCursor(entries);
          const reply = entries.at(-1)?.item.text || '';
          const replyError = providerReplyError(reply);
          // Check all visible assistant entries: an earlier leaked marker must
          // not disappear merely because the final message looks correct.
          const otherMarkers = sessions.filter(other => other !== session).map(other => other.marker);
          const latest = entries.at(-1);
          turn.newAssistantCursor = cursor !== null && cursor !== previousCursor &&
            Number.isInteger(latest?.seqStart) && Number.isInteger(latest?.seqEnd) &&
            latest.seqEnd >= latest.seqStart && latest.seqEnd > previousSequence;
          turn.ownMarker = reply.includes(marker);
          turn.isolated = !entries.some(entry => otherMarkers.some(other => entry.item.text.includes(other)));
          if (replyError) throw new LiveError(replyError);
          if (!turn.newAssistantCursor) throw new LiveError('STALE_ASSISTANT_CURSOR');
          if (!turn.isolated) throw new LiveError('CROSS_SESSION_MARKER');
          if (!turn.ownMarker) throw new LiveError('MARKER_MISSING');
          previousCursor = cursor; previousSequence = latest.seqEnd; turn.passed = true; turn.status = 'passed';
        } catch (error) { turn.status = 'failed'; turn.code = codeOf(error); throw error; }
        finally { turn.elapsedMs = elapsed(turnStart); save(); }
      }
    } catch (error) { row.code = codeOf(error); }
    finally {
      // Archive only identities confirmed by creation receipts/updates. Keep
      // ambiguous caller-selected IDs privately for manual reconciliation.
      for (const kind of ['agent', 'workspace']) {
        if (owned[`${kind}Creation`] === 'not_attempted') continue;
        if (!owned[`${kind}Owned`]) {
          row.cleanup[kind] = 'unconfirmed'; owned[`${kind}Archive`] = 'unconfirmed'; save(); continue;
        }
        try {
          const receipt = await request(() => kind === 'agent' ? client.archiveAgent(owned.agentId) : client.archiveWorkspace(owned.workspaceId));
          if (!archiveConfirmed(receipt, owned[`${kind}Id`])) throw new LiveError('ARCHIVE_UNCONFIRMED');
          row.cleanup[kind] = 'archived';
        } catch { row.cleanup[kind] = 'failed'; }
        owned[`${kind}Archive`] = row.cleanup[kind]; save();
      }
      row.recoveryRequired = ['agent', 'workspace'].some(kind => owned[`${kind}Creation`] === 'unconfirmed' || row.cleanup[kind] === 'failed');
      for (const turn of row.turns) if (turn.status === 'pending') turn.status = 'skipped';
      row.passed = row.turns.every(turn => turn.passed) && !row.recoveryRequired;
      row.status = row.passed ? 'passed' : 'failed'; row.elapsedMs = elapsed(started);
      if (row.recoveryRequired && !row.code) row.code = 'CLEANUP_UNCONFIRMED';
      save();
    }
  }
  try {
    requireEvidence();
    // If connection finishes after the deadline, close that late client too.
    let connectionExpired = false;
    try {
      client = await bounded(async () => {
        const connected = await connect(loc, options.requestTimeoutMs);
        if (connectionExpired) { await bounded(() => connected.close(), options.requestTimeoutMs).catch(() => {}); throw new LiveError('CONNECT_TIMEOUT'); }
        return connected;
      }, options.requestTimeoutMs, 'CONNECT_TIMEOUT');
    } catch (error) { connectionExpired = true; throw error; }
    if (client.getLastServerInfoMessage()?.features?.creationLifecycle !== true) throw new LiveError('OWNED_CREATION_UNSUPPORTED');
    const catalog = await bounded(() => client.listProviderModels('hermes'), options.requestTimeoutMs);
    if (catalog?.error || !catalog?.models?.some(model => model.id === options.model)) throw new LiveError('MODEL_UNAVAILABLE');
    for (let round = 1; round <= options.rounds; round++) {
      const batch = sessions.filter(session => session.row.round === round);
      const results = await Promise.allSettled(batch.map(verifySession));
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          batch[index].row.passed = false; batch[index].row.status = 'failed';
          batch[index].row.code = 'SESSION_FAILED'; batch[index].row.recoveryRequired = true;
        }
      });
      if (!metrics.evidencePersisted || batch.some(session => session.row.recoveryRequired)) break;
    }
  } catch (error) { metrics.code = codeOf(error); }
  finally {
    if (client) {
      try { await bounded(() => client.close(), options.requestTimeoutMs); metrics.connectionClosed = true; }
      catch { metrics.code ||= 'CONNECTION_CLOSE_FAILED'; }
    }
    for (const { row } of sessions) if (row.status === 'pending') {
      row.status = 'skipped'; row.code = 'RUN_STOPPED';
      for (const turn of row.turns) turn.status = 'skipped';
    }
    recovery.completed = true;
    metrics.passedSessions = metrics.sessions.filter(row => row.passed).length;
    metrics.recoveryRequired = metrics.sessions.some(row => row.recoveryRequired);
    metrics.passed = !metrics.code && metrics.evidencePersisted && metrics.connectionClosed && metrics.sessions.every(row => row.passed);
    metrics.status = metrics.passed ? 'passed' : 'failed';
    if (!save()) { metrics.passed = false; metrics.status = 'failed'; metrics.code = 'EVIDENCE_WRITE_FAILED'; }
  }
  return { metrics, runDirectory }; // The CLI deliberately never prints this path.
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  let options;
  try { options = parseOptions(argv, env); }
  catch (error) { process.stdout.write(`${JSON.stringify({ status: 'failed', code: codeOf(error) })}\n`); return 2; }
  if (options.help) { process.stdout.write(HELP); return 0; }
  try {
    const { metrics } = await runLiveConcurrency(options, dependencies);
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
    return metrics.status === 'skipped' || metrics.passed ? 0 : 1;
  } catch (error) { process.stdout.write(`${JSON.stringify({ status: 'failed', code: codeOf(error) })}\n`); return 1; }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  // Match the control CLI: finish after bounded cleanup even if an SDK handle
  // remains open. The durable ledger records every unconfirmed operation.
  const exitCode = await main();
  process.stdout.write('', () => process.exit(exitCode));
}
