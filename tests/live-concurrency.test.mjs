import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setImmediate as nextTick } from 'node:timers/promises';
import { parseOptions, runLiveConcurrency } from './live-concurrency.mjs';

const model = 'configured-test-catalog-model';
const stamp = '2026-10-25T00:00:00.000Z';
const privateText = 'SECRET_REPLY_AUTH_AND_ERROR_DETAILS';
const forever = () => new Promise(() => {});
const options = extra => ({ ...parseOptions(['--run', '--model', model], {}), ...extra });
const entry = (seq, text) => ({ turnId: `turn-${seq}`, seqStart: seq, seqEnd: seq, timestamp: stamp, item: { type: 'assistant_message', text } });

function fixture(t, hooks = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-paseo-live-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], agents = new Map(), workspaces = new Map();
  let active = 0, peak = 0, connections = 0;
  const record = (name, id) => calls.push({ name, id });
  const client = {
    getLastServerInfoMessage: () => ({ features: { creationLifecycle: hooks.supported !== false } }),
    listProviderModels: async () => { record('catalog'); return { models: hooks.models || [{ id: model }] }; },
    createWorkspace: async input => {
      record('create-workspace', input.workspaceId);
      assert.match(input.workspaceId, /^wks_[a-f0-9]{16}$/, 'Paseo 0.11.2 workspace ID wire format');
      const index = workspaces.size;
      assert.ok(input.source.path.startsWith(directory + path.sep));
      assert.equal(fs.statSync(input.source.path).mode & 0o777, 0o700);
      // The recovery ledger must exist *before* a mutating SDK call starts.
      const ledger = JSON.parse(fs.readFileSync(path.join(path.dirname(input.source.path), 'recovery.private.json')));
      assert.ok(ledger.sessions.some(row => row.workspaceId === input.workspaceId && row.workspaceCreation === 'unconfirmed'));
      workspaces.set(input.workspaceId, { input, index });
      if (hooks.createWorkspace) return hooks.createWorkspace(input, index);
      return { workspace: { id: input.workspaceId } };
    },
    createAgent: async input => {
      record('create-agent', input.agentId);
      assert.match(input.agentId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, 'Paseo agent ID is a UUID');
      const workspace = workspaces.get(input.workspaceId);
      assert.ok(workspace);
      assert.equal(input.cwd, workspace.input.source.path);
      assert.equal(input.model, model);
      const marker = input.initialPrompt.match(/HERMES_PASEO_LIVE_[0-9a-f]+/)[0];
      const agent = { input, index: workspace.index, marker, turn: 1 };
      agents.set(input.agentId, agent); peak = Math.max(peak, ++active);
      const ledger = JSON.parse(fs.readFileSync(path.join(path.dirname(input.cwd), 'recovery.private.json')));
      assert.ok(ledger.sessions.some(row => row.agentId === input.agentId && row.agentCreation === 'unconfirmed'));
      if (hooks.createAgent) return hooks.createAgent(agent);
      return { id: input.agentId };
    },
    waitForFinish: async (id, timeoutMs) => {
      assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0, 'official SDK requires a positive integer timeout');
      record('wait', id);
      const agent = agents.get(id); assert.ok(agent);
      // Yield across peers so a sequential harness cannot pass peak checks.
      await nextTick();
      if (hooks.wait) return hooks.wait(agent);
      return { status: 'idle' };
    },
    fetchAgentTimeline: async id => {
      record('timeline', id);
      const agent = agents.get(id); assert.ok(agent);
      if (hooks.timeline) return hooks.timeline(agent, [...agents.values()]);
      return { entries: Array.from({ length: agent.turn }, (_, index) => entry(index + 1, agent.marker)) };
    },
    sendAgentMessage: async (id, text) => {
      record('send', id);
      const agent = agents.get(id); assert.ok(agent);
      for (const peer of agents.values()) assert.equal(text.includes(peer.marker), false, 'follow-up must not give away any marker');
      assert.equal(agent.turn, 1, 'no message retry');
      agent.turn = 2;
      if (hooks.send) return hooks.send(agent);
    },
    archiveAgent: async id => {
      record('archive-agent', id);
      const agent = agents.get(id); assert.ok(agent, 'only a requested owned agent can be archived');
      active--;
      if (hooks.archiveAgent) return hooks.archiveAgent(agent);
      return { archivedAt: stamp };
    },
    archiveWorkspace: async id => {
      record('archive-workspace', id);
      const workspace = workspaces.get(id); assert.ok(workspace, 'only a requested owned workspace can be archived');
      if (hooks.archiveWorkspace) return hooks.archiveWorkspace(workspace);
      return { workspaceId: id, archivedAt: stamp, error: null };
    },
    close: async () => { record('close'); if (hooks.close) return hooks.close(); },
  };
  const dependencies = {
    resolveLocations: () => ({ stateDir: directory }),
    connect: async () => { connections++; return client; },
  };
  return { directory, client, dependencies, calls, agents, workspaces, get peak() { return peak; }, get connections() { return connections; } };
}
function readEvidence(result) {
  return {
    metrics: JSON.parse(fs.readFileSync(path.join(result.runDirectory, 'metrics.json'))),
    recovery: JSON.parse(fs.readFileSync(path.join(result.runDirectory, 'recovery.private.json'))),
  };
}
function assertSanitized(metrics, f) {
  const text = JSON.stringify(metrics);
  for (const secret of [model, privateText, f.directory, ...f.agents.keys(), ...f.workspaces.keys(), ...[...f.agents.values()].map(agent => agent.marker)]) {
    assert.equal(text.includes(secret), false, 'public metrics contain only fixed codes and measurements');
  }
}

