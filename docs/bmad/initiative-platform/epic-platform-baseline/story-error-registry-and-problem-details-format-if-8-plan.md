---
title: 'Error registry and problem-details format (IF-8)'
type: 'feature'
ticket: '2'
created: '2026-10-11'
status: done
baseline_revision: '08b816e66b11254780c48a463e3b237f944001d3'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context:
  - '{project-root}/docs/architecture/07-repo-and-workstreams.md'
  - '{project-root}/docs/adr/0012-monorepo-and-contract-toolchain.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** IF-8, the error contract, does not exist. Stream L's unmerged contracts already use about 45 placeholder codes and three different error bodies (IF-2 and IF-5: `code`, `message`, `request_id`, `field`; IF-4: `type`, `title`, `status`, `code`, `message`, `request_id`, `errors`), and say the registry will fix the final names (handoffs H-81, H-91). Sprint zero needs one registry and one body before contracts 2 to 6 are built on it.

**Approach:** Add `contracts/errors/error-codes.yaml` (every code with its HTTP status, family, generic text and retry hint), a JSON Schema for the response body, examples, a validator with tests, a generator that writes Python and TypeScript constants, a CI check that the registry validates and the generated files are current, and a small API change so a real API error validates against the schema. The body follows RFC 9457.

## Boundaries & Constraints

**Always:** The registry is the one place a code is defined; adding a code is additive and renaming or removing one is breaking (`contracts/CHANGELOG.md` rule). Messages are generic and never repeat a submitted value; no stack trace, flag, secret or internal name in any body (NFR-SEC-03). Seed the registry with every code named in the merged contracts and in stream L's in-flight branches, with their names unchanged, so nothing of theirs breaks. Contract version 0.1.0 (`0.x` until `contracts-v1.0.0`).

**Decisions (developer, 2026-10-11):** (1) The body uses the RFC 9457 members `type`, `title`, `status` plus our extensions `code`, `request_id`, an optional `field` (one JSON Pointer) and an optional `errors` list for 422 with several problems; no `message`, `detail` or `instance`. This adopts stream L's recorded decision M1 and replaces the three current shapes. (2) The generated constants live in `packages/py-models` (a new uv workspace member) and `packages/ts-client` (a new pnpm package); the API imports the Python one. (3) The seed keeps every name from stream L's branches unchanged (confirming the five `INST-INJECT-*` placeholders), adds their generic `REQ-*` family and `REQ-INTERNAL` (500) for unhandled errors; statuses and texts are proposals for the owner to approve in the pull request. (4) The API part is minimal: a problem helper and handlers for unknown route, invalid body and unhandled error, with a request ID from `X-Request-ID` or generated until story 1.6, tested against the schema with `jsonschema` 4.26.0 as a dev dependency.

**Never:** No rewrite of stream L's or T's contracts, mocks or code (they migrate in their own stories; this story only gives them the target and the list of changes). No request-ID middleware, structured logging or settings (story 1.6). No platform-feature codes (`ORG`, `ASM`, `PRV`, accounts) beyond those already referenced: later stories add them by additive change. No new architecture decision beyond the contract itself.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid registry | the committed `error-codes.yaml` | validator exits 0 | None |
| Duplicate or malformed code | two entries with one code, or a code outside `FAMILY-NAME` form | validator fails, names the entry | Exit 1 |
| Unknown family or status | family not in the list, status outside 400 to 599 | validator fails | Exit 1 |
| Message echoes input | a text with a placeholder such as `{value}` or a flag-like string | validator fails | Exit 1 |
| Generated code stale | registry changed, generated files not | CI check fails with a diff hint | Exit 1 |
| API error | unknown route, invalid body, unhandled exception | body validates against the schema, carries the right code and a request ID, no internals | 500 never shows exception text |
| Example bodies | valid and invalid examples | valid pass, each invalid one fails at its expected path | As the IF-6 validator |

</frozen-after-approval>

## Code Map

