---
title: 'Reconciler: repair differences between recorded and real state (spike S-13)'
type: 'feature'
ticket: '5'
created: '2026-10-16'
status: 'built'
baseline_revision: '65734bc4e95bec12c729b8c29b675ab36f37518b'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md', '{project-root}/docs/architecture/05-key-flows.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The orchestrator keeps its records only in memory. After a crash or restart it forgets every instance, a half-built instance leaves containers, networks and volumes behind, and a destroyed id can be created again (FR-INS-05, spike S-13, handoffs H-65, H-67, H-61).

**Approach:** Truth is Docker: a reconciler scans every object with the label `vm.kind=inst`, compares it with the records, and repairs the difference at start and about every minute. Live instances are rebuilt from labels (no database). Destroyed ids are kept as tombstones in a small file. Decided on the developer's delegation, recorded as D-55 and ADR 0036 (Proposed).

## Boundaries & Constraints

**Always:** Never destroy because a list is empty or missing: if the desired state cannot be read the pass is in safe mode (only objects of instances that are not live in any record and are incomplete, and expired ones, are removed; complete unknown instances are adopted, nothing is destroyed for being unwanted) and creates and resets are refused with ORCH-BUSY until a pass has worked. Creates and resets are refused with ORCH-BUSY until the first pass at start has finished. Objects of an instance whose build or destroy is running in this process are never touched (states requested, provisioning, starting, resetting and `destroying`). Old-epoch leftovers of a live record are removed. Adopted instances report their transitions with numbers that start high (1,000,000 plus the count) so the platform's (instance, epoch, transition) de-duplication never drops them. A used and destroyed id stays refused (409) after a restart (H-65). Nothing secret is written to the tombstone file (instance id, epoch, time only). No contract file changes; no new error code (IF-8 is closed).

