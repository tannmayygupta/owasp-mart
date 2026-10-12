---
title: 'API skeleton: kernel and single-head migrations'
type: 'feature'
ticket: '6'
created: '2026-10-12'
status: 'built'
baseline_revision: '328c189840744eec9d6da6d2d72ecb97056ec744'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/adr/0014-organization-scoping-app-filter-and-rls.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The API is a tracer bullet (`main.py`: one `/healthz`, a new connection per call, plain logs). There is no settings object, no database layer, no organisation scope, no request-id middleware, no readiness or version endpoint, no other entrypoint and no migration history, so no module of either stream can start (PB-5; P-07, P-09, P-17 and stream L's modules wait on it).

**Approach:** Build the kernel in `apps/api/src/vulnmart/kernel/`: typed settings, a SQLAlchemy 2 engine and a scoped session that enforces ADR 0014, request ids and JSON logs, health, readiness and version for every entrypoint, the P-05 port stubs wired in, and one Alembic history whose first migration creates the kernel and organisation tables with row-level security; run it against Postgres in Compose through a one-shot `migrate` service.

## Boundaries & Constraints

**Decisions (developer, 2026-10-12):** (1) The first migration creates `settings`, `quotas`, `job_runs` (kernel) and `organizations`, `org_members` (orgs, the first org-scoped tables); `events` waits for stream L (H-07 and H-104 disagree on its identity). (2) Org scope is both the session filter and RLS: policies with FORCE ROW LEVEL SECURITY, a migration-owner role and a non-owner app role without BYPASSRLS; Postgres tests run against Compose and are skipped where no Postgres is configured (CI today). (3) SQLAlchemy 2 and Alembic (D-21), pydantic-settings, stdlib logging with a JSON formatter and a secret filter; no other new dependency. (4) Ingest, live hub, worker and scheduler are skeleton entrypoints with `/healthz`, `/readyz`, `/version`; Compose adds only `migrate` before `api`.

**Always:** Exact pins (NFR-MNT-03). Every response carries `X-Request-ID` (kept when it matches `[A-Za-z0-9-]{8,64}`, else `req-<hex>`, as `problem.py` does today) and every log line is JSON with that id; passwords, tokens, cookies, `Authorization` and flag-shaped values are redacted (NFR-OBS-01, NFR-PRI-02). `GET /api/v1/health` answers IF-1's `ServiceHealth` (ok or degraded, no store named, `Cache-Control: private, no-store`); `/healthz` is liveness, `/readyz` checks Postgres and Valkey, `/version` names service, version and commit (NFR-OBS-02). A query on an org-scoped table without an org in scope raises `ScopeMissing`; with one, the filter is added and the transaction sets `vulnmart.org_id` for RLS. One linear Alembic history in `apps/api/migrations/versions/`, single head, `scripts/check_alembic_head.py` passes (NFR-MNT-05). The web proxy keeps the `/api` prefix (P-04 decision) and the page reads `/api/v1/health`. Errors keep the IF-8 body.

**Never:** No other table (no `events`, audit, outbox or keystore tables: P-09, P-17, stream L). No real audit, outbox or key service (the P-05 fakes are the stubs). No Dramatiq or job logic. No change to stream L's files, the port Protocols of P-05, or CI workflows. No secret in a file: dev-only passwords stay as Compose defaults.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Request id | header `X-Request-ID: abcd-1234-efgh` / missing / `bad id!` | echoed / new `req-<hex>` / replaced | — |
| Log line | a log call with `password=...` or `VM{...}` in its message or extras | JSON line with `request_id`, values redacted | — |
| Liveness | process up, stores down | `/healthz` 200 | — |
| Readiness | Postgres or Valkey down or slow (>2 s) | `/readyz` 503, `/api/v1/health` 503 `degraded` | no error text in the answer |
| Version | any service | `{service, version, commit}` | — |
| Scope missing | ORM select on `org_members` with no org in scope | refused | `ScopeMissing` (500 REQ-INTERNAL) |
| Scope set | select with org A in scope | only org A rows; `vulnmart.org_id` = A in the transaction | — |
| RLS | app role, raw SQL, setting = A | rows of B invisible, insert for B refused | Postgres error |
| Migrations | empty database | `alembic upgrade head` succeeds; one head; downgrade to base works | — |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/main.py` -- tracer: `create_app(checks, timeout)`, `check_postgres`/`check_valkey` (env `VULNMART_POSTGRES_DSN`, `VULNMART_VALKEY_URL`, 2 s timeout), `/healthz` with store names. Replace; keep `create_app` and `app` names (Dockerfile CMD `vulnmart.main:app`).
- `apps/api/src/vulnmart/problem.py` -- `install_problem_handlers`, `request_id_for` (move the id logic to middleware; handlers keep reading it), `problem_response` sets no-store.
- `apps/api/tests/test_healthz.py`, `test_problem.py` -- assert the tracer bodies and `POST /healthz` 405; update to the new routes.
- `apps/api/src/vulnmart/ports/{scope,settings,quota,audit,outbox,keys,fakes}.py` -- P-05 Protocols and fakes; implement `ScopePort` and `SettingsPort` for real, wire the fakes as audit, outbox and key stubs. Do not change the Protocols.
- `apps/api/pyproject.toml`, `uv.lock` -- add sqlalchemy, alembic, pydantic-settings (pydantic-settings 2.15.0 is already locked transitively).
- `apps/api/Dockerfile`, `apps/api/Dockerfile.dockerignore` -- healthcheck on `/healthz`; the allow-list must add `apps/api/migrations/**` and `apps/api/alembic.ini`.
- `infra/compose/compose.yaml` -- platform profile: postgres 18.6 (user `vulnmart`, dev password default), valkey, api (env, depends_on). Add `migrate`, an init script for the app role, the app DSN for `api`.
- `apps/web/next.config.mjs` (rewrite strips `/api`), `apps/web/app/page.tsx` (fetches `/api/healthz`, reads postgres/valkey), `scripts/e2e/platform-stack.e2e.test.mjs` (not in CI) -- follow the new routes.
- `scripts/check_alembic_head.py` (stream L) -- expects `apps/api/migrations/versions/*.py` with module-level `revision`/`down_revision`; NOT-APPLICABLE until the folder exists.
- `docs/architecture/04-data-and-state.md` s2.2, s2.7, s3 -- columns of the five tables; scope rules. ADR 0014 -- filter plus RLS, FORCE, non-owner role, pooled-connection test.
- `apps/api/tests/test_contract.py` -- pins the top-level contents of `vulnmart/`: new code goes inside `kernel/`, not beside it.

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/src/vulnmart/kernel/settings.py` -- `Settings` (pydantic-settings, prefix `VULNMART_`): app and migrate DSNs, Valkey URL, service name, version, commit, log level; `SettingsPort` over the `settings` table with the P-05 defaults.
- [x] `kernel/observability.py` -- request-id middleware and contextvar, JSON formatter, secret filter, `configure_logging`.
- [x] `kernel/db.py`, `kernel/scope.py`, `kernel/models.py`, `orgs/models.py` -- engine, session factory, org-scope enforcement (ORM event: refuse or filter, `set_config('vulnmart.org_id', ..., true)` per transaction), request `ScopePort`, the five tables.
- [x] `kernel/service.py`, `kernel/entrypoints/{ingest,live,worker,scheduler}.py`, `main.py` -- one factory for health, readiness and version; the api app adds `GET /api/v1/health`, problem handlers and the port wiring (`kernel/services.py`).
- [x] `apps/api/alembic.ini`, `apps/api/migrations/{env.py,script.py.mako,versions/0001_kernel_orgs_baseline.py}` -- the five tables, grants to the app role, RLS with FORCE on the org-scoped ones.
- [x] `infra/compose/compose.yaml`, `infra/compose/postgres/initdb/10-app-role.sh` (or `.sql`), `apps/api/Dockerfile*` -- app role, `migrate` service, api on the app DSN.
- [x] `apps/web/next.config.mjs`, `apps/web/app/page.tsx`, `scripts/e2e/platform-stack.e2e.test.mjs` -- keep the prefix, read `/api/v1/health`.
- [x] `apps/api/tests/test_kernel_*.py` -- the matrix; Postgres tests skip without `VULNMART_TEST_POSTGRES_DSN`; run them against Compose and keep the output as evidence.
- [x] `docs/dev/HANDOFFS.md` (H-07, H-16, H-22, H-96, H-104), `docs/architecture/02` or `07` if a name changes.

**Acceptance Criteria:**
- Given `pnpm run dev -- up platform` (or the Compose platform profile), when the stack starts, then `migrate` exits 0 before `api`, `api` is healthy, `/readyz` is 200 and `GET /api/v1/health` through the web proxy is 200 `{"status":"ok"}`.
- Given the repository, when `node scripts/check-contract-rules.mjs` runs, then the alembic check is PASS (one head) and nothing fails; `uv run --locked --package vulnmart-api pytest -q` passes in CI with the Postgres tests skipped and passes locally with them run.

## Implementation Notes

- Built directly in the main session. Pins: sqlalchemy 2.0.54 (the mature line; 2.1 reached general release on 24 September), alembic 1.20.0, pydantic-settings 2.15.0.
- Kernel files: `kernel/settings.py`, `observability.py`, `db.py`, `scope.py`, `models.py`, `service.py`, `services.py`, `entrypoints/{ingest,live,worker,scheduler}.py`; `orgs/models.py`; `main.py` rebuilt on `create_service_app`. Migrations: `apps/api/alembic.ini`, `migrations/env.py`, `script.py.mako`, `versions/0001_kernel_orgs_baseline.py`.
- Found by the tests while building: SQLAlchemy caches lambda loader criteria by code location, so one table's filter was reused for another (fixed with plain expressions); `select(func.count()).select_from(X)` escaped the guard because `all_mappers` misses `select_from` entities (fixed by walking the statement for tables); the JSON column already decodes values (`DbSettingsPort` decoded twice); `Bearer` tokens were only half redacted.
- Documented limit of the session guard: a Core statement over a plain `Table` of an org-scoped table is refused without an organisation in scope, but with one in scope only row-level security filters it (tested in both layers).
- RLS on `organizations` also guards inserts: creating a company needs its id in scope (or an admin path); the company stories decide.
- `node scripts/dev.mjs up` does not rebuild images: the first stack run used the P-01 image without Alembic. Rebuilt, the end-to-end test passes 10 of 10. Told Tanmay in H-96 (adding `--build` is his file).
- Postgres tests run against a separate local Postgres 18.6 container with the same init script (Compose does not publish Postgres to the host).
- Review (quick lens): 8 findings fixed, 2 rejected (see the Review Triage Log). After the patches: 933 pytest, Postgres tests 7 of 7, stack end-to-end 10 of 10, contract rules 0 FAIL.

## Plan Change Log

## Review Triage Log

### 2026-10-12, quick review (lens: quick), loop 0
Verdicts: 2 high, 3 medium, 3 low, 2 false. All patches applied; nothing deferred.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | A 500 had no `X-Request-ID` header and its log line a null id (Starlette's 500 handler runs outside every middleware) | high | patch | Reproduced by the reviewer. `RequestIdMiddleware` now answers the IF-8 500 itself inside the request context and logs with the id. Test: header, body and log carry the same id; the error text never leaks. |
| 2 | The secret filter missed prefixed keys (`csrf_token=`, `db_password=`), quoted keys, query parameters, every cookie after the first, and percent-encoded flags | high | patch | Patterns widened (prefix/suffix, quotes, whole Cookie and Authorization lines, `VM%7B...%7D`). Eight new parametrised cases. |
| 3 | The health checks opened a new Postgres and Valkey connection on every call of a public route | medium | patch | One small pooled engine and one Valkey client per check, created on first use; the public route reuses its answer for 2 s (internal `/readyz` always checks). Test: five calls, one round of checks. |
| 4 | The Python filter and the Postgres setting could name the organisation differently (non-canonical UUID), and a scope change inside a transaction split them | medium | patch | One canonical spelling (`current_org`) for both; a scope change inside a transaction is refused. Tests for both. |
| 5 | The migration skipped the grants with a NOTICE when the app role was missing, and stamped head anyway | medium | patch | It now stops with an error that says how to fix it; nothing is stamped. Postgres test. |
| 6 | `/version` could never report a real version or commit | low | patch | Docker build arguments to environment; Compose passes `VULNMART_VERSION` and `VULNMART_COMMIT`. |
| 7 | `job_runs` is mutable but had no `updated_at` (architecture 04 s2) | low | patch | Column added to model and migration; the Postgres schema-versus-models comparison passes. |
| 8 | Alembic's logging config was never applied, so `migrate` printed nothing | low | patch | `fileConfig` in `migrations/env.py`. |
| 9 | Postgres-test evidence missing | false | rejected | Written at close-out: `docs/assets/p-06-api-skeleton/postgres-tests-2026-10-12.txt` (7 passed) and the stack end-to-end output. They ran against a separate Postgres 18.6 container with the same init script, because Compose does not publish Postgres; the end-to-end test ran against Compose. |
| 10 | No dev-log, changelog or traceability row; ADR 0014 and architecture 02 s12 not updated | false | rejected | The documents are written at close-out. Architecture 02 s12 already describes `/healthz` as liveness and `/readyz` as readiness, which is what is built now; ADR 0014's status is the developer's to change. |

## Design Notes

Scope enforcement keys on a registry of org-scoped tables (`org_members`, later every table with `org_id`), not on column names, so a new scoped table is one line. `organizations` itself is scoped by its `id`. Participant scoping by `user_id` (04 s3) comes with the first participant table. The RLS policy reads `current_setting('vulnmart.org_id', true)`; an unset setting matches no row.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest -q` -- expected: all pass (Postgres tests skipped)
- `VULNMART_TEST_POSTGRES_DSN=... uv run --locked --package vulnmart-api pytest -q -k postgres` against Compose -- expected: pass
- `uv run --locked --package vulnmart-api python scripts/check_alembic_head.py` -- expected: PASS, one head
- `node scripts/check-contract-rules.mjs`, `node --test "scripts/*.test.mjs"` -- expected: 0 FAIL, all pass
- `docker compose -f infra/compose/compose.yaml --profile platform up -d --wait` then `curl /readyz`, `/version`, `/api/v1/health` -- expected: 200