test('options are explicitly opt-in, choose no default model, and accept an explicit environment model', () => {
  assert.deepEqual(parseOptions([], {}), { run: false, help: false, concurrency: 3, rounds: 1, timeoutMs: 180000, requestTimeoutMs: 30000 });
  assert.throws(() => parseOptions(['--run'], {}), { code: 'MODEL_REQUIRED' });
  assert.equal(parseOptions(['--run'], { HERMES_PASEO_LIVE_MODEL: model }).model, model);
  assert.equal(parseOptions(['--run', '--model', model], { HERMES_PASEO_LIVE_MODEL: 'another-model' }).model, model);
  assert.equal(parseOptions(['--run', '--help'], {}).help, true);
  assert.equal(parseOptions(['--concurrency', '4', '--rounds', '2'], {}).rounds, 2);
});

test('invalid options are rejected before location resolution, SDK loading or model calls', async () => {
  for (const argv of [
    ['--concurrency', '0'], ['--concurrency', '5'], ['--rounds', '3'], ['--rounds', '0'],
    ['--concurrency', '1.5'], ['--concurrency', '1e0'], ['--rounds', '-1'], ['--concurrency', 'NaN'],
    ['--timeout-ms', '999'], ['--timeout-ms', '600001'], ['--request-timeout-ms', '99'], ['--request-timeout-ms', '60001'],
    ['--model'], ['--model', '--run'], ['--run', '--run'], ['--concurrency', '2', '--concurrency', '3'],
    ['--model', 'contains spaces'], ['--model', '\u0000'], ['--output-dir', ''], ['--output-dir', 'bad\npath'],
    ['--concurrency=3'], ['--provider', 'fake'], ['positional'],
  ]) assert.throws(() => parseOptions(argv, {}));
  let touched = false;
  const dependencies = { resolveLocations: () => { touched = true; throw Error('must not run'); }, connect: () => { touched = true; } };
  for (const bad of [{ concurrency: 5 }, { rounds: 3 }, { model: undefined }, { run: 'true' }, { unrecognized: true }]) {
    await assert.rejects(runLiveConcurrency(options(bad), dependencies));
  }
  assert.equal(touched, false);
  assert.equal((await runLiveConcurrency(parseOptions([], {}), dependencies)).metrics.status, 'skipped');
  assert.equal((await runLiveConcurrency(parseOptions(['--help'], {}), dependencies)).metrics.status, 'skipped');
  assert.equal(touched, false);
});

test('CLI help, default skip, and invalid arguments never require an installed runtime', () => {
  const executable = new URL('./live-concurrency.mjs', import.meta.url);
  const env = { ...process.env, HERMES_PASEO_PORT: 'invalid', HERMES_PASEO_LIVE_MODEL: '' };
  for (const [argv, status, fragment] of [
    [['--help'], 0, 'Usage:'], [[], 0, '"status":"skipped"'],
    [['--run'], 2, 'MODEL_REQUIRED'], [['--run', '--model', privateText, '--concurrency', '5'], 2, 'INVALID_LIMIT'],
  ]) {
    const result = spawnSync(process.execPath, [executable.pathname, ...argv], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, status, result.stderr);
    assert.ok(result.stdout.includes(fragment));
    assert.equal(result.stdout.includes(privateText), false);
    assert.equal(result.stderr, '');
  }
});

