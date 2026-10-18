# Production readiness 1 and 2: the lab is stored in Postgres and served by the real API

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | tannmayygupta |
| Branch / commit | sprint-4-tanmay |
| Status | Done for stories 9.1 and 9.2; the open parts are listed under Limitations |
| Report tag | persistence, API integration, keys, contract |

## Requirements covered
FR-SES-02, FR-SES-04, FR-SES-10, FR-SCR-01, FR-SCR-10, FR-FLG-05, FR-DET-03, FR-ACH-07, NFR-SEC-03, NFR-SEC-04; handoff H-346, H-348; review findings A1 to A3, A5, A6, B1, B6, B7, C1 (see the review dev-log). Finding C1 (gate sync after an orchestrator restart) was also closed here: an adopted instance now gets a high access epoch and the lab opens it again.

## Summary
After the status check the lab's engines were correct but lived in memory, behind token-guarded demo routes, with a fake key service. This change stores the whole lab state in Postgres, adds a real key service, and serves the IF-2 lab routes, the catalogue and "my attempts" from the real API with the same session, Origin and CSRF rules as the account routes. A second runtime on the same database keeps every attempt, score, held capture, event and piece of sealed evidence.

## Why
The demo and the product need the lab to survive a restart and to be reachable from the dashboards. Handoff H-346 listed exactly this as missing.

## What was built
- Migration 0005 and `vulnmart/lab/models.py`: 15 tables with the names the table-owners contract already reserved for stream L (five added: held_captures, review_audit, attempt_events, bot_visits, security_events). The app role gets only what it needs: append-only tables cannot be updated, audit tables cannot be deleted from, an integrity flag can only get its decision columns updated.
- `vulnmart/lab/pg.py`: a Postgres twin of every in-memory store plus `purge_attempt_data`; `LabStores` bundles them; `LabRuntime` takes a bundle and never reaches into a store.
- (SUPERSEDED the same day: this file was deleted and the lab uses the platform key service, see 2026-10-18-tannmayygupta-pr-review-merge-and-key-service.md) `vulnmart/lab/keys.py`: `StoredKeyPort` (AES-256-GCM, a data key per attempt stored wrapped under a key derived from one master secret file, shred keeps a tombstone, derived flag, event and owner keys stable across restarts) and `python -m vulnmart.lab.keys init`.
- `vulnmart/lab/api.py`: the routes; `vulnmart/lab/tickets.py` signs the one-time gate ticket; `vulnmart/lab/catalog.py` reads the IF-7 catalogue files; `vulnmart/lab/background.py` runs the tick loop; `create_app` mounts all of it when `VULNMART_LAB_RUNTIME=1`.
- Runtime changes: start and reset wait outside the lock and have an async form for the API; a second start or reset of the same attempt cannot overlap; a start after submit, cancel or withdraw is refused; a failed step destroys the instance it made; stop frees an instance and a later start replaces it; the log now gets the `flag_submitted`, `hint_unlocked` and `milestone_reached` lines the metrics and the timeline read.

## How it works
Every store call is one short transaction; the attempt's write is a compare-and-set on `version`; a pasted flag's rate limit counts the stored `incorrect` rows; the held-capture decision is final because the row's status says so. Evidence is sealed with the attempt's key before it is stored; the table holds ciphertext, nonce and associated data only.

## Files changed
`apps/api/migrations/versions/0005_lab_state.py`, `apps/api/src/vulnmart/lab/{models,pg,keys,stores,api,tickets,catalog,background,runtime}.py`, `apps/api/src/vulnmart/main.py`, `apps/api/src/vulnmart/ingest/{stores,activity,engine,evidence}.py`, `apps/api/src/vulnmart/flags/submit.py`, `apps/api/src/vulnmart/ports/engine_attempts.py`, `packages/py-attempts/src/vulnmart_attempts/{store,engine,review,attempt_log}.py`, `apps/orchestrator/src/vulnmart_orchestrator/engine.py`, `contracts/api/lab/*`, `contracts/api/bundle/openapi.json`, regenerated clients, `contracts/mocks/fake-lab/server.mjs`, `contracts/db/table-owners.yaml`, `docs/architecture/04-data-and-state.md`, tests.

## Decisions made
- One master secret derives the lab keys (HKDF); the data keys are stored wrapped, in the `deks` table that can live in a separate keystore database (architecture 04 section 5.2) or in the same one on a small host. Alternative: wait for P-17; rejected because without stable keys a restart orphans every flag and every capture.
- PyYAML is now a runtime dependency of the API (the catalogue is YAML); the old rule "the runtime never imports yaml" became "only the catalogue reader does, with `safe_load`" (test updated).
- Instances are one per attempt in the directory; a replacement takes the place of the old one.

## Tests
- `uv run pytest -q` in apps/api with `VULNMART_TEST_POSTGRES_DSN` and `VULNMART_TEST_APP_DSN` set (Postgres 18.6 in Docker): 1760 passed, 4 skipped (Valkey not set, Windows mode bits), 1 failed (the old yaml rule, fixed and re-run: `tests/test_lab_image_files.py` 7 passed).
- New: `tests/test_lab_pg.py` 16 tests (schema, grants, the whole loop and a restart, sealed evidence across a restart, key port, purge, rate limit across a restart); `tests/test_lab_api.py` 12 tests (every answer validated against the OpenAPI components, ownership, CSRF and Origin, 429, 410, reviewer decision with a stubbed company scope, catalogue, my attempts); 5 runtime tests for start, stop, reset and the log.
- Orchestrator: 467 passed (`uv run pytest -q` in apps/orchestrator; one assertion updated for finding C1). py-attempts: 351 passed. Node: `npm test` 1013 tests, 1011 passed, 2 skipped, 0 failed (after removing a byte order mark my own PowerShell write had put in `background.py`, which the text-hygiene test caught).
- Contract check `scripts/check_lab_contract.py`: PASS (18 operations, 39 valid and 101 invalid examples).

## Problems met and how they were fixed
- Nothing created the attempt key, so every evidence capture would have been dropped: the runtime creates it at start (found while writing the sealed-evidence test).
- The contract's ticket URL pattern forbade the dot of `payload.signature`: fixed in the contract, the examples, the fake lab and the generated clients.
- The held-capture path wrote no integrity flag, so a reviewer would have had nothing to decide: it now writes an `activity` flag with the challenge key.
- The finality of a review decision lived in a dict of the process: it comes from the stored status now (review finding B6).
- `select(Model)` on a plain connection returns column rows, not entities: five stores read the first column only until the Postgres tests caught it.

## Security notes
No table holds a flag, a digest of a flag, a pasted text, a cookie or a password; a test reads the column list of `flag_submissions`. The master secret and the gate key are files with mode 0600 (refused otherwise on POSIX); nothing logs a key.

## Limitations and follow-ups
- Not persisted on purpose: the pairing buffers of the evidence recorder and the pending M2 windows of the milestone engine (seconds long; a restart replays the success events), and the orchestrator state history (the orchestrator resends).
- Candidate attempts need stream P (consent, invites, company scope: handoff H-348); the reviewer paths are tested with a stubbed scope. `GET /live` and `/live/snapshot` are P-22.
- `POST /attempts/{id}/start` is not served (D-80); the contract should drop it.
- Not tested live yet: the stores on the deployed hosts (story 9.5).