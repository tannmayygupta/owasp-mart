# PR #14 review response: real instance wiring, image healthchecks, bug fixes, hardening

| Field | Value |
|---|---|
| Date | 2026-10-16 |
| Developer | Sahil Roy |
| Branch / commit | sprint-2-sahil |
| Status | Done (harnesses + demo confirmed on Docker) |
| Report tag | Target stream, Sprint 2 PR #14 review response (A1–A4, B, C) |

## Requirements covered

Tanmay's review on PR #14 (Sprint 2 → main) requested changes. This addresses them:
A1 image healthchecks in the build pipeline; A2(a) wire the instance-mode marketplace + app events for real; A3 refund double-payout; A4 cart quantity bound; the safe subset of B (correct-flow robustness, not challenge surface); and the C documentation-accuracy fixes.

## Summary (plain language)

In an instance the shop now actually **serves the marketplace** (it mounts on the injected snapshot db through a lazy handle, gated by `/readyz`) and **emits real app events** on the built flows — `auth.attempt` on every login and `order.paid` on a paid checkout — posting them best-effort to the sidecar (IF-4). The two correct-flow bugs Tanmay found are fixed (a refund can no longer be paid twice; a cart line cannot exceed 99). The image build pipeline now carries each image's Docker healthcheck argv so the orchestrator can health-check distroless images, and CI builds the new `services/**` images. A small, safe set of hardening items is done; the rest is deferred to the challenge-epic stories (they may be intended vulnerable surface). Documentation ticks, wording and demo evidence are made honest.

## What was done

### A2(a) — instance-mode marketplace + real event emission (the main item)
- `apps/shop/src/instance/instance.mjs`: added `lazyDb(getDb)` (a `prepare`/`exec`/`close` handle that resolves the snapshot db per call, so the marketplace can be mounted before the db opens) and `makeEmitter(eventsUrl)` (builds a posted event with `shopEvent` and posts it best-effort, fire-and-forget; a no-op without an events URL).
- `apps/shop/src/server.mjs`: in instance mode the marketplace now mounts on `lazyDb(readiness.getDb)` with `emit = makeEmitter(VM_SIDECAR_EVENTS_URL)`; the local/non-instance branch keeps the eager db and a no-op emit.
- `apps/shop/src/app.mjs`, `web/routes.mjs`: `createApp`/`registerRoutes` thread an `emit`; the login route emits `auth.attempt` (route `web`; `account_id` the user id or `unknown`; `result` `success`/`rejected`/`unknown`, never a user-enumeration oracle, never a password/email), the checkout route emits `order.paid` (`order_id`, `verified`, `via: card`).
- There is no built refund-**decision** flow yet, so `shop.refund_decision` and the other per-challenge events stay for the challenge-epic stories when those flows exist.

### A3 — refund double-payout; A4 — cart quantity bound
- `apps/shop/src/domain/shop-service.mjs`: a cancelled item cannot be refunded or disputed; a refund request is refused when any non-rejected refund already exists (so a processed refund cannot be re-requested); a dispute is refused when the item already has an approved/processed refund. Cart: `MAX_CART_QTY = 99`, `Number.isSafeInteger` check (rejects 0, negative, fractional, `>99`, `1e15`), and the merge caps the line with `MIN(qty + ?, 99)`.

### A1 — image healthchecks in the build pipeline
- `infra/images.json`: an optional per-image `healthcheck` argv (the exact node-exec HEALTHCHECK each distroless Dockerfile already uses: shop `/readyz`, mock-services `:9101/healthz`, bot-controller `:9200/healthz`, import-service socket connect).
- `scripts/images-matrix.mjs`: `healthcheck` is an optional key, validated as a non-empty list of non-empty strings whose argv[0] is an absolute binary path, never a shell/`wget`/`curl`/`nc` (distroless has no shell).
- `scripts/images-release.mjs`: emits a `healthchecks` map (role → argv) in `release.json`, matching the orchestrator allowlist's `healthchecks` field; omitted when no image declares one. The orchestrator's loader (Tanmay, H-124) adds the Docker `CMD` wrapper itself, so the shop emits the bare argv (`/nodejs/bin/node ...`) and never adds `CMD`. The end-to-end proof is the first real CI release plus the demo (not provable from the shop repo alone).
- `.github/workflows/images.yml`: `services/**` added to both the `push` and `pull_request` path filters (the `registry change:` line is in `contracts/CHANGELOG.md`).

### B — safe subset (correct-flow robustness only)
- `apps/shop/src/domain/staff-service.mjs`: a resolved/closed ticket is not reopened by an assignment; only an open/pending ticket can be resolved (no re-resolve writing a second audit line); an admin cannot suspend their own account or the last active admin.
- `apps/shop/src/web/session.mjs`: the cookie reader wraps `decodeURIComponent` in try/catch, so a crafted cookie (`vm_sess=%`) no longer 500s every request.
- `apps/shop/src/app.mjs`: the 500 handler logs the error server-side (still no stack trace to the client).
- `services/import-service/src/server.mjs`: `MAX_INFLIGHT` default 8→3, a connection cap (`MAX_CONNS`), and an early busy-reject in the `data` handler (before buffering the whole body; a probe sends no data so it is never refused). `worker.mjs`: `process.send(msg, () => process.exit(0))` so the IPC result flushes before exit, and `safeMerge` is bounded to `MAX_MERGE_DEPTH = 8`.
- Deferred to challenge-epic stories (may be intended vulnerable surface; flagged to Tanmay): session `iat`/`exp` and CSRF rotation, seeded-password per-instance overwrite, unbounded list paging, stock-check/`BEGIN IMMEDIATE` at payment, field length limits.

