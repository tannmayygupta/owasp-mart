# 0035. Orchestrator reset, the reaper and the timing settings

- **Status:** Proposed (D-54, decided on the developer's delegation; to be confirmed)
- **Date:** 2026-10-15
- **Deciders:** Tanmay (by delegation to Claude Code, story "Reset with new flags, teardown at expiry or inactivity, timing defaults", task L-14 part 1)
- **Requirements:** FR-INS-03, FR-INS-04, FR-INS-07; decisions D-52, D-53, D-42; contracts IF-5 and IF-6; handoffs H-57, H-59, H-61, H-65, H-67

## Context
The service of story 3.2 answered a reset with ORCH-NOT-IMPLEMENTED and never ended an instance by itself. A reset must give a new epoch with new flags, and an instance nobody uses must not stay for ever. IF-5 is 1.0.0 and checked by the registry, so no contract file may change.

## Options considered
1. **Reset.** (a) Patch the running containers with new flags: old files could survive, which H-61 forbids. (b) Run the create path again for the new epoch after the old epoch's objects are removed: fresh volumes by construction, one code path to test. Chosen: (b).
2. **Old epoch removal.** (a) Remove by instance id (everything): also removes the objects of the new epoch if the order ever changes. (b) Remove by the `vm.instance` and `vm.epoch` labels (`Backend.find(instance_id, epoch)`): exactly the old epoch. Chosen: (b). The new epoch has other object names, so both can never meet.
3. **Teardown.** (a) Expiry labels read by an outside job (the reconciler of story 3.5). (b) A reaper inside the orchestrator with an injectable clock that calls the normal destroy path. Chosen: (b), so reports and the sweep are the same as for a platform destroy; the labels stay for the reconciler.
4. **Timing numbers.** (a) Constants in the engine. (b) One `SettingsPort` (default idle 60, default max 240, ceiling 1440, active window 5, reaper interval 30 s), faked in process until the platform provides it (open points P-4, P-19). Chosen: (b).

## Decision
- Reset body: the new epoch and the new secrets only. Template, owner, host name and limits come from the record (`base`, a create spec with its secrets blanked: `CreateSpec.without_secrets()`, `ResetSpec.apply_to` uses `dataclasses.replace`). The epoch must be current plus one (409 ORCH-STALE-EPOCH), the state ready, active or idle (409 ORCH-INVALID-STATE), there is no capacity check (memory stays counted, H-57), the first call answers 202 and the same body 200, another body for the same epoch 409 ORCH-REQUEST-MISMATCH. Transition numbering restarts at 1 in the new epoch. `access` and `access_epoch` stay platform-owned. The total limit counts from the first create and the reset plan keeps the original `vm.expires`.
- State machine: `resetting` to `stopping` is added in `states.py` so that a destroy during a reset cancels it (IF-5 says destroy is accepted from any state but destroyed and stopping; the contract table does not list this pair). No contract file changes.
- Activity: `record_activity` moves ready or idle to active (one report); active only moves the clock. Quiet for the active window moves active to idle. The inactivity clock runs from the last activity, or from ready. Candidates are not special: the platform sets a longer `idle_minutes` in the create.
- Reaper: `Orchestrator.reap_due(now, execute)` destroys at `created + min(max_minutes, ceiling)` in any live state and after `idle_minutes` of inactivity; the service runs it in a `Reaper` thread every `reaper_interval_s` and stops it at shutdown.
- Test control: `POST /_fake/v1/instances/{id}/activity` (unsigned, loopback only, only with `--backend fake`) moves an instance between ready, active and idle, like the Node fake.

## Consequences
Easier: one create path for both calls; teardown uses the same destroy, reports and sweep; every timing number is changed in one place; the shared suites of `apps/api` now run against the Python service with no reset skip.
Harder: no real activity signal exists until the platform forwards one, so in production no instance leaves `ready` by activity and the inactivity limit counts from ready (handoff for Akshay, H-122). The `resetting` to `stopping` pair is a small step beyond the contract table and should be added to the contract text at the next contract change. A reset that fails leaves the instance `failed` with every object of the id removed (the old epoch's too), the same rule as create; the retry of failed instances stays with OI-24.
Watch: the reaper and the platform could both destroy the same instance; destroy is idempotent (a repeat answers 200), so this is harmless but doubles the reports of nothing.

## Evidence
Design from the story plan and the IF-5 text (sections 3 and 8). The Node fake (`contracts/mocks/fake-orchestrator/server.mjs`) was the behaviour reference for reset and the activity control. Docker label filters are ANDed when given more than once (Docker Engine API, container and network list filters): checked by the real-Docker reset test, which passed on Docker Desktop 29.6.2. Not verified on vm-i.