test('default run overlaps three independent two-turn chats, measures turns, and keeps public evidence sanitized', async t => {
  const f = fixture(t);
  const result = await runLiveConcurrency(options(), f.dependencies);
  const { metrics, recovery } = readEvidence(result);
  assert.equal(metrics.passed, true);
  assert.equal(metrics.totalSessions, 3); assert.equal(f.peak, 3);
  assert.equal(f.agents.size, 3); assert.equal(new Set([...f.agents.values()].map(agent => agent.marker)).size, 3);
  assert.equal(new Set([...f.agents.values()].map(agent => agent.input.cwd)).size, 3);
  assert.equal(f.calls.filter(call => call.name === 'send').length, 3);
  assert.equal(f.calls.filter(call => call.name === 'wait').length, 6);
  for (const row of metrics.sessions) {
    assert.equal(row.passed, true); assert.ok(row.elapsedMs >= 0);
    assert.deepEqual(row.cleanup, { agent: 'archived', workspace: 'archived' });
    for (const turn of row.turns) {
      assert.equal(turn.passed, true); assert.ok(turn.elapsedMs >= 0);
      assert.equal(turn.newAssistantCursor, true); assert.equal(turn.ownMarker, true); assert.equal(turn.isolated, true);
    }
  }
  assert.ok(metrics.elapsedMs >= Math.max(...metrics.sessions.map(row => row.elapsedMs)));
  assert.equal(f.calls.at(-1).name, 'close'); assert.equal(metrics.connectionClosed, true);
  assert.equal(fs.statSync(result.runDirectory).mode & 0o777, 0o700);
  for (const name of ['metrics.json', 'recovery.private.json']) assert.equal(fs.statSync(path.join(result.runDirectory, name)).mode & 0o777, 0o600);
  assert.equal(recovery.completed, true);
  assert.equal(recovery.sessions.length, 3);
  assert.equal(JSON.stringify(recovery).includes('HERMES_PASEO_LIVE_'), false);
  assertSanitized(metrics, f);
});

test('two bounded rounds create at most eight sessions and repeated runs use new directories and IDs', async t => {
  const f = fixture(t);
  const first = await runLiveConcurrency(options({ concurrency: 4, rounds: 2 }), f.dependencies);
  assert.equal(first.metrics.passedSessions, 8); assert.equal(f.peak, 4);
  const firstIds = [...f.agents.keys()];
  const second = await runLiveConcurrency(options({ concurrency: 1 }), f.dependencies);
  assert.equal(second.metrics.passed, true);
  assert.notEqual(first.runDirectory, second.runDirectory);
  const secondIds = readEvidence(second).recovery.sessions.map(row => row.agentId);
  assert.ok(secondIds.every(id => !firstIds.includes(id)));
  assert.equal(f.agents.size, 9);
});

test('catalog mismatch and unsupported owned creation fail before any workspace or billed request', async t => {
  for (const hooks of [{ models: [] }, { supported: false }]) {
    const f = fixture(t, hooks);
    const result = await runLiveConcurrency(options(), f.dependencies);
    assert.equal(result.metrics.passed, false);
    assert.ok(['MODEL_UNAVAILABLE', 'OWNED_CREATION_UNSUPPORTED'].includes(result.metrics.code));
    assert.equal(f.workspaces.size, 0); assert.equal(f.agents.size, 0);
    assert.equal(f.calls.at(-1).name, 'close');
  }
});

test('independent wait/send failures settle and archive every owned session without retrying model calls', async t => {
  const f = fixture(t, {
    wait: async agent => { if (agent.index === 0) throw Object.assign(Error(privateText), { code: privateText }); return { status: 'idle' }; },
    send: async agent => { if (agent.index === 2) throw Error(privateText); },
  });
  const result = await runLiveConcurrency(options(), f.dependencies);
  assert.deepEqual(result.metrics.sessions.map(row => row.passed), [false, true, false]);
  assert.equal(f.calls.filter(call => call.name === 'create-agent').length, 3);
  assert.equal(f.calls.filter(call => call.name === 'send').length, 2);
  assert.equal(f.calls.filter(call => call.name === 'archive-agent').length, 3);
  assert.equal(f.calls.filter(call => call.name === 'archive-workspace').length, 3);
  assert.equal(f.calls.at(-1).name, 'close');
  assert.equal(result.metrics.sessions[0].turns[1].status, 'skipped');
  assert.equal(readEvidence(result).recovery.sessions[2].followup, 'unconfirmed');
  assertSanitized(result.metrics, f);
});

