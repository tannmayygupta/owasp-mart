# Reconciler: repair differences between recorded and real state (story 3.5, task L-14 part 2, spike S-13)

| Field | Value |
|---|---|
| Date | 2026-10-16 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-2-tanmay-b`, baseline `65734bc` (commit of this story follows) |
| Status | Partly done: story 3.5 built and tested on the fake backend and on Docker Desktop; task L-14 stays open until the failed-start retry (story 3.6); not checked on vm-i |
| Report tag | orchestrator, instance lifecycle, FR-INS-05, spike S-13 |

## Requirements covered
FR-INS-05, FR-INS-07, NFR-AVL-04, spike S-13, handoffs H-61, H-65, H-67 (answered) and H-123 (new), decision D-55 (Proposed), ADR 0036 (Proposed). Open points not touched: OI-24 (failed retry, story 3.6).

## Summary (plain language)
After a restart the orchestrator used to forget every instance, a create killed halfway left containers, networks and volumes behind, and a destroyed id could be created again. Now a reconciler looks at Docker (every object labelled `vm.kind=inst`) before the service answers and about every minute, and repairs the difference: leftovers are removed and the id is recorded `failed`, complete unknown instances are adopted `ready`, destroyed ids stay refused through a small tombstone file. If the list of wanted instances cannot be read, nothing is destroyed for being unwanted and creates and resets answer 429 ORCH-BUSY.

## Why
FR-INS-05 and spike S-13: an orchestrator crash must not leave objects behind or lose instances (handoffs H-61, H-65, H-67).

## What was built
- `Backend.scan()` on the protocol, the fake backends and the Docker backend (label filter `vm.kind=inst`).
- `reconcile.py`: `DesiredStatePort`, `FakeDesiredState`, `AllWantedDesiredState` (the service's port until the platform has a source), `TombstoneStore` (JSONL, one atomic append, torn last line skipped), `Reconciler`.
- Engine: `reconcile()`, `register_found()` (adoption and failed records, transition numbers of 1,000,000 plus the seconds since 2026-01-01 at adoption), tombstone write on `destroyed` and check in `accept_create`, the gate (`reconcile_gate`: busy until the first pass, and in safe mode), the reaper reading `vm.expires` and the settings idle limit for adopted records.
- Service: `--state-dir`, one pass before serving, `ReconcileLoop` thread, `Settings.reconcile_interval_s` (60).

## How it works
A pass groups the scan by `vm.instance`. For each id: skip it if its build or destroy runs in this process (states requested, provisioning, starting, resetting, or the `destroying` flag). Known live record: remove old-epoch objects; no object left in Docker (checked again with a fresh `find`) means destroy through the normal path; not in the desired list means destroy through the normal path (only when the list was read). Unknown id: removed silently if tombstoned or without a container; adopted `ready` if every non-injector component of the newest epoch and the keeper are running, the injector is gone, the network and all volumes exist; otherwise recorded `failed` (INST-START-FAILED) and every object removed. A backend error for one instance is logged by class name and the others are still repaired. A pass that cannot list Docker raises and leaves the engine busy.

## Files changed
- `apps/orchestrator/src/vulnmart_orchestrator/reconcile.py` -- new
- `.../backend.py` -- `Seen`, `scan` on the protocol, fake, locked service fake and Docker backend
- `.../engine.py` -- reconcile entry, adoption, tombstones, gate, reaper fields
- `.../service.py` -- `--state-dir`, `ReconcileLoop`, first pass
- `.../lifecycle.py` -- `reconcile_interval_s`
- `apps/orchestrator/tests/test_reconcile.py` (new), `test_docker_integration.py`, `test_service.py`
- `docs/adr/0036-orchestrator-reconciler-labels-and-tombstones.md`, `initial.md` (D-55), `docs/dev/HANDOFFS.md` (H-61, H-65, H-67 answers, new H-123), `CHANGELOG.md`, `docs/traceability.md`, `docs/bmad/initiative-lab/deferred-work.md`, `docs/assets/story-3-5-reconciler/`

## Decisions made
D-55 and ADR 0036 (Proposed, decided on the developer's delegation): labels as the only truth, tombstone file, adopt rather than destroy, no retry of half-built instances, desired state through a port. Alternatives (a database, snapshot file, retry) are in the ADR.

## Tests
Run on 2026-10-16 (Windows, Docker Desktop):
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests`: 319 passed in 92.76 s (includes the real-Docker tests).
- `uv run --locked --package vulnmart-orchestrator pytest -v apps/orchestrator/tests/test_reconcile.py`: 21 passed (fake backend, every row of the story matrix).
- `uv run --locked --package vulnmart-orchestrator pytest -v apps/orchestrator/tests/test_docker_integration.py -k killed`: 1 passed (a child process creates an instance on real Docker and stalls at its first start, is killed with 3 containers, 1 network and 4 volumes present, a new engine's first pass leaves none and records `failed`).
- `VM_ORCH_SERVICE=python uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_protocol.py apps/api/tests/test_wire_rules.py apps/api/tests/test_http_service.py apps/api/tests/test_reports.py apps/api/tests/test_mtls.py`: 392 passed, 1 skipped (a test of the Node fake).
- `node scripts/check-contract-rules.mjs`: 15 PASS, 0 FAIL, 1 NOT-APPLICABLE (approvals, no tag yet); `node scripts/check-text-files.mjs`: PASS; `node scripts/scan-secrets.mjs`: PASS.
Traceability rows: FR-INS-05, S-13, FR-INS-07.

## Review round (2026-10-16, after the first report)
Changes made on the coordinator's review: the gate stays closed while a pass has an instance error and the loop retries every 5 s while closed (`ReconcileLoop.retry_s`); `first_pass` is false on safe mode or errors; an adopted instance answers reset with ORCH-INVALID-STATE; the gate check runs after the repeat lookup (a repeat is answered in safe mode); an adopted deadline is `min(vm.expires, now + ceiling)` and `now` for a missing or unreadable label (logged); adopted transition numbers are 1,000,000 plus seconds since 2026-01-01 (grow across restarts); `Seen.health` and the state rules (transient states skip the instance, dead, unhealthy or duplicated components are incomplete); a live record with only some objects is recorded `failed` and swept; the records are re-checked right before every removal; `SdkBackend.scan` lists networks and volumes before containers; the tombstone store falls back to memory on an OSError (log `tombstones-unavailable`) and continues short writes; log `no-state-dir` for the Docker backend; import order, `MEMORY_ADOPTION_SLACK_MB`. Tests added in `test_reconcile.py` (56 tests now), the real-Docker adoption test and a counts-from-the-plan kill test in `test_docker_integration.py`. Run after the changes: `pytest -q` on `test_reconcile.py`, `test_engine_lifecycle.py`, `test_service.py` and `test_docker_integration.py`: 133 passed and 1 failed (a list-order assertion in the new adoption test, fixed by comparing sorted names); the Docker file re-run: 6 passed. The wider suites were not re-run in this round (the coordinator runs them).
Deferred: the tombstone append happens inside the engine lock (move after the lock later); the idle limit of an adopted instance is fixed at adoption; `AllWantedDesiredState` is a stand-in until H-123; a state `_known` does not handle is only logged.

## Evidence
`docs/assets/story-3-5-reconciler/pytest-reconcile.txt`, `pytest-kill-and-service.txt` (the kill test only; the `-k killed` filter also applied to the service file, the service tests are in the full run above).

## Problems met and how they were fixed
- First kill test stalled for 90 s: the step delay pauses before any object exists, so the child never created anything. Fixed by a child backend that sleeps at its first `start`, after all objects exist.
- First adoption test failed: the default idle limit (60 minutes, from adoption) ended the instance before its 120-minute `vm.expires`; the test now sets a large idle default.
- The service test expected a problem body from `_create`; the engine raises `Busy` and the endpoint converts it, so the test checks `Busy` and `_problem_of`.
- The existing engine tests build engines without a first pass, so the gate is opt-in (`reconcile_gate`); only the service turns it on.

## Security notes (vulnerable parts only)
None: the orchestrator is not a vulnerable part. The tombstone file and the logs hold no flag, seed or key (a test checks the file); failures are logged by class name only.

## Limitations and follow-ups
- The platform's source of the desired state is open (H-123); until then the service wants everything and never destroys an instance for being unwanted.
- An adopted instance cannot be reset (no create request is kept) and its access is closed until the platform's next `access` call.
- Reports of adopted or failed unknown instances go to a platform that may not know the id (H-123 asks).
- Tombstone retention not set (H-65); file not backed up; not checked on vm-i; the failed-start retry is story 3.6 (OI-24).
- Reaper and reconciler race on real Docker has no test (see `deferred-work.md`).
