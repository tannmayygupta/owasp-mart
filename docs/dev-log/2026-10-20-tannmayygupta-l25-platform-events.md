# L-25: the platform's events reach the attempt log (invite, consent, recruiter view) and request_seen

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | l-25-platform-events |
| Status | Done |
| Report tag | lab, L-25, FR-TIM-04, FR-PRV-11 |

## Requirements covered
L-25, FR-TIM-04, FR-PRV-11 (H-145), D-90.

## Summary
All 20 events of the FR-TIM-04 allow-list are now written. The lab already wrote 16; this adds the four that waited on stream P, plus a marker.
- `invite_created`, `invite_opened`, `consent_given`: the platform knows these instants and the lab does not. When the attempt is made from a consent, the accept flow passes them (`history`, new optional argument of `AttemptPort.create_from_consent`) and the lab writes them into the attempt log with their real times, each once.
- `recruiter_viewed_report`: when a recruiter of the owning company reads the report, the log gets a line with the viewer's id only. The same read (and the evidence read) writes an entry into the candidate's view history (`ViewHistory.record`, handoff H-145), which nothing called before.
- `request_seen`: a marker when the player's traffic starts and again after five quiet minutes, never one line per request and never a request.

## Why
The 2026-10-18 audit and the status table: the allow-listed events of FR-TIM-04 were never written; the view history of P-25 stayed empty until someone called it.

## What was built
- `ports/attempts.py` (optional `history`), `ports/engine_attempts.py` (writes the history, best effort, once), `ports/lab_fakes.py`, `assessments/accept.py` (passes the invite's times), `orgs/service.py` (`company_name_of`), `lab/api.py` (`note_company_view` on getReport and listEvidence), `lab/runtime.py` (`journal`, `request_seen`).

## How it works
A failing note never blocks the read or the creation of the attempt (logged, swallowed). The history is written only for instants that exist; an unknown instant is not invented. A candidate cannot read the company's report (OI-15), so the owner's own reads produce nothing.

## Files changed
The seven source files above, `apps/api/tests/test_lab_runtime.py`, `test_lab_api.py`, docs.

## Decisions made
The history travels through the existing create call as one optional argument instead of a new port, so no other implementer breaks. The company name for the view history is read under the company's own scope.

## Tests
- `test_lab_runtime.py` 31 passed (invite history once with real times; request_seen marker); `test_lab_api.py` (recruiter view noted in the log and the history, owner not a company view, a failing note does not block the read); invite acceptance, consent and contract tests pass: 218 of 219 before the last test fix, then green.

## Evidence
Tests only: the invite and consent flow has no web route yet (stream P), so the history was proved at the port with the real engine and the recruiter view through the API with a stubbed session.

## Problems met and how they were fixed
The test events needed the full proxy.request schema (resp_len, client_class, user_id); the shared dependency overrides of the API test replaced the recruiter identity after the owner call.

## Security notes
The log holds ids and instants only: the viewer id, instance id, challenge key. No name, e-mail, request or flag.

## Limitations and follow-ups
Stream P must call `view_history.record` from its own dashboards and exports too (H-145 stands); the lab now does it for the two lab routes that show candidate data to a company.