**Never:** A second source of truth beside Docker labels and the tombstone file. Retrying a half-built instance (the flags are gone; the failed-start retry is story 3.6, OI-24). Calls to the platform API (desired state comes through a port with a fake). Touching `contracts/**`, `.github/workflows/**`, the Excel tracker, AWS, terraform, pushes, commits (the developer's session commits). Write the dev-log last but do write it, and keep every file without a byte order mark.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Killed mid-provision | process killed during create, objects exist, no record after restart | the pass removes every object of the id, records it `failed` (INST-START-FAILED), one report | none |
| Complete unknown instance | restart, all template components of its epoch present, injector gone, others running | adopted as `ready` (access closed, access_epoch 0, deadline from `vm.expires`, idle from settings), reports with high numbers | none |
| Orphan | desired state known and does not list the id | destroyed through the normal destroy path | none |
| Safe mode | desired state raises or is None | no unwanted-destroy; creates and resets refused 429 ORCH-BUSY | logged by class name |
| Old epoch leftover | record epoch 2, objects with `vm.epoch=1` | epoch-1 objects removed | none |
| Missing objects | live record, no object in Docker (not building) | record ends `destroyed` with a report | none |
| Empty network or volume | labelled, no container, no record | removed | none |
| Tombstone | destroyed id, orchestrator restarted | create with that id is 409 ORCH-INSTANCE-EXISTS | none |
| In-flight build | record `provisioning` with a worker | not touched by a pass | none |
| Expired unknown | adopted, past `vm.expires` | destroyed by the reaper | none |
| Pass fails | backend error for one instance | the other instances are still repaired; error logged | continue |

</frozen-after-approval>

## Code Map

- `apps/orchestrator/src/vulnmart_orchestrator/backend.py` -- `Backend.scan() -> tuple[Seen, ...]` (kind, name, labels, status) for every object with `vm.kind=inst`: `FakeBackend`, `SdkBackend` (label filter), `ServiceFakeBackend` inherits; reuse `find`/remove helpers.
- `.../reconcile.py` (new) -- `DesiredStatePort` (Protocol, `desired() -> set[str] | None`), `FakeDesiredState`, `TombstoneStore` (JSONL in a state dir, atomic append, in-memory when no dir), `Reconciler` (grouping by `vm.instance`, classification, repair).
- `.../engine.py` -- `reconcile()` entry, adoption (`InstanceRecord` fields `expires_dt`, `idle_minutes`, `transition_offset`; `_move` numbering; `_expiry_reason` and `reap_due` read them instead of `base` when set), tombstone load and write on `destroyed`, `reconciled` flag and safe-mode flag checked in `accept_create` and `accept_reset` (Busy), the busy set (states and `destroying`) the pass skips.
- `.../service.py`, `__main__.py` -- `--state-dir`, a first pass before serving, the loop (same thread as the reaper or a sibling, interval from `Settings.reconcile_interval_s` default 60), safe-mode log line.
- `.../lifecycle.py` -- `Settings.reconcile_interval_s`.
- `apps/orchestrator/tests/test_reconcile.py` (new), `test_docker_integration.py` (real kill test: child process creates with a slow step, is killed, a new engine reconciles, zero labelled objects), `test_service.py` (busy before first pass).
- Docs: `docs/dev/HANDOFFS.md` (H-61, H-65, H-67 answers; new row for Akshay: desired-state source and the high transition numbers after adoption), ADR 0036, `initial.md` D-55, `CHANGELOG.md`, `docs/traceability.md` (FR-INS-05, S-13), dev-log, evidence `docs/assets/story-3-5-reconciler/`, `deferred-work.md`.

## Tasks & Acceptance

**Execution:**
- [ ] `backend.py` -- `scan()` on the protocol, fake and Docker backends
- [ ] `reconcile.py`, `lifecycle.py` -- ports, tombstones, reconciler, setting
- [ ] `engine.py` -- adoption, tombstones, busy gate, safe mode, reaper reads the new fields
- [ ] `service.py`, `__main__.py` -- state dir, first pass, loop
- [ ] tests -- every matrix row on the fake backend; the real-Docker kill test; service busy test
- [ ] docs -- as in the Code Map, story state `built`

**Acceptance Criteria:**
- Given an orchestrator killed with `kill -9` (or the process ended) during a real create, when a new orchestrator runs its first pass, then no object with `vm.instance=<id>` is left and the id is `failed`, within one pass.
- Given a restart, when a complete instance is found, then it is adopted `ready` and the reaper still ends it at its `vm.expires`.
- Given the desired state cannot be read, then nothing live is destroyed and a create answers 429 ORCH-BUSY until a pass works.
- Given `contracts/` is unchanged, `node scripts/check-contract-rules.mjs` shows 0 FAIL.

## Implementation Notes

- Built 2026-10-16. The engine gate is opt-in (`reconcile_gate`, on only in the service) so the existing engine tests need no first pass. The service's desired-state port wants every instance (`AllWantedDesiredState`) until the platform has a source (H-123).
- An empty network or volume with no container is removed without a failed record; an incomplete unknown instance with containers is recorded `failed`. An unknown template label is left alone. Adopted instances cannot be reset (ORCH-INVALID-STATE).
- Review round (2026-10-16): gate closed while a pass has errors (loop retry 5 s), repeats answered in safe mode, adopted deadline capped by the ceiling (missing label ends at once), adopted transition numbers 1,000,000 plus seconds since 2026-01-01, container state and health rules (transient states skip, dead, unhealthy or duplicated are incomplete), a live record with some objects is failed, records re-checked before each removal, tombstone fallback to memory. Deferred: tombstone append inside the engine lock, idle limit fixed at adoption, `AllWantedDesiredState` stand-in, unhandled `_known` states only logged.
- Tests: see the dev-log 2026-10-16-tannmayygupta-story-3-5-reconciler.md for the real commands and results.
## Plan Change Log

## Review Triage Log

Pass 1 (2026-10-16, thorough: blind, edge-case, verification-gap, intent-alignment). All claims checked in the code before a verdict.

| Verdict | Route | Finding and evidence |
|---|---|---|
| high | patch | A pass with per-instance errors still opened the gate (creates accepted over unrepaired state) and a failed first pass kept 429 for 60 s: the gate stays closed on errors, retry every 5 s, tests with a failing scan and a surviving thread. |
| high | patch | Transient container states (restarting, paused) were adopted as failed and swept; health was ignored (an unhealthy shop adopted as ready); duplicate component containers hidden: `Seen.health`, skip on transient, incomplete on exited/created/unhealthy/duplicate/missing, tests on the fake and a stub client for `SdkBackend.scan`. |
| high | patch | Adopted transition numbers restarted at 1,000,001 on each restart (platform dedup drops them): 1,000,000 plus seconds since 2026-01-01. Test. |
| medium | patch | Missing or unparseable `vm.expires` pushed the deadline out at every restart, a far-future label bypassed the ceiling: capped by the ceiling, a bad label expires now. Tests. |
| medium | patch | Reset of an adopted instance answered ORCH-TEMPLATE-UNKNOWN: now ORCH-INVALID-STATE with a clear text. Test. |
| medium | patch | Repeat of an accepted create or reset got 429 in safe mode: the gate runs after the repeat lookup. Test. |
| medium | patch | A live record with only some of its objects stayed `ready`: recorded failed and swept. Test. |
| medium | patch | A create accepted between the record check and the sweep could lose its objects: re-check under the engine lock. Test with a hook. |
| medium | patch | Tombstone OSError at start crashed the service, short writes tore a line: fallback to memory with a log line, write loop. Tests. |
| low | patch | `scan` took three inconsistent snapshots (networks and volumes now first), no warning without `--state-dir` (log line), import order, magic `+64`, dead `or`, integration test brittle (counts, stderr pipe), missing tests (loop failure, interval validation, production port, adoption on real Docker). Done. |
| low | defer | Tombstone append inside the engine lock; adopted idle limit fixed at adoption; the `_Everything` desired-state stand-in (H-123); `_known` ignores unhandled states (logged). In `deferred-work.md`. |
| false | rejected | "Intent surface is the fake backend, not the process": the kill test runs a real child process and real Docker; the service tests start the real service twice over one state dir. Partly true for the 1-minute loop, which now has its own tests. |
## Design Notes

Adoption is an inference from labels and Docker state, not a memory: access is unknown after a restart and is closed until the platform's next `access` call; the platform's own database stays the authority on who owns what. High transition numbers for adopted instances are a proposal for the platform (H-67 follow-up). Retention of tombstones is not set (H-65): the file only grows by one short line per destroyed instance.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests` -- expected: all pass (Docker running)
- `VM_ORCH_SERVICE=python uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_protocol.py apps/api/tests/test_wire_rules.py apps/api/tests/test_http_service.py apps/api/tests/test_reports.py apps/api/tests/test_mtls.py` -- expected: pass
- `node scripts/check-contract-rules.mjs`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass
