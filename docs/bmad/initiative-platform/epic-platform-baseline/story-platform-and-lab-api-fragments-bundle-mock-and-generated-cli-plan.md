---
title: 'Platform and lab API fragments, bundle, mock and generated clients (IF-1, IF-2)'
type: 'feature'
ticket: '4'
created: '2026-10-11'
status: 'built'
baseline_revision: '74df5328e30f14b2485d09437b99edb5541f3301'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/docs/architecture/07-repo-and-workstreams.md'
  - '{project-root}/docs/architecture/03-origins-and-access.md'
  - '{project-root}/contracts/api/lab/lab-api.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The dashboards cannot be built against the API: stream L's lab fragment (IF-2) exists alone, and the platform fragment (IF-1: accounts, sessions, consent, catalogue, attempts list, the live stream) does not. There is no bundle of the two, no mock that serves every route, and no typed client or Python models (P-07 and P-26 and the whole of sprint 2 wait on it; PB-3).

**Approach:** Author the platform fragment `contracts/api/platform/platform.openapi.yaml` with examples and text, write a bundle script that merges it with the lab fragment into `contracts/api/bundle/openapi.json` (reconciling shared schemas), add a mock that serves every example, generate the TypeScript client and the Python models from the bundle and commit them, and check all of it in CI, using the interface stream L's rules engine already expects (`pnpm run contracts:bundle:check`).

## Boundaries & Constraints

**Always:** The browser sees one origin and paths under `/api/v1/`, with the lab fragment's cross-cutting rules (session cookie `__Host-vm_session`, signed session-bound CSRF token in `X-CSRF-Token` plus the Origin check, JSON only, `Cache-Control: private, no-store`, a resource that is missing and one that is not yours give the same 404, UTC timestamps with `Z`). Errors use the IF-8 body and registry codes. Ids and state vocabularies are the ones of IF-2, IF-3 and IF-5. Every operation has an `operationId`, its error responses and at least one example. Internal routes (`/internal/v1/...`) are never in the browser bundle. No flag, secret, key or personal data in any example. The contract follows `contracts/registry.json` (entry, changelog, `registry change:` line).

**Decisions (developer, 2026-10-11):** (1) Scope: the sprint-2 slice of about 25 platform operations (public health; signup, email verification, login, logout, session and current user, password reset, multi-factor; consent and its record; the challenge catalogue; the list of my attempts; the live ticket, live stream and snapshot); organisations, assessments, invitations, exports, admin and the rest are added additively with their own stories. (2) The bundler is a small Node script (js-yaml): identical shared schemas are defined once, the IF-8 `Problem` is authoritative, the lab's differing definitions are kept under a `Lab` prefix and listed in a report for Tanmay; the bundle is validated with openapi-spec-validator. (3) The mock is a dependency-free Node server generated from the bundle. (4) Generated code: openapi-typescript 7.13.0 with openapi-fetch 0.17.0 into `packages/ts-client`, datamodel-code-generator 0.83.0 (Pydantic v2) into `packages/py-models`, committed with freshness checks. (5) The internal endpoints (`POST /internal/v1/events`, `POST /internal/v1/orch/state`, handoffs H-16 and H-17) stay in stream L's IF-5 and IF-4 files; IF-1 lists them in its README and the bundler fails when a browser fragment has an `/internal/` path. (6) Handoffs H-19, H-23, H-84 (as decision 2), H-85, H-86, H-87, H-88, H-89, H-90 and H-91 are confirmed as proposed and recorded in `HANDOFFS.md`; H-12, H-13, H-14 and H-20 (orchestrator call behaviour) stay open for P-05.

**Never:** No FastAPI route implementation (P-06 and later). No edit to stream L's lab fragment, examples or mock (a needed change goes to Tanmay by pull request). No deployment or Vercel configuration. No decision of an open question (OI-xx) that a route depends on: the route is marked pending with both outcomes, as the lab file does.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Bundle | the two fragments | one valid OpenAPI 3.1 file, deterministic, every `$ref` resolved, `operationId`s unique | Fails naming the clash |
| Shared schema, identical | both fragments define a component with the same content | defined once | None |
| Shared schema, different | e.g. lab `Problem` and platform `Problem` | the platform (IF-8) definition is authoritative; the lab's differing one is kept under a `Lab` prefix and listed in the bundle report | Reported, not silent |
| Stale bundle | a fragment changed, the committed bundle did not | `contracts:bundle:check` exits 1 | Names the difference |
| Mock | every operation of the bundle | answers its example with the declared status and validates against its schema | Unknown route: IF-8 404 |
| Internal route | a `/internal/` path in a fragment | the bundle fails | Exit 1 |
| Generated code | the bundle | the TypeScript client compiles with `tsc --strict`; the Python models import | CI fails when a generated file is stale |
| Auth rules | a state-changing route without the CSRF and session requirement | validator fails | Exit 1 |

</frozen-after-approval>

## Code Map

- `contracts/api/lab/lab.openapi.yaml` (18 operations, `/api/v1/...`, components `Problem`, `ProblemCode`, `ErrorCode`, `Cursor`, `Timestamp` and the shared vocabularies), `lab-api.md` (scope, role table, cross-cutting rules, 30 open points), `examples/`, `contracts/mocks/fake-lab/server.mjs`, `scripts/check_lab_contract.py` and its tests: stream L's, read only. They are the pattern for fragment, examples, checker and mock.
- `contracts/api/platform/` and `contracts/api/bundle/` are empty (`.gitkeep`); `contracts/registry.json` lists `contracts/api/platform` as reserved and `contracts/api/bundle` as generated; stream L's checker runs `pnpm run contracts:bundle:check` and expects `contracts/api/bundle/openapi.json`.
- `docs/dev/HANDOFFS.md` H-12 to H-14, H-16, H-17, H-19, H-20, H-23, H-84 to H-91 (rows for this task), `docs/dev/messages/2026-10-11-if2-changes-for-akshay.md` (IF-2 0.2.0: RFC 9457 problems, cursor paging, `has_more`, `att_gone`).
- `contracts/errors/` (IF-8), `contracts/domain-events/` (IF-3), `contracts/catalog/challenge.schema.json` and `challenges/catalog/` (IF-7 content for the catalogue route), `docs/architecture/03-origins-and-access.md` (cookies, CSRF, the one-time ticket), `04-data-and-state.md` (attempt and account states).
- `packages/ts-client/` (holds `src/error-codes.ts`) and `packages/py-models/` (holds `error_codes.py`): where the generated client and models go. `.github/workflows/ci.yml` job `scripts`, `scripts/ci-linux.mjs` and its test.
- Tools checked 2026-10-11: openapi-typescript 7.13.0 and openapi-fetch 0.17.0 (MIT), @hey-api/openapi-ts 0.99.0 and orval 8.41.0 (need Node 22.18 or newer), @redocly/cli 2.62.1, @stoplight/prism-cli 5.16.0 (needs Node 24.18 or newer: the repository pins 24.21.0, this PC has 24.11), datamodel-code-generator 0.83.0, openapi-spec-validator 0.9.0 (already a dev dependency).
- Requirements: FR-ACC-01 to 11, FR-PRV-01 to 03, 13, FR-LIV-04, 05, FR-DSH, FR-ORG, FR-ASM, FR-EXP, FR-ADM (by slice, see decisions); PB-3; NFR-SEC-03, NFR-MNT-02.

## Tasks & Acceptance

**Execution:**
- [x] `contracts/api/platform/`: `platform.openapi.yaml`, `platform-api.md`, `examples/valid` and `examples/invalid`, shared definitions; the handoff answers recorded.
- [x] `scripts/bundle-openapi.mjs` + tests: merge, reconcile, report, deterministic output; `contracts/api/bundle/openapi.json` and a bundle report; `package.json` scripts `contracts:bundle` and `contracts:bundle:check`.
- [x] `scripts/check_platform_contract.py` (Python, matching the lab checker; `apps/api/tests/test_platform_contract.py`) + tests: structure, every operation has id, errors and example, the auth rules, no internal route, examples validate against their schemas.
- [x] The mock under `contracts/mocks/` + tests: every operation of the bundle answers its example.
- [x] Generated TypeScript client in `packages/ts-client/` and Python models in `packages/py-models/`, generation scripts with `--check`, tests that the client compiles and the models import.
- [x] `contracts/registry.json`, `contracts/CHANGELOG.md`, `.github/workflows/ci.yml`, `scripts/ci-linux.mjs`, `docs/dev/HANDOFFS.md`, `docs/architecture/07-repo-and-workstreams.md` (tool names confirmed).

**Acceptance Criteria:**
- Given the fragments, when `pnpm run contracts:bundle` runs, then `contracts/api/bundle/openapi.json` validates as OpenAPI 3.1 and `pnpm run contracts:bundle:check` exits 0; given a changed fragment and a stale bundle, it exits 1.
- Given the mock, when every operation of the bundle is called, then each answers its example with the declared status and the body validates against its schema.
- Given the generated files, when CI runs, then the TypeScript client compiles under `tsc --strict`, the Python models import, and a stale file fails the check.
- Given stream L's rules engine (`node scripts/check-contract-rules.mjs`), then it passes with IF-1 registered and the bundle present.

## Implementation Notes

