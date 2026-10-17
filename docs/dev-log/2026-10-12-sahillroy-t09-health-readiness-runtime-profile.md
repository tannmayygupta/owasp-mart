# Health, readiness after the marker and runtime profile (T-09)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | Sahil Roy |
| Branch / commit | sprint-2-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 2, instance runtime (FR-SHP-15) |

## Requirements covered
FR-SHP-15 (shop runs inside an instance: health endpoints, ready only after the injector marker, non-root + read-only filesystem + no egress). BMAD story 2.2 of `epic-shop-instance-integration`.

## Summary (plain language, 3-5 lines)
Ran the real shop image as an actual instance container under the IF-6 runtime profile and proved, end to end in Docker, that it is never ready before the injector marker (`/readyz` 503) and becomes ready only after it (200, with the injected snapshot copied to `/data` and opened), while running non-root (65532), read-only root, cap-drop ALL, no-new-privileges, and with no network egress. Because Tanmay's lab harness live-checks are hard-wired to the stub's `/_stub` routes and a JSON snapshot, this is a shop-owned harness driving the real shop with a real seeded snapshot.

## Why
T-04 proved the shop-side behaviours in-process against a fake sidecar; FR-SHP-15 needs the real container to actually run under the hardened profile with the marker gate. This is the foundation the rest of Sprint 2 (boundaries/events T-10, mock services T-11, import service T-12, bot T-13) builds on.

## What was built
- `apps/shop/instance-harness/shop-instance-check.mjs` — a Docker orchestrator that builds a real seeded snapshot on the host, runs the real shop image on an internal (egress-less) network under the runtime-profile flags, asserts `/healthz` up, `/readyz` 503 before the marker, injects snapshot+flags then the marker last, asserts `/readyz` 200, checks the runtime profile via `docker inspect`, checks no egress, and checks no flag leaks. `pnpm --filter @vulnmart/shop run instance:check`.
- `apps/shop/src/server.mjs` — the seed import is now dynamic (local-run branch only).
- `apps/shop/package.json` — `instance:check` script.

## How it works
The shop image ships only `src/` (no seed/migrations), so the snapshot is built on the host (T-08 `buildSnapshot`) and injected by piping it to `node` over `docker exec -i` as uid 65532 — a cap-dropped root cannot `chown`, so the files are written by the shop user with the injector's modes (snapshot 0444, flags 0400), marker last. Readiness (from T-04) copies the snapshot to writable `/data`, opens it, and flips `/readyz` to 200. The internal docker network has no gateway out, so a fetch to an external IP fails (no egress). The profile is applied by the run flags, mirroring IF-6 section 7.

## Files changed
- `apps/shop/instance-harness/shop-instance-check.mjs` — new.
- `apps/shop/src/server.mjs` — dynamic seed import.
- `apps/shop/package.json` — `instance:check` script.

## Decisions made
A shop-owned harness rather than Tanmay's stub-coupled one (his live-checks need `/_stub` routes the correct shop must not ship). The runtime profile is applied by the harness run flags per IF-6 section 7; binding it to the real orchestrator's instance template is L-13. No sidecar/event wiring here (T-10).

## Tests
Real commands and results:
- `pnpm --filter @vulnmart/shop run instance:check` (Docker 28.5.1) → **`shop-instance: PASS (9 checks)`**: live-process-up, live-not-ready-before-marker (503), live-ready-after-marker (200), live-runtime-nonroot (65532:65532), live-runtime-readonly-root, live-runtime-cap-drop-all, live-runtime-no-new-privileges, live-no-egress, live-no-flag-in-health.
- `node --test "apps/shop/test/**/*.test.mjs"` → 90 passed (the shop suite is unaffected).
- Traceability row FR-SHP-15 (shop) added in `docs/traceability.md`.

## Evidence
Harness output above; it drives the real shop image in a real hardened container and reads `docker inspect` for the profile.

## Problems met and how they were fixed
The first container run crashed with `ERR_MODULE_NOT_FOUND: /app/seed/registry.mjs` — the T-14↔T-04 merge left a top-level `import { seedAll } from '../seed/registry.mjs'` in `server.mjs`, but the production image ships only `src/`. Fixed by making the seed import dynamic inside the local-run branch, so the instance path (and the image) never loads seed code. Injection then failed with `EACCES chown` because a cap-dropped root has no `CAP_CHOWN`; fixed by writing the files as uid 65532 over `docker exec -i` stdin instead of `docker cp` + chown.

## Security notes (vulnerable parts only)
No deliberate weakness — this proves the hardened runtime. Non-root, read-only root, cap-drop ALL, no-new-privileges, no egress, no flag in the health surface. The harness uses a fake per-run flag only, confined to a temp dir and the container, both removed on teardown.

## Limitations and follow-ups
- The instance shop currently serves only the health surface; mounting the marketplace routes (T-14/15) on the injected snapshot once ready needs lazy db wiring — tracked as a follow-up in `deferred-work.md`, exercised with the flows/boundaries work.
- The profile is applied by harness run flags; binding it to the real orchestrator's IF-6 instance template is L-13.
- Running the harness in CI (Docker) is a possible follow-up; it runs locally today.
