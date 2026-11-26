# Step2 security and runtime preparation implementation plan

**Goal:** Ship local, reviewable 0.1.5-rc.2 changes based on d63578d, keeping Paseo 0.11.2 and Hermes 0.22.5 compatibility.

**Architecture:** Install a separately receipted r3 runtime before stopping r2. Select control modules only by an exact known revision and verified ownership; preserve configuration, keys and Step1 opt-in targets. Preparation and safe package maintenance are independent of Smart branding.

**Tech stack:** Node ESM, Python host bridge, existing dashboard and test fixtures.

1. Update `runtime/package.json` overrides and regenerate its lock with only necessary changes; bump root/plugin to rc.2. Run `npm audit`, record both manifest SHA256s and r3 revision for parent chart allowlist.
2. Adapt revision routing in `src/runtime.mjs` and `src/runtime-layout.mjs`. Add preparation, disk preflight, private cache cleanup and failed-install recovery. Keep exact r2/r1 receipts; reject unknown daemons and directories. Prune only known, owned, inactive prior releases after a successful new start, retaining r2.
3. Add `prepare` to `src/control.mjs`, `hermes_paseo.py`, dashboard and tests. Preserve phase/enabled intent on failure, bounded automatic retries and explicit retry; stop remains available. No config normalization or provider changes.
4. Test live old-daemon control using isolated fixtures, preparation order, no rewrites, idempotence, recovery, capacity, process ownership and symlink guards. Keep target regression suites.
5. Run full Node/Python/browser suites and rc9 plugin-guard comparison with temporary files under this worktree. Document actual results and chart 0.4.10 dependency in README/operations/validation. Commit logical chunks as Codex, with no push or deployment.