- Built directly in the main session (developer's choice, 2026-10-11). Fragment: 25 operations on 21 paths; bundle: 43 operations, 9 lab components renamed `Lab*`, 10 shared.
- The validator for IF-1 is Python (`scripts/check_platform_contract.py`), like the lab's, not `validate-platform-api.mjs`: it needs openapi-spec-validator and jsonschema, both already in the workspace.
- IF-8 grew from 49 to 54 codes (registry 0.2.0) for routes of this fragment. The rules engine cannot compare `error-codes.yaml`, so the changelog entry carries a `BREAKING:` line that says it is only the engine's safe-side declaration (verified by hand: 5 added, 0 changed).
- Generated Python models map an e-mail address to a plain string (email-validator refuses `.test`, `.local`, `.invalid`), so `format: email` and `minProperties` are enforced by the bundle, not by the models.
- Found by the tests while building: a validator crash on an exception without text (`first_line`), a 401 with two causes (`SessionOrPasswordFailed`), a named-example fallback in the mock.
- Not run here: CI on a pull request; Prism (replaced by the Node mock); the Linux container run of `pnpm run ci:linux` (Docker steps were run for earlier tasks, not for this one).
## Plan Change Log

## Review Triage Log

## Design Notes

Proposed operations of the slice (to refine while authoring, reviewed in the pull request): health `GET /api/v1/health`; accounts `POST /api/v1/accounts`, `POST /api/v1/accounts/verify-email`, `POST /api/v1/accounts/verify-email/resend`; session `POST|GET|DELETE /api/v1/session`, `POST /api/v1/session/mfa`; account self-service `GET|PATCH /api/v1/me`, `POST /api/v1/me/password`, `POST /api/v1/me/mfa` and `/confirm`; password reset `POST /api/v1/password-reset/request` and `/confirm`; consent `GET /api/v1/consent/notice`, `POST /api/v1/consent`, `GET /api/v1/me/consents`; catalogue `GET /api/v1/challenges` and `/{challenge_key}`; attempts `GET /api/v1/me/attempts`; live `POST /api/v1/live/ticket`, `GET /api/v1/live` (SSE, IF-3 events), `GET /api/v1/live/snapshot`. Anything that depends on an open question (OI-10, OI-15, OI-22, OI-27, OI-37) is marked pending with both outcomes.

Assumption to confirm in review: the browser path `/api/v1/...` reaches the API unchanged (the rewrite keeps the `/api` prefix), so FastAPI routes match the bundle exactly (architecture 07 section 3.4); P-01's rewrite strips `/api` and changes in P-06 and P-07, with a public `GET /api/v1/health` for the dashboards skeleton.

## Verification

**Commands:**
- `pnpm run contracts:bundle:check` -- expected: exit 0
- the validator for IF-1, the mock tests, the generation checks -- expected: pass
- `node --test "scripts/*.test.mjs"` -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
- `uv run --locked --package vulnmart-api pytest -q` and `pnpm run contracts:check` -- expected: pass

## Code Review

### 2026-10-11
Code review complete (4 lenses: blind-hunter, edge-case-hunter, verification-gap, intent-alignment). 3 `decision-needed` (all resolved), 10 `patch` (all applied), 5 `defer` (+1 from the decisions), 13 rejected.

- [x] [Review][Decision] Rate limit (429) on the authenticated routes that verify a secret or write: `confirmMfaEnrolment` (6-digit code), `disableMfa` (password), `recordConsent`, `updateMe` declare no 429; only `changePassword` does, and the checker forces 429 only on public routes. Resolved by the developer 2026-10-11: add 429 to all four, and the checker requires it on every authenticated state-changing route with a body. Applied.
- [x] [Review][Decision] The shared 409 `Conflict` answer uses `ATT-INVALID-STATE` for non-attempt conflicts (MFA already active, admin cannot turn MFA off, stale consent notice), and `NotFound` has only the `ATT-NOT-FOUND` example (so `Prefer: code=404` on `getCatalogueChallenge` says "Attempt not found"). New registry codes (IF-8 0.3.0) or keep and document. Resolved by the developer 2026-10-11: new codes `AUTH-MFA-STATE` and `ATT-CONSENT-STALE` (IF-8 0.3.0), route-specific 409 answers, `ChallengeNotFound` for the catalogue. Applied.
- [x] [Review][Decision] `has_more` is true on `listMyAttempts` and `listMyConsents` but no cursor parameter exists, so a caller with more than `limit` (maximum 100) records cannot read the rest; `LiveSnapshot` arrays have no bound or `has_more`. Add a cursor now or accept for the slice. Resolved by the developer 2026-10-11: accept for the slice; open point 15 of `platform-api.md`. Deferred, not applied.
- [x] [Review][Patch] The cosmetic-key filter (`title`, `description`, `example`, `examples`) also drops schema members of those names under `properties` (Problem has a `title` member), so drift passes the "Problem equals IF-8" check and the bundler's equality [scripts/check_platform_contract.py:same, scripts/bundle-openapi.mjs:sameIgnoringCosmetics]
- [x] [Review][Patch] Bundler: fail when the two fragments' top-level `security` or `servers` differ (lab operations would silently inherit the platform default), when a `Lab<Name>` target already exists, and when a security scheme would be renamed (requirements name it, not `$ref`) [scripts/bundle-openapi.mjs:bundleFragments]
- [x] [Review][Patch] `check_bundle` compares counts, not identity (a swapped operation passes), and `main` loads the bundle and report outside the `try` [scripts/check_platform_contract.py:check_bundle, main]
- [x] [Review][Patch] Checker robustness: `int(status)` crashes on `default` or `4XX` with problem+json; `check_stream` crashes on non-object data, loses multi-line `data:` and misreads `data:{...}` without a space; malformed example JSON raises a traceback; `/api/v1/internal` (no slash) and `/Internal` pass the internal-route test (checker and bundler); dead assignment in `validator_for` [scripts/check_platform_contract.py]
- [x] [Review][Patch] The checker does not enforce `application/problem+json` on 4xx and 5xx answers (an `application/json` or empty error answer passes) nor the `Cache-Control` value `private, no-store`; two tests assert only "some problem" (unknown code, missing Problem) [scripts/check_platform_contract.py, apps/api/tests/test_platform_contract.py]
- [x] [Review][Patch] Mock: a wrong Origin on `createSession` answers the `AUTH-EMAIL-NOT-VERIFIED` example; `Prefer: example=mfa_required` still sets the session cookie; `ajv.compile` runs per request on a fresh object; the request handler has no try/catch [contracts/mocks/platform-mock/server.mjs]
- [x] [Review][Patch] No runtime test of the client: `X-CSRF-Token` on unsafe methods only, `credentials: 'include'`, `isProblem` (tsc compiles even if the middleware is deleted or inverted) [packages/ts-client/src/index.ts, packages/ts-client/test]
- [x] [Review][Patch] `generate-api-code.mjs` says it checks the bundle first but only tests that the file exists [scripts/generate-api-code.mjs:run]
- [x] [Review][Patch] `pnpm run contracts:check` (the documented local gate) does not run the IF-1 checker; move it from `api:check` into `contracts:check` [package.json]
- [x] [Review][Patch] Documentation: the mock is not "dependency-free" (ajv, ajv-formats, js-yaml); open point 3 says architecture 07 "still says Prism" (it was updated); machine-specific Node text in a contract file; `--origin http://localhost:3000` is needed for a local dashboard and is not documented, nor that `Prefer: code` skips the cookie, CSRF and Origin checks, nor the `Secure` cookie over plain http; malformed `Last-Event-ID` has no stated answer (IF-3: one `stream.resync`); `GET /challenges` takes no `limit`; email normalisation, idle-timer extension and `DELETE /me/mfa` with a body are not stated; the lab errors are not `Problem` (`isProblem`); CHANGELOG says CSRF on "unsafe methods" and `no-store` only for session data, both narrower or wider than `platform-api.md` [contracts/api/platform/platform-api.md, contracts/CHANGELOG.md, contracts/mocks/platform-mock/server.mjs]
- [x] [Review][Defer] Lab operations are proxied to the fake lab, and the mock tests check them only for reachability; the plan's acceptance criterion says every operation of the bundle answers its example [contracts/mocks/platform-mock/server.mjs] — deferred: stream L's `test_lab_contract.py` already validates the fake lab's answers against IF-2; a bundle-level comparison is a later hardening
- [x] [Review][Defer] The mock does not validate path, query and header parameters (`limit=1000` gives 200, not 422) [contracts/mocks/platform-mock/server.mjs] — deferred: the mock answers declared examples; parameter validation is added when P-07 needs a failure path
- [x] [Review][Defer] No account-deletion or email-change route in IF-1 — deferred: later stories (FR-PRV, P-25); listed as open point 14 for email change
- [x] [Review][Defer] The client has no helper for `/live` (reconnect, `Last-Event-ID`, `stream.resync` then snapshot) — deferred: written with the dashboards (P-07)
- [x] [Review][Defer] The client does not throw when an authenticated write has no CSRF token — deferred: the server answers `AUTH-CSRF-FAILED`; a client-side policy is a dashboards decision (P-07)

**Rejected:**
- Lab operations are not covered by the platform rule checks (auth, cache, examples): the lab's own checker (`check_lab_contract.py`) covers them.
- CHANGELOG bullets joined on one line: false, the two bullets are on separate lines.
- Lock files, generated files and examples missing from the diff: they were excluded from the review diff on purpose and are committed.
- `uv.lock` and `pnpm-lock.yaml` not updated: false, both are updated (frozen install passes).
- `Prefer: example=UNKNOWN` falls back to the default answer: intended (an operation without that example answers its default).
- Route shadowing by a templated sibling: no literal route has a templated sibling in the bundle.
- Lab request over 64 KiB or non-UTF-8 forwarded truncated, aborted SSE leaves upstream open: low, a test aid.
- Only SIGINT handled, the lab child can outlive: low, a developer tool run in a terminal.
- Dead `continue` in the mock test: cosmetic.
- Hard-coded counts (25 operations) in tests and prose: low; a new route makes the test fail loudly, which is the point of a contract test.
- CI duplication of the generation check (`scripts` tests and `api:check`): low; restructuring costs more than it saves.
- Temp directories not removed by two tests; `junction` link type: low, harmless on Linux.
- Free-text `rule` match in `check_api_models.py`; proxied lab answers' `Cache-Control`; the story file's blank line, empty review fields and file name: cosmetic or not defects.
