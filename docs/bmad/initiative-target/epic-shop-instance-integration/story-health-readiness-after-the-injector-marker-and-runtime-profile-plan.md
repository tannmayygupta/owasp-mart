---
title: 'Health, readiness after the injector marker and runtime profile'
type: 'feature'
ticket: '2'
created: '2026-10-12'
status: 'done'
baseline_revision: 'db4444b'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/contracts/instance/instance-contract.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** T-04 proved the shop-side instance behaviours against a fake sidecar in-process, but the real shop had never been run as an actual instance container under the IF-6 runtime profile (FR-SHP-15): non-root, read-only root filesystem, no egress, ready only after the injector marker.

**Approach:** Run the real shop image as an instance container under the IF-6 section-7 runtime profile and prove, end to end in Docker, that it is never ready before the injector marker (503) and becomes ready only after it (200, snapshot copied to `/data` and opened), while running non-root (65532), read-only, cap-drop ALL, no-new-privileges, and with no network egress. Because Tanmay's lab harness live-checks are hard-wired to the stub's `/_stub` routes and a JSON snapshot, this is a shop-owned harness (`apps/shop/instance-harness/`) driving the real shop with a real seeded snapshot.

## Boundaries & Constraints

**Always:** Use the real shop image; apply the IF-6 section-7 profile; build the snapshot on the host (T-08) and inject it (the image ships no seed/migrations); stay in `apps/shop/`.

**Never:** No `/_stub` routes in the real shop. No changes to Tanmay's harness or the stub. No sidecar/event wiring (that is T-10). No real secrets — a fake per-run flag only.

## I/O & Edge-Case Matrix

| Check | Expected |
|-------|----------|
| Process up (/healthz) before marker | 200 |
| /readyz before the marker | 503 |
| /readyz after marker + snapshot open | 200 |
| Container user | 65532:65532 |
| Root filesystem | read-only |
| Capabilities | ALL dropped |
| no-new-privileges | set |
| Network egress (to an external IP) | blocked |
| Flag in /healthz or /version | never |

</frozen-after-approval>

## Code Map

- `apps/shop/src/server.mjs` -- the seed import is now dynamic, loaded only in the local-run branch, so the instance path (and the production image, which ships no `seed/`) never loads seed code. (Bug fix: the T-14↔T-04 merge left a top-level `../seed/registry.mjs` import that crashed the container.)
- `apps/shop/instance-harness/shop-instance-check.mjs` -- new; the Docker orchestrator that runs the real shop under the runtime profile and asserts the checks above. `pnpm --filter @vulnmart/shop run instance:check`.
- `apps/shop/package.json` -- `instance:check` script.

## Tasks & Acceptance

**Execution:**
- [x] Fix `server.mjs` so the instance image does not load seed code (dynamic import in the local-run branch only).
- [x] `instance-harness/shop-instance-check.mjs` -- run the real shop under the profile; assert ready-after-marker + the runtime profile + no egress + no flag leak.
- [x] `instance:check` script.

**Acceptance Criteria:**
- Given the real shop image run under the IF-6 runtime profile with the instance env but no marker, `/readyz` is 503; after the injector writes the marker (snapshot + flags first, marker last), `/readyz` becomes 200.
- The container runs non-root (65532), read-only root, cap-drop ALL, no-new-privileges, and cannot reach an external address.
- No flag appears in `/healthz` or `/version`.

## Implementation Notes

The snapshot is built on the host (the image carries no seed/migrations) and injected by piping it to `node` over `docker exec -i` as uid 65532, because a cap-dropped root cannot `chown`; the marker is written last. Once ready, the instance shop mounts the full marketplace on the injected snapshot through a lazy db handle (`lazyDb`) and emits real app events to the sidecar (done 2026-10-16, PR #14 review A2a; proven by the T-10 harness and the `instance-events-wiring` unit test).

## Plan Change Log

### 2026-10-16 — instance-mode marketplace + app events wired (PR #14 review A2a)

The follow-up noted in the Implementation Notes is done. In instance mode the shop now mounts the marketplace on `lazyDb(readiness.getDb)` (routes resolve the snapshot db per request, after `/readyz` is 200) and posts real IF-4 events on the built flows — `auth.attempt` on login, `order.paid` on a paid checkout — via `makeEmitter(VM_SIDECAR_EVENTS_URL)`, best-effort. New unit test `apps/shop/test/instance/instance-events-wiring.test.mjs`; the T-10 Docker harness (`shop-events-check`) now injects a snapshot, drives a real login over loopback and asserts a stamped `auth.attempt` reaches the fake ingest (12/12). See `docs/dev-log/2026-10-16-sahillroy-pr14-review-response.md`.

## Review Triage Log

### 2026-10-12 — security/correctness review (Opus)

The review confirmed the hardening itself is correct: the dynamic-import fix genuinely removes seed/migration loading from the instance path (verified against the image), the readiness gate is race-free (fresh container + fresh tmpfs `/data` each run; snapshot injected to `/run/vm`, not `/data`; marker required before the copy), and the runtime-profile assertions read real `docker inspect` values. The three real findings were all about test *strength*, now fixed:

**Fixed:**
- **No-egress check was non-hermetic** — a bare "the shop cannot reach out" also passes on an offline host, so it would not catch a dropped `--internal`. Added a positive control: a sibling container on the default bridge must reach out; if the host itself has no egress the check is reported as a NOTICE (not a false pass) instead of asserted.
- **`live-no-flag-in-health` was vacuous on error** — it passed when the endpoint was unreachable (empty body). Now asserts both endpoints answer 200 before the no-leak check.
- **`writeIn` (snapshot/flags injection) had no spawnSync timeout** — a wedged `docker exec -i` could block forever; added the 120s timeout the other docker calls use.
- Nits: removed dead code (`nodeIn` root option, unused after the inject-as-65532 change), fixed a temp-dir leak on early failure (removed in `finally` and in `main().catch`), dropped `process.exit` after `stdout.write` in the in-container probes (let node flush and exit naturally), and added an image pre-flight (`docker image inspect`) with a clear "build it first" message.

## Design Notes

A shop-owned harness rather than Tanmay's stub-coupled one; the profile mirrors IF-6 section 7 (and the harness x-instance block). Binding the profile to the real orchestrator's instance template is L-13.

## Verification

**Commands:**
- `pnpm --filter @vulnmart/shop run instance:check` (needs Docker) -- expected: `shop-instance: PASS (9 checks)`.
- `node --test "apps/shop/test/**/*.test.mjs"` -- the shop suite still passes (90).
