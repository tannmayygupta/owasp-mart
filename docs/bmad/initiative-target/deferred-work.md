# Deferred work (initiative-target)

## Deferred from: code review of story-shop-skeleton-runs-in-a-container-tracer-bullet-plan (2026-10-09)

- `/version` reads `VM_BUILD_ID` and `VM_CATALOG_VERSION`, which are not on the instance-contract section 2 env allowlist, and nothing stamps a real build id (so `/version` is permanently `dev`). Raise in T-03 (instance-contract consumer review): either add these names to the contract or wire a Docker build-arg to stamp the build id.
- `/readyz` not-ready (503) branch is unreachable because `isReady()` is hardcoded `true`, so it has no test seam. T-04 adds the injector-marker gate (`/run/vm/injected`) and the test that exercises both the ready and not-ready branches.

## Deferred from: code review of story-shop-identity-six-roles-permissions-and-strong-hashing-plan (2026-10-09)

- No brute-force throttling, lockout, or attempt accounting in `authenticate`. Deferred: lockout and security-event emission belong to the login flow (T-14) and interact with C07 (weak password reset) and C09 (unlogged legacy login). The `needsRehash` seam and `security_events`/`alerts` tables are in place for that work.
- Rehash-on-successful-login (using `needsRehash`) is wired by the login flow (T-14), not the identity primitives.
