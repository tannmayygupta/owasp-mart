# Shop skeleton meets the instance contract (T-04)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | Sahil Roy |
| Branch / commit | t-04-shop-in-harness |
| Status | Done |
| Report tag | Target stream, Sprint 1 completion, instance integration (TB-3) |

## Requirements covered
TB-3 (shop skeleton meets the instance contract: ready only after the injector marker, serve a planted flag, emit one app event). BMAD story 1.4 of `epic-target-baseline`. Completes Sprint 1.

## Summary (plain language, 3-5 lines)
Made the real shop join a VulnMart instance per the instance contract (IF-6) and the event contract (IF-4): `/readyz` returns 200 only after the injector writes the marker `/run/vm/injected` and the shop has copied the injected snapshot to its writable `/data` and opened it; the shop reads a planted flag from `/run/vm/flags.json` for sentinel logic (never a served route); and it posts one best-effort, schema-valid event to the sidecar (unsigned — the sidecar stamps and signs). Proven with a shop-owned integration test against a real seeded snapshot, a real flags file, a marker and a fake sidecar. The live docker-compose swap and the full sidecar→ingest chain are T-09.

## Why
Without this, the shop cannot run inside an instance: it would report ready before the injector finished, never load the per-instance snapshot, and have no way to read a flag or emit telemetry. TB-3 is the tracer bullet that proves the shop-side of the contract; T-09 then runs it in the real harness under the full runtime profile.

## What was built
- `apps/shop/src/instance/instance.mjs` — `isInjected`/`markerPath`, `openSnapshot` (copy the 0444 snapshot to `/data`, make it writable, open), `readFlag`, `shopEvent` (IF-4 posted-body builder), `postEvent` (best-effort POST to the sidecar), `makeReadiness` (marker + lazy snapshot open).
- `apps/shop/src/app.mjs` — `createApp({ isReady })`: readiness is injectable; the default preserves the always-ready skeleton.
- `apps/shop/src/server.mjs` — builds readiness from the instance env (`VM_SNAPSHOT_PATH`/`VM_FLAGS_PATH`/`VM_DB_PATH`); always-ready outside an instance; fails loudly on partial config.
- `apps/shop/test/instance/instance.test.mjs` — the behaviours end to end.

## How it works
`makeReadiness` returns a `ready()` the `/readyz` handler calls: false until the marker exists, then it copies the injected snapshot to `/data`, makes the copy writable (the injected file is 0444), opens it with `node:sqlite`, and caches the handle. The shop reads a flag only through `readFlag` (no route). `shopEvent` builds the IF-4 posted body (no `instance_id`/`epoch`/`seq`; the sidecar stamps those), and `postEvent` POSTs it to `VM_SIDECAR_EVENTS_URL/v1/events` best-effort — any network error, timeout or a sidecar 503 resolves without throwing or blocking a request.

## Files changed
- `apps/shop/src/instance/instance.mjs`, `apps/shop/test/instance/instance.test.mjs` — new.
- `apps/shop/src/app.mjs`, `apps/shop/src/server.mjs` — injectable readiness + instance-env wiring.

## Decisions made
Scope settled with the developer: because the lab harness's live-checks are hard-wired to the stub's test-only routes and a JSON stand-in snapshot (which the correct shop must not and cannot replicate), T-04 delivers the shop-side behaviours + a shop-owned integration test; the literal docker-compose swap, the runtime profile, and the full sidecar→signing→fake-ingest chain are T-09. "Serve a planted flag" is implemented read-only (`readFlag`) because serving a flag in the correct shop would be a deliberate vulnerability (added per-challenge later).

## Tests
Real commands and results:
- `node --test "apps/shop/test/**/*.test.mjs"` → **61 passed, 0 failed** (55 prior + 6 new). The instance tests prove: `/readyz` 503 before the marker and 200 after; the 0444 snapshot is copied to writable `/data` and opens (a write probe succeeds); a planted flag is read by key (and a foreign key is null); `/healthz`/`/version` never leak a flag; a posted event validates against the real IF-4 posted schema, omits `instance_id`/`epoch`/`seq`, and the sidecar answers 202; and posting is best-effort (an unreachable and a hung sidecar both resolve to 0 without throwing or hanging).
- Traceability row TB-3 updated in `docs/traceability.md`.

## Evidence
Test output above; the integration test stands up the real shop (`createApp`) over HTTP against a real seeded SQLite snapshot (from `buildSnapshot`), a real flags file, a marker, and an in-test fake sidecar that validates against the actual posted schema.

## Problems met and how they were fixed
The two-lens review caught a critical bug the first test missed: `copyFileSync` preserves the snapshot's 0444 mode, so the `/data` copy was read-only and `openDb` (read-write) would fail — the real shop would never become ready. Fixed by chmod-ing the copy to 0644 (and removing a copy that fails to open); the test now reproduces the 0444 condition and asserts the opened db is writable. Also fixed: `postEvent` could throw on a response aborted mid-body (added a response error handler), `shopEvent` could not build the `import.job` event the shop must post for the import service (made `source` a parameter), a partially configured instance silently fell back to always-ready (now fails loudly), and the timeout→destroy path was untested (added a hung-sidecar test).

## Security notes (vulnerable parts only)
No deliberate weakness — this is correct instance integration. No flag is served over any route or leaked in `/healthz`/`/version`/logs/errors (the flag is read only via `readFlag`, wired to no response). The shop posts unsigned (correct — the sidecar signs). The snapshot copy stays inside the shop's own writable `/data`.

## Limitations and follow-ups
- The live docker-compose run of the real shop in the harness, the runtime profile, and the full sidecar→signing→fake-ingest chain are **T-09**.
- The running skeleton does not autonomously emit an event (no marketplace action yet); `postEvent`/`shopEvent`/`readFlag` ship as tested capabilities that later stories wire to real actions and sentinel paths.
