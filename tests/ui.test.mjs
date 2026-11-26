import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../dashboard/dist/index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../dashboard/manifest.json', import.meta.url), 'utf8'));
const css = fs.readFileSync(new URL('../dashboard/dist/style.css', import.meta.url), 'utf8');
const pairingGuide = 'https://hermes-agent-connect-pairing.elmolin47.chatgpt.site/';
const snapshot = (patch = {}) => ({
  enabled: true, phase: 'running', daemon: { running: true, reachable: true },
  providers: [{ provider: 'hermes', label: 'Hermes ACP', status: 'ready' }],
  onboarding: { required: false, id: 'activation-1', completed: false }, ...patch,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const acceptanceResult = (passed = true) => ({ passed, providers: [{ provider: 'hermes', firstReply: true, followup: passed, passed, cleanup: { archived: true, deleted: true } }] });
const acceptanceJob = (patch = {}) => ({ jobId: 'acceptance-job-1', phase: 'running', pending: true, result: null, code: null, ...patch });
const accepted = body => ({ httpStatus: 202, body });
const modelData = { models: [{ id: 'live/acp-model', label: 'ACP 即時模型', isDefault: true }], modes: [{ id: 'live-mode', label: '動態模式' }] };

// Simulates the host's React hooks, effect cleanup, child components, auth helper,
// SPA history and clock. All assertions go through registered surfaces and events.
function host({ status = snapshot(), storage = new Map(), pathname = '/sessions', raw = true, basePath = '' } = {}) {
  let currentStatus = status;
  let active = null;
  let dirty = false;
  let now = 0, timerId = 0;
  const components = new Map(), slots = new Map(), roots = new Map(), instances = new Map();
  const timers = new Map(), events = new Map(), calls = [], navigations = [], logs = [], reloads = [];
  const handlers = new Map();
  const document = {
    visibilityState: 'visible',
    addEventListener(name, handler) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(handler); },
    removeEventListener(name, handler) { events.get(name)?.delete(handler); },
  };
  const window = {
    document,
    __HERMES_BASE_PATH__: basePath,
    location: { pathname, reload() { reloads.push(window.location.pathname); } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    localStorage: { getItem() { throw new Error('Forbidden localStorage read'); }, setItem() { throw new Error('Forbidden localStorage write'); } },
    history: { pushState(_state, _title, path) { window.location.pathname = path; navigations.push(path); } },
    dispatchEvent(event) { assert.equal(event.type, 'popstate'); },
    PopStateEvent: class { constructor(type) { this.type = type; } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const hooks = {
    useState(initial) {
      const instance = active, index = instance.cursor++;
      if (!(index in instance.hooks)) instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = instance.hooks[index];
      return [slot.value, value => {
        const next = typeof value === 'function' ? value(slot.value) : value;
        if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
      }];
    },
    useEffect(effect, deps) {
      const instance = active, index = instance.cursor++;
      const previous = instance.hooks[index];
      if (previous && deps && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
      instance.hooks[index] = { deps, cleanup: previous?.cleanup };
      instance.effects.push(() => {
        previous?.cleanup?.();
        instance.hooks[index].cleanup = effect();
      });
    },
  };
  const React = { ...hooks, createElement(type, props, ...children) { return { type, props: { ...(props || {}), children: children.flat(Infinity) } }; } };
  async function dispatch(path, init = {}) {
    const call = { path, init };
    calls.push(call);
    const handler = handlers.get(path);
    return handler ? handler(call) : path.endsWith('/status') ? structuredClone(currentStatus) :
      path.includes('/models/') ? structuredClone(modelData) : {};
  }
  const SDK = { React, hooks };
  if (raw) SDK.authedFetch = async (path, init) => {
    const value = await dispatch(path, init);
    if (value?.httpError) return { ok: false, status: value.httpError, json() { throw new Error('Must not read raw error body containing secrets'); } };
    return { ok: true, status: value?.httpStatus || 200, json: async () => value?.httpStatus ? value.body : value };
  };
  else SDK.fetchJSON = dispatch;
  window.__HERMES_PLUGIN_SDK__ = SDK;
  window.__HERMES_PLUGINS__ = {
    register(name, component) { components.set(name, component); },
    registerSlot(name, slot, component) { assert.equal(name, manifest.name); slots.set(slot, component); },
  };
  vm.runInNewContext(source, { window, document, URL, AbortController, console: {
    log(...args) { logs.push(args); }, warn(...args) { logs.push(args); }, error(...args) { logs.push(args); },
  } });
  function render(node, path, seen) {
    if (node == null || node === false) return null;
    if (typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const key = path + ':' + node.type.name;
      let instance = instances.get(key);
      if (!instance) { instance = { hooks: [], effects: [], cursor: 0 }; instances.set(key, instance); }
      seen.add(key);
      instance.cursor = 0;
      active = instance;
      const result = node.type(node.props);
      active = null;
      return render(result, key, seen);
    }
    return { type: node.type, props: node.props, children: node.props.children.map((child, i) => render(child, path + '/' + i, seen)).filter(child => child != null) };
  }
  function cleanup(instance) { for (const hook of instance.hooks) hook?.cleanup?.(); }
  function flush() {
    for (let iteration = 0; iteration < 30 && dirty; iteration++) {
      dirty = false;
      const seen = new Set();
      for (const [key, root] of roots) root.tree = render({ type: root.component, props: {} }, key, seen);
      for (const [key, instance] of instances) if (!seen.has(key)) { cleanup(instance); instances.delete(key); }
      const effects = Array.from(instances.values()).flatMap(instance => instance.effects.splice(0));
      effects.forEach(effect => effect());
    }
    assert.equal(dirty, false, 'React render must settle');
  }
  async function settle() {
    for (let i = 0; i < 25; i++) { await Promise.resolve(); flush(); }
  }
  const api = {
    window, document, components, slots, calls, navigations, logs, storage, timers, events, reloads,
    status(value) { currentStatus = value; },
    handle(path, fn) { handlers.set('/api/plugins/hermes-paseo' + path, fn); },
    hostHandle(path, fn) { handlers.set('/api/hermes-paseo-host' + path, fn); },
    async mount(kind) { roots.set(kind, { component: kind === 'header' ? slots.get('header-right') : components.get('hermes-paseo') }); dirty = true; await settle(); },
    async unmount(kind) { roots.delete(kind); dirty = true; await settle(); },
    tree(kind = 'page') { return roots.get(kind)?.tree; },
    async hidden(value) { document.visibilityState = value ? 'hidden' : 'visible'; events.get('visibilitychange')?.forEach(handler => handler()); await settle(); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].fn(); await settle();
      }
      now = target;
    },
    async click(label) { const node = nodes(api.tree()).find(node => node.type === 'button' && content(node).includes(label)); assert.ok(node, label); assert.equal(node.props.disabled, false, label + ' enabled'); node.props.onClick(); await settle(); },
    async change(label, value) { const node = nodes(api.tree()).find(node => node.type === 'label' && content(node.children[0]) === label); assert.ok(node, label); const select = nodes(node).find(row => row.type === 'select'); select.props.onChange({ target: { value } }); await settle(); },
    settle,
  };
  return api;
}
function nodes(node) { if (!node || typeof node !== 'object') return []; return [node, ...(node.children || []).flatMap(nodes)]; }
function content(node) { if (node == null || node === false) return ''; if (typeof node !== 'object') return String(node); return (node.children || node.props?.children || []).map(content).join(''); }
const count = (app, path, method) => app.calls.filter(call => call.path === '/api/plugins/hermes-paseo' + path && (!method || call.init.method === method)).length;
const acceptanceButton = app => nodes(nodes(app.tree()).find(row => row.type === 'section' && row.props['aria-label'] === '真實對話驗收')).find(row => row.type === 'button');
const buttonNode = (app, label) => nodes(app.tree()).find(row => row.type === 'button' && content(row).includes(label));

test('official IIFE registers the host React page and visible persistent header slot without executing on bundle load', () => {
  const app = host();
  assert.equal(manifest.name, 'hermes-paseo');
  assert.equal(manifest.tab.path, '/paseo');
  assert.equal(manifest.api, 'plugin_api.py');
  assert.deepEqual(manifest.slots, ['header-right']);
  assert.equal(app.components.size, 1);
  assert.equal(app.slots.size, 1);
  assert.equal(app.calls.length, 0);
  assert.match(css, /\.hermes-paseo/);
  assert.match(css, /max-width: 640px/);
});

test('host activation guides once; page initializes once and immediately shows pairing wizard, no popup or paid call', async () => {
  const app = host({ status: snapshot({ enabled: false, phase: 'running', daemon: { running: false, reachable: false } }) });
  await app.mount('header');
  assert.equal(app.navigations.length, 0);
  app.status(snapshot({ enabled: false, phase: 'not_installed', daemon: { running: false, reachable: false }, onboarding: { required: true, id: 'activation-1', completed: false } }));
  const start = deferred();
  app.handle('/start', () => start.promise);
  await app.advance(5000);
  assert.deepEqual(app.navigations, ['/paseo']);
  assert.equal(count(app, '/start'), 0, 'header only checks status');
  await app.mount('page');
  assert.equal(count(app, '/start', 'POST'), 1);
  assert.match(content(app.tree()), /配對精靈/);
  assert.equal(count(app, '/pair'), 0);
  assert.equal(count(app, '/acceptance'), 0);
  assert.equal(buttonNode(app, '停止服務').props.disabled, false);
  app.status(snapshot({ onboarding: { required: true, id: 'new-server-id', completed: false } }));
  start.resolve({}); await app.settle();
  await app.advance(8000);
  assert.equal(count(app, '/start'), 1);
  assert.equal(app.navigations.length, 1, 'new start identity cannot loop');
  app.window.location.pathname = '/logs';
  await app.advance(4000);
  assert.equal(app.navigations.length, 1, 'respect manual navigation away');
});

test('stored onboarding marker prevents redirects after reload and guide works behind a host basename', async () => {
  const storage = new Map();
  const status = snapshot({ onboarding: { required: true, completed: false, id: 'onboarding-A' } });
  const first = host({ status, storage, pathname: '/hermes/plugins', basePath: '/hermes' });
  await first.mount('header');
  assert.deepEqual(first.navigations, ['/hermes/paseo']);
  await first.unmount('header');
  const second = host({ status, storage, pathname: '/hermes/logs', basePath: '/hermes' });
  await second.mount('header');
  assert.equal(second.navigations.length, 0);
  const link = nodes(second.tree('header')).find(row => row.type === 'a');
  link.props.onClick({ button: 0, preventDefault() {} });
  assert.equal(second.window.location.pathname, '/hermes/paseo');
});

test('initial disabled/manual pause never starts; explicit resume permits pairing once ready', async () => {
  const app = host({ status: snapshot({ enabled: false, phase: 'disabled', daemon: { running: false, reachable: false }, onboarding: { required: true, id: 'paused-1', completed: false } }) });
  await app.mount('header'); await app.mount('page');
  await app.advance(6000);
  assert.equal(count(app, '/start'), 0);
  assert.equal(app.navigations.length, 0);
  assert.match(content(app.tree()), /已手動停止/);
  app.handle('/start', () => { app.status(snapshot()); return {}; });
  await app.click('恢復服務');
  assert.equal(count(app, '/start'), 1);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, false);
});

test('unexpected daemon loss preserves enabled intent, guides and recovers once; manual pause is respected', async () => {
  const storage = new Map([['hermes-paseo:ui:v1', JSON.stringify({ started: ['restart-1'], guided: [], paused: false })]]);
  const stopped = snapshot({ phase: 'stopped', daemon: { running: false, reachable: false },
    onboarding: { required: true, completed: false, id: 'restart-1' } });
  const app = host({ status: stopped, storage });
  const start = deferred();
  app.handle('/start', () => start.promise);
  await app.mount('header');
  assert.deepEqual(app.navigations, ['/paseo']);
  assert.equal(count(app, '/start'), 1, 'enabled header recovers a lost daemon');
  await app.mount('page'); await app.advance(6000);
  assert.equal(count(app, '/start'), 1, 'no duplicate recovery while in flight');
  assert.doesNotMatch(content(app.tree()), /已手動停止|你已停止服務/);
  app.status(snapshot()); start.resolve({}); await app.settle();
  app.handle('/start', () => { app.status(snapshot()); return {}; });
  app.status(stopped); await app.advance(2000);
  assert.equal(count(app, '/start'), 2, 'a later loss can recover after readiness was confirmed');
  assert.equal(count(app, '/pair'), 0); assert.equal(count(app, '/acceptance'), 0);

  const pausedStorage = new Map([['hermes-paseo:ui:v1', JSON.stringify({ started: [], guided: [], paused: true })]]);
  const paused = host({ status: stopped, storage: pausedStorage });
  await paused.mount('header'); await paused.mount('page'); await paused.advance(6000);
  assert.equal(count(paused, '/start'), 0); assert.equal(paused.navigations.length, 0);
  assert.match(content(paused.tree()), /已手動停止/);
});

test('stopped disabled intent or ownership diagnostics never automatically restart', async () => {
  for (const patch of [{ enabled: false }, { diagnosticCode: 'DAEMON_NOT_OWNED' }]) {
    const app = host({ status: snapshot({ phase: 'stopped', daemon: { running: false, reachable: false }, ...patch }) });
    await app.mount('header'); await app.mount('page'); await app.advance(6000);
    assert.equal(count(app, '/start'), 0);
  }
});

test('stop is enabled during reads, cancels stale state, and persists manual pause across remount/reload', async () => {
  const app = host();
  await app.mount('header'); await app.mount('page');
  const stale = deferred(); let staleSignal;
  app.handle('/status', call => { staleSignal = call.init.signal; return stale.promise; });
  await app.advance(2000);
  assert.equal(buttonNode(app, '停止服務').props.disabled, false);
  app.handle('/stop', () => {
    app.handle('/status', () => snapshot({ phase: 'disabled', daemon: { running: false, reachable: false } }));
    return {};
  });
  await app.click('停止服務');
  assert.equal(staleSignal.aborted, true);
  stale.resolve(snapshot({ phase: 'not_installed' })); await app.settle();
  assert.match(content(app.tree()), /已手動停止/);
  assert.equal(count(app, '/start'), 0);
  await app.unmount('page'); await app.mount('page'); await app.advance(4000);
  assert.equal(count(app, '/start'), 0);
  const reload = host({ storage: app.storage, status: snapshot({ phase: 'not_installed' }) });
  await reload.mount('page');
  assert.equal(count(reload, '/start'), 0, 'client pause survives a stale backend on reload');
});

test('polling coalesces between surfaces and slow responses; hide/unmount abort reads and remove timers', async () => {
  const slow = deferred();
  const app = host();
  app.handle('/status', () => slow.promise);
  await app.mount('header'); await app.mount('page');
  assert.equal(count(app, '/status'), 1);
  await app.advance(15000);
  assert.equal(count(app, '/status'), 1);
  const signal = app.calls[0].init.signal;
  await app.hidden(true);
  assert.equal(signal.aborted, true);
  assert.equal(app.timers.size, 0);
  slow.resolve(snapshot()); await app.settle();
  assert.doesNotMatch(content(app.tree()), /服務已就緒/);
  app.handle('/status', () => snapshot());
  await app.hidden(false);
  assert.equal(count(app, '/status'), 2);
  await app.unmount('page');
  const before = count(app, '/status');
  await app.advance(4999); assert.equal(count(app, '/status'), before);
  await app.advance(1); assert.equal(count(app, '/status'), before + 1);
  await app.unmount('header');
  assert.equal(app.timers.size, 0);
  assert.equal(app.events.get('visibilitychange').size, 0);
  await app.advance(20000);
  assert.equal(count(app, '/status'), before + 1);
});

test('paid acceptance never runs automatically, duplicate actions disable, and actual result is shown', async () => {
  const app = host(); await app.mount('page');
  assert.equal(count(app, '/acceptance'), 0);
  const pending = deferred(); app.handle('/acceptance', () => pending.promise);
  await app.click('執行真實對話驗收');
  assert.equal(count(app, '/acceptance'), 1);
  assert.match(content(app.tree()), /消耗帳號/);
  assert.equal(buttonNode(app, '正在進行付費驗收').props.disabled, true);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, true);
  assert.equal(buttonNode(app, '停止服務').props.disabled, false);
  pending.resolve({ passed: false, providers: [{ provider: 'hermes', firstReply: true, followup: false, passed: false, cleanup: { archived: true, deleted: true } }], checkedAt: '2026-10-12' });
  await app.settle();
  assert.match(content(app.tree()), /未全部通過/);
  assert.match(content(app.tree()), /測試代理已清理/);
});

test('202 releases POST busy, blocks duplicate paid clicks and adopts completion through status polling', async () => {
  const app = host(); await app.mount('page');
  const click = acceptanceButton(app).props.onClick;
  app.handle('/acceptance', () => {
    app.status(snapshot({ acceptanceJob: acceptanceJob() }));
    return accepted(acceptanceJob());
  });
  click(); click(); await app.settle();
  assert.equal(count(app, '/acceptance', 'POST'), 1);
  assert.equal(acceptanceButton(app).props.disabled, true);
  assert.match(content(app.tree()), /背景執行|等待驗證結果/);
  assert.doesNotMatch(content(app.tree()), /後端回報：真實對話驗收通過|狀態格式不完整/);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, false, '202 releases the foreground action lock');
  assert.equal(buttonNode(app, '停止服務').props.disabled, false);
  click(); await app.settle(); await app.advance(4000);
  assert.equal(count(app, '/acceptance', 'POST'), 1, 'a stale click handler cannot start another paid job');
  app.status(snapshot({ acceptanceJob: acceptanceJob({ phase: 'completed', pending: false, result: acceptanceResult() }) }));
  await app.advance(2000);
  assert.match(content(app.tree()), /後端回報：真實對話驗收通過/);
  assert.match(content(app.tree()), /Hermes ACP：通過首輪與續聊驗收；測試代理已清理/);
  assert.equal(acceptanceButton(app).props.disabled, false);
  assert.equal(count(app, '/acceptance', 'GET'), 0, 'the existing status poll is the only job observer');
  for (const call of app.calls) {
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.credentials, 'same-origin');
  }
  assert.equal(app.calls.find(call => call.path.endsWith('/acceptance')).init.body, '{}');
  assert.doesNotMatch(JSON.stringify([...app.storage]), /acceptance-job|firstReply|providers/);
  assert.deepEqual(app.logs, []);
});

