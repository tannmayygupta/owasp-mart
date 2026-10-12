---
title: 'Shop skeleton meets the instance contract in the lab harness'
type: 'feature'
ticket: '4'
created: '2026-10-11'
status: 'built'
baseline_revision: 'c1a20cf'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: ['security', 'intent-alignment']
review_loop_iteration: 1
context:
  - '{project-root}/contracts/instance/instance-contract.md'
  - '{project-root}/contracts/events/app-events.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The shop skeleton (T-01) answers the health surface but does not meet the instance contract: it reports ready immediately (not after the injector marker), has no snapshot hand-over, cannot read a planted flag, and cannot emit an app event (TB-3; FR-SHP-15 is the fuller runtime profile, T-09).

**Approach:** Implement the instance-contract behaviours in the real shop — `/readyz` 200 only after the injector marker `/run/vm/injected` exists AND the injected snapshot is copied to writable `/data` and opened (IF-6 s5/6/7); read a planted flag from `/run/vm/flags.json` for sentinel logic only (never a served route — that is a later per-challenge vulnerability); and post one best-effort, schema-valid event to the sidecar (IF-4 s3, unsigned — the sidecar signs). Prove it with a shop-owned integration test (real snapshot + flags + marker in a temp dir + a fake sidecar).

**Scope decision:** The lab harness's live-checks (L-06) are hard-wired to the STUB's test-only routes (`/_stub/planted-flag`, `/_stub/emit`) and a JSON stand-in snapshot, which the correct shop must not and cannot replicate. So the literal docker-compose swap (real shop in `harness.yaml` with a real injector + runtime profile) is **deferred to T-09**; T-04 delivers the shop-side behaviours and their proof. (Chosen with the developer.)

## Boundaries & Constraints

**Always:** `/readyz` gates on marker AND snapshot-open; the shop copies the injected snapshot to `/data` before ready; flags are only read for sentinel logic; events are posted unsigned to the sidecar, best-effort, never blocking a request; posted bodies carry no `instance_id`/`epoch`/`seq`. Stay in `apps/shop/`.

**Never:** No flag served over any route or leaked in `/healthz`/`/version`/logs/errors. No signing in the shop. No changes to Tanmay's harness (`scripts/harness.mjs`, `infra/compose/harness.yaml`) or the stub. No marketplace routes (those are T-14+, a separate branch).

## I/O & Edge-Case Matrix

| Scenario | Expected |
|----------|----------|
| `/readyz` before the marker | 503 |
| `/readyz` after the marker + snapshot opens | 200 |
| Injected snapshot is 0444 | copied to `/data`, made writable, opened read-write |
| Snapshot open fails | not-ready, clean retry (no stale copy left) |
| `readFlag(key)` | the flag string, or null for a key not in this instance |
| `/healthz`, `/version` | 200, never a flag |
| Posted event | valid against IF-4 posted schema; no instance_id/epoch/seq |
| Sidecar unreachable / hung | `postEvent` resolves 0, never throws, never blocks |
| Partially configured instance env | fail loudly (all three of VM_SNAPSHOT_PATH/VM_FLAGS_PATH/VM_DB_PATH, or none) |

</frozen-after-approval>

## Code Map

- `apps/shop/src/instance/instance.mjs` -- new; `markerPath`/`isInjected`, `openSnapshot` (copy→chmod→open), `readFlag`, `shopEvent` (posted body builder), `postEvent` (best-effort POST), `makeReadiness` (marker + lazy snapshot open).
- `apps/shop/src/app.mjs` -- `createApp({ isReady })` injectable readiness (default always-ready preserves the skeleton).
- `apps/shop/src/server.mjs` -- build readiness from the instance env, or always-ready; fail loudly on partial config.
- `apps/shop/test/instance/instance.test.mjs` -- new; the behaviours above against a real snapshot + flags + marker + fake sidecar.

## Tasks & Acceptance

**Execution:**
- [x] `instance.mjs` -- readiness, snapshot copy/open, flag read, event build + best-effort post.
- [x] `app.mjs`/`server.mjs` -- injectable readiness, instance-env wiring.
- [x] `test/instance/instance.test.mjs` -- ready-after-marker, writable copy, flag read, schema-valid event accepted, best-effort (refused + hung).

**Acceptance Criteria:**
- Given no marker, `/readyz` is 503; given the marker and a readable snapshot, 200, with the snapshot copied to writable `/data` and opened.
- A planted flag is read from the flags file by key; no flag is served or leaked.
- A posted event validates against the IF-4 posted schema, omits instance_id/epoch/seq, and the sidecar answers 202; an unreachable or hung sidecar resolves to 0 without throwing or blocking.

## Implementation Notes

The running skeleton does not autonomously emit an event (there is no marketplace action yet; those are T-14+); `postEvent`/`shopEvent` ship as the tested capability that later stories wire to real actions. The full sidecar→signing→fake-ingest chain is exercised in the docker harness (T-09); T-04 proves the shop's hop (a schema-valid unsigned post the sidecar accepts).

## Plan Change Log

## Review Triage Log

### 2026-10-11 — two-lens review (security/blind-hunter, intent-alignment; Opus)

**Fixed:**
- **(critical) Read-only snapshot copy.** `copyFileSync` replicates the snapshot's 0444 mode, so the `/data` copy was read-only and `openDb` (read-write) would fail → the real shop would never become ready. `openSnapshot` now `chmod`s the copy to 0644 and removes a copy that fails to open. The test now `chmod`s the stand-in snapshot to 0444 and asserts the opened db is writable (a write probe), so the fix is exercised.
- **`postEvent` could throw** on a response aborted mid-body (no `res` error handler) — added `res.on('error', …)`.
- **`shopEvent` hardcoded `source:'shop'`** so it could not build the `import.job` event the shop must post for the import service (IF-4 H-50) — `source` is now a parameter (default `shop`).
- **Partial instance config** silently fell back to always-ready — `server.mjs` now fails loudly unless all three instance env vars are set, or none.
- **Timeout path untested** — added a hung-sidecar test proving `postEvent` resolves 0 promptly via the timeout.

**Acknowledged, not fixed:**
- "Serve a planted flag" is implemented read-only (`readFlag`), not as an HTTP route — serving a flag in the correct shop would be a deliberate vulnerability (added per-challenge later). The capability is tested but not yet wired to a sentinel path (no marketplace routes in the skeleton).
- The event is proven at the shop→sidecar hop against the posted schema, not through the real sidecar→signing→fake-ingest chain; that chain, and the literal "in the lab harness" verify, are T-09.
- `/readyz` does a small synchronous snapshot copy during the readiness window (bounded, cached after first open); `makeReadiness` does not re-check the marker once the db is cached (reset = new container).

## Design Notes

Readiness mirrors the stub's lazy marker+open check, but with a real SQLite snapshot and the writable-copy fix. Env names and the marker path are exactly those the instance contract allows.

## Verification

**Commands:**
- `node --test "apps/shop/test/**/*.test.mjs"` -- expected: the instance tests pass with the suite (ready-after-marker, writable copy, flag read, schema-valid event, best-effort).
