# Agent Connect Naming and Pairing Guide Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give coworkers a clearly named Agent Connect interface and a shareable Traditional Chinese guide for pairing and testing all three supported Apps.

**Architecture:** Preserve the existing plugin identity, API routes and connection behavior while updating visible labels. Keep a buildless guide in `docs/pairing-guide/`, publish the same files through Sites, and link the guide from the plugin. Prepare and verify a new patch prerelease through the existing CI and staged rollout.

**Tech Stack:** Existing React plugin, static HTML/CSS/JavaScript, Playwright, Sites static hosting, GitHub CI, native PaaS updater.

---

### Task 1: Confirm the user flow and publishing destination

- Verify the deployed interface and the three App origins against source and browser behavior.
- Register one Sites project and persist its identity. Keep access private until the requested sharing audience is known.
- Capture only sanitized interface examples; do not include tenant credentials or pairing offers.

### Task 2: Rename visible plugin surfaces

**Files:** `dashboard/manifest.json`, `dashboard/dist/index.js`, `dashboard/dist/style.css`, `plugin.yaml`, `package.json`, `README.md`.

- Change the sidebar, header shortcut, title and user-facing service copy to Agent Connect.
- Keep the platform name Paseo in the platform selector and when referring specifically to its runtime or official App.
- Add the three-platform pairing guide link and distinguish plugin version from the Paseo runtime version.
- Bump the plugin to `0.1.5-rc.3`. Retain the reviewed runtime manifest pair and host adapters.
- Use existing Node, Python and browser suites to detect behavior regressions; update expectations only where visible labels changed.

### Task 3: Build a coworker testing guide

**Files:** `docs/pairing-guide/index.html`, `style.css`, `guide.js`, sanitized assets.

- Provide prerequisite checks, the exact Dashboard controls and complete pairing steps for Woowtech Smart, Apporo Smart and Paseo.
- Explain that one daemon uses one selected relay at a time, saved changes apply after stop/start, and visiting an App homepage alone does not pair a host.
- Include expected success signals, safe two-turn model prompts, platform switching, errors, and a locally generated result report.
- Include accessible platform navigation, per-platform manual checklists, copy and download report actions, print styles and mobile layouts.
- Make the report distinguish manual checks from automatic validation. Do not collect reports remotely or persist pairing material.

### Task 4: Validate and publish the guide

- Serve locally; verify all platforms, checklist state, report content, keyboard controls, links and 320/360/desktop layouts with Playwright.
- Inspect screenshots of the overview and pairing content; confirm font, stylesheet and MDI loading.
- Publish the exact reviewed static files through the Sites source helper and retain the deployment receipt.

### Task 5: Release and staged verification

- Run the relevant existing suites and candidate/updater checks, inspect the final diff, then create a reviewable PR.
- Follow the session's existing CI and merge authorization; do not bypass any failed gate.
- After release CI is green, publish rc.3 and use each service's actual updater Job, first 255 then 225.
- Verify visible Agent Connect labels, guide link, preserved identity and daemon health. Restore any temporarily suspended schedule and retain the final receipts.

The user requested implementation and a guide for coworkers. Execute in this session; routine implementation choices and reversible preparation do not need another confirmation.
