# Move the IF-2, IF-4 and IF-5 error bodies to the IF-8 format

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | tannmayygupta |
| Branch / commit | sprint-2-tanmay, not committed yet (base 4005bfd) |
| Status | Done (built; the developer commits and closes the story) |
| Report tag | contracts, error format |

## Requirements covered
LB-8 (contracts v1.0.0 preparation, condition F-2 of the sign-off), FR-INS-07 (IF-5 service answers), D-37, handoffs H-114 (answered), H-04 and H-91 (already answered, unchanged).

## Summary (plain language, 3-5 lines)
Every error answer of the lab API (IF-2), the instance events ingest (IF-4) and the orchestrator API (IF-5) is now the one closed IF-8 body: `type`, `title`, `status`, `code`, `request_id`, and for a 422 `field` or `errors`. No `detail`, no `instance`, no `message`. The title and status come from the registry, not from each mock or service. Done before the v1.0.0 tag, so it is not a breaking change after the tag.

## Why
Stream P signs contracts v1.0.0 only if the three error bodies follow IF-8 (change request `docs/reviews/2026-10-11-if8-change-request-for-stream-l.md`, handoff H-114).

## What was built
- Contracts: IF-2 0.3.0, IF-5 0.4.0, IF-4 0.3.0 (all declared BREAKING, still 0.x), IF-6 0.3.2 (wording only), IF-8 0.4.0 (three codes the seed lacked: `ORCH-CURSOR-INVALID`, `ORCH-UNSUPPORTED-MEDIA-TYPE`, `ORCH-NOT-IMPLEMENTED`).
- `Problem` in IF-2 and IF-5 is a copy of the IF-8 schema and the check scripts compare it; the bundle now shares it (0 renamed components).
- `field` is only on a 422 and is a pointer: query parameters are `/query/<name>`, a forbidden field is `/image`, a path id `/path/instance_id`.
- Node mocks use one builder, `contracts/mocks/shared/problem.mjs`, that reads the registry. Python orchestrator uses the generated `vulnmart_models.error_codes`.

## How it works
`problem_body(code, field, request_id)` (Python) and `problemBody(code, requestId, {field, errors})` (Node) build the body from the registry entry. The reason text of an error goes to the log under the request id and never into the answer.

## Files changed
- `contracts/errors/error-codes.yaml` and the generated `packages/*/error-codes.*` (59 codes)
- `contracts/api/lab/*` (OpenAPI, `lab-api.md`, examples), `contracts/orchestrator/*`, `contracts/events/app-events.md`, `contracts/instance/instance-contract.md`
- `contracts/api/bundle/*`, `packages/ts-client/src/api.d.ts`, `packages/py-models/src/vulnmart_models/api.py` (regenerated)
- `contracts/mocks/shared/problem.mjs` (new), `fake-orchestrator`, `fake-lab`, `fake-ingest`, stub-instance Dockerfile and ignore file
- `contracts/registry.json`, `contracts/COMPAT.md` (versions only, every Approvals status still `pending`), `contracts/CHANGELOG.md`
- `scripts/check_orchestrator_contract.py`, `scripts/check_lab_contract.py`, `scripts/validate-events.mjs` and its test
- `apps/orchestrator` (`problems.py`, `service.py`, `builder.py`, `pyproject.toml` now depends on `vulnmart-models`, `Dockerfile`, `uv.lock`)
- `apps/api/src/vulnmart/ports/` (client message is the `title`, fake host pointers) and tests in `apps/api/tests`, `apps/orchestrator/tests`
- `docs/dev/HANDOFFS.md` (H-114 answered), `docs/traceability.md`, `CHANGELOG.md`

## Decisions made
No ADR: the shape was decided by IF-8 and the change request. Choices made inside it: add the three missing codes to the registry; `ORCH-BAD-SIGNATURE` on the fake's loopback test route became 404 `ORCH-ROUTE-UNKNOWN` so the status is the registry's; query pointers use the IF-8 README form `/query/<name>`.

## Tests
Real runs, 2026-10-12/13 (details in the story plan file):
- `node scripts/check-contract-rules.mjs`: 25 PASS, 0 FAIL, 1 NOT-APPLICABLE.
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests`: 225 passed, 1 failed on 2026-10-12 (`test_over_twenty_per_second...`, timing: each local call takes about 55 ms so the 20 per second limit never triggers; the same at the base commit, checked with `git archive`). The rate-limit timing test was flaky on the slow Windows machine and was made deterministic on 2026-10-13; the real count on 2026-10-13 is 243 passed, 0 failed.
- `VM_ORCH_SERVICE=python` five suites: 393 passed, 18 skipped.
- `node --test "scripts/*.test.mjs"`: 705 pass, 0 fail.
- `check-text-files`, `scan-secrets`: PASS. New test `test_every_error_answer_validates_against_the_if8_schema` validates the Python service answers with `problem.schema.json`.

## Evidence
Command output only (above).

## Problems met and how they were fixed
- IF-5 text said the codes already used the registry spelling, but three were missing from the registry; added them (IF-8 0.4.0).
- `field` was a bare name in IF-5 (not a pointer) and `/limit` style for queries; changed to pointers.
- A 429.0 example was written as 429 by `JSON.stringify`; fixed by hand.
- The stub-instance image imports the fake ingest, which now needs `js-yaml` and the registry; Dockerfile updated (not built, no docker run).

## Security notes (vulnerable parts only)
None. The change removes free text from answers (no path or value reaches a client).

## Limitations and follow-ups
- The stub sidecar's own answers on `/v1/events` keep their shape (not ingest answers).
- `contracts/api/platform/platform-api.md` still says IF-2 keeps its own error bodies (stream P file, not touched).
- Akshay re-confirms the new versions; Approvals rows stay `pending`.
- The rate-limit test was timing-bound on this machine; made deterministic on 2026-10-13 (see Tests).