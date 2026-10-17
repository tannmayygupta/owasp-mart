---
title: 'Lab runtime wiring: attempts, scoring and ingest connected to apps/api, demo routes and demo clock'
type: 'feature'
ticket: '1'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md', '{project-root}/docs/architecture/07-repo-and-workstreams.md', '{project-root}/apps/api/Dockerfile']
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** The libraries of stories 6.x and 7.x (flag material, checker, submit service, milestone engine, ingest handler, `vulnmart-attempts`) are built and tested alone, but nothing connects them: `vulnmart-attempts` is not a dependency of `apps/api`, the Docker image does not contain it, the ingest entrypoint serves the handler with no stores, `jsonschema` is a dev-only dependency although the ingest handler imports it at run time (the production image would fail on the first event), and there is no way to drive one attempt over HTTP for the demo.

**Approach:** One small additive edit of Akshay's files plus an L-owned folder. Exact steps:

1. Check first (stop and report if wrong): `apps/api/src/vulnmart/ports/engine_attempts.py` and `engine_reports.py` exist and their tests pass (stories 7.2 and 7.3 say built; they were not in the tree when this plan was written). `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests` passes.
2. `apps/api/pyproject.toml`: add `"vulnmart-attempts",` and `"jsonschema==4.26.0",` (the pin of the dev group) to `dependencies`, and `vulnmart-attempts = { workspace = true }` under `[tool.uv.sources]`. Nothing else. Then `uv lock` (never `--upgrade`); the `uv.lock` diff must show only the added edges (read it). `catalogue.py` imports PyYAML at call time: the runtime does not call it, so PyYAML stays dev-only (a test asserts the runtime never imports `yaml`).
3. `apps/api/Dockerfile`: builder stage, after the line `COPY packages/py-models/pyproject.toml ...` add `COPY packages/py-attempts/pyproject.toml packages/py-attempts/pyproject.toml`; after `COPY packages/py-models/src packages/py-models/src` add `COPY packages/py-attempts/src packages/py-attempts/src`. Runtime stage, before `USER`: `COPY contracts/events/instance-events.schema.json /app/contracts/events/instance-events.schema.json` and `ENV VULNMART_EVENT_SCHEMA=/app/contracts/events/instance-events.schema.json` (the schema default `parents[5]` points at the repository root, which does not exist inside the image; `SCHEMA_ENV` is the existing override in `ingest/schema.py`). The `milestone_rules.json` file sits beside `rules.py` and ships in the wheel; a test opens it from the installed package.
4. `apps/api/Dockerfile.dockerignore`: add `!packages/py-attempts/pyproject.toml`, `!packages/py-attempts/src/**`, `!contracts/events/instance-events.schema.json` (the file is an allow-list; without them the COPY lines fail).
5. New folder `apps/api/src/vulnmart/lab/` (the only new folder in `apps/api`; stream L owns it): `clock.py` (`OffsetClock`: `SystemClock` plus an offset in seconds that only the demo route can raise, never lower), `control.py` (`HostInstanceControl(host)` implements `InstanceControl`: `freeze` = `host.set_access(instance_id, Access.FROZEN, access_epoch + 1)`, `destroy` = `host.destroy`; both idempotent and an absent instance counts as done), `runtime.py` (`LabRuntime` and `build_lab_runtime(environ, *, host=None, clock=None)`), `demo_routes.py` (`install_demo_routes(app, runtime, token)`), `__init__.py`.
6. `LabRuntime` holds, in one process and in memory (D-96): `AttemptEngine(InMemoryAttemptStore, HostInstanceControl, clock, events=attempt_log)`, `EngineAttemptPort`, `EngineReportPort` over a `FactSource` built from `InMemoryMilestoneStore`, hint facts and the held queue, `FlagChecker`, `FlagSubmitService` (attempts = `EngineAttemptPort`), `MilestoneEngine` as the `sink` of `IngestHandler` (keys = a `FakeKeyPort` with RANDOM master keys per process from `secrets.token_bytes`, never the fixed `FAKE_*` constants), `MemoryInstanceEpochs`, `InMemoryInstanceDirectory`, `MemoryEventStore`, and a host: `HttpInstanceHost` when `VULNMART_ORCH_URL` and the signing key file are set, `FakeInstanceHost` otherwise. Method `start_attempt(user_id, template_id)`: engine `create` (synthetic consent id), flag material from `build_material` and `KeyPort`, `host.create(CreateRequest)`, poll `host.get` every 1 s up to 120 s until `ready` (the push of state reports to the platform, H-67, is not needed for the demo), then `engine.instance_ready(attempt_id, clock(), instance_id)`, `directory.add(InstanceInfo(...))` and `epochs.set(instance_id, epoch)`. Methods `submit_flag`, `score`, `submit`, `tick`, `state`.
7. `apps/api/src/vulnmart/kernel/entrypoints/ingest.py` (stream L's entrypoint): after `install_event_route(app)`, `if os.environ.get("VULNMART_LAB_RUNTIME") == "1": runtime = build_lab_runtime(os.environ); app.state.ingest_handler = runtime.handler; app.state.lab = runtime`, and when `VULNMART_LAB_DEMO == "1"` and `VULNMART_LAB_DEMO_TOKEN` is non-empty, `install_demo_routes(app, runtime, token)`. With the variables unset the file behaves exactly as today. The tick runs from a background task every 5 s when `VULNMART_LAB_TICK_SECONDS` is set (production: the scheduler entrypoint, Akshay's job; handoff).
8. Demo routes (all under `/internal/v1/lab-demo/`, `include_in_schema=False`, header `X-Lab-Demo-Token` compared with `hmac.compare_digest`, 401 without it, not mounted at all unless both variables are set): `POST /attempts` (`user_id`, `template_id`) returns `attempt_id`, `instance_id`; `GET /attempts/{id}` state and times; `POST /attempts/{id}/flags` (`challenge_key`, `text`); `POST /attempts/{id}/hints` (`challenge_key`, `level`); `POST /attempts/{id}/submit`; `GET /attempts/{id}/score`; `POST /tick`; `POST /advance` (`seconds`, 1 to 7200, raises the `OffsetClock`).

