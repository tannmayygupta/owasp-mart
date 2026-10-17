---
title: 'Reset with new flags, teardown at expiry or inactivity, timing defaults'
type: 'feature'
ticket: '4'
created: '2026-10-15'
status: 'built'
baseline_revision: 'a60bbc873c15ecc9cdda9a24a1bf342f3ef6642d'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The orchestrator answers a reset with ORCH-NOT-IMPLEMENTED and never ends an instance by itself, so a reset cannot give new flags and an instance that nobody uses stays for ever (FR-INS-03, FR-INS-04, handoffs H-57, H-59, H-61, H-65, H-67).

**Approach:** Reset runs the create path again with epoch+1 after the old epoch's objects are removed. A reaper with an injectable clock destroys at the total limit and after inactivity through the normal destroy path. All timing numbers sit in one `SettingsPort`, faked in process. Decided on the developer's delegation, recorded as D-54 and ADR 0035 (Proposed).

## Boundaries & Constraints

**Always:** No contract file changes (IF-5 is 1.0.0 and registry-checked). Reset body is the new epoch plus new secrets only; template, owner, hostname and limits come from the record. Epoch must be current+1 (409 ORCH-STALE-EPOCH), only from ready, active or idle (409 ORCH-INVALID-STATE), no capacity check (memory stays counted), 202 first and 200 for the same body, same new epoch with another body is 409 ORCH-REQUEST-MISMATCH. Transition numbering restarts at 1 in the new epoch. Old-epoch objects are removed (by the `vm.epoch` label) before the new epoch's objects exist, volumes included (H-61). The record keeps no flag, decoy, key or seed after its work ran. `access` and `access_epoch` stay platform-owned and are not changed by reset. The total limit counts from the first create (a reset does not extend it); the reset plan's `vm.expires` label keeps the original expiry. A destroy during reset cancels it like a destroy during create. Teardown uses the normal destroy path, so reports and the sweep are the same.

**Never:** Touching `contracts/**`, the Excel tracker, `apps/api` source (tests only: remove the `needs_reset` skip), AWS, terraform, pushes. No persistence and no list-all call (story 3.5). No idle logic for candidates beyond their own `idle_minutes` (the platform sets it at create). No change to quotas or the failed retry (story 3.6, OI-24).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Reset ready | epoch 1, ready, body epoch 2 | 202, state resetting, epoch 2, then provisioning, starting, ready; epoch-1 objects gone; injector got the new flags on stdin only | none |
| Reset repeat | same body again | 200, current view, no new work | none |
| Same epoch other body | epoch 2 known, other flags | 409 ORCH-REQUEST-MISMATCH | problem body (IF-8) |
| Skipped epoch | current 1, body 3 | 409 ORCH-STALE-EPOCH | nothing changes |
| Bad state | provisioning, stopping, failed | 409 ORCH-INVALID-STATE | nothing changes |
| Unknown id | no record | 404 ORCH-INSTANCE-NOT-FOUND | none |
| Reset fails | injector exits 1 | every object of the id removed, state failed with code | as create |
| Activity | record_activity at T while ready or idle | state active, last activity T, one report | no change when already active |
| Quiet | no activity for `active_window` | active becomes idle | none |
| Inactivity | no activity for `idle_minutes` since ready or the last activity | destroy accepted by the reaper, ends destroyed | none |
| Total limit | now at or after created + min(max_minutes, ceiling) | destroy in any live state | none |
| Candidate | long `idle_minutes` in the create | not stopped before it | none |
| Restart of a reset | destroy arrives during reset | cancelled, destroy finishes | none |

</frozen-after-approval>

## Code Map