test('a 202 receipt alone blocks duplicates even when an older status fixture omits acceptanceJob', async () => {
  for (const raw of [true, false]) {
    const app = host({ raw }); await app.mount('page');
    app.handle('/acceptance', () => raw ? accepted(acceptanceJob()) : acceptanceJob());
    await app.click('執行真實對話驗收'); await app.advance(4000);
    assert.match(content(app.tree()), /背景執行|等待驗證結果/);
    assert.equal(acceptanceButton(app).props.disabled, true);
    assert.equal(buttonNode(app, '產生配對連結').props.disabled, false);
    assert.equal(count(app, '/acceptance', 'POST'), 1);
  }
});

test('status cannot restore a previous successful job while a new paid POST is still being submitted', async () => {
  const previous = acceptanceJob({ phase: 'completed', pending: false, result: acceptanceResult() });
  const app = host({ status: snapshot({ acceptanceJob: previous }) });
  await app.mount('page');
  const pending = deferred(); app.handle('/acceptance', () => pending.promise);
  await app.click('執行真實對話驗收'); await app.advance(4000);
  assert.doesNotMatch(content(app.tree()), /後端回報：真實對話驗收通過/);
  assert.equal(acceptanceButton(app).props.disabled, true);
  app.status(snapshot({ acceptanceJob: acceptanceJob({ jobId: 'next-job' }) }));
  pending.resolve(accepted(acceptanceJob({ jobId: 'next-job' }))); await app.settle();
  assert.match(content(app.tree()), /背景執行|等待驗證結果/);
  assert.equal(count(app, '/acceptance', 'POST'), 1);
});