**Proposed (decided on the developer's delegation):**
- **D-95:** the integration edit of `apps/api` is limited to the three manifest files and `uv.lock` (steps 2 to 4) plus the L-owned folder `apps/api/src/vulnmart/lab/` and the stream-L entrypoint `kernel/entrypoints/ingest.py`; `main.py`, `kernel/services.py`, `kernel/settings.py`, migrations and Akshay's route modules are not touched. Akshay's real routes later call `EngineAttemptPort`, `EngineReportPort` and `FlagSubmitService` through `build_ports`; until then the demo routes are the only HTTP entry. The edit is announced to Akshay in a handoff row in the same commit and goes on the same branch as the story.
- **D-96:** the demo runtime keeps all state in memory in one process (the ingest entrypoint process), because the real tables (`events`, `milestones`, `flag_submissions`, attempts) are Akshay's and not migrated (H-330). A restart loses attempts; this is stated in the runbook. The demo routes and the clock offset exist only behind two environment variables and a token, loopback or private network only, and are never part of the production compose profile `lab` as shipped (a compose rule test asserts neither variable is set there).

## Boundaries & Constraints

**Always:** random keys per process (a test starts two runtimes and checks the event keys differ); the demo token is read from the environment, never logged, never in an error body; demo routes refuse to mount with an empty token; the demo clock can only move forward and only through `/advance`; every route answer holds ids, states, numbers and result words, never a flag, digest, key or pasted text; the runtime off path imports nothing new at module import time that is not installed (import `vulnmart.lab` lazily inside the `if`).

**Never:** touching `apps/api/migrations/**`, `contracts/**`, `main.py`, `kernel/services.py`, `kernel/settings.py` or any file of `apps/web`; a new third-party dependency other than the pinned `jsonschema` already used by the dev group; a database write; real AWS, VM or SSH steps; enabling the runtime or the demo routes in `infra/compose/compose.yaml` profile `lab` or on any deployed host; the Excel tracker; commits, pushes, checkout, stash, reset.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Runtime off | no `VULNMART_LAB_RUNTIME` | entrypoint as before (event route answers REQ-INTERNAL without a handler) | none |
| Runtime on, demo off | runtime variable only | event route works, `/internal/v1/lab-demo/*` answers 404 | none |
| Demo on, no token set | demo variable, empty token | routes not mounted, a log line says why | none |
| Wrong or missing token | any demo call | 401 IF-8 problem body | none |
| Start attempt, fake host | `POST /attempts` | attempt `running` after the fake host reaches ready, clock started at ready | `INST-*` problem if the host refuses |
| Start attempt twice | same user and template | same attempt (one per invite rule of story 1) | none |
| Signed event | valid IF-4 event for the instance | 202, milestone engine sees it | as the ingest handler |
| Advance clock | `seconds` 7201 or negative | 422 | none |
| Tick after deadline | clock advanced past deadline | auto-submitted, access frozen, destroy after the freeze | host error leaves record unchanged |
| Image build | Dockerfile as edited | image builds, `python -c "import vulnmart_attempts, jsonschema"` works, schema file found | build fails loudly |

</frozen-after-approval>

## Code Map

- `apps/api/pyproject.toml`, `apps/api/Dockerfile`, `apps/api/Dockerfile.dockerignore`, root `uv.lock` -- the additive edit (D-95).
- `apps/api/src/vulnmart/kernel/entrypoints/ingest.py` -- the switch; `ingest/route.py` (`install_event_route`), `ingest/handler.py` (`IngestHandler`), `ingest/engine.py` (`MilestoneEngine`), `ingest/stores.py` (in-memory stores, `InstanceInfo`), `ingest/store.py` (`MemoryEventStore`, `MemoryInstanceEpochs`), `ingest/schema.py` (`SCHEMA_ENV`).
- `apps/api/src/vulnmart/flags/material.py` (`build_material`), `flags/checker.py`, `flags/submit.py` (`FlagSubmitService`).
- `apps/api/src/vulnmart/ports/` -- `engine_attempts.py`, `engine_reports.py` (stories 7.2, 7.3), `fakes.py` (`FakeKeyPort`), `fake_instance_host.py`, `http_instance_host.py`, `instance_host.py` (`CreateRequest`, `Access`).
- `packages/py-attempts/src/vulnmart_attempts/` -- `engine.py`, `store.py`, `instances.py`, `clock.py`, `scoring.py`, `catalogue.py`.
- `apps/api/src/vulnmart/kernel/service.py` -- `create_service_app`, `background_lifespan` (tick loop).
- `scripts/check_table_owners.py`, `scripts/check_platform_contract.py`, `scripts/check-lab-compose-rules.mjs` -- must still pass.
- New: `apps/api/src/vulnmart/lab/*`, tests `apps/api/tests/test_lab_runtime.py`, `test_lab_demo_routes.py`, `test_lab_image_files.py`.
- docs: dev-log, CHANGELOG, traceability, evidence `docs/assets/story-8-1-lab-runtime/`, handoff rows (below), runbook text in `docs/runbooks/local-demo.md` (a short "lab runtime" section: the four environment variables).

## Tasks & Acceptance

**Execution:**
- [ ] step 1 checks, recorded in the dev-log with their real output
- [ ] steps 2 to 4 manifests and lock, `uv lock` diff read and summarised
- [ ] steps 5 and 6 `lab/` package with unit tests (runtime on `FakeInstanceHost` and a fake clock; keys random; host errors)
- [ ] steps 7 and 8 entrypoint switch and demo routes with route tests (404, 401, mounted, bad bodies, clock only forward)
- [ ] `test_lab_image_files.py`: Dockerfile and dockerignore contain the new lines; no source file in `lab/` imports `yaml`; the compose `lab` profile sets neither variable
- [ ] build the image: `docker build -f apps/api/Dockerfile -t vulnmart-api:lab .` and run `docker run --rm --entrypoint python vulnmart-api:lab -c "import vulnmart_attempts, jsonschema, vulnmart.lab"` (skip with a note if Docker is not running)
- [ ] docs -- handoffs, dev-log, CHANGELOG, traceability, story `built`

**Acceptance Criteria:**
- Given the runtime variables unset, then the ingest entrypoint and the existing api tests behave as before.
- Given the runtime and demo variables set with a token, then `POST /attempts`, a signed event, a flag submission, `POST /advance`, `POST /tick` and `GET /score` run the loop on a fake host.
- Given the built image, then `vulnmart_attempts`, `jsonschema` and the event schema file are present and the handler validates an event.
- Given the compose rules check, then it still passes and no deployed profile enables the demo routes.

## Handoffs (proposed, add rows in the same commit; numbers to be given by the next free H id)

- To Akshay (all P tasks that touch `apps/api`): the additive edit of `apps/api/pyproject.toml` (`vulnmart-attempts`, `jsonschema` runtime), `Dockerfile`, `Dockerfile.dockerignore` and `uv.lock`; please merge or confirm no conflict; do not remove them. Default if no answer: stays as written (it is additive).
- To Akshay (P-xx scheduler, attempts and report tables): production needs the real `AttemptStore` (compare-and-set on a version column), `MilestoneStore`, event log and `flag_submissions` tables (H-330), a scheduler job calling `AttemptEngine.tick()` every 15 s, and a Python gate-ticket signer behind `InstancePort.open_ticket` (the signer exists only in Node, `apps/edge/src/tickets.mjs`; confirm owner and contract `contracts/edge/gate-ticket.md`). Until then the demo runs on the in-memory runtime (D-96).

## Verification

**Commands:**
- `uv sync --locked` then `uv run --locked --package vulnmart-api pytest -q apps/api/tests apps/api/tests/test_lab_runtime.py apps/api/tests/test_lab_demo_routes.py apps/api/tests/test_lab_image_files.py`
- `uv run --locked --package vulnmart-attempts pytest -q packages/py-attempts/tests`
- `node scripts/check-lab-compose-rules.mjs`, `uv run --locked --package vulnmart-api python scripts/check_table_owners.py`, `uv run --locked --package vulnmart-api python scripts/check_platform_contract.py`
- `docker build -f apps/api/Dockerfile -t vulnmart-api:lab .` (Docker Desktop)
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`