- `apps/orchestrator/src/vulnmart_orchestrator/engine.py` -- `InstanceRecord` (add `base` spec without secrets, `created_dt`, `last_activity`, `reset_prints`); `accept_reset` and `_run_reset` beside `accept_create`/`_run` (reuse `_run`, `_sweep`, `_fail`, `_move`); `record_activity`, `force_activity`, `reap_due`. Change `_sweep` to take an optional epoch. The `accept_create` message "a new epoch is a reset" stays for create.
- `.../backend.py` -- `Backend.find(instance_id, epoch=None)`: `FakeBackend.find` (:134), `SdkBackend.find` (:289, add the `vm.epoch=` label filter). `ServiceFakeBackend` inherits.
- `.../builder.py` -- `CreateSpec` (:60): add `without_secrets()` and use `dataclasses.replace` for the reset spec; `ResetSpec`/`parse_reset` (:207) already exist; `build_plan(now=...)` gets the original creation time.
- `.../lifecycle.py` (new) -- `Settings` (default idle 60, default max 240, ceiling 1440, active window 5, reaper interval 30 s), `SettingsPort`, `FakeSettingsPort`.
- `.../service.py` -- real `_reset` (replaces the placeholder at :281); the reaper thread (stops on shutdown); `POST /_fake/v1/instances/{id}/activity` body `{"state": ...}` unsigned, only with `--backend fake`; `__main__.py` wires it.
- `apps/api/tests/conftest.py` (:7-24), `support.py` (:37) -- remove the `needs_reset` skip for the Python service (reset and activity cases then run against it).
- `apps/orchestrator/tests/` -- `test_engine.py` and `test_engine_service.py` (add reset, reaper, activity with a fake clock), `test_service.py`, `test_docker_integration.py`.
- `docs/dev/HANDOFFS.md` (H-57, H-59, H-61, H-65, H-67, new row for Akshay: activity signal and idle destroy); `docs/dev-log/`, `docs/adr/0035-*.md`, `initial.md` D-54, `CHANGELOG.md`, `docs/traceability.md`.

## Tasks & Acceptance

