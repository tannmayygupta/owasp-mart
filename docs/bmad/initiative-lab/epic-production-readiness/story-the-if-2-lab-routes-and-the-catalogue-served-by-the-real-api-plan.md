---
title: 'The IF-2 lab routes and the catalogue served by the real API, with the runtime and its tick in the API process'
type: 'feature'
ticket: '2'
created: '2026-10-18'
status: 'done'
baseline_revision: '93cbc85'
route: 'full'
risk: 'high'
---

## Intent
Serve the lab part of IF-2 from the real API so the dashboards can use it, instead of the token-guarded demo routes.

## Acceptance criteria
1. Instances (request, get, open, reset, stop), attempts (get, submit, flags, score, challenges, hints, evidence, integrity flags and decision, report, timeline), the catalogue and my attempts answer the shapes of the contract.
2. Session, Origin and CSRF rules are those of the account routes; not yours and not found are the same 404; withdrawn attempts are 410.
3. The one-time ticket is signed as the gate expects.
4. The runtime, the event receiver and a tick loop run in the API process when `VULNMART_LAB_RUNTIME=1`.

## Result
Done for learner practice; the reviewer paths are in place and tested with a stubbed company scope because the candidate and company stories of stream P (P-18 to P-21) do not exist yet. 12 tests in `apps/api/tests/test_lab_api.py` validate every answer against the OpenAPI components. Contract defect found and fixed: the ticket URL pattern forbade the dot of `payload.signature` (lab.openapi.yaml, bundle, examples, fake lab, regenerated clients). `POST /attempts/{id}/start` is not served: OI-22 was decided as D-80 (the clock starts at instance ready), so the route is to be removed from the contract. `GET /live/snapshot`, `GET /live` and consent are stream P (P-16, P-22).