test('refresh and remount adopt pending and completed jobs without sending a paid POST on either SDK', async () => {
  for (const raw of [true, false]) {
    const app = host({ raw, status: snapshot({ acceptanceJob: acceptanceJob() }) });
    await app.mount('header'); await app.mount('page');
    assert.equal(acceptanceButton(app).props.disabled, true);
    assert.match(content(app.tree()), /背景執行|等待驗證結果/);
    await app.unmount('page'); await app.unmount('header'); await app.mount('page');
    assert.equal(acceptanceButton(app).props.disabled, true);
    const refresh = host({ raw, storage: app.storage, status: snapshot({ acceptanceJob: acceptanceJob() }) });
    await refresh.mount('page');
    assert.equal(acceptanceButton(refresh).props.disabled, true);
    refresh.status(snapshot({ acceptanceJob: acceptanceJob({ phase: 'completed', pending: false, result: acceptanceResult(false) }) }));
    await refresh.advance(2000);
    assert.match(content(refresh.tree()), /未全部通過/);
    assert.equal(acceptanceButton(refresh).props.disabled, false);
    const completedRefresh = host({ raw, status: snapshot({ acceptanceJob: acceptanceJob({ phase: 'completed', pending: false, result: acceptanceResult() }) }) });
    await completedRefresh.mount('page');
    assert.match(content(completedRefresh.tree()), /後端回報：真實對話驗收通過/);
    assert.equal(count(app, '/acceptance') + count(refresh, '/acceptance') + count(completedRefresh, '/acceptance'), 0);
  }
});

test('interrupted, error and idle receipts clear old success and never render a partial result as a pass', async () => {
  for (const phase of ['interrupted', 'error', 'idle']) {
    const app = host({ status: snapshot({ acceptanceJob: acceptanceJob({ phase: 'completed', pending: false, result: acceptanceResult() }) }) });
    await app.mount('page');
    assert.match(content(app.tree()), /後端回報：真實對話驗收通過/);
    app.status(snapshot({ acceptanceJob: acceptanceJob({ phase, pending: false, result: phase === 'idle' ? null : acceptanceResult(), code: 'PRIVATE_BACKEND_DETAIL' }) }));
    await app.advance(2000);
    assert.doesNotMatch(content(app.tree()), /後端回報：真實對話驗收通過|PRIVATE_BACKEND_DETAIL/);
    if (phase !== 'idle') assert.match(content(app.tree()), phase === 'interrupted' ? /驗收已中斷/ : /驗收發生錯誤/);
    assert.equal(acceptanceButton(app).props.disabled, false);
  }
});

test('uncertain paid POST keeps duplicate clicks blocked while only status GETs recover the job', async () => {
  const app = host(); await app.mount('page');
  const click = acceptanceButton(app).props.onClick;
  app.handle('/acceptance', () => { throw new Error('PRIVATE: connection lost after paid work started'); });
  app.handle('/status', () => { throw new Error('PRIVATE status outage'); });
  click(); await app.settle();
  assert.match(content(app.tree()), /驗收請求可能已送達/);
  assert.equal(acceptanceButton(app).props.disabled, true);
  assert.equal(buttonNode(app, '停止服務').props.disabled, false);
  click(); await app.settle(); await app.advance(6000);
  assert.equal(count(app, '/acceptance', 'POST'), 1);
  assert.doesNotMatch(content(app.tree()), /PRIVATE|後端回報：真實對話驗收通過/);
  app.handle('/status', () => snapshot({ acceptanceJob: acceptanceJob() }));
  await app.advance(2000);
  assert.match(content(app.tree()), /背景執行|等待驗證結果/);
  assert.doesNotMatch(content(app.tree()), /驗收請求可能已送達|無法完成操作/);
  click(); await app.settle();
  assert.equal(count(app, '/acceptance', 'POST'), 1);
  app.handle('/status', () => snapshot({ acceptanceJob: acceptanceJob({ phase: 'completed', pending: false, result: acceptanceResult() }) }));
  await app.advance(2000);
  assert.match(content(app.tree()), /後端回報：真實對話驗收通過/);
  assert.equal(count(app, '/acceptance', 'POST'), 1);
});

test('an idle receipt resolves uncertain submission without a retry and needs a new explicit paid click', async () => {
  const app = host(); await app.mount('page');
  app.handle('/acceptance', () => { throw new Error('lost response'); });
  await app.click('執行真實對話驗收');
  assert.equal(acceptanceButton(app).props.disabled, true, 'an old status without a job cannot resolve uncertainty');
  await app.advance(4000);
  assert.equal(count(app, '/acceptance'), 1);
  app.status(snapshot({ acceptanceJob: acceptanceJob({ jobId: null, phase: 'idle', pending: false }) }));
  await app.advance(2000);
  assert.equal(acceptanceButton(app).props.disabled, false);
  assert.doesNotMatch(content(app.tree()), /驗收請求可能已送達/);
  assert.equal(count(app, '/acceptance'), 1);
});

test('stop remains usable for a background job and interrupted status cannot become acceptance success', async () => {
  const app = host({ status: snapshot({ acceptanceJob: acceptanceJob() }) });
  await app.mount('page');
  assert.equal(buttonNode(app, '停止服務').props.disabled, false);
  app.handle('/stop', () => {
    app.status(snapshot({ enabled: false, phase: 'disabled', daemon: { running: false, reachable: false },
      acceptanceJob: acceptanceJob({ phase: 'interrupted', pending: false, code: 'ACCEPTANCE_INTERRUPTED' }) }));
    return {};
  });
  await app.click('停止服務');
  assert.match(content(app.tree()), /已手動停止/);
  assert.match(content(app.tree()), /驗收已中斷/);
  assert.doesNotMatch(content(app.tree()), /後端回報：真實對話驗收通過/);
  assert.equal(count(app, '/acceptance'), 0);
});

test('stop supersedes an in-flight paid POST and rejects its late successful result', async () => {
  const app = host(); await app.mount('page');
  const pending = deferred(); app.handle('/acceptance', () => pending.promise);
  await app.click('執行真實對話驗收');
  app.handle('/stop', () => {
    app.status(snapshot({ enabled: false, phase: 'disabled', daemon: { running: false, reachable: false },
      acceptanceJob: acceptanceJob({ phase: 'interrupted', pending: false }) }));
    return {};
  });
  await app.click('停止服務');
  pending.resolve(accepted(acceptanceJob({ phase: 'completed', pending: false, result: acceptanceResult() })));
  await app.settle();
  assert.match(content(app.tree()), /驗收已中斷/);
  assert.doesNotMatch(content(app.tree()), /後端回報：真實對話驗收通過/);
  assert.equal(count(app, '/acceptance', 'POST'), 1);
});