- `contracts/errors/` -- empty (`.gitkeep`); stream P owns it (`CODEOWNERS`). New: `error-codes.yaml`, the body schema, `README.md`, examples. Consumers: all streams.
- `scripts/validate-contracts.mjs` -- pattern to copy (Ajv2020, `errorPath`, example manifest with expected error paths); `scripts/validate-catalog.mjs` -- the YAML variant (js-yaml 4.1.0). New: `scripts/validate-errors.mjs`, `scripts/generate-error-codes.mjs` and tests; add `errors:check` to `package.json`.
- `contracts/CHANGELOG.md`, `contracts/COMPAT.md` (not yet present) -- add the IF-8 0.1.0 entry.
- `contracts/instance/instance-contract.md` -- placeholder `INST-INJECT-*` names (exit codes 10 to 13); open-points rows 5 and 21 of `contracts/events/app-events.md` name P-02 as the decider. READ ONLY here.
- Stream L's branches `sprint-1-tanmay` and `shared-L-03` (read with `git show`): codes in `lab.openapi.yaml`, `lab-api.md` section 5, `orchestrator-api.md` section 6, `app-events.md`; ADR 0019 records decision M1 (adopt RFC 9457) as "awaiting Akshay".
- `apps/api/src/vulnmart/main.py` -- tracer app from P-01; add the problem helper and handlers here or beside it. `apps/api/tests/test_healthz.py` is the test pattern.
- `pyproject.toml`, `pnpm-workspace.yaml` -- uv and pnpm workspaces; the generated-code packages are `packages/py-models` and `packages/ts-client` (both empty).
- Seed codes found (about 45): AUTH (3), ATT (5), INST (11 including the five `INST-INJECT-*`, `INST-HEALTH-TIMEOUT`, `INST-LOST`), REQ (5 generic request errors), ORCH (15), EVT (5). Registry versions checked 2026-10-11: jsonschema 4.26.0 (Python), Ajv 8.20.0 (already pinned).

## Tasks & Acceptance

**Execution:**
- [ ] `contracts/errors/error-codes.yaml`, the body schema, `README.md`, `examples/` -- the IF-8 contract with the seed codes.
- [ ] `scripts/validate-errors.mjs` + tests, `package.json` -- validator for the registry, the schema and the examples.
- [ ] `scripts/generate-error-codes.mjs` + tests; `packages/py-models/` (pyproject, `src/vulnmart_models/error_codes.py`) and `packages/ts-client/` (package.json, `src/error-codes.ts`), generated -- one source, two languages; root `pyproject.toml`, lockfiles updated.
- [ ] `apps/api/` -- depends on `vulnmart-models`; problem helper and handlers for unknown route, invalid body and unhandled error; tests that validate real responses against the schema.
- [ ] `.github/workflows/ci.yml` -- run the validator and the generated-current check.
- [ ] `contracts/CHANGELOG.md` and `docs/reviews/2026-10-11-if8-change-request-for-stream-l.md` -- the body shape and the list of changes stream L and T must make (their stories, not this one).

**Acceptance Criteria:**
- Given the committed registry, when the validator runs, then it exits 0, and each broken fixture in the matrix fails with a specific message.
- Given the registry, when the generator runs, then the Python and TypeScript files contain exactly its codes, and the check fails if either is stale.
- Given the API, when a client calls an unknown route, sends an invalid body or triggers an unhandled error, then the answer validates against the schema with the right code, a request ID and no internals.
- Given the seed set, when compared with every code string in `origin/sprint-1-tanmay`, `origin/shared-L-03` and `main`, then none is missing.

## Implementation Notes

