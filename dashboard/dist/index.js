(function () {
  "use strict";
  const SDK = window.__HERMES_PLUGIN_SDK__;
  const registry = window.__HERMES_PLUGINS__;
  if (!SDK || !SDK.React || !registry) return;
  const React = SDK.React;
  const { useState, useEffect } = SDK.hooks || React;
  const h = React.createElement;
  const BASE = "/api/plugins/hermes-paseo";
  const PLUGIN_VERSION = "0.1.5-rc.3";
  const PAIRING_GUIDE = "https://hermes-agent-connect-pairing.elmolin47.chatgpt.site/";
  const STORAGE = "hermes-paseo:ui:v1";
  const PAUSED = new Set(["disabled", "paused", "stopped", "stopping"]);
  const COMPANIONS = new Set(["claude", "codex", "pi"]);
  const AVAILABLE = new Set(["ready", "available", "installed", "authenticated", "auth_required", "login_required"]);
  // The connection targets: fixed official web apps, mirrored from src/connection-targets.mjs and hermes_paseo.py
  // (tests/target-parity.test.mjs fails when the three copies drift). A pairing link is shown only for the saved
  // target's exact origin, and no link is built from anything the backend sends. The page lists them in this order.
  const TARGETS = [
    { id: "woowtech", label: "Woowtech Smart", origin: "https://smart.woowtech.io" },
    { id: "apporo", label: "Apporo Smart", origin: "https://smart.apporo.ai" },
    { id: "paseo", label: "Paseo", origin: "https://app.paseo.sh" }
  ];
  const DEFAULT_TARGET = "paseo";
  function knownTarget(id) { return TARGETS.some(row => row.id === id); }
  // An unknown id is the default, named; it is never another row by position.
  function targetOf(id) { return TARGETS.find(row => row.id === id) || TARGETS.find(row => row.id === DEFAULT_TARGET); }
  // Until a target is saved (Paseo included) the plugin leaves the daemon's relay, app and CORS settings alone and the
  // page shows Paseo. A record that cannot be read is shown as Paseo too; saving the displayed target replaces it,
  // except where the path is a symbolic link, which the plugin never follows or replaces.
  function repairable(status) { return !!status && (!status.connectionCode || status.connectionCode === "CONNECTION_STATE_CORRUPT"); }
  function needsRecord(status) { return !!status && status.targetSupported && (!status.targetSaved || !!status.connectionCode) && repairable(status); }
  function connectionIssue(code) {
    return ({
      CONNECTION_STATE_CORRUPT: "連線標的的紀錄（connection.json）無法辨識，暫時顯示為 Paseo，也不會產生配對連結。重新選擇並按「儲存連線標的」即可修復。",
      UNSAFE_SYMLINK: "連線標的的紀錄路徑含有符號連結，插件不會跟隨或取代它，也不會產生配對連結。請由管理者檢查 plugin-data/hermes-paseo/connection.json 後再重新檢查。"
    })[code] || "連線標的的紀錄無法讀取（" + code + "），不會產生配對連結。請由管理者檢查後再重新檢查。";
  }
  // What a failed start means, for the codes this plugin raises on the way to a start. The code itself is shown too.
  // Looked up by own property only: the code is data from the backend.
  const START_FAILURES = {
    BRAND_IDENTITY_SOURCE_MISMATCH: "所選的 Smart 標的需要在 runtime 加上品牌識別補丁，但 websocket-server.js 不是已知的 Paseo 0.11.2 原版（可能被改過），所以沒有更動它。請改選 Paseo 再啟動，或請管理者還原該檔案。",
    BRAND_IDENTITY_PATCH_MISMATCH: "品牌識別補丁套用後驗證不通過，已還原檔案。請改選 Paseo 再啟動，並請管理者檢查 runtime。",
    RUNTIME_NOT_WRITABLE: "插件無法寫入 runtime 目錄（權限不足或唯讀），所以不能為所選的 Smart 標的套用補丁。請管理者修正 plugin-data/hermes-paseo/runtime 的權限，或先改選 Paseo。",
    RUNTIME_NOT_READABLE: "插件無法讀取 runtime 裡的 websocket-server.js（權限不足）。請管理者修正 plugin-data/hermes-paseo/runtime 的權限，或先改選 Paseo。",
    CONFIG_BACKUP_FAILED: "無法備份 daemon 的 config.json，所以沒有改寫它。請管理者檢查 plugin-data/hermes-paseo/daemon 的權限與剩餘空間。",
    UNSAFE_SYMLINK: "外掛資料路徑中有符號連結，插件拒絕跟隨。請管理者檢查 plugin-data/hermes-paseo 下的檔案。",
    CONNECTION_STATE_CORRUPT: "連線標的的紀錄無法辨識，沒有啟動。請在下方重新選擇並儲存連線標的。"
  };
  function startFailure(code) { return typeof code === "string" && Object.prototype.hasOwnProperty.call(START_FAILURES, code) ? START_FAILURES[code] : null; }
  let markers = { started: [], guided: [], paused: false };
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(STORAGE));
    if (saved && Array.isArray(saved.started) && Array.isArray(saved.guided)) {
      markers = { started: saved.started.slice(-40), guided: saved.guided.slice(-40), paused: saved.paused === true };
    }
  } catch (_) { /* Storage is optional; URLs never enter it. */ }
  function saveMarkers() {
    try { window.sessionStorage.setItem(STORAGE, JSON.stringify(markers)); } catch (_) { /* Private browsing. */ }
  }
  function remember(kind, key) {
    if (markers[kind].includes(key)) return;
    markers[kind] = markers[kind].concat(key).slice(-40);
    saveMarkers();
  }
  function activation(status) {
    return typeof status.onboarding.id === "string" && status.onboarding.id ? status.onboarding.id : "initial";
  }
  function pausedStatus(status) {
    return !!status && PAUSED.has(status.phase) && (status.phase !== "stopped" || !status.enabled);
  }
  function text(value, fallback) {
    return typeof value === "string" && value.trim() ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160) : fallback;
  }
  function fault(code) { const error = new Error(code); error.code = code; return error; }
  function httpFault(status) {
    return fault(status === 404 ? "RESTART" : status === 401 ? "AUTH" : status === 403 ? "FORBIDDEN" : status === 409 ? "BUSY" : "REQUEST");
  }
  function errorCopy(error) {
    return ({
      RESTART: "外掛 API 尚未載入。請使用下方「重載 Dashboard」，完成後會自動回到配對頁。",
      AUTH: "Dashboard 登入已過期，請重新整理頁面並登入。",
      FORBIDDEN: "操作被拒絕。請確認 hermes-paseo 已啟用且登入有效；若使用反向代理，請由管理者確認正式網址設定。",
      BUSY: "服務仍在處理上一項操作，請稍後重試。",
      PAIR: "配對服務沒有傳回有效的官方連結，請重新產生。",
      DATA: "服務傳回的狀態格式不完整，請重新檢查。",
      SDK: "此 Dashboard 缺少外掛 API SDK，請由管理者檢查 Hermes Dashboard 版本。",
      REQUEST: "無法完成操作。請確認 Dashboard 與 Agent Connect 服務可連線，再重試。"
    })[error && error.code] || "無法完成操作，請稍後重試。";
  }
  // authedFetch keeps host authentication without logging response bodies (pairing secrets).
  async function request(path, method, signal, body) {
    const init = { method: method || "GET", credentials: "same-origin", cache: "no-store", signal };
    if (method === "POST") {
      init.headers = { "Content-Type": "application/json" };
      init.body = body ? JSON.stringify(body) : "{}";
    }
    try {
      if (typeof SDK.authedFetch === "function") {
        const response = await SDK.authedFetch(BASE + path, init);
        if (!response.ok) throw httpFault(response.status);
        return await response.json();
      }
      // Older SDKs expose only fetchJSON. Never expose or retain their raw errors.
      if (typeof SDK.fetchJSON !== "function") throw fault("SDK");
      return await SDK.fetchJSON(BASE + path, init);
    } catch (error) {
      if (signal && signal.aborted) throw fault("ABORT");
      if (error && ["RESTART", "AUTH", "FORBIDDEN", "BUSY", "SDK"].includes(error.code)) throw error;
      const status = error && (error.status || (/^(\d{3}):/.exec(error.message || "") || [])[1]);
      throw status ? httpFault(Number(status)) : fault("REQUEST");
    }
  }
  function normalizeAcceptance(value) {
    if (!value || typeof value.passed !== "boolean" || !Array.isArray(value.providers)) throw fault("DATA");
    return { passed: value.passed, providers: value.providers.filter(row => row && typeof row.provider === "string").map(row => ({
      provider: text(row.provider, ""), passed: row.passed === true,
      code: typeof row.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(row.code) ? row.code : "",
      first: row.firstReply === true || !!(row.firstReply && row.firstReply.passed === true),
      followup: row.followup === true || !!(row.followup && row.followup.passed === true),
      cleanup: row.cleanup === true || !!(row.cleanup && row.cleanup.archived === true && row.cleanup.workspaceArchived !== false),
      workspaceArchived: !!(row.cleanup && row.cleanup.workspaceArchived === true)
    })) };
  }
  function normalizeJob(value) {
    if (!value || !(value.jobId === null || typeof value.jobId === "string") ||
        !["running", "completed", "error", "interrupted", "idle"].includes(value.phase) ||
        typeof value.pending !== "boolean" || !(value.code === null || typeof value.code === "string")) throw fault("DATA");
    return { jobId: value.jobId, phase: value.phase, pending: value.pending,
      result: value.result === null ? null : normalizeAcceptance(value.result), code: value.code };
  }
  function jobPending(job) { return !!job && (job.pending || job.phase === "running"); }
  function jobPatch(job) {
    return { acceptanceJob: job, acceptanceUncertain: false,
      acceptance: !jobPending(job) && job.phase === "completed" ? job.result : null };
  }
  function normalizePrepare(value) {
    if (!value || typeof value !== "object" || !["ready", "pending", "running", "failed"].includes(value.stage)) return null;
    const count = number => Number.isSafeInteger(number) && number >= 0 ? number : null;
    return { stage: value.stage, code: typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : "",
      retryIn: count(value.retryInSeconds), required: count(value.requiredMiB), available: count(value.availableMiB) };
  }
  function normalize(value) {
    if (!value || typeof value.enabled !== "boolean" || typeof value.phase !== "string" ||
        !value.daemon || typeof value.daemon.running !== "boolean" || typeof value.daemon.reachable !== "boolean" ||
        !Array.isArray(value.providers) || !value.onboarding || typeof value.onboarding.required !== "boolean" ||
        typeof value.onboarding.completed !== "boolean") throw fault("DATA");
    return {
      enabled: value.enabled, phase: value.phase,
      runtimeVersion: typeof value.version === "string" ? text(value.version, "") : null,
      installed: typeof value.installed === "boolean" ? value.installed : null,
      prepare: normalizePrepare(value.prepare),
      acceptanceJob: Object.prototype.hasOwnProperty.call(value, "acceptanceJob") ? normalizeJob(value.acceptanceJob) : undefined,
      diagnosticCode: typeof value.diagnosticCode === "string" ? value.diagnosticCode : null,
      daemon: { running: value.daemon.running, reachable: value.daemon.reachable },
      // An older backend still loaded after a plugin update reports no target: the page then stays Paseo-only.
      targetSupported: typeof value.selectedTarget === "string",
      selectedTarget: knownTarget(value.selectedTarget) ? value.selectedTarget : DEFAULT_TARGET,
      targetSaved: value.targetSaved === true,
      connectionCode: typeof value.connectionCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.connectionCode) ? value.connectionCode : null,
      activeTarget: knownTarget(value.activeTarget) ? value.activeTarget : null,
      configurationPending: value.configurationPending === true,
      providers: value.providers.filter(row => row && typeof row.provider === "string").map(row => ({
        provider: row.provider, label: text(row.label, row.provider), status: row.status,
        available: row.available, installed: row.installed
      })),
      onboarding: { required: value.onboarding.required, completed: value.onboarding.completed,
        id: typeof value.onboarding.id === "string" ? value.onboarding.id : "" }
    };
  }
  const subscribers = new Set();
  const modelReads = new Set();
  let state = { status: null, reading: false, busy: null, stopping: false, error: null, readError: null, pairUrl: null, targetDraft: null, acceptance: null, acceptanceJob: null, acceptanceUncertain: false };
  let pollTimer = null;
  let statusFlight = null;
  let revision = 0;
  let navigationDone = false;
  let startAttempted = false;
  let resuming = false;
  let recoveryAttempted = false;
  let dashboardReloading = false;
  function publish(patch) {
    state = Object.assign({}, state, patch);
    for (const subscriber of subscribers) subscriber.update(state);
  }
  function visible() { return document.visibilityState !== "hidden"; }
  function pageMounted() { return Array.from(subscribers).some(subscriber => subscriber.kind === "page"); }
  function canPoll() { return subscribers.size > 0 && visible() && !dashboardReloading; }
  function cancelReads() {
    revision++;
    if (statusFlight) { statusFlight.controller.abort(); statusFlight = null; }
    for (const controller of modelReads) controller.abort();
    modelReads.clear();
    publish({ reading: false });
  }
  function schedule() {
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
    if (canPoll()) pollTimer = window.setTimeout(() => { pollTimer = null; void readStatus(); }, pageMounted() ? 2000 : 5000);
  }
  function basePath() {
    const value = window.__HERMES_BASE_PATH__;
    return typeof value === "string" && /^\/(?!\/)[^?#]*$/.test(value) ? value.replace(/\/+$/, "") : "";
  }
  function navigate(event) {
    if (event && (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
    if (event) event.preventDefault();
    const path = basePath() + "/paseo";
    if (window.location.pathname.replace(/\/+$/, "") === path) return;
    // The official SDK has no router hook. BrowserRouter listens to popstate.
    window.history.pushState({}, "", path);
    window.dispatchEvent(new window.PopStateEvent("popstate"));
  }
  function activated(status) {
    // Host gates mounting and API access. enabled describes the daemon desire,
    // so a fresh not_installed or manually disabled daemon still permits start.
    return !!status && (status.enabled || ["not_installed", "installing", "starting", "disabled", "paused", "stopped", "stopping", "error", "restart_required"].includes(status.phase));
  }
  function maybeGuide(status) {
    if (!activated(status) || !status.onboarding.required || status.onboarding.completed ||
        markers.paused || pausedStatus(status) || !visible()) return;
    const key = activation(status);
    if (navigationDone || markers.guided.includes(key)) return;
    navigationDone = true;
    remember("guided", key); // Record before navigation to prevent mount/refresh loops.
    navigate();
  }
  function maybeStart(status) {
    const recovery = status && status.enabled && status.phase === "stopped" &&
      !status.daemon.running && !status.daemon.reachable && !status.diagnosticCode;
    if (!visible() || !activated(status) || (!recovery && (!pageMounted() || status.phase !== "not_installed")) ||
        markers.paused || state.busy || state.stopping) return;
    if (recovery) {
      // Recover enabled intent after a host/daemon restart. A failed attempt
      // requires an explicit retry; only confirmed readiness permits another.
      if (recoveryAttempted) return;
      recoveryAttempted = true;
    } else {
      const key = activation(status);
      if (markers.started.includes(key)) return;
      remember("started", key);
    }
    void action("start");
  }
  async function readStatus() {
    if (!canPoll()) return;
    if (statusFlight) return statusFlight.promise;
    const controller = new AbortController();
    const flight = { controller, revision, promise: null };
    statusFlight = flight;
    publish({ reading: true });
    flight.promise = (async () => {
      try {
        const result = normalize(await request("/status", "GET", controller.signal));
        if (controller.signal.aborted || flight.revision !== revision || !canPoll()) return;
        if (state.status && state.status.enabled && !result.enabled) navigationDone = false;
        if (!pausedStatus(result)) resuming = false;
        if (result.enabled && result.daemon.running && result.daemon.reachable && ["running", "ready"].includes(result.phase)) recoveryAttempted = false;
        if (navigationDone) remember("guided", activation(result));
        if (startAttempted) remember("started", activation(result));
        if (pausedStatus(result) && !resuming && state.busy !== "start") { markers.paused = true; saveMarkers(); }
        // An absent field belongs to an older server. A receipt is authoritative,
        // but a status read during submission may still describe the previous job.
        const acceptance = result.acceptanceJob !== undefined && (state.busy !== "acceptance" || markers.paused)
          ? jobPatch(result.acceptanceJob) : {};
        // A link belongs to the target it was made for, and only while that target is applied. An unsaved choice
        // (the draft) is the user's and survives every poll; it ends when the saved target becomes the same.
        const sameTarget = !state.status || state.status.selectedTarget === result.selectedTarget;
        publish(Object.assign(acceptance, { status: result, readError: null,
          targetDraft: state.targetDraft === result.selectedTarget ? null : state.targetDraft,
          pairUrl: result.enabled && !pausedStatus(result) && sameTarget && !result.configurationPending ? state.pairUrl : null }));
        maybeGuide(result);
        maybeStart(result);
      } catch (error) {
        if (!controller.signal.aborted && flight.revision === revision && canPoll()) publish({ readError: errorCopy(error) });
      } finally {
        if (statusFlight === flight) { statusFlight = null; publish({ reading: false }); schedule(); }
      }
    })();
    return flight.promise;
  }
  function visibilityChanged() {
    if (!visible()) {
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollTimer = null;
      cancelReads();
      publish({ pairUrl: null });
    } else void readStatus();
  }
  function subscribe(kind, update) {
    const subscriber = { kind, update };
    subscribers.add(subscriber);
    if (subscribers.size === 1) document.addEventListener("visibilitychange", visibilityChanged);
    update(state);
    void readStatus();
    return () => {
      subscribers.delete(subscriber);
      if (kind === "page" && !pageMounted()) {
        for (const controller of modelReads) controller.abort();
        modelReads.clear();
        publish({ pairUrl: null });
      }
      if (!subscribers.size) {
        document.removeEventListener("visibilitychange", visibilityChanged);
        if (pollTimer !== null) window.clearTimeout(pollTimer);
        pollTimer = null;
        cancelReads();
        navigationDone = false;
        startAttempted = false;
        resuming = false;
        recoveryAttempted = false;
        publish({ status: null, readError: null, error: null, pairUrl: null, targetDraft: null, acceptance: null, acceptanceJob: null,
          acceptanceUncertain: state.acceptanceUncertain || jobPending(state.acceptanceJob) || state.busy === "acceptance" });
      } else schedule();
    };
  }
  function useSnapshot(kind) {
    const [snapshot, setSnapshot] = useState(state);
    useEffect(() => subscribe(kind, setSnapshot), [kind]);
    return snapshot;
  }
  function validPairUrl(value, target) {
    if (!value || typeof value.url !== "string" || value.url.length > 16384 || /[\s\\]/.test(value.url) ||
        (value.target !== undefined && value.target !== target)) throw fault("PAIR");
    let url;
    try { url = new URL(value.url); } catch (_) { throw fault("PAIR"); }
    if (url.origin !== targetOf(target).origin || url.username || url.password || url.pathname !== "/" || url.search ||
        !/^#offer=[A-Za-z0-9_-]+$/.test(url.hash)) throw fault("PAIR");
    return url.href;
  }
  function chooseTarget(value) {
    if (!knownTarget(value) || !state.status) return;
    publish({ targetDraft: value === state.status.selectedTarget ? null : value, pairUrl: null });
  }
  async function action(name) {
    const status = state.status;
    if (!activated(status) || (name === "stop" ? state.stopping : state.busy || state.stopping)) return;
    if (name === "acceptance" && (jobPending(state.acceptanceJob) || state.acceptanceUncertain || state.readError || dashboardReloading)) return;
    if (["pair", "acceptance"].includes(name) && (!status.daemon.reachable || markers.paused || PAUSED.has(status.phase))) return;
    // A saved target applies only after the daemon was stopped and started with it; an unsaved one never pairs.
    if (name === "pair" && (status.configurationPending || state.targetDraft)) return;
    // Saving what is shown is allowed where nothing was ever saved (Paseo included) or the record must be replaced.
    const target = name === "config" ? state.targetDraft || (needsRecord(status) ? status.selectedTarget : null) : null;
    if (name === "config" && (!target || !repairable(status) || (target === status.selectedTarget && !needsRecord(status)))) return;
    if (name === "start" || name === "stop") {
      markers.paused = name === "stop";
      resuming = name === "start";
      if (name === "start") startAttempted = true;
      if (name === "start") remember("started", activation(status));
      saveMarkers();
    }
    // A stop can run during a slow GET or start. Old reads/results cannot undo it.
    cancelReads();
    const actionRevision = revision;
    publish(name === "stop" ? { stopping: true, error: null, pairUrl: null, acceptance: null } :
      { busy: name, error: null, acceptance: name === "acceptance" ? null : state.acceptance,
        acceptanceJob: name === "acceptance" ? null : state.acceptanceJob,
        // Until a receipt arrives, a lost response must never unlock a duplicate paid submission.
        acceptanceUncertain: name === "acceptance" || state.acceptanceUncertain,
        pairUrl: ["pair", "start", "config"].includes(name) ? null : state.pairUrl });
    try {
      const result = await request("/" + name, "POST", undefined, target ? { target } : undefined);
      if (actionRevision !== revision) return;
      if (name === "pair" && pageMounted() && visible()) publish({ pairUrl: validPairUrl(result, status.selectedTarget) });
      if (name === "config") {
        // Show the saved choice at once instead of the old one until the next read; that read has the last word.
        const saved = result && result.saved === true && result.target === target;
        publish({ targetDraft: null, status: saved && state.status ? Object.assign({}, state.status, { selectedTarget: target, targetSaved: true, connectionCode: null, configurationPending: result.configurationPending === true }) : state.status });
      }
      if (name === "acceptance") {
        if (result && Object.prototype.hasOwnProperty.call(result, "phase")) publish(jobPatch(normalizeJob(result)));
        else publish({ acceptance: normalizeAcceptance(result), acceptanceJob: null, acceptanceUncertain: false });
      }
      // POST completion is not evidence of readiness; refresh the actual status.
    } catch (error) {
      if (actionRevision === revision) {
        if (name === "start") resuming = false;
        if (name === "acceptance") {
          const uncertain = ["REQUEST", "DATA", "BUSY"].includes(error.code);
          publish({ acceptanceUncertain: uncertain, error: uncertain ? null : errorCopy(error) });
        } else publish({ error: errorCopy(error) });
      }
    } finally {
      if (name === "stop") publish({ stopping: false });
      else if (state.busy === name) publish({ busy: null });
      if (canPoll()) void readStatus();
    }
  }
  function choices(status) {
    const rows = status ? status.providers : [];
    const hermes = rows.find(row => row.provider === "hermes") || { provider: "hermes", label: "Hermes", status: "unknown" };
    const seen = new Set(["hermes"]);
    return [hermes].concat(rows.filter(row => {
      if (seen.has(row.provider) || !COMPANIONS.has(row.provider) || row.available === false || row.installed === false ||
          !(AVAILABLE.has(row.status) || row.available === true)) return false;
      seen.add(row.provider);
      return true;
    }));
  }
  function phaseCopy(snapshot) {
    const status = snapshot.status;
    if (snapshot.stopping) return "正在停止";
    if (snapshot.readError) return "狀態無法確認";
    if (!status) return "讀取狀態中";
    if (!activated(status)) return "外掛尚未啟用";
    if (markers.paused || pausedStatus(status)) return snapshot.busy === "start" ? "正在恢復" : status.daemon.running ? "停止待確認" : "已手動停止";
    if (status.phase === "stopped" && snapshot.busy === "start") return "正在恢復服務";
    if (status.daemon.running && status.diagnosticCode === "RESTART_REQUIRED" && status.installed === false) {
      return status.prepare && status.prepare.stage === "failed" ? "新版準備失敗" : "準備新版中";
    }
    if (status.phase === "running" && status.daemon.running && status.diagnosticCode === "RESTART_REQUIRED") return "需要重新啟動";
    return ({ not_installed: "等待初始化", installing: "正在準備連線環境", starting: "正在啟動服務",
      running: status.daemon.reachable ? "服務已就緒" : "等待服務連線", ready: "服務已就緒",
      stopped: "服務已中斷", restart_required: "需要重新啟動", error: "啟動失敗" })[status.phase] || "正在確認服務";
  }
  function button(label, onClick, disabled, secondary) {
    return h("button", { type: "button", className: secondary ? "hp-button hp-secondary" : "hp-button", onClick, disabled }, label);
  }
  function HeaderGuide() {
    const snapshot = useSnapshot("header");
    return h("div", { className: "hermes-paseo hp-header", lang: "zh-Hant" },
      h("a", { href: basePath() + "/paseo", onClick: navigate, className: "hp-guide",
        title: snapshot.readError || "開啟 Agent Connect 配對與啟用指南" },
      h("span", { className: "hp-dot", "data-ready": !!(snapshot.status && snapshot.status.enabled && snapshot.status.daemon.reachable && !markers.paused && !snapshot.readError) }),
      h("span", null, "Agent Connect"),
      h("span", { className: "hp-header-status" }, snapshot.readError ? "需要檢查" : phaseCopy(snapshot))));
  }
  function ModelSelectors({ status, blocked }) {
    const providers = choices(status);
    const [provider, setProvider] = useState("hermes");
    const [catalog, setCatalog] = useState(null);
    const [model, setModel] = useState("");
    const [mode, setMode] = useState("");
    const [error, setError] = useState(null);
    const [retry, setRetry] = useState(0);
    const providerKey = providers.map(row => row.provider).join(",");
    const allowed = providers.some(row => row.provider === provider);
    const ready = status.enabled && status.daemon.reachable && !blocked && visible();
    useEffect(() => { if (!allowed) setProvider("hermes"); }, [providerKey, provider, allowed]);
    useEffect(() => {
      setCatalog(null); setModel(""); setMode(""); setError(null);
      if (!ready || !allowed) return;
      const controller = new AbortController();
      let active = true;
      modelReads.add(controller);
      request("/models/" + encodeURIComponent(provider), "GET", controller.signal).then(value => {
        if (!active || controller.signal.aborted) return;
        if (!value || !Array.isArray(value.models) || !Array.isArray(value.modes)) throw fault("DATA");
        const clean = list => list.filter(row => row && typeof row.id === "string" && row.id && row.id.length <= 300)
          .map(row => ({ id: row.id, label: text(row.label, row.id), isDefault: row.isDefault === true }));
        const models = clean(value.models), modes = clean(value.modes);
        setCatalog({ models, modes });
        setModel((models.find(row => row.isDefault) || models[0] || {}).id || "");
        setMode((modes.find(row => row.id === value.defaultModeId) || modes.find(row => row.isDefault) || modes[0] || {}).id || "");
      }).catch(error => { if (active && !controller.signal.aborted) setError(errorCopy(error)); })
        .finally(() => modelReads.delete(controller));
      return () => { active = false; controller.abort(); modelReads.delete(controller); };
    }, [provider, ready, allowed, retry]);
    // A visibility change publishes a new snapshot; visible() gates the next read.
    function select(label, value, onChange, rows, disabled) {
      return h("label", { className: "hp-field" }, h("span", null, label),
        h("select", { value, onChange: event => onChange(event.target.value), disabled },
          !rows.length && h("option", { value: "" }, ready && !error ? "等待模型資訊" : "尚無可用選項"),
          rows.map(row => h("option", { key: row.id, value: row.id }, row.label))));
    }
    return h("section", { className: "hp-card", "aria-label": "模型與模式" },
      h("h2", null, "3. 探索模型與模式"),
      h("p", { className: "hp-muted" }, "模型與模式由 ACP 即時探索；清單代表可選項，仍須以實際模型切換與回覆確認可用性。請在所選平台建立對話時使用相同設定。"),
      h("div", { className: "hp-fields" },
        select("代理", provider, setProvider, providers.map(row => ({ id: row.provider, label: row.label })), !ready),
        select("模型", model, setModel, catalog ? catalog.models : [], !ready || !catalog || !catalog.models.length),
        select("模式", mode, setMode, catalog ? catalog.modes : [], !ready || !catalog || !catalog.modes.length)),
      error && h("div", { className: "hp-error", role: "alert" }, error,
        button("重試探索", () => setRetry(value => value + 1), !ready, true)),
      catalog && !catalog.models.length && h("p", { className: "hp-muted" }, "此代理未提供模型清單，請確認它的官方登入與 ACP 設定。"));
  }
  async function hostRequest(path, method, signal) {
    const init = { method: method || "GET", credentials: "same-origin", cache: "no-store", signal };
    if (method === "POST") {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify({ confirm: true });
    }
    const endpoint = "/api/hermes-paseo-host" + path;
    if (typeof SDK.authedFetch === "function") {
      const response = await SDK.authedFetch(endpoint, init);
      if (!response.ok) throw httpFault(response.status);
      return response.json();
    }
    if (typeof SDK.fetchJSON === "function") return SDK.fetchJSON(endpoint, init);
    throw fault("SDK");
  }
  function DashboardReload({ blocked }) {
    const [mode, setMode] = useState("checking");
    const [capability, setCapability] = useState(null);
    const [error, setError] = useState(null);
    const [operation] = useState(() => ({ alive: false, running: false, controller: null, timeout: null, delay: null }));
    useEffect(() => {
      operation.alive = true;
      const controller = new AbortController();
      operation.controller = controller;
      void hostRequest("/capabilities", "GET", controller.signal).then(value => {
        if (!operation.alive) return;
        setCapability(value);
        setMode(value && value.supported === true && typeof value.generation === "string" ? "idle" : "unavailable");
      }).catch(() => { if (operation.alive) setMode("unavailable"); });
      return () => {
        operation.alive = false;
        operation.controller?.abort();
        if (operation.timeout !== null) window.clearTimeout(operation.timeout);
        if (operation.delay !== null) window.clearTimeout(operation.delay);
        if (operation.running) { dashboardReloading = false; publish({}); schedule(); }
      };
    }, [operation]);
    async function reload() {
      if (blocked || operation.running || !capability || capability.supported !== true) return;
      operation.running = true;
      dashboardReloading = true;
      cancelReads();
      publish({ pairUrl: null });
      setError(null); setMode("waiting");
      const controller = new AbortController();
      operation.controller = controller;
      operation.timeout = window.setTimeout(() => controller.abort(), 60000);
      let previous = capability.generation;
      try {
        try {
          const accepted = await hostRequest("/reload", "POST", controller.signal);
          if (!accepted || accepted.ok !== true || typeof accepted.generation !== "string") throw fault("DATA");
          previous = accepted.generation;
        } catch (failure) {
          // A disconnected POST can already have been accepted. Observe first;
          // never send a second restart automatically.
          if (failure && ["AUTH", "FORBIDDEN", "BUSY", "DATA", "RESTART", "SDK"].includes(failure.code)) throw failure;
        }
        for (let attempt = 0; attempt < 30 && operation.alive && !controller.signal.aborted; attempt++) {
          try {
            const current = await hostRequest("/capabilities", "GET", controller.signal);
            if (current.supported === true && current.generation !== previous) {
              const recovered = normalize(await request("/status", "GET", controller.signal));
              if (operation.alive && !controller.signal.aborted) {
                if (recovered.phase === "not_installed" && !markers.paused && !pausedStatus(recovered)) {
                  // Explicit Dashboard reload may follow an earlier failed first
                  // start. Permit one new initialization after refresh, while
                  // retaining manual pause and preventing automatic retry loops.
                  markers.started = markers.started.filter(key => key !== activation(recovered));
                  saveMarkers();
                }
                window.location.reload();
                return;
              }
            }
          } catch (failure) {
            if (failure && ["AUTH", "FORBIDDEN"].includes(failure.code)) throw failure;
          }
          if (controller.signal.aborted || !operation.alive) break;
          await new Promise(resolve => {
            function complete() {
              if (operation.delay !== null) window.clearTimeout(operation.delay);
              operation.delay = null;
              controller.signal.removeEventListener("abort", complete);
              resolve();
            }
            operation.delay = window.setTimeout(complete, 2000);
            controller.signal.addEventListener("abort", complete, { once: true });
          });
        }
        throw fault("RELOAD_TIMEOUT");
      } catch (failure) {
        if (operation.alive) {
          setError(failure && failure.code === "RELOAD_TIMEOUT"
            ? "尚未確認重載完成。請稍後重新檢查，或重新登入 Dashboard。"
            : errorCopy(failure));
          setMode("failed");
        }
      } finally {
        operation.running = false;
        if (operation.timeout !== null) window.clearTimeout(operation.timeout);
        if (operation.delay !== null) window.clearTimeout(operation.delay);
        operation.timeout = operation.delay = null;
        dashboardReloading = false;
        if (operation.alive) { publish({}); schedule(); }
      }
    }
    return h("section", { className: "hp-card", "aria-label": "Dashboard 重載" },
      h("h2", null, "Dashboard 重載"),
      h("p", { className: "hp-muted" }, "安裝或更新外掛後，從這裡重新載入 Dashboard。完成後會自動回到目前頁面。"),
      mode === "checking" && h("p", { role: "status" }, "正在檢查重載功能…"),
      mode === "unavailable" && h("p", { className: "hp-muted" }, "這台主機尚未配置 Dashboard 重載介面，需要管理者完成一次性主機設定。"),
      mode === "waiting" && h("p", { role: "status", "aria-live": "polite" }, "Dashboard 正在重載，等待重新連線…"),
      error && h("p", { className: "hp-error", role: "alert" }, error),
      mode === "confirm" && h("div", { role: "dialog", "aria-modal": "false", "aria-label": "確認重載 Dashboard" },
        h("p", null, "重載期間 Dashboard 會短暫離線，進行中的網頁操作可能中斷。已儲存的設定與資料會保留。"),
        h("div", { className: "hp-actions" },
          button("確認重載", () => void reload(), blocked || operation.running),
          button("取消", () => setMode("idle"), operation.running, true))),
      mode !== "confirm" && button(mode === "waiting" ? "正在重載…" : "重載 Dashboard",
        () => setMode("confirm"), blocked || !capability || capability.supported !== true || operation.running || mode === "checking" || mode === "unavailable", true));
  }
  function Page() {
    const snapshot = useSnapshot("page");
    const status = snapshot.status;
    const paused = markers.paused || pausedStatus(status);
    const enabled = activated(status);
    const busy = !!snapshot.busy || snapshot.stopping || dashboardReloading;
    const reachable = enabled && !paused && !!status.daemon.reachable && !snapshot.readError;
    const job = snapshot.acceptanceJob;
    const acceptancePending = jobPending(job);
    const acceptanceBlocked = acceptancePending || snapshot.acceptanceUncertain;
    const acceptanceIssue = job && !acceptancePending && ({
      interrupted: "真實對話驗收已中斷，尚未確認通過。請確認服務狀態後，再自行決定是否重新執行。",
      error: "真實對話驗收發生錯誤，尚未確認通過。請確認代理的官方登入與服務狀態。",
      completed: !job.result ? "驗收已結束，但未取得有效結果，尚未確認通過。請重新檢查狀態。" : null
    })[job.phase];
    const errors = Array.from(new Set([snapshot.readError, snapshot.error].filter(Boolean)));
    const saved = targetOf(status && status.selectedTarget);
    const draft = snapshot.targetDraft && knownTarget(snapshot.targetDraft) ? snapshot.targetDraft : saved.id;
    const targetDirty = draft !== saved.id;
    const preparing = !!(status && status.daemon.running && status.diagnosticCode === "RESTART_REQUIRED" && status.installed === false);
    const prepareFailed = preparing && status.prepare && status.prepare.stage === "failed";
    const pending = !!(status && status.configurationPending);
    const legacy = !!(status && status.targetSupported && !status.targetSaved && !status.connectionCode);
    const unreadable = !!(status && status.targetSupported && status.connectionCode);
    // A saved target waits for a stop and start, an unsaved one has not been saved, and a record that cannot be read
    // names no target: none of them pairs.
    const pairBlocked = pending || targetDirty || unreadable;
    return h("div", { className: "hermes-paseo hp-page", lang: "zh-Hant" },
      h("header", { className: "hp-title" }, h("div", null, h("p", { className: "hp-eyebrow" }, "HERMES × AGENT CONNECT"),
        h("h1", null, "Agent Connect"), h("p", { className: "hp-muted" }, "選擇 Woowtech Smart、Apporo Smart 或 Paseo，配對這台 Hermes，從其他裝置繼續對話。"),
        h("p", { className: "hp-small hp-version" }, "Agent Connect 外掛 " + PLUGIN_VERSION + (status && status.runtimeVersion ? " · Paseo 底層執行環境 " + status.runtimeVersion : "")),
        h("a", { className: "hp-button hp-secondary hp-manual", href: PAIRING_GUIDE, target: "_blank", rel: "noopener noreferrer", referrerPolicy: "no-referrer" }, "三平台配對與實測教學")),
        h("span", { className: "hp-badge", role: "status", "aria-live": "polite" }, phaseCopy(snapshot))),
      errors.map(message => h("div", { key: message, className: "hp-error", role: "alert" }, message)),
      h(DashboardReload, { blocked: !!snapshot.busy || snapshot.stopping ||
        !!(status && ["installing", "starting", "stopping"].includes(status.phase)) }),
      h("section", { className: "hp-card", "aria-label": "安裝與服務" },
        h("h2", null, "1. 安裝與服務"),
        h("p", null, !status ? "正在檢查已啟用外掛的狀態。" : !enabled ? "請在 Hermes 外掛頁啟用 hermes-paseo，再回來開始設定。" :
          paused ? status.daemon.running ? "已要求停止，但服務仍在執行。請等候停止完成，或再次按「停止服務」重試。重新整理不會自動啟動。" : "你已停止服務。重新整理或切換頁面會保留停止狀態；按「恢復服務」才會再啟動。" :
          status.phase === "not_installed" || status.phase === "installing" ? "首次啟用會自動安裝所需的 Paseo 執行環境，可能需要數分鐘。配對精靈已在下方顯示。" :
          reachable ? "Agent Connect 已可連線。服務就緒與模型清單不代表已完成真實對話驗證。" : "等待安裝或服務連線完成；你隨時可以停止。"),
        h("ol", { className: "hp-progress" },
          h("li", { "data-done": !!(status && (status.daemon.running || ["starting", "running", "ready", "restart_required"].includes(status.phase))) }, "安裝執行環境"),
          h("li", { "data-done": !!(status && status.daemon.running) }, "啟動服務"),
          h("li", { "data-done": reachable }, "確認連線")),
        preparing && h("div", { className: prepareFailed ? "hp-error" : "hp-notice", role: prepareFailed ? "alert" : "status" },
          h("p", null, prepareFailed
            ? "新版 Paseo 執行環境準備失敗（原因代碼 " + (status.prepare.code || "未知") + "）。目前服務照常可用，不需要停止或重啟。" +
              (status.prepare.retryIn !== null ? "約 " + status.prepare.retryIn + " 秒後自動重試；" : "自動重試已停止，可按「立即重試準備」；") +
              "準備完成後才會提示重啟；仍可按「停止服務」手動停止。"
            : "正在準備新版 Paseo 執行環境（目前的服務照常可用，不需要任何操作）。準備完成後這裡才會提示重新啟動；仍可按「停止服務」手動停止。"),
          prepareFailed && status.prepare.code === "INSUFFICIENT_DISK" && status.prepare.required !== null && status.prepare.available !== null &&
            h("p", null, "磁碟空間不足：安裝需要約 " + status.prepare.required + " MiB 可用，目前只有 " + status.prepare.available + " MiB。清出空間後會自動重試。")),
        status && !preparing && !pending && (status.phase === "restart_required" || status.diagnosticCode === "RESTART_REQUIRED") && h("p", { className: "hp-error" }, status.installed === true
          ? "Paseo 執行環境已更新" +
            "，需要停止再恢復服務才會換成新版本。目前的服務照常可用；請先結束使用中的對話。"
          : "Paseo 執行環境需要重啟。請先停止，再恢復服務。"),

        status && status.phase === "error" && startFailure(status.diagnosticCode) && h("p", { className: "hp-error", role: "alert" },
          startFailure(status.diagnosticCode), "（代碼 " + status.diagnosticCode + "）"),
        h("div", { className: "hp-actions" },
          button(snapshot.stopping ? "正在停止…" : "停止服務", () => void action("stop"), !enabled || snapshot.stopping || dashboardReloading || (paused && !status.daemon.running), true),
          button(snapshot.busy === "start" ? "正在啟動…" : paused ? "恢復服務" : prepareFailed ? "立即重試準備" : "重新啟動／重試", () => void action("start"),
            !enabled || busy || !!snapshot.readError || (!paused && reachable && !prepareFailed), false),
          button(snapshot.reading ? "檢查中…" : "重新檢查", () => void readStatus(), snapshot.reading || dashboardReloading, true)),
        h("p", { className: "hp-muted hp-small" }, "頁面約每 2 秒檢查一次，頁首約每 5 秒檢查。分頁隱藏時暫停讀取；已送出的操作仍由服務處理。")),
      h("section", { className: "hp-card hp-pair", "aria-label": "配對精靈" },
        h("h2", null, "2. 配對精靈"),
        h("p", null, "啟用後配對精靈會自動顯示。選擇連線標的並儲存，服務就緒後產生連結，再親自點擊開啟該標的的官方網站並綁定這台主機。"),
        status && status.targetSupported && h("div", { className: "hp-target" },
          h("label", { className: "hp-field" }, h("span", null, "連線標的"),
            h("select", { value: draft, onChange: event => chooseTarget(event.target.value), disabled: !enabled || busy },
              TARGETS.map(row => h("option", { key: row.id, value: row.id }, row.label)))),
          h("div", { className: "hp-actions" },
            button(snapshot.busy === "config" ? "正在儲存…" : "儲存連線標的", () => void action("config"), !enabled || busy || !repairable(status) || !(targetDirty || needsRecord(status)), true),
            h("a", { className: "hp-button hp-secondary", href: saved.origin + "/", target: "_blank",
              rel: "noopener noreferrer", referrerPolicy: "no-referrer" }, "開啟 " + saved.label))),
        legacy && h("div", { className: "hp-notice", role: "status" },
          h("p", null, "尚未選擇連線標的：服務維持原有設定，沿用 Paseo 官方 relay，插件不會改動 daemon 的 config.json。"),
          h("p", { className: "hp-small" }, "儲存連線標的（Paseo 也可以）之後，下次啟動服務才會依所選標的寫入 relay、App 網址與 CORS 設定，並先把原來的 config.json 備份為 config.json.pre-agent-connect。")),
        unreadable && h("p", { className: "hp-error", role: "alert" }, connectionIssue(status.connectionCode)),
        targetDirty && h("p", { className: "hp-muted", role: "status" }, "連線標的尚未儲存；儲存後才能產生 " + targetOf(draft).label + " 的配對連結。"),
        pending && !preparing && h("div", { className: "hp-notice", role: "status" },
          h("p", null, "標的已儲存，停止再啟動服務後生效。"),
          h("p", { className: "hp-small" }, status.daemon.running
            ? "目前的服務仍是舊標的：請先結束使用中的對話，按「停止服務」，待停止完成再按「恢復服務」，之後重新產生「" + saved.label + "」的配對連結。已配對的裝置不會被撤銷，切回原標的後仍可使用。"
            : "新的連線標的「" + saved.label + "」會在下次啟動服務時套用。")),
        !reachable && h("p", { className: "hp-muted" }, paused ? "確認停止完成並恢復服務後，即可配對。" : "正在等待服務就緒，無須允許自動彈出視窗。"),
        button(snapshot.busy === "pair" ? "正在產生連結…" : snapshot.pairUrl ? "重新產生配對連結" : "產生配對連結", () => void action("pair"), !reachable || busy || !!snapshot.readError || pairBlocked),
        snapshot.pairUrl && h("a", { className: "hp-button hp-link", href: snapshot.pairUrl, target: "_blank",
          rel: "noopener noreferrer", referrerPolicy: "no-referrer" }, "使用配對連結開啟 " + saved.label),
        h("p", { className: "hp-muted hp-small" }, "配對連結只適用於 " + saved.label + "，僅顯示在本頁，離開或隱藏分頁後會清除。配對連結可能授予存取權，請勿分享。")),
      status && h(ModelSelectors, { status, blocked: paused || busy || !!snapshot.readError }),
      h("section", { className: "hp-card", "aria-label": "真實對話驗收" },
        h("h2", null, "4. 真實對話驗收"),
        h("p", null, "此操作會向 Hermes 發送真實首輪與續聊請求，會消耗帳號的模型額度，也可能產生費用。只有按下按鈕才會執行。"),
        button(snapshot.busy === "acceptance" ? "正在進行付費驗收…" : acceptancePending ? "驗收進行中，等待結果…" :
          snapshot.acceptanceUncertain ? "驗收狀態待確認…" : "執行真實對話驗收（會消耗帳號額度）",
          () => void action("acceptance"), !reachable || busy || acceptanceBlocked || !!snapshot.readError),
        acceptancePending && h("p", { role: "status", "aria-live": "polite" }, "驗收已在背景執行，正在等待驗證結果；請勿重複送出。"),
        snapshot.acceptanceUncertain && snapshot.busy !== "acceptance" && h("p", { role: "status", "aria-live": "polite" },
          "驗收請求可能已送達，結果尚無法確認。請重新檢查狀態；不會自動重送付費請求。"),
        acceptanceIssue && h("p", { className: "hp-error", role: "alert" }, acceptanceIssue),
        h("p", { className: "hp-muted hp-small" }, "驗收採用後端的代理預設設定；上方選單用於探索，不會變更驗收設定。"),
        snapshot.acceptance && h("div", { className: "hp-result", role: "status", "aria-live": "polite" },
          h("strong", null, snapshot.acceptance.passed ? "後端回報：真實對話驗收通過" :
            snapshot.acceptance.providers.some(row => row.code === "MODEL_SELECTION_UNAVAILABLE")
              ? "Hermes 未成功套用選定模型；驗收未向其他模型送出訊息。請先檢查 Hermes 模型服務。"
              : "真實對話驗收未全部通過；請確認代理的官方登入與服務狀態。"),
          h("ul", null, snapshot.acceptance.providers.map((row, index) => h("li", { key: index },
            ((status ? status.providers : []).find(provider => provider.provider === row.provider) || {}).label || row.provider,
            "：", row.passed ? "通過首輪與續聊驗收" : "未通過", row.cleanup ? "；測試代理已清理" : "；請檢查測試清理狀態", row.workspaceArchived ? "，工作區已歸檔" : ""))))));
  }
  registry.register("hermes-paseo", Page);
  if (typeof registry.registerSlot === "function") registry.registerSlot("hermes-paseo", "header-right", HeaderGuide);
})();