test('job polling retains visibility and unmount cleanup with no independent acceptance requests', async () => {
  const app = host({ status: snapshot({ acceptanceJob: acceptanceJob() }) });
  await app.mount('page');
  assert.equal(acceptanceButton(app).props.disabled, true);
  const slow = deferred(); let signal;
  app.handle('/status', call => { signal = call.init.signal; return slow.promise; });
  await app.advance(2000);
  await app.hidden(true);
  assert.equal(signal.aborted, true);
  slow.resolve(snapshot({ acceptanceJob: acceptanceJob({ phase: 'completed', pending: false, result: acceptanceResult() }) }));
  await app.settle(); await app.advance(10000);
  assert.doesNotMatch(content(app.tree()), /後端回報：真實對話驗收通過/);
  app.handle('/status', () => snapshot({ acceptanceJob: acceptanceJob({ phase: 'completed', pending: false, result: acceptanceResult() }) }));
  await app.hidden(false);
  assert.match(content(app.tree()), /後端回報：真實對話驗收通過/);
  await app.unmount('page');
  const reads = count(app, '/status'); await app.advance(10000);
  assert.equal(count(app, '/status'), reads);
  assert.equal(app.timers.size, 0);
  assert.equal(app.events.get('visibilitychange').size, 0);
  assert.equal(count(app, '/acceptance'), 0);
});

test('hiding during submission ignores its late result and adopts the job when visible without resubmitting', async () => {
  const app = host(); await app.mount('page');
  const pending = deferred(); app.handle('/acceptance', () => pending.promise);
  const click = acceptanceButton(app).props.onClick;
  click(); await app.settle(); await app.hidden(true);
  app.status(snapshot({ acceptanceJob: acceptanceJob({ phase: 'completed', pending: false, result: acceptanceResult() }) }));
  pending.resolve(accepted(acceptanceJob())); await app.settle();
  const reads = count(app, '/status'); await app.advance(10000);
  assert.equal(count(app, '/status'), reads);
  assert.equal(acceptanceButton(app).props.disabled, true);
  assert.doesNotMatch(content(app.tree()), /後端回報：真實對話驗收通過/);
  await app.hidden(false);
  assert.match(content(app.tree()), /後端回報：真實對話驗收通過/);
  assert.equal(count(app, '/acceptance', 'POST'), 1);
});

test('completed without a result and malformed receipts cannot claim a pass or leak backend details', async () => {
  const app = host({ status: snapshot({ acceptanceJob: acceptanceJob({ phase: 'completed', pending: false }) }) });
  await app.mount('page');
  assert.match(content(app.tree()), /未取得有效結果/);
  assert.doesNotMatch(content(app.tree()), /後端回報：真實對話驗收通過/);
  app.status(snapshot({ acceptanceJob: acceptanceJob({ phase: 'error', pending: false, code: 'PROCESS_TIMEOUT' }) }));
  await app.advance(2000);
  assert.match(content(app.tree()), /驗收發生錯誤/);
  assert.doesNotMatch(content(app.tree()), /PROCESS_TIMEOUT/);
  app.status(snapshot({ acceptanceJob: { phase: 'completed', pending: false, result: acceptanceResult(), code: 'PRIVATE_BACKEND_DETAIL' } }));
  await app.advance(2000);
  assert.match(content(app.tree()), /狀態格式不完整/);
  assert.equal(acceptanceButton(app).props.disabled, true);
  assert.equal(buttonNode(app, '停止服務').props.disabled, false);
  assert.doesNotMatch(content(app.tree()), /PRIVATE_BACKEND_DETAIL|後端回報：真實對話驗收通過/);
});

test('legacy immediate results survive status polling when acceptanceJob is absent', async () => {
  for (const raw of [true, false]) {
    const app = host({ raw }); await app.mount('page');
    app.handle('/acceptance', () => acceptanceResult());
    await app.click('執行真實對話驗收'); await app.advance(4000);
    assert.match(content(app.tree()), /後端回報：真實對話驗收通過/);
    assert.equal(acceptanceButton(app).props.disabled, false);
    assert.equal(count(app, '/acceptance', 'POST'), 1);
  }
});

test('pairing stays as an explicit secure official link and never enters storage, logs or a popup', async () => {
  const app = host(); await app.mount('page');
  const secretUrl = 'https://app.paseo.sh/#offer=PRIVATE-PAIR-OFFER';
  app.handle('/pair', () => ({ url: secretUrl }));
  await app.click('產生配對連結');
  const link = nodes(app.tree()).find(node => node.type === 'a' && content(node) === '使用配對連結開啟 Paseo');
  assert.equal(link.props.href, secretUrl);
  assert.equal(link.props.rel, 'noopener noreferrer');
  assert.equal(link.props.referrerPolicy, 'no-referrer');
  assert.doesNotMatch(content(app.tree()), /PRIVATE-PAIR-OFFER/);
  assert.doesNotMatch(JSON.stringify([...app.storage]), /PRIVATE-PAIR-OFFER/);
  assert.deepEqual(app.logs, []);
  await app.hidden(true);
  assert.deepEqual(nodes(app.tree()).filter(row => row.type === 'a').map(row => row.props.href), [pairingGuide]);
  await app.hidden(false);
  await app.click('產生配對連結');
  await app.unmount('page'); await app.mount('page');
  assert.deepEqual(nodes(app.tree()).filter(row => row.type === 'a').map(row => row.props.href), [pairingGuide]);
});

test('nonofficial, credentialed or executable pair URLs are rejected without leaking them', async () => {
  for (const url of ['javascript:alert(1)', 'https://evil.example/?secret=SECRET', 'https://app.paseo.sh.evil.example/pair', 'https://user:SECRET@app.paseo.sh/pair', 'http://app.paseo.sh/pair',
    'https://app.paseo.sh/pair#offer=SECRET', 'https://app.paseo.sh/?x=1#offer=SECRET', 'https://app.paseo.sh/#token=SECRET', 'https://app.paseo.sh/#offer=', 'https://smart.woowtech.io/#offer=SECRET']) {
    const app = host(); await app.mount('page');
    app.handle('/pair', () => ({ url })); await app.click('產生配對連結');
    assert.deepEqual(nodes(app.tree()).filter(row => row.type === 'a').map(row => row.props.href), [pairingGuide]);
    assert.match(content(app.tree()), /有效的官方連結/);
    assert.doesNotMatch(content(app.tree()), /SECRET|evil\.example|javascript:/);
  }
});

test('model/provider/mode labels are dynamic; missing companions are excluded; requests follow the selection', async () => {
  const app = host({ status: snapshot({ providers: [
    { provider: 'hermes', label: '自己的 Hermes', status: 'ready' },
    { provider: 'codex', label: '本機 Codex', status: 'available' },
    { provider: 'claude', label: '缺少 Claude', status: 'unavailable' },
    { provider: 'pi', label: '缺少 Pi', status: 'unknown' },
  ] }) });
  await app.mount('page');
  let select = nodes(app.tree()).find(row => row.type === 'select');
  assert.deepEqual(select.children.map(content), ['自己的 Hermes', '本機 Codex']);
  assert.match(content(app.tree()), /ACP 即時模型/);
  assert.match(content(app.tree()), /動態模式/);
  app.handle('/models/codex', () => ({ models: [{ id: 'discovered-model-42', label: '新探索模型' }], modes: [{ id: 'agent-mode', label: '代理自訂模式' }] }));
  await app.change('代理', 'codex');
  assert.equal(count(app, '/models/codex'), 1);
  assert.match(content(app.tree()), /新探索模型/);
  assert.match(content(app.tree()), /代理自訂模式/);
  app.status(snapshot()); await app.advance(2000);
  select = nodes(app.tree()).find(row => row.type === 'select');
  assert.equal(select.props.value, 'hermes');
});

test('late model replies cannot replace a newly selected provider; models abort on hidden/unmount', async () => {
  const app = host({ status: snapshot({ providers: [{ provider: 'hermes', label: 'Hermes', status: 'ready' }, { provider: 'codex', label: 'Codex', status: 'ready' }] }) });
  const old = deferred(); let signal;
  app.handle('/models/hermes', call => { signal = call.init.signal; return old.promise; });
  await app.mount('page');
  await app.change('代理', 'codex');
  assert.equal(signal.aborted, true);
  old.resolve({ models: [{ id: 'old', label: 'STALE MODEL' }], modes: [] }); await app.settle();
  assert.doesNotMatch(content(app.tree()), /STALE MODEL/);
  const slow = deferred();
  app.handle('/models/hermes', call => { signal = call.init.signal; return slow.promise; });
  await app.change('代理', 'hermes');
  await app.hidden(true); assert.equal(signal.aborted, true);
  await app.hidden(false);
  await app.unmount('page'); assert.equal(signal.aborted, true);
});

test('404 from old hosts requires dashboard restart, has no fake success, and errors never show backend secrets', async () => {
  const app = host(); app.handle('/status', () => ({ httpError: 404 }));
  await app.mount('header'); await app.mount('page');
  assert.match(content(app.tree()), /重載 Dashboard/);
  assert.match(content(app.tree()), /一次性主機設定/);
  assert.equal(buttonNode(app, '重載 Dashboard').props.disabled, true);
  assert.equal(count(app, '/start'), 0);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, true);
  assert.doesNotMatch(content(app.tree()), /服務已就緒/);
  app.handle('/status', () => snapshot()); await app.click('重新檢查');
  app.handle('/pair', () => { throw new Error('token=NEVER-RENDER-THIS https://private/pair'); });
  await app.click('產生配對連結');
  assert.match(content(app.tree()), /無法完成操作/);
  assert.doesNotMatch(content(app.tree()), /NEVER-RENDER-THIS|private\/pair/);
  assert.deepEqual(app.logs, []);
});

