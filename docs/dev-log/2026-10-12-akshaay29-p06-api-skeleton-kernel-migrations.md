# API skeleton: kernel and single-head migrations (P-06, story 1.6)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-1-akshay-5 / local commit, not pushed |
| Status | Done; awaiting Tanmay's look at the Alembic layout (H-96) and the stale-image note for `dev.mjs up` |
| Report tag | API kernel, database, organisation scope, observability, BMAD cycle |

## Requirements covered
PB-5 (API skeleton: kernel, request ids and structured logs, health, readiness and version, skeleton entrypoints, one Alembic history). Related: NFR-OBS-01, NFR-OBS-02, NFR-MNT-05, NFR-PRI-02, NFR-SEC-03, ADR 0014, D-21, architecture 01 section 2, 02 section 12, 04 sections 2 and 3, handoffs H-07, H-16, H-22, H-96, H-104.

## Summary (plain language, 3-5 lines)
The API is no longer a tracer bullet. It has typed settings, a database layer that refuses to read company data unless a company is in scope and lets Postgres enforce the same rule with row-level security, request ids on every answer and log line, logs as JSON with secrets removed, and health, readiness and version routes on every entrypoint. The first database migration creates the settings, quota, job and company tables, and Compose runs it before the API starts.

## Why
Every module of both streams needs the kernel and the migration history (PB-5); P-07, P-09, P-17 and stream L's modules wait on it.

## What was built
- `apps/api/src/vulnmart/kernel/`: `settings.py` (pydantic-settings, `DbSettingsPort`), `observability.py` (request ids, JSON logs, secret filter, IF-8 500 inside the request), `db.py` (one metadata, engine, scoped session), `scope.py` (context `ScopePort`), `models.py` (settings, quotas, job_runs), `service.py` (health, readiness, version), `services.py` (port wiring: real scope and settings, P-05 fakes as audit, outbox, key and quota stubs), `entrypoints/` (ingest, live, worker, scheduler skeletons); `orgs/models.py`; `main.py` rebuilt with `GET /api/v1/health` (IF-1).
- `apps/api/alembic.ini`, `apps/api/migrations/` with revision `0001`: the five tables, row-level security forced on the company tables, row rights for the app role.
- Compose: a one-shot `migrate` service before `api`, an app role without ownership or BYPASSRLS (init script), version and commit build arguments; the API image carries the migrations and checks `/readyz`.
- The web proxy keeps the `/api` prefix and the page reads `/api/v1/health`; the stack end-to-end test follows.
- Tests: health, observability, scope, settings and migrations (CI), and Postgres integration tests (run locally).

## How it works
A request gets an id at the door; everything logged while it runs carries the id, and secrets are cut out of every line. Each query that touches a company table goes through the session, which asks "which company is in scope?": none means the query is refused, one means the filter is added and Postgres is told the same company for the transaction. Postgres then checks every row against it on its own, so a mistake in Python still cannot show another company's rows to the API's database role.

## Files changed
- `apps/api/src/vulnmart/kernel/` (8 modules and `entrypoints/`), `apps/api/src/vulnmart/orgs/models.py`, `main.py`, `problem.py`
- `apps/api/alembic.ini`, `apps/api/migrations/` (new); `apps/api/pyproject.toml`, `uv.lock` (sqlalchemy 2.0.54, alembic 1.20.0, pydantic-settings 2.15.0)
- `apps/api/Dockerfile`, `apps/api/Dockerfile.dockerignore`, `infra/compose/compose.yaml`, `infra/compose/postgres/initdb/10-app-role.sql`
- `apps/web/next.config.mjs`, `apps/web/app/page.tsx`, `scripts/e2e/platform-stack.e2e.test.mjs`
- `apps/api/tests/test_kernel_{health,observability,scope,settings,postgres}.py` (new), `test_healthz.py` (removed)
- `docs/dev/HANDOFFS.md`, `CHANGELOG.md`, `docs/traceability.md`, `docs/dev/dev2-akshay.md`, the story plan

## Decisions made
No ADR (ADR 0014 is implemented as written). By the developer on 2026-10-12: (1) the first migration holds the kernel tables and the two company tables, `events` waits for stream L (H-07 and H-104 disagree on its identity); (2) organisation scope is both the session filter and row-level security, with an owner role and an app role; (3) SQLAlchemy 2 and Alembic, pydantic-settings, stdlib JSON logging; (4) four skeleton entrypoints, Compose gains only `migrate`. While building: SQLAlchemy 2.0.54 rather than the very new 2.1; the public health answer is reused for 2 seconds.

## Tests
All on the developer's Windows 11 PC, Node 24.11.0, uv 0.12.23, Docker 28.5.1. Outputs in `docs/assets/p-06-api-skeleton/`.
- `uv run --locked --package vulnmart-api pytest -q`: 933 passed, 7 skipped (the Postgres tests, which need a database).
- `test_kernel_postgres.py` against Postgres 18.6 with the Compose init script: 7 passed (schema equals models, app role owns nothing and cannot bypass RLS, RLS per transaction, pooled connection keeps nothing, downgrade and upgrade, a missing role stops the migration).
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` on the real Compose stack: 10 of 10 (migrate exits 0 first, health through the proxy, readiness naming the store that is down, IF-8 errors, hardening, recovery).
- `node --test "scripts/*.test.mjs"`: 581 of 581. `node scripts/check-contract-rules.mjs`: 14 PASS, 0 FAIL (alembic: one head). `uv lock --check`: current.
- NOT run: CI on a pull request (CI has no Postgres: the seven Postgres tests are skipped there).
- Traceability row: PB-5 in `docs/traceability.md`.

## Evidence
`docs/assets/p-06-api-skeleton/`. Review log: Review Triage Log of the story plan.

## Problems met and how they were fixed
- SQLAlchemy caches lambda loader criteria by code location, so one table's organisation filter was reused for another; aggregates with `select_from` escaped the guard: both found by the tests and fixed.
- The first stack run used the old P-01 image (no Alembic) because `dev.mjs up` does not rebuild; after a build the end-to-end test passed. Noted for Tanmay in H-96.
- The old Compose Postgres volume predates the app role (init scripts run once): it was removed (it held no tables). Anyone with an old volume must remove `vulnmart_pg-data`; the migration now says so when the role is missing.
- Independent quick review: 8 findings fixed (500 without request id, secret-filter gaps, per-call health connections, scope spelling and mid-transaction change, silent missing role, `/version`, `job_runs.updated_at`, Alembic logging), 2 rejected.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant platform code: organisation scope (two layers), the app role without BYPASSRLS, the log secret filter, no error text in any answer. Only fixed development passwords appear, as Compose defaults.

## Limitations and follow-ups
- Not pushed or merged. ADR 0014's status (Proposed) is the developer's to change.
- Creating a company needs its id in scope or an admin path, because row-level security also guards inserts: the company stories decide.
- A Core statement over a plain company `Table` is filtered only by row-level security when a company is in scope (documented; module code uses the mapped classes).
- The real audit, outbox and key services come in P-17 and P-09; the entrypoints get work in P-09, P-22, P-24 and stream L's ingest story.