test('stale follow-ups and another session marker cannot pass while an independent peer finishes', async t => {
  const f = fixture(t, { timeline: async (agent, peers) => {
    if (agent.index === 0) return { entries: [entry(1, agent.marker)] };
    if (agent.index === 1) return { entries: [entry(1, `${agent.marker} ${peers[0].marker}`), entry(2, agent.marker)] };
    return { entries: [entry(agent.turn, agent.marker)] };
  } });
  const result = await runLiveConcurrency(options(), f.dependencies);
  assert.deepEqual(result.metrics.sessions.map(row => row.passed), [false, false, true]);
  assert.equal(result.metrics.sessions[0].code, 'STALE_ASSISTANT_CURSOR');
  assert.equal(result.metrics.sessions[1].code, 'CROSS_SESSION_MARKER');
  assert.equal(f.calls.filter(call => call.name === 'archive-agent').length, 3);
  assertSanitized(result.metrics, f);
});

test('unconfirmed archive receipts preserve private IDs and turn evidence and stop later rounds', async t => {
  const f = fixture(t, {
    archiveAgent: async agent => agent.index === 0 ? { archivedAt: stamp, error: privateText } : { archivedAt: stamp },
    archiveWorkspace: async workspace => workspace.index === 1 ? { archivedAt: stamp, workspaceId: 'foreign-workspace' } : { archivedAt: stamp },
  });
  const result = await runLiveConcurrency(options({ rounds: 2 }), f.dependencies);
  const { metrics, recovery } = readEvidence(result);
  assert.equal(metrics.passed, false); assert.equal(metrics.recoveryRequired, true);
  assert.deepEqual(metrics.sessions.map(row => row.status), ['failed', 'failed', 'passed', 'skipped', 'skipped', 'skipped']);
  assert.ok(metrics.sessions[0].turns.every(turn => turn.passed), 'cleanup failure must retain successful turn evidence');
  assert.equal(f.calls.filter(call => call.name === 'archive-workspace').length, 3);
  assert.equal(recovery.sessions[0].agentArchive, 'failed');
  assert.equal(recovery.sessions[1].workspaceArchive, 'failed');
  assert.ok(f.agents.has(recovery.sessions[0].agentId));
  assert.ok(fs.existsSync(recovery.sessions[0].workspacePath));
  assertSanitized(metrics, f);
});

test('ambiguous create failures keep pre-recorded IDs and never archive a foreign receipt ID', async t => {
  const f = fixture(t, {
    createWorkspace: async (input, index) => { if (index === 0) throw Error(privateText); return { workspace: { id: input.workspaceId } }; },
    createAgent: async agent => agent.index === 1 ? { id: 'foreign-agent' } : { id: agent.input.agentId },
  });
  const result = await runLiveConcurrency(options(), f.dependencies);
  const { recovery } = readEvidence(result);
  assert.deepEqual(result.metrics.sessions.map(row => row.passed), [false, false, true]);
  assert.equal(recovery.sessions[0].workspaceCreation, 'unconfirmed');
  assert.equal(recovery.sessions[1].agentCreation, 'unconfirmed');
  assert.ok(result.metrics.recoveryRequired);
  assert.equal(f.calls.some(call => call.id === 'foreign-agent'), false);
  assert.equal(f.calls.filter(call => call.name === 'archive-workspace').length, 2);
  assert.equal(f.calls.filter(call => call.name === 'archive-agent').length, 1);
  assert.equal(recovery.sessions[0].workspaceOwned, false);
  assert.equal(recovery.sessions[1].agentOwned, false);
  assert.equal(f.calls.filter(call => call.name === 'create-agent').length, 2);
  assert.equal(f.calls.filter(call => call.name === 'send').length, 1);
  assertSanitized(result.metrics, f);
});