test('legacy fetchJSON SDK accepts exact same-origin JSON POSTs and sanitizes its HTTP errors', async () => {
  const app = host({ raw: false }); await app.mount('page');
  app.handle('/pair', () => { throw new Error('404: secret=PRIVATE'); });
  await app.click('產生配對連結');
  assert.match(content(app.tree()), /重載 Dashboard/);
  assert.doesNotMatch(content(app.tree()), /PRIVATE/);
  for (const call of app.calls) {
    assert.ok(call.path.startsWith('/api/plugins/hermes-paseo/') ||
      ['/api/hermes-paseo-host/capabilities', '/api/hermes-paseo-host/reload'].includes(call.path));
    assert.equal(call.init.credentials, 'same-origin');
    if (call.init.method === 'POST') {
      assert.equal(call.init.headers['Content-Type'], 'application/json');
      assert.equal(call.init.body, '{}');
    }
  }
});

test('disabled host status prevents page actions and onboarding-completed status never redirects', async () => {
  const disabled = host({ status: snapshot({ enabled: false, phase: 'running', onboarding: { required: true, id: 'off', completed: false } }) });
  await disabled.mount('header'); await disabled.mount('page');
  assert.equal(disabled.navigations.length, 0);
  assert.equal(disabled.calls.filter(row => row.init.method === 'POST').length, 0);
  assert.equal(buttonNode(disabled, '停止服務').props.disabled, true);
  const completed = host({ status: snapshot({ onboarding: { required: true, id: 'done', completed: true } }) });
  await completed.mount('header');
  assert.equal(completed.navigations.length, 0);
});


test('first-start onboarding identity is persisted for a refresh after the server assigns its ID', async () => {
  const storage = new Map();
  const app = host({ storage, status: snapshot({ enabled: false, phase: 'not_installed', daemon: { running: false, reachable: false }, onboarding: { required: true, id: null, completed: false } }) });
  app.handle('/start', () => { app.status(snapshot({ onboarding: { required: true, id: 'assigned-after-start', completed: false } })); return {}; });
  await app.mount('header'); await app.mount('page');
  assert.equal(count(app, '/start'), 1);
  await app.unmount('page'); await app.unmount('header');
  const refresh = host({ storage, pathname: '/logs', status: snapshot({ onboarding: { required: true, id: 'assigned-after-start', completed: false } }) });
  await refresh.mount('header');
  assert.equal(refresh.navigations.length, 0);
});

test('a slow explicit resume does not re-latch cached disabled status into a manual pause', async () => {
  const app = host({ status: snapshot({ enabled: false, phase: 'disabled', daemon: { running: false, reachable: false } }) });
  await app.mount('page');
  const start = deferred(); app.handle('/start', () => start.promise);
  await app.click('恢復服務');
  await app.advance(4000);
  app.status(snapshot()); start.resolve({}); await app.settle();
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, false);
  assert.doesNotMatch(content(app.tree()), /已手動停止/);
});


test('failed stop never claims success, remains retryable, and manual intent prevents automatic starts', async () => {
  const app = host(); await app.mount('page');
  app.handle('/stop', () => ({ httpError: 503 }));
  await app.click('停止服務');
  assert.match(content(app.tree()), /停止待確認/);
  assert.match(content(app.tree()), /服務仍在執行/);
  assert.doesNotMatch(content(app.tree()), /已手動停止/);
  assert.equal(buttonNode(app, '停止服務').props.disabled, false);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, true);
  await app.advance(4000);
  assert.equal(count(app, '/start'), 0);
  app.handle('/stop', () => { app.status(snapshot({ enabled: false, phase: 'disabled', daemon: { running: false, reachable: false } })); return {}; });
  await app.click('停止服務');
  assert.match(content(app.tree()), /已手動停止/);
});

test('status failure after readiness removes readiness claims and disables model and paid actions', async () => {
  const app = host(); await app.mount('page');
  assert.match(content(app.tree()), /服務已就緒/);
  app.handle('/status', () => ({ httpError: 404 }));
  await app.advance(2000);
  assert.match(content(app.tree()), /狀態無法確認/);
  assert.doesNotMatch(content(app.tree()), /服務已就緒/);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, true);
  assert.equal(buttonNode(app, '執行真實對話驗收').props.disabled, true);
  assert.equal(buttonNode(app, '停止服務').props.disabled, false);
});

test('explicit stop can supersede a pending first start without permitting later restart or pairing', async () => {
  const app = host({ status: snapshot({ enabled: false, phase: 'not_installed', daemon: { running: false, reachable: false } }) });
  const start = deferred(); app.handle('/start', () => start.promise);
  await app.mount('page');
  assert.equal(count(app, '/start'), 1);
  app.handle('/stop', () => { app.status(snapshot({ enabled: false, phase: 'disabled', daemon: { running: false, reachable: false } })); return {}; });
  await app.click('停止服務');
  start.resolve(snapshot()); await app.settle();
  await app.advance(4000);
  assert.equal(count(app, '/stop'), 1);
  assert.equal(count(app, '/start'), 1);
  assert.match(content(app.tree()), /已手動停止/);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, true);
});

test('host disable/re-enable can guide a new onboarding identity while preserving once-per-identity behavior', async () => {
  const app = host({ status: snapshot({ onboarding: { required: true, id: 'first-activation', completed: false } }) });
  await app.mount('header');
  assert.equal(app.navigations.length, 1);
  await app.unmount('header');
  app.window.location.pathname = '/plugins';
  app.status(snapshot({ onboarding: { required: true, id: 'second-activation', completed: false } }));
  await app.mount('header');
  assert.equal(app.navigations.length, 2);
  await app.unmount('header');
  app.window.location.pathname = '/logs';
  await app.mount('header');
  assert.equal(app.navigations.length, 2);
});

test('Dashboard reload bootstraps missing plugin API and waits for a new generation plus API readiness', async () => {
  const app = host({ pathname: '/paseo' });
  let accepted = false, generationReads = 0, ready = false;
  app.handle('/status', () => ready ? snapshot() : { httpError: 404 });
  app.hostHandle('/capabilities', () => ({ supported: true, generation: accepted && ++generationReads > 1 ? 'new' : 'old' }));
  app.hostHandle('/reload', call => {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(call.init.body), { confirm: true });
    accepted = true;
    return { ok: true, generation: 'old' };
  });
  await app.mount('page');
  assert.match(content(app.tree()), /外掛 API 尚未載入/);
  await app.click('重載 Dashboard');
  const confirm = buttonNode(app, '確認重載');
  confirm.props.onClick(); confirm.props.onClick(); await app.settle();
  assert.equal(app.calls.filter(x => x.path === '/api/hermes-paseo-host/reload').length, 1);
  await app.advance(4000);
  assert.equal(app.reloads.length, 0, 'new host alone is insufficient while plugin API remains 404');
  ready = true;
  await app.advance(2000);
  assert.deepEqual(app.reloads, ['/paseo']);
  assert.equal(count(app, '/pair'), 0); assert.equal(count(app, '/acceptance'), 0);
});

test('Dashboard reload requires explicit confirmation; cancel and unavailable hosts do not POST', async () => {
  const app = host();
  app.hostHandle('/capabilities', () => ({ supported: true, generation: 'old' }));
  await app.mount('page');
  await app.click('重載 Dashboard'); await app.click('取消');
  assert.equal(app.calls.filter(x => x.init.method === 'POST' && x.path.includes('hermes-paseo-host')).length, 0);
  const unsupported = host();
  unsupported.hostHandle('/capabilities', () => ({ httpError: 404 }));
  await unsupported.mount('page');
  assert.equal(buttonNode(unsupported, '重載 Dashboard').props.disabled, true);
  assert.match(content(unsupported.tree()), /一次性主機設定/);
});

test('a disconnected reload POST is observed without retries and manual pause survives recovery', async () => {
  const paused = snapshot({ enabled: false, phase: 'paused', daemon: { running: false, reachable: false } });
  const app = host({ status: paused, pathname: '/paseo' });
  let accepted = false;
  app.hostHandle('/capabilities', () => ({ supported: true, generation: accepted ? 'new' : 'old' }));
  app.hostHandle('/reload', () => { accepted = true; throw new Error('connection lost after acceptance'); });
  await app.mount('page');
  await app.click('重載 Dashboard'); await app.click('確認重載');
  assert.deepEqual(app.reloads, ['/paseo']);
  assert.equal(app.calls.filter(x => x.path.endsWith('/reload')).length, 1);
  assert.equal(count(app, '/start'), 0);
  assert.equal(JSON.parse(app.storage.get('hermes-paseo:ui:v1')).paused, true);
});

test('reload timeout never refreshes an unchanged server or retries POST; expired auth is actionable', async () => {
  const app = host();
  app.hostHandle('/capabilities', () => ({ supported: true, generation: 'old' }));
  app.hostHandle('/reload', () => ({ ok: true, generation: 'old' }));
  await app.mount('page'); await app.click('重載 Dashboard'); await app.click('確認重載');
  await app.advance(60000);
  assert.equal(app.reloads.length, 0);
  assert.equal(app.calls.filter(x => x.path.endsWith('/reload')).length, 1);
  assert.match(content(app.tree()), /尚未確認重載完成/);
  const expired = host();
  expired.hostHandle('/capabilities', () => ({ supported: true, generation: 'old' }));
  expired.hostHandle('/reload', () => ({ httpError: 401 }));
  await expired.mount('page'); await expired.click('重載 Dashboard'); await expired.click('確認重載');
  assert.match(content(expired.tree()), /登入已過期/);
  assert.equal(expired.reloads.length, 0);
});