- Built directly in the main session (no implementer subagent). Found while building: Tanmay's branches already use 51 code-like strings; 48 are codes, `INST-INJECT` is a prefix, `ORCH-MYSTERY` a test value, `ORCH-ERROR` a base-class label. `REQ-INTERNAL` and `ORCH-INTERNAL` already exist in his mocks, so adding them matched his work. IF-4 uses a third body shape (with `message` and `errors` as `{path, message}`), which the change request covers.
- A first version of the 422 handling gave the pointer `/0` for a body that is not JSON (FastAPI reports `("body", 0)`); fixed to `""` with a fixed text.
- The API image now copies `packages/py-models` (Dockerfile and `.dockerignore`); the image was rebuilt and the full e2e suite run on the real engine, including a new test that an unknown route and a wrong method through the web origin come back in the IF-8 format.
- No ADR: no new architecture decision beyond the contract (the body-format choice adopts stream L's recorded decision M1).

## Plan Change Log

## Review Triage Log

## Code Review

### 2026-10-11 Code review complete. 0 `decision-needed`, 9 `patch`, 4 `defer`, 13 rejected.

Four independent reviewers (blind-hunter, edge-case-hunter, verification-gap, intent-alignment) read a 1,731-line diff of 48 files (lockfiles, generated constants and saved output excluded). Verdicts were rendered by the main session. The developer approved applying every patch in advance.

- [x] [Review][Patch] A framework `HTTPException` with a status other than 404, 405, 413 or 415 became a 500 `REQ-INTERNAL`, route code could not raise a registry code, and `Retry-After` and `WWW-Authenticate` were dropped; added `ProblemError(code)`, kept those headers, tested 413, 415 and the unmapped fallback [apps/api/src/vulnmart/problem.py]
- [x] [Review][Patch] A client-chosen key over 200 characters made a pointer that broke the schema; such a pointer is now `""`; nested, escaped, query-location, 50-entry cap and `json_invalid` cases are tested [apps/api/src/vulnmart/problem.py, apps/api/tests/test_problem.py]
- [x] [Review][Patch] The JSON Pointer pattern accepted a bare `~`; tightened to `~0` and `~1` only, with two invalid examples [contracts/errors/problem.schema.json]
- [x] [Review][Patch] The validator threw on an unparseable example, accepted `errors` or `field` on a non-422 body and both together, accepted an exit code on an HTTP code, did not enforce ASCII titles, and let a manifest `stage` typo pass [scripts/validate-errors.mjs]
- [x] [Review][Patch] A flag that needs a value and has none reported "Unknown argument" [scripts/validate-errors.mjs, scripts/generate-error-codes.mjs]
- [x] [Review][Patch] Thin examples: added valid 405 and not-JSON bodies and invalid status 600, illegal request ID, 51 errors, bad pointer escapes, `errors` or `field` on a non-422, and both together (now 7 valid, 24 invalid) [contracts/errors/examples/]
- [x] [Review][Patch] Tests hard-coded the counts 48, 5 and 16; they now derive them from the files [scripts/validate-errors.test.mjs]
- [x] [Review][Patch] README: guidance on which of the overlapping codes to use, how pointers and locations work, that `field` and `errors` are 422-only and exclusive, and an honest statement of where the request ID is logged today; change request gets a migration note and the PR number [contracts/errors/README.md, docs/reviews/]
- [x] [Review][Patch] The API image depends on the new package but CI never built it; CI now builds it [.github/workflows/ci.yml]
- [x] [Review][Defer] The end-to-end test is not run in CI — deferred: needs Docker in CI; the image build is now in CI.
- [x] [Review][Defer] Nothing compares the registry with the instance contract's exit-code table or with stream L's contracts after they merge — deferred: they match today by construction; a parse check is a follow-up.
- [x] [Review][Defer] Registry gaps (generic rate-limit, unavailable, forbidden and sign-in failure codes; `retryable` and `Retry-After` convention) — deferred: additive, with the stories that need them.
- [x] [Review][Defer] The generated TypeScript is not type-checked in CI (checked once with `tsc --strict`, exit 0) — deferred until `apps/web` imports it.

**Rejected**
- False: generated files and lockfiles missing from the diff: excluded from the review diff by me; both are in the tree and the frozen installs pass.
- False: the e2e `request_id` equality depends on unseen proxy behaviour: it ran green against the real proxy.
- Low, not worth fixing: the handler's own failure giving a plain-text 500; ruff line length (no ruff configured); `ORCH-STALE-EPOCH` versus `ORCH-STALE-ACCESS-EPOCH` and similar pairs (stream L's names, kept on purpose); the Node version note for type stripping (`.node-version` is 24.21.0); hard-coded counts in dated prose (changelog and README describe the 2026-10-11 seed); a request-ID header on responses (story 1.6); logging the request ID for 404, 405 and 422 (story 1.6); the retry hint not in the body (deferred above); unmapped 4xx answered as 500 (documented, and route code uses `ProblemError`).
- Accepted by design: stream L's contracts are not changed here (the intent-alignment audit confirms the diff implements "create the contract and its tooling" and defers adoption to their stories, listed in the change request); 42 of 48 codes are exercised only through the generic builder, because the platform has no endpoint that raises them yet.

## Design Notes

Keep the body small and closed (`additionalProperties: false`) so a field that could leak cannot be added silently. The generated constants are the only way application code names a code. Proposed body, for the owner to approve in review: `{"type":"urn:vulnmart:error:AUTH-SESSION-REQUIRED","title":"Sign in to continue.","status":401,"code":"AUTH-SESSION-REQUIRED","request_id":"..."}`; `title` is the registry's fixed generic text, `detail` and `instance` are not used so a path or value cannot leak.

## Verification

**Commands:**
- `node scripts/validate-errors.mjs` -- expected: exit 0
- `node scripts/generate-error-codes.mjs --check` -- expected: exit 0 (generated files current)
- `node --test "scripts/*.test.mjs"` -- expected: all pass
- `uv run --frozen --package vulnmart-api pytest apps/api` -- expected: all pass
- `pnpm install --frozen-lockfile` and `uv lock --check` -- expected: exit 0