### C — documentation accuracy
- Restored Tanmay's canonical `docs/assets/local-demo/demo-output.txt` (2026-10-13) and saved my own runs under task slugs (`docs/assets/t03-contracts-signoff/`, `docs/assets/t14-instance-events-wiring/`); the demo script writes to `local-demo/`, so that file is restored after any run of mine.
- The T-09 harness note "marketplace-on-snapshot wiring is a follow-up" is now "proven by the T-10 harness"; the root CHANGELOG line that said the Docker re-verify was pending is updated with the real results below.

## Tests added
- `apps/shop/test/shop-service.test.mjs` (A3/A4, 5) · `apps/shop/test/instance/instance-events-wiring.test.mjs` (A2a, 5: a real POST /login and a real checkout post schema-valid events through a posted-schema-validating sidecar, and `/readyz` gates until the marker) · `apps/shop/test/staff-service.test.mjs` (B, 4) · `apps/shop/test/session.test.mjs` (B, 2) · `scripts/images-matrix.test.mjs` (A1, +2).

## Evidence
- `node --test apps/shop/test/**` → **106 pass, 0 fail**. `services/*/test/**` → **19 pass, 1 Windows skip**. `scripts/images-matrix.test.mjs` → 9. `check-contract-rules` → **15 PASS, 0 FAIL**. `check-text-files` + `scan-secrets` → PASS.
- Docker instance harnesses (shop image rebuilt from this branch): **T-09 shop-instance 9/9, T-10 shop-events 12/12** (incl. the new real-login proof: injected snapshot → marketplace serves → a correct login over loopback → the route's own emit → the sidecar signs → the fake ingest stores a stamped `auth.attempt`; the negative control still rejects an unsigned event 401, and no route to another network / no egress / no secret in the read-out all hold), **T-11 mock-services 6/6, T-12 import-service 7/7, T-13 bot 5/5** — **39 checks, 0 FAIL**. Saved under `docs/assets/t14-instance-events-wiring/`.
- `node scripts/dev.mjs demo` (**with web dashboards**) → **PASSED in 304 s**: platform + web profiles healthy, the real Python orchestrator built and ran the real `apps/shop` image in the shop role (create→ready, `/readyz` 200 inside, 0 of 7 secrets found, idempotent create/destroy, nothing left over). Saved under `docs/assets/t14-instance-events-wiring/demo-output.txt`.

## Security notes (vulnerable parts only)
No intended weakness was added or removed. A2(a) events carry ids/classes/counts only (no flag-like value; the posted schema enforces it) and are best-effort (never block a player request). The safe-B items are correct-flow robustness, not challenge surface; the ambiguous items are deferred, not changed, so no intended vulnerability is affected.

## Second review follow-ups (same day, head 49f0c34)

Tanmay's second review found the shop-side blockers fixed and asked for these:
- **B1 refund-after-dispute (must):** `requestRefund` now also refuses when a dispute on the item is open/under_review/escalated/resolved_customer (the reverse of the dispute-side guard); only a seller-resolved dispute leaves the refund path open. Test added (reverse order).
- **B2 import slowloris (must):** added an absolute per-connection deadline (`CONN_DEADLINE_MS`, default 15 s, injectable) so a client trickling one byte cannot hold a slot past the idle timeout; test added (off-Windows).
- **A healthcheck wording:** the orchestrator's loader adds the Docker `CMD` wrapper (H-124), so the shop emits the bare argv and never adds `CMD`; validator also rejects `nc`/`ncat`/`netcat`; dev-log corrected; end-to-end proof is the first real CI release plus the demo.
- **C 503-until-ready:** marketplace routes answer a clean 503 before the snapshot opens (was a logged 500 from the lazy db).
- **C emitter cap:** `makeEmitter` caps in-flight posts at 32 and drops beyond that (a login flood against a slow sidecar cannot open unbounded sockets).
- **C safeMerge:** at the depth cap a nested object is now dropped, not assigned raw (the raw assign skipped the dangerous-key filter).
- **C session:** C07's spec has no session-expiry/fixation challenge (its only session item is "end sessions after reset"), so the never-expiring cookie is a baseline gap, now fixed: sessions carry `iat`/`exp` (12 h default), `parse` rejects an expired one, and the CSRF token rotates at login (logout already drops the session). Tests added; the cookie-jar e2e tests re-read the rotated token as a real client would.
- **C cart cap:** `addToCart` is the only cart write path and is already capped (1..99 with the `MIN()` merge cap), tested; no update-quantity route exists.
- **B3 docs:** traceability FR-SHP-14/15 → `Partial` (events are only `auth.attempt`/`order.paid`; FR-SHP-15 still Partial until the healthcheck runs through the orchestrator loader), the duplicate LB-3 row removed; HANDOFFS H-28/29/31/36/37/38/40/44/47/52/54 given dated statuses; dev3-sahil carries a note on tick-vs-plan-status; deferred-work gets the accepted-deferred items and marks the T-09 marketplace follow-up and the admin-guard item resolved.

## Limitations and follow-ups
- A per-image field named `healthcheck` (argv) maps to the orchestrator's `healthchecks` map (role → argv); the orchestrator loader adds `CMD` (H-124).
- The deferred items are tracked in `docs/bmad/initiative-target/deferred-work.md` (PR #14 second-review section) for later target stories.