test('Dashboard reload waits while the Paseo installer is active', async () => {
  const app = host({ status: snapshot({ phase: 'installing', daemon: { running: false, reachable: false } }) });
  app.hostHandle('/capabilities', () => ({ supported: true, generation: 'old' }));
  await app.mount('page');
  assert.equal(buttonNode(app, '重載 Dashboard').props.disabled, true);
  assert.equal(app.calls.filter(x => x.path.endsWith('/reload')).length, 0);
});

test('explicit Dashboard recovery permits one failed first-start retry without clearing manual pause', async () => {
  for (const paused of [false, true]) {
    const key = 'failed-init';
    const storage = new Map([['hermes-paseo:ui:v1', JSON.stringify({ started: [key], guided: [key], paused })]]);
    const current = snapshot({ enabled: false, phase: 'not_installed', daemon: { running: false, reachable: false },
      onboarding: { required: true, completed: false, id: key } });
    const app = host({ storage, status: current, pathname: '/paseo' });
    let accepted = false;
    app.hostHandle('/capabilities', () => ({ supported: true, generation: accepted ? 'new' : 'old' }));
    app.hostHandle('/reload', () => { accepted = true; return { ok: true, generation: 'old' }; });
    await app.mount('page'); await app.click('重載 Dashboard'); await app.click('確認重載');
    const saved = JSON.parse(app.storage.get('hermes-paseo:ui:v1'));
    assert.equal(saved.started.includes(key), paused);
    assert.equal(saved.paused, paused);
    assert.equal(count(app, '/start'), 0, 'new initialization waits for the actual refresh');
  }
});

// ---- connection targets (item 6) ----
const targeted = (patch = {}) => snapshot({ selectedTarget: 'paseo', targetSaved: true, connectionCode: null, activeTarget: 'paseo', configurationPending: false, ...patch });
const targetSelect = app => nodes(nodes(app.tree()).find(row => row.type === 'label' && content(row.children[0]) === '連線標的')).find(row => row.type === 'select');
const linkNamed = (app, name) => nodes(app.tree()).find(row => row.type === 'a' && content(row) === name);
const offerFor = origin => origin + '/#offer=PRIVATE-' + Buffer.from(origin).toString('base64url');
const TABLE = [['woowtech', 'Woowtech Smart', 'https://smart.woowtech.io'], ['apporo', 'Apporo Smart', 'https://smart.apporo.ai'], ['paseo', 'Paseo', 'https://app.paseo.sh']];

test('an older backend without targets keeps the Paseo-only page and exact empty POST bodies', async () => {
  const app = host(); await app.mount('page');
  assert.equal(targetSelect(app), undefined);
  assert.equal(linkNamed(app, '開啟 Paseo'), undefined);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, false);
  app.handle('/pair', () => ({ url: offerFor('https://app.paseo.sh') }));
  await app.click('產生配對連結');
  assert.equal(app.calls.find(call => call.path.endsWith('/pair')).init.body, '{}');
  assert.equal(linkNamed(app, '使用配對連結開啟 Paseo').props.href, offerFor('https://app.paseo.sh'));
});

test('targets are offered as Woowtech Smart, Apporo Smart and Paseo, with a link to the saved target\'s web app', async () => {
  for (const [id, label, origin] of TABLE) {
    const app = host({ status: targeted({ selectedTarget: id, activeTarget: id }) }); await app.mount('page');
    const select = targetSelect(app);
    assert.deepEqual(select.children.map(option => [option.props.value, content(option)]), TABLE.map(([value, name]) => [value, name]));
    assert.equal(select.props.value, id);
    const open = linkNamed(app, '開啟 ' + label);
    assert.equal(open.props.href, origin + '/');
    assert.equal(open.props.target, '_blank');
    assert.equal(open.props.rel, 'noopener noreferrer');
    assert.equal(open.props.referrerPolicy, 'no-referrer');
    assert.equal(nodes(app.tree()).filter(row => row.type === 'a' && content(row).startsWith('開啟 ')).length, 1, 'one fixed link, for the saved target only');
    assert.equal(buttonNode(app, '儲存連線標的').props.disabled, true, 'nothing to save yet');
    assert.equal(count(app, '/config'), 0);
  }
});

test('saving a target sends exactly that target, then pairing waits until the daemon restarts with it', async () => {
  const app = host({ status: targeted() }); await app.mount('page');
  await app.change('連線標的', 'woowtech');
  assert.equal(targetSelect(app).props.value, 'woowtech');
  assert.match(content(app.tree()), /連線標的尚未儲存；儲存後才能產生 Woowtech Smart 的配對連結/);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, true, 'an unsaved target never pairs');
  assert.equal(linkNamed(app, '開啟 Paseo').props.href, 'https://app.paseo.sh/', 'the link follows the saved target');
  app.handle('/config', () => { app.status(targeted({ selectedTarget: 'woowtech', configurationPending: true })); return { saved: true, target: 'woowtech', configurationPending: true }; });
  await app.click('儲存連線標的');
  const post = app.calls.find(call => call.path.endsWith('/config'));
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.body, '{"target":"woowtech"}');
  assert.equal(post.init.headers['Content-Type'], 'application/json');
  assert.match(content(app.tree()), /標的已儲存，停止再啟動服務後生效/);
  assert.match(content(app.tree()), /停止服務」，待停止完成再按「恢復服務」/);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, true);
  assert.equal(linkNamed(app, '開啟 Woowtech Smart').props.href, 'https://smart.woowtech.io/');
  assert.equal(targetSelect(app).props.value, 'woowtech');
  assert.doesNotMatch(content(app.tree()), /Paseo 執行環境需要重啟/, 'a pending target is not mistaken for a runtime restart');
  assert.equal(count(app, '/pair'), 0);
  assert.equal(count(app, '/start'), 0);
  // Restarted with the new target: pairing returns its own web app only.
  app.status(targeted({ selectedTarget: 'woowtech', activeTarget: 'woowtech' })); await app.advance(2000);
  assert.doesNotMatch(content(app.tree()), /標的已儲存/);
  const secret = offerFor('https://smart.woowtech.io');
  app.handle('/pair', () => ({ url: secret, target: 'woowtech' }));
  await app.click('產生配對連結');
  const link = linkNamed(app, '使用配對連結開啟 Woowtech Smart');
  assert.equal(link.props.href, secret);
  assert.equal(link.props.rel, 'noopener noreferrer');
  assert.equal(link.props.referrerPolicy, 'no-referrer');
  assert.doesNotMatch(content(app.tree()), /PRIVATE/);
  assert.doesNotMatch(JSON.stringify([...app.storage]), /PRIVATE/);
  assert.deepEqual(app.logs, []);
  // Another tab saves a different target: the old link disappears at the next read.
  app.status(targeted({ selectedTarget: 'apporo', activeTarget: 'woowtech', configurationPending: true })); await app.advance(2000);
  assert.equal(linkNamed(app, '使用配對連結開啟 Woowtech Smart'), undefined);
  assert.equal(linkNamed(app, '開啟 Apporo Smart').props.href, 'https://smart.apporo.ai/');
});

test('the saved choice shows at once and the next read has the last word', async () => {
  const app = host({ status: targeted() }); await app.mount('page');
  await app.change('連線標的', 'apporo');
  const reads = count(app, '/status');
  const answer = deferred();
  app.handle('/status', () => answer.promise);
  app.handle('/config', () => ({ saved: true, target: 'apporo', configurationPending: true }));
  await app.click('儲存連線標的');
  assert.equal(targetSelect(app).props.value, 'apporo', 'no flicker back to the old choice while the status is read again');
  assert.equal(linkNamed(app, '開啟 Apporo Smart').props.href, 'https://smart.apporo.ai/');
  assert.match(content(app.tree()), /標的已儲存/);
  assert.ok(count(app, '/status') > reads);
  answer.resolve(targeted({ selectedTarget: 'apporo', configurationPending: true })); await app.settle();
  assert.equal(targetSelect(app).props.value, 'apporo');
  // A reply that does not describe this save changes nothing optimistic.
  const odd = host({ status: targeted() }); await odd.mount('page');
  await odd.change('連線標的', 'woowtech');
  odd.handle('/config', () => ({ saved: true, target: 'apporo', configurationPending: true }));
  await odd.click('儲存連線標的');
  assert.equal(targetSelect(odd).props.value, 'paseo');
});

