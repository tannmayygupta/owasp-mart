# Error registry and problem-details format, IF-8 (P-02, story 1.2)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-1-akshay / local commit, then pushed to the sprint pull request |
| Status | Done; awaiting Tanmay's review of the statuses, titles and the body shape stream L moves to |
| Report tag | contracts, errors, BMAD cycle |

## Requirements covered
PB-1 (error codes and the problem-details format as one registry contract). Related: IF-8, NFR-SEC-03 (no stack traces, only a generic message and a request ID), architecture 07 sections 3.6 and 7.7 row 1, D-21.

## Summary (plain language, 3-5 lines)
There is now one list of error codes (48, with HTTP status, a fixed generic text and a retry hint) and one shape for an error answer, in `contracts/errors/`. A validator checks them, a generator turns the list into Python and TypeScript constants, and the platform API answers its errors in that shape. Stream L's contracts already used about 45 placeholder codes and three different bodies; the registry keeps every one of their names so nothing breaks, and a change request lists what they change to match.

## Why
Sprint zero needs one registry and one body before contracts 2 to 6 are built on it (architecture 07 section 7.7, row 1). Tanmay's unmerged contracts named the registry as the place the final names are fixed (handoffs H-81 and H-91) and recorded the decision to adopt RFC 9457 as "awaiting Akshay" (ADR 0019, M1).

## What was built
- `contracts/errors/`: `error-codes.yaml` (48 codes in the families AUTH, ATT, EVT, INST, ORCH, REQ), `error-codes.schema.json`, `problem.schema.json`, 7 valid and 24 invalid example bodies with a manifest of the path where each invalid one must fail, and a README.
- `scripts/validate-errors.mjs`: registry schema and rules (sorted, unique, family listed, fixed ASCII titles with no placeholder or flag-like text, exit codes only on never-HTTP INST-INJECT codes), body schema, and every example against both.
- `scripts/generate-error-codes.mjs`: writes `packages/py-models/src/vulnmart_models/error_codes.py` (`ErrorCode`, `ERRORS`) and `packages/ts-client/src/error-codes.ts`; `--check` fails when either is stale. Both packages are new workspace members.
- `apps/api/src/vulnmart/problem.py`: answers unknown route (404), wrong method (405), invalid body (422 with a list of pointers) and unhandled error (500) in the contract format; `ProblemError(code)` lets route code raise a registry code.
- CI: `pnpm run errors:check`, an `api` job that now has the new package, and a step that builds the API image.

## How it works
The registry is the only place a code is defined. An error answer has the RFC 9457 members `type` (`urn:vulnmart:error:` plus the code), `title` (the registry's fixed text), `status`, plus `code`, `request_id`, and for a 422 `field` or `errors`. The schema is closed, and `detail` and `instance` are not used, so a path, a submitted value or an internal name cannot leak. A code whose status is null (for example the injector exit codes) never travels as an HTTP answer.

## Files changed
- `contracts/errors/*`, `contracts/CHANGELOG.md`, `docs/reviews/2026-10-11-if8-change-request-for-stream-l.md`
- `scripts/validate-errors.mjs`, `scripts/generate-error-codes.mjs` and their tests; `package.json` (`errors:check`)
- `packages/py-models/`, `packages/ts-client/` (new, generated constants), `pyproject.toml`, `uv.lock`
- `apps/api/src/vulnmart/problem.py`, `main.py`, `tests/test_problem.py`, `pyproject.toml`, `Dockerfile`, `Dockerfile.dockerignore`
- `scripts/e2e/platform-stack.e2e.test.mjs` (a test that error bodies pass through the web origin), `.github/workflows/ci.yml`
- `docs/bmad/initiative-platform/`: story plan with the review log, `deferred-work.md`

## Decisions made
No ADR: no architecture decision beyond the contract. By the developer on 2026-10-11: (1) the body follows RFC 9457 members plus our extensions (adopting stream L's decision M1); (2) the generated constants live in `packages/py-models` and `packages/ts-client`; (3) the seed keeps every name from stream L's branches and adds `REQ-INTERNAL`, with statuses and texts proposed for Tanmay to approve; (4) the API part is minimal handlers with `jsonschema` 4.26.0 as a dev dependency.

## Tests
All on the developer's Windows 11 PC, Docker 28.5.1, Node 24.11.0, uv 0.12.23, pnpm 12.10.1. Outputs in `docs/assets/p-02-error-registry/`.
- `pnpm run errors:check`: OK, 48 codes, 7 valid and 24 invalid example bodies; generated files current.
- `node --test "scripts/*.test.mjs"`: 89 pass (35 are the new validator and generator tests, including registries and examples broken on purpose).
- `uv run --frozen --package vulnmart-api pytest apps/api`: 81 passed (71 are new: every HTTP code builds a schema-valid body, never-HTTP codes are refused, unknown route, wrong method, invalid and non-JSON bodies, nested, escaped and over-long pointers, the 50-entry cap, 413, 415, the unmapped fallback, header handling, no echo of values or internals).
- `node --test "apps/*/test/*.test.mjs"`: 55 pass.
- `pnpm run test:e2e` (serial, real Docker): 27 of 27 pass, including a new test that an unknown route and a wrong method through the web origin return the IF-8 body.
- `tsc --strict` on the generated TypeScript: exit 0; loaded under Node in a test.
- `pnpm install --frozen-lockfile`, `uv lock --check`, `docker compose ... config -q`, `node scripts/verify-skills.mjs` (217 files): exit 0.
- NOT run: CI on the pull request (it runs after the push), Linux or macOS, stream L's own tests against the registry.
- Traceability row: PB-1 in `docs/traceability.md`.

## Evidence
`docs/assets/p-02-error-registry/`. Review log: Code Review section of the story plan; deferred items in `docs/bmad/initiative-platform/deferred-work.md`.

## Problems met and how they were fixed
- Stream L's branches hold three different body shapes and about 45 placeholder codes; the registry keeps all names and a change request lists the body change (their stories).
- A regex that collected code names missed single-word codes (`ORCH-BUSY`, `EVT-SCHEMA`); redone, then every ambiguous string was traced to where it is used (prefix, test value, base-class label, real code).
- A non-JSON body gave the pointer `/0` (FastAPI's location); fixed to the whole body with a fixed text.
- Independent code review (4 reviewers): 9 patch groups applied (unmapped framework statuses answered as 500, a way for route code to raise a registry code, over-long pointers, a loose pointer pattern, validator gaps, thin examples, hard-coded counts, README guidance, an image build in CI), 4 deferred, 13 rejected (details in the plan).

## Security notes (vulnerable parts only)
None; no vulnerable code. Error bodies never carry a submitted value, a path, a host, a key, a flag or a stack trace; a test posts a secret-looking value and checks it never comes back.

## Limitations and follow-ups
- Streams L and T still use their own bodies and placeholder names until their stories adopt IF-8 (`docs/reviews/2026-10-11-if8-change-request-for-stream-l.md`); Tanmay should review the statuses, titles and the `status: null` codes.
- Not in CI: the end-to-end test; a check of the registry against the instance contract and stream L's contracts; a type-check of the generated TypeScript. Registry gaps (generic rate-limit, unavailable, forbidden and sign-in failure codes, a `Retry-After` convention) wait for the stories that need them. All in `docs/bmad/initiative-platform/deferred-work.md`.
- Request IDs are generated per error answer until story 1.6 adds the middleware.