test('hanging setup/cleanup requests are bounded, peers finish, and workspace cleanup still runs', async t => {
  const f = fixture(t, {
    createWorkspace: async (input, index) => index === 0 ? forever() : { workspace: { id: input.workspaceId } },
    archiveAgent: async agent => agent.index === 1 ? forever() : { archivedAt: stamp },
  });
  const result = await runLiveConcurrency(options({ requestTimeoutMs: 100 }), f.dependencies);
  assert.deepEqual(result.metrics.sessions.map(row => row.passed), [false, false, true]);
  assert.equal(result.metrics.sessions[0].code, 'REQUEST_TIMEOUT');
  assert.equal(result.metrics.sessions[1].cleanup.agent, 'failed');
  assert.equal(result.metrics.sessions[1].cleanup.workspace, 'archived');
  assert.equal(f.calls.filter(call => call.name === 'archive-workspace').length, 2);
  assert.equal(f.calls.at(-1).name, 'close');
  assert.equal(readEvidence(result).recovery.sessions[0].workspaceCreation, 'unconfirmed');
});

test('a hung model turn times out once, is archived, and never receives a follow-up', async t => {
  const f = fixture(t, { wait: async agent => agent.index === 0 ? forever() : { status: 'idle' } });
  const result = await runLiveConcurrency(options({ timeoutMs: 1000, requestTimeoutMs: 100 }), f.dependencies);
  assert.deepEqual(result.metrics.sessions.map(row => row.passed), [false, true, true]);
  assert.equal(result.metrics.sessions[0].code, 'TURN_TIMEOUT');
  assert.equal(result.metrics.sessions[0].turns[1].status, 'skipped');
  assert.equal(f.calls.filter(call => call.name === 'send').length, 2);
  assert.equal(f.calls.filter(call => call.name === 'archive-agent').length, 3);
});

test('close failures fail the run without erasing completed verification or cleanup evidence', async t => {
  const f = fixture(t, { close: forever });
  const result = await runLiveConcurrency(options({ concurrency: 1, requestTimeoutMs: 100 }), f.dependencies);
  assert.equal(result.metrics.passed, false);
  assert.equal(result.metrics.sessions[0].passed, true);
  assert.equal(result.metrics.code, 'CONNECTION_CLOSE_FAILED');
  assert.equal(result.metrics.connectionClosed, false);
  assert.equal(readEvidence(result).metrics.code, 'CONNECTION_CLOSE_FAILED');
});

test('creation updates permit owned cleanup after a partial creation failure, without touching unproven IDs', async t => {
  const f = fixture(t, { createAgent: async agent => {
    if (agent.index === 0) {
      agent.input.onEvent({ idempotencyKey: agent.input.agentId, agentId: agent.input.agentId, agent: { id: agent.input.agentId } });
      throw Error(privateText);
    }
    if (agent.index === 1) {
      agent.input.onEvent({ idempotencyKey: 'foreign-key', agentId: agent.input.agentId, agent: { id: agent.input.agentId } });
      throw Error(privateText);
    }
    return { id: agent.input.agentId };
  } });
  const result = await runLiveConcurrency(options(), f.dependencies);
  const { recovery } = readEvidence(result);
  assert.equal(result.metrics.sessions[0].cleanup.agent, 'archived');
  assert.equal(result.metrics.sessions[1].cleanup.agent, 'unconfirmed');
  assert.equal(recovery.sessions[0].agentOwned, true);
  assert.equal(recovery.sessions[1].agentOwned, false);
  assert.equal(recovery.sessions[0].agentCreation, 'unconfirmed');
  assert.equal(f.calls.filter(call => call.name === 'archive-agent').length, 2);
  assert.equal(f.calls.filter(call => call.name === 'archive-workspace').length, 3);
  assert.equal(f.calls.filter(call => call.name === 'send').length, 1);
  assertSanitized(result.metrics, f);
});

test('managed ws loader accepts Node CommonJS namespace exports as well as named ESM exports', async t => {
  const { webSocketConstructor } = await import('./live-concurrency.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-paseo-ws-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ws.cjs');
  fs.writeFileSync(file, 'class Socket {}\nmodule.exports = Socket;\nObject.assign(module.exports, { WebSocket: Socket });\n');
  const { pathToFileURL } = await import('node:url');
  const loaded = await import(pathToFileURL(file).href);
  assert.equal(loaded.WebSocket, undefined, 'exercise the CommonJS import namespace seen in production');
  const Socket = webSocketConstructor(loaded);
  assert.equal(new Socket().constructor, loaded.default);
  assert.equal(webSocketConstructor({ WebSocket: Socket }), Socket);
  assert.throws(() => webSocketConstructor({ default: {} }), error => error.code === 'SDK_WEBSOCKET_UNAVAILABLE');
});