test('an unsaved choice survives status polling, hidden tabs and the daemon restarting, and blocks pairing until saved', async () => {
  const app = host({ status: targeted() }); await app.mount('page');
  await app.change('連線標的', 'apporo');
  for (let i = 0; i < 4; i++) {
    await app.advance(2000);
    assert.equal(targetSelect(app).props.value, 'apporo', 'poll ' + i);
    assert.equal(buttonNode(app, '產生配對連結').props.disabled, true);
    assert.match(content(app.tree()), /連線標的尚未儲存/);
  }
  assert.ok(count(app, '/status') >= 5, 'the page did poll');
  await app.hidden(true); await app.hidden(false);
  assert.equal(targetSelect(app).props.value, 'apporo');
  app.status(targeted({ phase: 'restart_required', diagnosticCode: 'RESTART_REQUIRED' })); await app.advance(2000);
  assert.equal(targetSelect(app).props.value, 'apporo');
  assert.equal(count(app, '/config'), 0, 'choosing never saves by itself');
  // Choosing the saved target again drops the draft; another tab saving the same choice ends it too.
  await app.change('連線標的', 'paseo');
  assert.doesNotMatch(content(app.tree()), /尚未儲存/);
  assert.equal(buttonNode(app, '儲存連線標的').props.disabled, true);
  await app.change('連線標的', 'woowtech');
  app.status(targeted({ selectedTarget: 'woowtech', activeTarget: 'paseo', configurationPending: true })); await app.advance(2000);
  assert.doesNotMatch(content(app.tree()), /尚未儲存/);
  assert.equal(targetSelect(app).props.value, 'woowtech');
});

test('a pairing link for another target, or one naming another target, is rejected', async () => {
  for (const reply of [{ url: offerFor('https://app.paseo.sh') }, { url: offerFor('https://smart.woowtech.io'), target: 'paseo' }, { url: offerFor('https://smart.woowtech.io') + 'x y' },
    { url: 'https://smart.woowtech.io/#offer=' }, { url: 'https://smart.woowtech.io/x#offer=A' }, { url: 'https://smart.woowtech.io/?a=1#offer=A' }, { url: 'https://smart.woowtech.io:444/#offer=A' }, { url: 'https://smart.woowtech.io/#offer=A', target: 'apporo' }]) {
    const app = host({ status: targeted({ selectedTarget: 'woowtech', activeTarget: 'woowtech' }) }); await app.mount('page');
    app.handle('/pair', () => reply); await app.click('產生配對連結');
    assert.equal(nodes(app.tree()).filter(row => row.type === 'a' && content(row).startsWith('使用配對連結')).length, 0, JSON.stringify(reply).slice(0, 80));
    assert.match(content(app.tree()), /有效的官方連結/);
    assert.doesNotMatch(content(app.tree()), /PRIVATE/);
  }
  const apporo = host({ status: targeted({ selectedTarget: 'apporo', activeTarget: 'apporo' }) }); await apporo.mount('page');
  apporo.handle('/pair', () => ({ url: offerFor('https://smart.apporo.ai'), target: 'apporo' })); await apporo.click('產生配對連結');
  assert.equal(linkNamed(apporo, '使用配對連結開啟 Apporo Smart').props.href, offerFor('https://smart.apporo.ai'));
});

test('a target saved while stopped applies at the next start, and nothing here ever starts or stops the service', async () => {
  const app = host({ status: targeted({ enabled: false, phase: 'disabled', daemon: { running: false, reachable: false }, selectedTarget: 'apporo', activeTarget: null, configurationPending: true }) });
  await app.mount('page');
  assert.match(content(app.tree()), /標的已儲存，停止再啟動服務後生效/);
  assert.match(content(app.tree()), /新的連線標的「Apporo Smart」會在下次啟動服務時套用/);
  await app.change('連線標的', 'paseo');
  assert.equal(buttonNode(app, '儲存連線標的').props.disabled, false);
  await app.change('連線標的', 'apporo');
  assert.equal(buttonNode(app, '儲存連線標的').props.disabled, true);
  assert.doesNotMatch(content(app.tree()), /尚未儲存/);
  assert.equal(count(app, '/start'), 0);
  assert.equal(count(app, '/stop'), 0);
});

test('an unknown or hostile target in the status falls back to Paseo by name and builds no link from it', async () => {
  for (const bad of ['javascript:alert(1)', '__proto__', 'https://evil.example', '', 7, null, ['apporo']]) {
    const app = host({ status: targeted({ selectedTarget: bad, activeTarget: bad }) }); await app.mount('page');
    const anchors = nodes(app.tree()).filter(row => row.type === 'a').map(row => row.props.href);
    assert.deepEqual(anchors.filter(Boolean), typeof bad === 'string' ? [pairingGuide, 'https://app.paseo.sh/'] : [pairingGuide], String(bad));
    if (typeof bad === 'string') assert.equal(targetSelect(app).props.value, 'paseo');
  }
});

test('a pending target, an unsaved choice and a busy save each keep the pairing and save buttons honest', async () => {
  const app = host({ status: targeted({ selectedTarget: 'woowtech', activeTarget: 'paseo', configurationPending: true }) }); await app.mount('page');
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, true);
  assert.equal(targetSelect(app).props.disabled, false);
  const gate = deferred();
  app.handle('/config', () => gate.promise);
  await app.change('連線標的', 'apporo');
  const click = app.click('儲存連線標的');
  await app.settle();
  assert.equal(targetSelect(app).props.disabled, true, 'busy');
  assert.match(content(buttonNode(app, '正在儲存')), /正在儲存/);
  assert.equal(buttonNode(app, '正在儲存').props.disabled, true);
  gate.resolve({ saved: true, target: 'apporo', configurationPending: true }); await click; await app.settle();
  assert.equal(count(app, '/config', 'POST'), 1);
  assert.equal(targetSelect(app).props.disabled, false);
});

test('before any target is saved the page says nothing was changed, and saving what is shown (Paseo too) turns the plugin\'s settings on', async () => {
  const app = host({ status: targeted({ targetSaved: false }) }); await app.mount('page');
  assert.match(content(app.tree()), /尚未選擇連線標的：服務維持原有設定，沿用 Paseo 官方 relay，插件不會改動 daemon 的 config\.json/);
  assert.match(content(app.tree()), /下次啟動服務才會依所選標的寫入 relay、App 網址與 CORS 設定，並先把原來的 config\.json 備份為 config\.json\.pre-agent-connect/);
  assert.equal(targetSelect(app).props.value, 'paseo');
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, false, 'rc.9 paired in this state, and so does the page');
  assert.equal(buttonNode(app, '儲存連線標的').props.disabled, false, 'Paseo is a choice that can be saved');
  app.handle('/config', () => { app.status(targeted()); return { saved: true, target: 'paseo', configurationPending: false }; });
  await app.click('儲存連線標的');
  const post = app.calls.find(call => call.path.endsWith('/config'));
  assert.equal(post.init.body, '{"target":"paseo"}');
  assert.doesNotMatch(content(app.tree()), /尚未選擇連線標的/, 'saved: the notice is gone');
  assert.equal(buttonNode(app, '儲存連線標的').props.disabled, true);
  assert.doesNotMatch(content(app.tree()), /標的已儲存，停止再啟動服務後生效/, 'saving the shown target changes nothing that waits');
  // Choosing another target while nothing is saved works as it does later.
  const other = host({ status: targeted({ targetSaved: false }) }); await other.mount('page');
  await other.change('連線標的', 'apporo');
  assert.match(content(other.tree()), /連線標的尚未儲存；儲存後才能產生 Apporo Smart 的配對連結/);
  other.handle('/config', () => { other.status(targeted({ selectedTarget: 'apporo', configurationPending: true })); return { saved: true, target: 'apporo', configurationPending: true }; });
  await other.click('儲存連線標的');
  assert.equal(other.calls.find(call => call.path.endsWith('/config')).init.body, '{"target":"apporo"}');
  assert.match(content(other.tree()), /標的已儲存，停止再啟動服務後生效/);
  assert.doesNotMatch(content(other.tree()), /尚未選擇連線標的/);
});

test('a record that cannot be read is named, blocks pairing, and saving the shown target repairs it', async () => {
  const app = host({ status: targeted({ targetSaved: true, connectionCode: 'CONNECTION_STATE_CORRUPT', diagnosticCode: 'CONNECTION_STATE_CORRUPT' }) }); await app.mount('page');
  assert.match(content(app.tree()), /連線標的的紀錄（connection\.json）無法辨識，暫時顯示為 Paseo，也不會產生配對連結。重新選擇並按「儲存連線標的」即可修復/);
  assert.doesNotMatch(content(app.tree()), /尚未選擇連線標的/, 'it is not the legacy state');
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, true);
  assert.equal(buttonNode(app, '儲存連線標的').props.disabled, false, 'the shown target can be saved to replace the record');
  app.handle('/config', () => { app.status(targeted()); return { saved: true, target: 'paseo', configurationPending: false }; });
  await app.click('儲存連線標的');
  assert.equal(app.calls.find(call => call.path.endsWith('/config')).init.body, '{"target":"paseo"}');
  assert.doesNotMatch(content(app.tree()), /無法辨識/);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, false);
  assert.equal(buttonNode(app, '儲存連線標的').props.disabled, true);
  // Another target can be chosen and saved from there too.
  const other = host({ status: targeted({ selectedTarget: 'paseo', targetSaved: true, connectionCode: 'CONNECTION_STATE_CORRUPT' }) }); await other.mount('page');
  await other.change('連線標的', 'woowtech');
  other.handle('/config', () => { other.status(targeted({ selectedTarget: 'woowtech', configurationPending: true })); return { saved: true, target: 'woowtech', configurationPending: true }; });
  await other.click('儲存連線標的');
  assert.equal(other.calls.find(call => call.path.endsWith('/config')).init.body, '{"target":"woowtech"}');
  assert.doesNotMatch(content(other.tree()), /無法辨識/);
});

