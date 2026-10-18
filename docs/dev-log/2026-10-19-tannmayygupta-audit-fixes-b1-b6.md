# Audit fixes B1 (activity reaches the orchestrator) and B6 (activity gate on pasted flags)

Developer: tannmayygupta. Date: 2026-10-19. Branch: fix-b1-b6-activity-and-gate.

## Requirements covered
FR-INS-04 (idle teardown), FR-ACH-02 (activity-versus-capture check), FR-ACH-03 (timing signals), D-94; L-14, L-27; audit blockers B1 and B6.

## Summary (plain language, 3-5 lines)
B1: the orchestrator never learned that a player was active, so every instance was destroyed "idle limit" minutes after it became ready, even while someone played. The platform now tells the orchestrator (a new signed call), from what the sidecar and the player's actions show. B6: pasted flags were never checked against activity, so nothing was ever held for review. A pasted correct flag now needs recorded use of the shop; without it the capture is held for a named reviewer, and a capture that is too fast raises a timing flag.

## Why
Without B1 a 2-hour assessment is cut off at the template's idle limit. Without B6 the anti-cheat of L-27 existed only as library code.

## What was built
- IF-5 1.1.0 (additive): `POST /v1/instances/{id}/activity` (`reportActivity`, body `{at}`), schema, 4 examples, changelog entry, Node fake route, orchestrator-api.md row.
- Orchestrator: `parse_activity`, the route (the old unsigned test control of `--backend fake` was renamed `_fake_activity`), `engine.record_activity` (existed, now reachable).
- API: `InstanceHost.record_activity` in the protocol, the fake host and the HTTP host. `LabRuntime._note_activity`: every accepted event of a player session and every flag paste reports activity, at most once per instance per minute, from a short-lived thread, failures only logged.
- `ingest/gate.py` `RecordedActivityGate` for pasted flags: consistent when the instance of the current epoch shows at least 5 requests before the capture (placeholder, OI-25); inconsistent is held (mode hold) or counted with an activity flag (mode flag); a capture sooner than the minimum raises a timing flag and never holds. The sidecar-observed event path is not gated (that request is the activity).
- Tests that pasted a flag without any traffic now call `play()` (tests/support.py).

## How it works
The sidecar emits aggregated `proxy.request` events for browsing. The runtime's event sink turns each accepted player event into an activity report (throttled). The orchestrator moves the instance to `active` and counts the idle limit from the last report. For a paste, the gate sums the activity buckets of the instance and epoch up to the paste minute.

## Files changed
contracts/orchestrator/*, contracts/mocks/fake-orchestrator/server.mjs, contracts/CHANGELOG.md, scripts/check_orchestrator_contract.py, apps/orchestrator/src/vulnmart_orchestrator/{builder,service}.py, apps/api/src/vulnmart/{ports/instance_host,ports/fake_instance_host,ports/http_instance_host,lab/runtime,ingest/gate}.py, tests (protocol, runtime, gate, five lab tests updated).

## Decisions made
No ADR: the call follows the existing IF-5 pattern. The numbers of the gate are placeholders recorded under OI-25.

## Tests
- Protocol suite against the fake host, the Node fake and the real Python orchestrator service (VM_ORCH_SERVICE=python): 398 passed, 1 skipped; default run 92 passed.
- apps/api full run (Postgres enabled): 2469 passed, 36 skipped, 1 failed (the contract check expected 8 operations; fixed to 9, file re-run 62 passed).
- Orchestrator 466 passed and 1 timing flake under load (test_the_retry_sends_the_same_secrets_again_and_logs_none passes alone and in 4 of 4 reruns); py-attempts 357.
- New: test_activity_gate.py (6), runtime activity tests (2), protocol activity tests (3). `npm test` earlier on this branch: 1033 passed, 2 skipped, 1 failed (the audit test read a CRLF fixture on Windows; the test now normalises line endings).
- Live proof on the deployed system: see the pull request.

## Evidence
See the pull request.

## Problems met and how they were fixed
A first design counted only flag events as activity; browsing produces no flag event, so the aggregated `proxy.request` events and flag pastes are used as well. The default gate holds a paste with no traffic, which broke seven tests that pasted flags without playing; they now simulate play.

## Limitations and follow-ups
Idle is an event signal at minute resolution; a player who only reads for the whole idle limit is idle. Write-up similarity is still not wired (needs the write-up submissions). The idle-gap signal of integrity.py is not wired (needs the capture-after-resume time). The 5-request baseline is a placeholder.