# Hermes Paseo Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 公開可從 Hermes 插件頁安裝、啟用後進入配對，並於 Paseo 以 Hermes ACP 選模型與完成首輪／續聊。

**Architecture:** 原生 plugin.yaml＋Hermes Dashboard manifest/API/IIFE。Python bridge 使用 profile 私有狀態並以 bounded subprocess 調用固定 Node Paseo runtime；使用官方 ACP 接 Hermes，沿用受測試的 Pi 狀態鎖與程序擁有權。沒有重寫核心函式或讀出模型憑證；配對只由受保護頁面傳遞。

**Tech Stack:** Python 3.11+, FastAPI, Hermes plugin SDK, Node 22.19+, Paseo 0.11.2 fixed lock, ACP, React supplied by host.

---

### Task 1: Runtime
Create src/{runtime,state,process,runtime-layout,single-flight,provider-launchers,chat-result,provider-reply,acceptance-agent}.mjs, bin/control.mjs, runtime/package*.json and tests/runtime.test.mjs. Copy only tested, licensed runtime primitives from Pi 0.1.3; isolate Hermes home/state/ownership; register hermes ACP and discover optional local agents. Validate concurrent start/stop, pause preservation, port conflict, secret redaction and first/continued reply.

Run: node --test tests/*.test.mjs; expect all pass. Verify actual runtime dependency audit and a real isolated daemon. Commit only after checks.

### Task 2: Native Hermes and API
Create plugin.yaml, __init__.py, hermes_paseo.py, dashboard/plugin_api.py, tests/test_bridge.py. Public plugin tools for status/start/stop/models/chat/continue; pairing secrets are excluded from tools. Dashboard endpoints: status GET, start/stop/pair/acceptance POST, models/{provider} GET. Start is idempotent and checkpoint onboarding identity before fallible work. Restrict origins/JSON/body sizes, forbid arbitrary commands/cwd, bound subprocess and redact failures. Existing host lacks backend hot mount: verify concrete restart requirement before deployment.

Run: python -m unittest discover -s tests; then Hermes plugin doctor through actual discovery. Expect zero registration network side effects.

### Task 3: Dashboard
Create dashboard/manifest.json and dashboard/dist/{index.js,style.css}, tests/ui.test.mjs. Host-provided React; persistent header slot checks enabled/onboarding state and takes user to /paseo once. Page invokes start on first activation, shows installation/readiness and profile agents, gives protected pairing link with no-referrer, model and real conversation validation. Stop/resume preserves manual pause. No pair URL in logs/localStorage/chat.

Run meaningful UI tests and Playwright on actual host: plugin page install/enable, automatic pairing flow, mobile layout, models and first/followup through official Paseo. Do not label catalog listing as conversation proof.

### Task 4: Publication and authorized target
Create public WOOWTECH/hermes-paseo-plugin, push source/CI/docs with secret scan. Target approved: https://paas-cs-052c6889-49b939d2.woowtech.io, namespace paas-ws-052c6889 / svc-6e4171af-hermes-agent-0. Preserve settings and existing sessions, install via host plugin API if available, restart only as necessary with rollback evidence. Do not upgrade Hermes image or unrelated data. Record provider login limitations honestly; missing companions need official auth.