test('a record path that is a link is named, cannot be saved over from here, and blocks pairing', async () => {
  const app = host({ status: targeted({ targetSaved: true, connectionCode: 'UNSAFE_SYMLINK' }) }); await app.mount('page');
  assert.match(content(app.tree()), /含有符號連結，插件不會跟隨或取代它，也不會產生配對連結。請由管理者檢查 plugin-data\/hermes-paseo\/connection\.json/);
  assert.equal(buttonNode(app, '儲存連線標的').props.disabled, true);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, true);
  await app.change('連線標的', 'apporo');
  assert.equal(buttonNode(app, '儲存連線標的').props.disabled, true, 'not even for another target: the write would be refused');
  buttonNode(app, '儲存連線標的').props.onClick(); await app.settle();
  assert.equal(count(app, '/config'), 0, 'and a click that gets through anyway sends nothing');
  // Any other code is named as a code, and never as prose from the backend.
  const odd = host({ status: targeted({ targetSaved: true, connectionCode: 'STATE_UNAVAILABLE' }) }); await odd.mount('page');
  assert.match(content(odd.tree()), /連線標的的紀錄無法讀取（STATE_UNAVAILABLE）/);
  assert.equal(buttonNode(odd, '儲存連線標的').props.disabled, true, 'only a record that is known to be damaged is replaced');
  const hostile = host({ status: targeted({ targetSaved: true, connectionCode: '<b>x</b> not a code' }) }); await hostile.mount('page');
  assert.doesNotMatch(content(hostile.tree()), /<b>/);
  assert.equal(buttonNode(hostile, '產生配對連結').props.disabled, false, 'a value that is not a code is no record problem');
});

test('a failed start for a target reason is explained in plain words with its code, and a code that is not ours is not', async () => {
  const failure = (code, phase = 'error') => host({ status: targeted({ phase, diagnosticCode: code, daemon: { running: false, reachable: false } }) });
  const expected = {
    BRAND_IDENTITY_SOURCE_MISMATCH: /不是已知的 Paseo 0\.11\.2 原版（可能被改過），所以沒有更動它。請改選 Paseo 再啟動/,
    BRAND_IDENTITY_PATCH_MISMATCH: /驗證不通過，已還原檔案/,
    RUNTIME_NOT_WRITABLE: /無法寫入 runtime 目錄（權限不足或唯讀）/,
    RUNTIME_NOT_READABLE: /無法讀取 runtime 裡的 websocket-server\.js/,
    CONFIG_BACKUP_FAILED: /無法備份 daemon 的 config\.json，所以沒有改寫它/,
    UNSAFE_SYMLINK: /外掛資料路徑中有符號連結，插件拒絕跟隨/,
    CONNECTION_STATE_CORRUPT: /連線標的的紀錄無法辨識，沒有啟動/,
  };
  for (const [code, pattern] of Object.entries(expected)) {
    const app = failure(code); await app.mount('page');
    assert.match(content(app.tree()), pattern, code);
    assert.match(content(app.tree()), new RegExp('（代碼 ' + code + '）'));
  }
  for (const code of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'PROCESS_FAILED', '', null]) {
    const app = failure(code); await app.mount('page');
    assert.doesNotMatch(content(app.tree()), /（代碼 /, String(code));
  }
  const running = failure('BRAND_IDENTITY_SOURCE_MISMATCH', 'running'); await running.mount('page');
  assert.doesNotMatch(content(running.tree()), /（代碼 /, 'only while the start has failed');
});

test('the Dashboard zh-TW wording for targets stays Traditional Chinese', () => {
  const copy = [...source.matchAll(/"([^"\n]*[\u4e00-\u9fff][^"\n]*)"/g)].map(match => match[1]).join('\n');
  for (const phrase of ['連線標的', '儲存連線標的', '標的已儲存，停止再啟動服務後生效', '連線標的尚未儲存', '使用配對連結開啟', '尚未選擇連線標的', '重新選擇並按「儲存連線標的」即可修復', '請改選 Paseo 再啟動']) assert.ok(copy.includes(phrase), phrase);
  // Characters that exist only in Simplified Chinese (the Dashboard's other copy is Traditional).
  assert.doesNotMatch(copy, /[连线标储务启动开关态选择码链对话测试验证设绑]/);
});

const unprepared = (prepare, patch = {}) => targeted({ diagnosticCode: 'RESTART_REQUIRED', installed: false, prepare,
  daemon: { running: true, reachable: true, version: '0.11.2' }, ...patch });

test('while the new release is being installed beside an older daemon the page says so and advises nothing the service would refuse', async () => {
  const app = host({ status: unprepared({ stage: 'running' }) }); await app.mount('page');
  const text = content(app.tree());
  assert.match(text, /正在準備新版 Paseo 執行環境/);
  assert.match(text, /準備新版中/);
  assert.doesNotMatch(text, /需要停止再恢復服務才會換成新版本|需要重新啟動|執行環境已更新/);
  assert.equal(buttonNode(app, '停止服務').props.disabled, false, 'an explicit stop remains possible');
  assert.equal(buttonNode(app, '重新啟動／重試').props.disabled, true, 'nothing to retry while it runs');
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, false, 'the older daemon still pairs');
  assert.equal(count(app, '/start'), 0);
  // Ready: only now is the restart advised.
  app.status(targeted({ diagnosticCode: 'RESTART_REQUIRED', installed: true, prepare: { stage: 'ready' }, daemon: { running: true, reachable: true, version: '0.11.2' } })); await app.advance(2000);
  assert.match(content(app.tree()), /Paseo 執行環境已更新/);
  assert.doesNotMatch(content(app.tree()), /正在準備新版|準備失敗/);
});

test('a failed preparation shows its code and the next try, never the stop-and-restart advice, and can be retried by hand', async () => {
  const app = host({ status: unprepared({ stage: 'failed', code: 'RUNTIME_INSTALL_FAILED', retryInSeconds: 60 }, { phase: 'running' }) });
  await app.mount('header'); await app.mount('page');
  const text = content(app.tree());
  assert.match(text, /新版 Paseo 執行環境準備失敗（原因代碼 RUNTIME_INSTALL_FAILED）/);
  assert.match(text, /目前服務照常可用，不需要停止或重啟/);
  assert.match(text, /約 60 秒後自動重試/);
  assert.match(text, /仍可按「停止服務」手動停止/);
  assert.match(text, /新版準備失敗/);
  assert.doesNotMatch(text, /需要停止再恢復服務才會換成新版本|啟動失敗|需要重新啟動/);
  assert.match(content(app.tree('header')), /新版準備失敗/);
  assert.equal(buttonNode(app, '產生配對連結').props.disabled, false);
  // The retry button posts the ordinary start request: the service retries the preparation at once.
  app.handle('/start', () => { app.status(unprepared({ stage: 'running' })); return {}; });
  await app.click('立即重試準備');
  assert.equal(count(app, '/start', 'POST'), 1);
  assert.equal(app.calls.find(call => call.path.endsWith('/start')).init.body, '{}');
  assert.match(content(app.tree()), /正在準備新版/);
  assert.equal(count(app, '/stop'), 0);
});

test('a preparation that ran out of space or attempts says exactly that', async () => {
  const app = host({ status: unprepared({ stage: 'failed', code: 'INSUFFICIENT_DISK', retryInSeconds: 30, requiredMiB: 1536, availableMiB: 812 }) });
  await app.mount('page');
  assert.match(content(app.tree()), /磁碟空間不足：安裝需要約 1536 MiB 可用，目前只有 812 MiB/);
  app.status(unprepared({ stage: 'failed', code: 'RUNTIME_INSTALL_TIMEOUT', retryInSeconds: null })); await app.advance(2000);
  assert.match(content(app.tree()), /自動重試已停止，可按「立即重試準備」/);
  assert.doesNotMatch(content(app.tree()), /磁碟空間不足|秒後自動重試/);
  assert.equal(buttonNode(app, '立即重試準備').props.disabled, false);
});

test('preparation data from the service is validated: unknown stages, odd codes and bad numbers are not trusted', async () => {
  for (const prepare of [{ stage: 'exploded', code: 'X' }, 'failed', null, { stage: 'failed', code: 'lowercase/path', retryInSeconds: -5, requiredMiB: 'many', availableMiB: 1.5 }]) {
    const app = host({ status: unprepared(prepare) }); await app.mount('page');
    const text = content(app.tree());
    assert.doesNotMatch(text, /lowercase|\/path|many|-5/);
    assert.match(text, /準備新版|新版 Paseo 執行環境準備失敗/);
    assert.doesNotMatch(text, /磁碟空間不足/);
  }
  const odd = host({ status: unprepared({ stage: 'failed', code: 'lowercase/path', retryInSeconds: -5 }) }); await odd.mount('page');
  assert.match(content(odd.tree()), /原因代碼 未知）/);
  assert.match(content(odd.tree()), /自動重試已停止/);
});
