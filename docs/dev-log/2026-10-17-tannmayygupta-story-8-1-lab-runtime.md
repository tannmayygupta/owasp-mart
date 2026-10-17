# Lab runtime wiring: attempts, scoring and ingest connected to apps/api (story 8.1)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay / not committed yet |
| Status | Done locally (Docker Desktop and in-process); nothing run on vm-i or vm-p |
| Report tag | integration, lab runtime |

## Requirements covered
FR-SES-02, FR-SES-04, FR-SES-09, FR-SES-10, FR-SCR-01, FR-FLG-04, FR-DET-01, FR-ACH-07, FR-TIM-01 to 03, NFR-OBS-02; D-95, D-96 (Proposed in the story plan, not yet confirmed); handoffs H-145, H-146.

## Summary
The libraries for flags, ingest, milestones, attempts and scoring were built and tested one by one but nothing connected them. This story connects them in one process in memory (`LabRuntime`), switches it on in the ingest entrypoint with `VULNMART_LAB_RUNTIME=1`, and adds token-guarded demo routes (`VULNMART_LAB_DEMO=1` plus a token) to drive one attempt over HTTP. The plan's step 1 check failed (the two port adapters `engine_attempts.py` and `engine_reports.py` did not exist), so they were written here.

## Why
The 19 October demo needs one loop: start an attempt, capture a flag, see a score, expire, freeze, destroy. Akshay's real tables and routes are not there yet (H-130), so the runtime keeps state in memory (D-96).

## What was built
- `apps/api/src/vulnmart/ports/engine_attempts.py`: `AttemptPort` over `AttemptEngine` (create, get, cancel, withdraw, purge).
- `apps/api/src/vulnmart/ports/engine_reports.py`: `ReportPort` over `compute_score` and a `FactSource`; evidence through `EvidenceReader`, integrity flags from the sink.
- `apps/api/src/vulnmart/lab/`: `clock.py` (system clock plus a forward-only offset), `control.py` (`InstanceControl` over `InstanceHost`, freeze and destroy idempotent), `runtime.py` (`LabRuntime`: start attempt, paste flag, hints, reset with limit, withdraw, time metrics, held-capture review, tick; keys random per process), `demo_routes.py`.
- `kernel/entrypoints/ingest.py`: the switch (lazy import; unset variables behave as before).
- `apps/api/pyproject.toml`, `Dockerfile`, `Dockerfile.dockerignore`, `uv.lock`: additive (D-95). `tests/test_contract.py`: the two file lists name the new files and the `lab` folder.

## How it works
`start_attempt` creates a `ready` attempt, builds flag material through the (fake, random-key) KeyPort, calls `host.create`, waits for `ready`, opens access, registers the instance with the ingest directory, and calls `instance_ready` so the clock starts when the instance is ready (D-80). A signed IF-4 event goes through the real `IngestHandler`; its sink runs the milestone engine, then evidence, activity buckets and bot visits. The score is `compute_score` over best milestone, hint levels and held state per challenge. `tick` runs the engine (warnings, expiry, auto-submit, freeze, destroy, withdrawal deletion), the milestone timers, and moves `submitted` to `reported` only after the instance is destroyed and no capture is held.

## Files changed
See "What was built". Tests: `apps/api/tests/test_lab_runtime.py`, `test_lab_demo_routes.py`, `test_lab_image_files.py`, `test_lab_loop.py`, `test_lab_review_reset_withdraw.py`.

## Decisions made
D-95 and D-96 are Proposed in the story plan and stay Proposed until the developer confirms them. The demo 401 uses the registry code `AUTH-SESSION-REQUIRED` because no new code may be added to the registry here.

## Tests
- `uv run --locked --package vulnmart-api pytest apps/api/tests/test_lab_runtime.py apps/api/tests/test_lab_demo_routes.py apps/api/tests/test_lab_image_files.py apps/api/tests/test_lab_loop.py -q`: 40 passed (output in `docs/assets/story-8-1-lab-runtime/pytest-lab.txt`).
- `uv run --locked --package vulnmart-api pytest apps/api/tests/test_lab_review_reset_withdraw.py -q`: 7 passed.
- Full api suite `uv run --locked --package vulnmart-api pytest apps/api -q` (final run, after the review, reset and withdrawal wiring): 1249 passed, 7 skipped (the Postgres tests need a database).
- `node scripts/check-lab-compose-rules.mjs`: PASS. `check_table_owners.py`: PASS (43 tables). `check_platform_contract.py`: OK (25 operations).
- `docker build -f apps/api/Dockerfile -t vulnmart-api:lab .` built; `docker run --rm --entrypoint python vulnmart-api:lab -c "import vulnmart_attempts, jsonschema, vulnmart.lab.runtime ..."` printed `imports ok True` (the schema file is present).
- Hand-computed expected scores: 63 (C01 alone: 1000 x 60 / 960 = 62.5, half up), 94 (C02 or C03 alone: 93.75), 56 (C01 with hint level 1: 54 / 960), 147 (C01 + C02 with a hint).

## Evidence
`docs/assets/story-8-1-lab-runtime/pytest-lab.txt`.

## Problems met and how they were fixed
- Step 1 of the plan failed: the port adapters were not in the tree. Written here.
- The first tick reported an attempt before its instance was destroyed, and the engine never destroys a `reported` attempt. Reporting now waits for `destroyed`.
- The demo token first used `AUTH-TOKEN-INVALID`, which is a 400. Changed to `AUTH-SESSION-REQUIRED` (401).
- `seconds: "10"` was accepted by pydantic's lax mode; the field is now strict.
- `test_contract.py::test_the_ports_package_holds_only_the_three_modules` failed as designed for a new module; its lists were updated (H-145).
- A PowerShell `Set-Content -Encoding utf8` added a BOM; removed (check-text-files).

## Security notes
The demo routes and the clock offset exist only behind two environment variables and a token, are never in a compose file (a test asserts it), and every answer holds ids, states, numbers and result words, never a flag or key. Event keys are random per process.

## Limitations and follow-ups
State is in memory (restart loses attempts). No real KeyPort or tables (H-130, H-146). The tick runs only when a demo route is called or a scheduler calls it. `EngineCohortPort` and the report-port `time` method are not written. Real orchestrator over mTLS was not run here (story 3 covers http loopback).
