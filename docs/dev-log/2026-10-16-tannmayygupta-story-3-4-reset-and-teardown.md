# Reset with new flags, teardown at the total limit or after inactivity, timing settings (story 3.4, task L-14 part 1)

| Field | Value |
|---|---|
| Date | 2026-10-16 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-2-tanmay-b`, baseline `a60bbc8` (commit of this story follows) |
| Status | Partly done: story 3.4 built, reviewed and tested; task L-14 stays open until story 3.5 (reconciler) is done |
| Report tag | orchestrator, instance lifecycle, FR-INS-03, FR-INS-04 |

## Requirements covered
FR-INS-03 (stop after 60 minutes idle or 4 hours in total), FR-INS-04 (reset with new flags and a new epoch), handoffs H-57, H-59, H-61, H-65, H-67, decision D-54 (Proposed), ADR 0035 (Proposed). Open points: P-4 and P-19 (activity signal), OI-24 (failed retry, not touched).

## Summary (plain language)
The orchestrator now resets an instance: epoch plus one, the old epoch's containers, network and volumes are removed first, then the create path runs again with the new flags. A reaper thread ends instances at their total limit and after inactivity through the normal destroy path. All timing numbers live in one settings place (a fake port). The shared protocol suites of `apps/api` now run the reset and activity cases against the Python service; none is skipped any more. The one thing that does not exist yet is a real activity signal from the platform (handoff H-122).

## Why
Before this story a reset answered ORCH-NOT-IMPLEMENTED and an instance nobody used lived for ever. FR-INS-03 and FR-INS-04 need both.

## What was built
- Reset (`POST /v1/instances/{id}/reset`): 202 first, 200 for the same body, 409 for a stale epoch, a wrong state or another body for the same epoch; no capacity check; numbering restarts at 1 in the new epoch; `access` is left alone (the platform owns `access_epoch`); the expiry label keeps the time of the first create.
- Reaper (`Orchestrator.reap_due`, thread `service.Reaper`): moves `active` to `idle` after the active window, destroys at `min(max_minutes, ceiling)` from the first create and after `idle_minutes` without activity; retries a destroy that stopped halfway.
- Settings (`lifecycle.py`): defaults 60 and 240 for the platform, ceiling 1440, active window 5 minutes, reaper interval 30 s; validated; a fake port.
- Activity input: `Orchestrator.record_activity` plus a fake-backend-only unsigned loopback route `POST /_fake/v1/instances/{id}/activity` (like the Node fake).

## How it works
Reset reuses the create path (`_run_create` with the old epoch to clear). The record keeps a copy of the create spec without secrets, so a reset needs only the new secrets. Old-epoch objects are found by the label `vm.epoch` (`find(instance_id, epoch)` on the fake and the Docker backend). A destroy during a reset cancels it like a destroy during create (`resetting` to `stopping` was added to the engine's table).

## Files changed
- `apps/orchestrator/src/vulnmart_orchestrator/engine.py`, `backend.py`, `builder.py`, `service.py`, `states.py` -- reset, reaper, activity, epoch-aware find
- `apps/orchestrator/src/vulnmart_orchestrator/lifecycle.py` (new) -- settings and port
- `apps/orchestrator/tests/test_engine_lifecycle.py` (new), `test_service.py`, `test_docker_integration.py` -- tests
- `apps/api/tests/conftest.py`, `support.py` -- the `needs_reset` skip removed for the Python service
- `docs/adr/0035-orchestrator-reset-reaper-and-timing-settings.md`, `initial.md` (D-54), `docs/dev/HANDOFFS.md` (H-57, H-59, H-61, H-65, H-67, new H-122), `docs/traceability.md`, `CHANGELOG.md`, `docs/dev/dev1-tanmay.md`, `docs/dev/dev2-akshay.md` (H-122 on P-28), `docs/bmad/initiative-lab/` (plan, deferred-work)

## Decisions made
ADR 0035 and D-54 (Proposed, decided on the developer's delegation): access is not changed by reset; the total limit counts from the first create; the activity input is a method until the platform signal exists; no IF-5 change. Alternatives: closing access and bumping `access_epoch` on reset (rejected: the platform owns that counter and its next call would be stale); a new IF-5 activity call (rejected: contracts are 1.0.0).

## Tests
Real commands and results of 2026-10-16, after the review patches (raw lines in `docs/assets/story-3-4-reset-and-teardown/test-output.txt`):
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests` -- 295 passed (real Docker with the stub image included, Docker Desktop).
- `VM_ORCH_SERVICE=python uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_protocol.py test_wire_rules.py test_http_service.py test_reports.py test_mtls.py` -- 392 passed, 1 skipped (a test of the Node fake, not of the service). Before this story: 375 passed, 18 skipped.
- `uv run --locked --package vulnmart-api pytest -q` -- 963 passed, 7 skipped (Postgres tests need DSNs).
- `node scripts/check-contract-rules.mjs` -- 15 PASS, 0 FAIL (no contract file touched); `node scripts/check-text-files.mjs` PASS; `node scripts/scan-secrets.mjs` PASS; `node scripts/verify-skills.mjs` OK.
- `node --test "scripts/*.test.mjs"` -- 737 tests, 736 pass, 1 fail: `generate-api-code.test.mjs` "a stale file is found by --check ... CRLF alone is not stale". It fails the same way in a separate checkout of the PR branch of Sahil and does not touch this story: a Windows line-ending (autocrlf) problem of that test, not investigated further.
Traceability rows: FR-INS-03, FR-INS-04, FR-INS-07.

## Evidence
`docs/assets/story-3-4-reset-and-teardown/test-output.txt`. The pytest duration of the last suite (15 h 35 min) is what pytest printed; the PC was not running that long of work, so do not read it as a speed figure.

## Problems met and how they were fixed
- The implementation subagent stalled after its code was done (before the dev-log); I finished the docs myself. It had also edited a comment in `.github/workflows/ci.yml`: reverted, because a workflow change needs a `registry change:` line.
- Review (four lenses) found: one failing destroy start aborted the whole reaper pass; a destroy that stopped halfway stayed `stopping` for ever; `vm.expires` ignored the ceiling; `record_activity` took naive or older times; the reaper thread died silently if the settings port failed; invalid settings accepted; activity control answered 409 for a bad body. All fixed with tests (see the Review Triage Log in the story plan).
- The evidence file first had a byte order mark (PowerShell `Out-File`): removed.

## Security notes (vulnerable parts only)
No planted weakness here. Operational risk: until H-122 is answered the orchestrator ends an instance `idle_minutes` after ready even while a player works, so the platform must send a large `idle_minutes` meanwhile (warning in H-122). The fake activity route trusts the loopback address of the caller and exists only with `--backend fake`.

## Limitations and follow-ups
Story 3.5 (persistence, reconciler, list-all by label) is next. Deferred (see `deferred-work.md`): a failed reset can only be destroyed (OI-24, story 3.6); `resetting` to `stopping` is not in the IF-5 table (next contract release); the stale comment in `ci.yml`; the live check of reset on the Oracle VMs; the activity signal from the platform (H-122, Akshay).