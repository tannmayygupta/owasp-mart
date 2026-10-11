# Deferred work (initiative-target)

## Deferred from: code review of story-shop-skeleton-runs-in-a-container-tracer-bullet-plan (2026-10-09)

- `/version` reads `VM_BUILD_ID` and `VM_CATALOG_VERSION`, which are not on the instance-contract section 2 env allowlist, and nothing stamps a real build id (so `/version` is permanently `dev`). Raise in T-03 (instance-contract consumer review): either add these names to the contract or wire a Docker build-arg to stamp the build id.
- `/readyz` not-ready (503) branch is unreachable because `isReady()` is hardcoded `true`, so it has no test seam. T-04 adds the injector-marker gate (`/run/vm/injected`) and the test that exercises both the ready and not-ready branches.

## Deferred from: code review of story-challenge-catalogue-schema-and-11-stub-entries-if-7-plan (2026-10-09)

- No consistency rule between `flag.placement` and `flag.delivery` in the IF-7 schema/validator. Deferred: the stub placements are provisional and `delivery: env` has no matching placement, so a strict coupling could be wrong now. Confirm the real placement/delivery pairs per challenge in T-19..T-29 and add the rule then.

## Deferred from: code review of story-shop-identity-six-roles-permissions-and-strong-hashing-plan (2026-10-09)

- No brute-force throttling, lockout, or attempt accounting in `authenticate`. Deferred: lockout and security-event emission belong to the login flow (T-14) and interact with C07 (weak password reset) and C09 (unlogged legacy login). The `needsRehash` seam and `security_events`/`alerts` tables are in place for that work.
- Rehash-on-successful-login (using `needsRehash`) is wired by the login flow (T-14), not the identity primitives.

## Deferred from: code review of story-customer-flows-plan (2026-10-11)

- No login throttling/lockout or security-event emission on `/login` (T-14). Deferred: the attempt-logging and lockout model is entangled with C09 (what gets logged) and C07 (password reset); design it alongside the C09 logging story. The `security_events`/`alerts` tables and the `needsRehash` seam are ready.

## Deferred from: code review of story-support-finance-and-admin-flows-plan (2026-10-11)

- `setUserStatus` (admin manage-users) has no self-suspend / last-admin guard, so an admin can lock themselves or the last admin out. Deferred: out of FR-SHP-07 scope (correct-flow role screens); add the guard with the richer admin user-management screen.
- The service layer calls `can(role, action, {})` with an empty ctx. Safe today because every staff-reachable matrix cell is unscoped (`true`/`amounts_only`); if a staff action ever gains a scoped rule (`own`/`own_store`), pass real ctx so the matrix check is not a no-op behind `requireRole`.
- `assignTicket` and `holdPayout` endpoints exist and are gated but have no UI control yet (reachable only by direct POST). Add the buttons with the fuller staff screens.
