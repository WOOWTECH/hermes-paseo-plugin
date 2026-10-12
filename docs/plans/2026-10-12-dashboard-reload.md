# Hermes Dashboard Reload Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the user reload Dashboard and continue Paseo pairing entirely within Hermes.

**Architecture:** Add a profile-local host adapter that is loaded before plugin APIs and retains the existing Hermes authentication gate. Its fixed POST operation signals only its own verified s6-supervised Dashboard process after acknowledging the request. The plugin frontend confirms the action, waits for a new server generation and an available plugin API, then refreshes the current page.

**Tech Stack:** Python/FastAPI, s6, Hermes native CLI, browser React SDK, Node test runner and pytest.

---

### Task 1: Host adapter and persistent installation

- Create `host/dashboard_control.py` and `host/hermes`.
- Mount operator-controlled adapter code and a Dashboard-only native CLI entrypoint using a read-only ConfigMap on the requested test service; every other command delegates to the original Hermes main function.
- Preserve existing privilege-drop supervision and authentication. No additional listener, cluster API token or shell-command endpoint.
- Reject unauthenticated, cross-origin, malformed and concurrent reload requests; validate the supervisor PID before signalling.
- Test authentication, scope, confirmation, request limits and PID verification in `tests/test_dashboard_control.py`.

### Task 2: Plugin UI

- Modify `dashboard/dist/index.js` to show a host-capability-aware reload control, inline confirmation and bounded reconnect state.
- The first-install action must work while the plugin API returns 404.
- Require a changed host generation and successful plugin status before refreshing; preserve manual Paseo pause state.
- Extend `tests/ui.test.mjs` for first-install recovery, cancel, double-click prevention, unavailable hosts and reconnect failures.

### Task 3: Documentation and release

- Update version metadata, `README.md`, `CHANGELOG.md`, `docs/install.zh-TW.md` and host integration documentation.
- Clearly distinguish a prepared host from a vanilla host that needs a one-time operator adapter installation.
- Run Node and Python suites, then publish the reviewed changes to the existing public repository.

### Task 4: Live validation

- Install the host adapter as the service account only on the newly requested test instance.
- Persist the adapter mounts in workload configuration; document the need to carry the mounts in deployment templates when Helm recreates the workload.
- Update the installed plugin, then perform a normal authenticated browser reload and verify server-generation change, current-page recovery, native Plugins access and Paseo pairing controls.
- Verify rejected requests do not restart the service. Keep login, pairing links and deployment-specific evidence private.