**Execution:**
- [x] `backend.py` -- epoch-aware `find` on the protocol, fake and Docker backends -- old epoch removed without touching the new
- [x] `lifecycle.py` -- Settings, SettingsPort, FakeSettingsPort -- one place for timing numbers
- [x] `engine.py` -- record fields, reset, activity, reaper, `_sweep(epoch)` -- FR-INS-03, FR-INS-04
- [x] `service.py`, `__main__.py` -- real reset, reaper thread, fake-only activity control -- IF-5 behaviour (the wiring is in `main()` of `service.py`; `__main__.py` only calls it and did not change)
- [x] `apps/api/tests/conftest.py`, `support.py` -- drop the skip -- shared protocol suites run against the real service
- [x] orchestrator tests -- unit tests for every matrix row with a fake clock; the real-Docker reset test with the stub image (new epoch, old epoch's objects gone, new flags only in the injector document, memory unchanged)
- [x] docs -- dev-log, ADR 0035, D-54, CHANGELOG, traceability rows, handoff answers and the new row, evidence in `docs/assets/story-3-4-reset-and-teardown/`, story state in this plan

**Acceptance Criteria:**
- Given a ready instance, when reset with epoch+1 is accepted, then the old epoch's objects are removed, the new epoch becomes ready, and `get` shows no secret.
- Given a clock under test, when 60 idle minutes or 240 total minutes pass, then the learner instance ends `destroyed` with reports, and a candidate with a longer `idle_minutes` is still there.
- Given the Python service started with `--backend fake`, when the shared suites of `apps/api` run, then the reset and activity cases pass and none is skipped for the Python service.
- Given `contracts/` is unchanged, then `node scripts/check-contract-rules.mjs` shows 0 FAIL.

## Implementation Notes

Built 2026-10-15. Deviations and choices, all small:
- `states.py` gets `(resetting, stopping)` in `TRANSITIONS`; without it a destroy during a reset (matrix row "Restart of a reset") would be refused. Not in the contract table, follows from the destroy rule text; to add at the next contract change. No contract file touched.
- `_run_create` and `_run` take an optional `clear_epoch`; the reset reuses them (no second copy of the build). The old epoch is swept after `provisioning` is reported, so a sweep failure fails the instance with a code instead of leaving it in `resetting`.
- `accept_destroy` takes an optional reason text (the reaper's destroy says why in the report). `abandon_create` also handles a reset whose worker could not start.
- The reaper entry is `Orchestrator.reap_due(now, execute)`; the thread is `service.Reaper`. The defaults 60 and 240 live in `Settings` for the platform to read; the engine itself uses the record's limits (the create body always carries them) and only the ceiling, the active window and the interval from the port.
- The reset and activity handoffs were recorded with their written defaults; the developer was not asked to confirm each one in this run.
- New test file `apps/orchestrator/tests/test_engine_lifecycle.py` (instead of extending `test_engine.py`); other tests extended as planned. Docker Desktop was started by hand to run the real-Docker tests.
- The story state was NOT moved to done: it waits for review and the developer's confirmation (CLAUDE.md, task cycle step 4).

## Plan Change Log

## Review Triage Log

Pass 1 (2026-10-16, thorough: blind, edge-case, verification-gap, intent-alignment). Verdicts after verifying each claim in the code.

| Verdict | Route | Finding and evidence |
|---|---|---|
| medium | patch | One failing destroy start aborted the whole `reap_due` pass (engine.py): now per instance, the flag is cleared, the first error is raised after the pass. Test `test_one_instance_that_cannot_be_reaped...`. |
| medium | patch | A destroy that gave up stayed `stopping` and the reaper skipped it (`_ENDING`): the reaper now retries a `stopping` instance with no worker. Test `test_the_reaper_tries_again_with_a_destroy_that_stopped_halfway`. |
| medium | patch | `vm.expires` used the request's `max_minutes`, not the ceiling: `_capped` cuts it for create and reset. Test `test_the_expiry_label_is_the_real_deadline...`. |
| medium | patch | `record_activity` took naive times (TypeError in the reaper), older times (moved the clock back) and future times: now refused, ignored, cut to now. Test added. |
| medium | patch | `Reaper._loop` read the settings port outside the try (a failing port ended the thread silently) and zero or negative settings were accepted: `_interval()` with a fallback, `Settings.__post_init__` validation. Test added. |
| low | patch | `force_activity` to `idle` kept a stale clock (test control): the clock starts when forced. |
| low | patch | Activity control answered 409 for a body without a text state: now 422. Test added. |
| medium | patch | No test for a reset whose worker cannot start (`abandon_create` on `resetting`): `test_a_reset_whose_worker_cannot_start...`. |
| medium | defer (documented) | The orchestrator ends an instance `idle_minutes` after ready while no activity signal exists. The matrix row (frozen) says so; H-122 carries a warning, deferred-work entry added. |
| medium | defer | A failed reset can only be destroyed (retry is story 3.6, OI-24). |
| low | defer | `resetting` to `stopping` is not in the contract table (contract release); stale ci.yml comment (needs a registry line); unused `default_*` settings (numbers for the platform); no reaper-reset race test; loopback trust of the fake route. |
| medium | patch (docs) | Stale texts: traceability FR-INS-07 skips, initial.md D-53 open line, H-57 placeholder sentence, H-122 task ids (P-05, P-28; the open points P-4, P-19 are architecture points, written so). Fixed. |
| false | rejected | "`accept_reset` mutates before `_move` which can raise": the three resettable states all allow `resetting`, so `_move` cannot raise there. |
| false | rejected | "Repeat before state check contradicts the matrix": the contract (and the fake) answer a known body with 200 first; the matrix row "bad state" is about a new body. |
| none | intent-alignment | Reading B (service behaviour) is the one implemented; reading D (a real activity signal) is H-122 by design. |
## Design Notes

Why `access` is not touched: the platform owns `access_epoch` and sends the next value; an orchestrator that raised it on its own would make the platform's next call stale. The old containers are gone during a reset, so nothing is reachable anyway. The architecture note "access epoch + 1" is for the platform's call to IF-5 `access` around a reset.

Activity: a recorded activity moves ready or idle to active. Quiet for the active window moves active to idle. The inactivity clock runs from the last activity, or from the time the instance became ready if there was none. Real activity arrives later from the platform (open points P-4, P-19): until then `record_activity` is the only input and the handoff row asks Akshay which side does the idle destroy.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests` -- expected: all pass (the Docker test runs with a daemon)
- `VM_ORCH_SERVICE=python` suites of `apps/api` with `--backend fake` (command as in ci.yml, job scripts) -- expected: pass, no `needs_reset` skip
- `node scripts/check-contract-rules.mjs`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`, `node --test "scripts/*.test.mjs"` -- expected: pass
