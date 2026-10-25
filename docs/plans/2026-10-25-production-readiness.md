# Hermes Paseo Production Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore the current Hermes service, fix release blockers, and verify every supported installation, lifecycle, pairing and conversation flow with explicit evidence.

**Architecture:** Keep the plugin profile scoped, replace manual deployment assumptions with an operator-controlled host adapter and durable lifecycle integration, and validate against the actual Hermes 0.22.5 / Python 3.14 / Node 26 deployment. Preserve credentials through the platform's normal authentication/model configuration; do not copy another service's credentials or conversation history.

**Tech Stack:** Python/FastAPI, Hermes ACP, Node/Paseo 0.11.2 managed runtime, s6, Kubernetes, Chromium/Playwright, GitHub Actions.

---

### Task 1: Freeze the failing baseline

- Record public source/release, current runtime/image and host-wrapper drift.
- Reproduce same-origin plugin POST failing with STATE_UNAVAILABLE after fsGroup widens the private Origin file.
- Run the Node/Python suites and dependency audit separately; historical passing CI is not current evidence.

### Task 2: Runtime dependencies (independent worker)

- Update only `runtime/package.json`, `runtime/package-lock.json`, and revision literals/tests that require a changed runtime receipt.
- Keep Paseo 0.11.2 until a protocol migration is justified by evidence; choose patched compatible dependency overrides.
- Require a fresh npm audit and deterministic installation before integration.

### Task 3: Repeatable browser verification (independent worker)

- Update `tests/ui-browser.py` for current Dashboard reload and privacy behavior.
- Add a runnable browser CI job plus current Python/Node compatibility checks and periodic dependency checks.
- Keep credentials, pairing offers and real deployments out of public test fixtures.

### Task 4: Durable host/profile lifecycle (main)

- Add a narrow owner-verified repair for operator-created Origin permissions at container startup; do not weaken the bridge's private-file check.
- Integrate start/recovery and graceful stop with the existing host adapter while preserving manual pause and explicit plugin enablement.
- Support the current bundle CLI bootstrap; test exact wrapper behavior against the installed image before rollout.
- Add failing regression tests first for restart/remount and plugin disable/remove behavior.

### Task 5: Real account/model setup and end-to-end validation

- Inspect available account-owned model configuration through normal product interfaces; if required information is missing, ask once while continuing unrelated work.
- Verify fresh Web install, enable, reload, runtime preparation, official pairing, model/mode selection, first reply and memory follow-up.
- Verify native plugin tools, stop/resume, reload, restart without an open browser, update and supported disable/remove/reinstall behavior.
- Validate every installed/authenticated companion separately; missing providers and missing model login are explicit unmet conditions, not successful tests.

### Task 6: Release and evidence

- Run full local suites, browser checks, dependency audit and current-version integration.
- Publish only reviewed source, reproducible instructions and sanitized validation; keep deployment credentials/evidence private.
- Give the user the exact test URL and an acceptance matrix with passed, unsupported and genuinely blocked rows; do not claim completion until required work is actually finished.

### Task 7: Blockers found during live acceptance

- Retire provably stale PID locks without signalling a reused Dashboard PID; persist container identity for fast recreations.
- Bound native local inference and HTTP threads by cgroup CPU quota; retain explicit operator settings.
- Keep optional speech downloads opt-in for the managed text service, preserving an existing explicit enable.
- Flush and exit one-shot control processes so dependency handles cannot hold completed results open.
- Replace the synchronous Web acceptance request after observing Cloudflare HTTP 524 at 125 seconds: return a durable background job, deduplicate submissions across processes, poll via authenticated status, and preserve a running job through Dashboard reload. Never retry a model call automatically.
- Use a dedicated local-model fixture with an explicit ACP toolset for resource-bounded real conversations; preserve the pre-test configuration privately. This does not establish cloud-provider authentication or companion availability.
