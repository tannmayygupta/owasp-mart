---
title: 'Lab fragment of the platform API (IF-2)'
type: 'feature'
ticket: '9'
created: '2026-10-09'
status: done
baseline_revision: 'f76f76d53d6ee614946a3dfaf8c66e579f04a8e6'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context: []
assignee: "tannmayygupta"
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Akshay's dashboards (P-04) must be built against the browser-facing lab API, but IF-2 does not exist: `contracts/api/lab/` is empty and the docs disagree on paths and on who owns hints, reports and attempt routes.

**Approach:** Author IF-2 as one OpenAPI 3.1 fragment `contracts/api/lab/lab.openapi.yaml` with contract text, examples, a conformance check and a dependency-free Node mock that answers every operation, consistent with IF-5 (handoff H-78). Draft status: a proposal for Akshay, review optional (D-37).

## Boundaries & Constraints

**Always:** Decisions confirmed by the developer on 2026-10-09: every route under `/api/v1/`; mock is a Node fake with no dependency (not Prism); scope is lab-owned routes only; the attempt start route is included and marked pending OI-22. Instance states, access and health are exactly those of IF-5 (10 states; `open`, `frozen`, `closed`; `unknown`, `healthy`, `unhealthy`). Browser auth model: `__Host-` session cookie, CSRF header, Origin check, JSON only, `Cache-Control: private, no-store`, problem+json errors with `code`, `message`, `request_id`, `field` on 422. Missing and not-yours answer the same 404. No answer shows a flag, decoy, digest, seed, event key, owner hash, orchestrator URL, host id or stack trace, and the submitted flag text is never echoed or stored. Placeholder `ATT-*`, `INST-*`, `AUTH-*` codes until the registry (IF-8, P-02). Undocumented cross-cutting rules (CSRF header name, pagination, idempotency key, time format, id shapes) are written as proposals in the open-points table, none presented as decided. Real commands and results only.

**Never:** No change to IF-1, IF-4, IF-5 or IF-6 meaning; no platform (P-owned) routes: login, orgs, assessments, invitations, consent, create-attempt-from-consent, cancel, withdraw, purge, exports, admin, live stream and live ticket (listed as handoff rows). No server code beyond the mock; no new dependency; no Prism. No decision on OPEN items OI-14, 15, 21, 22, 23, 24, 25, 26, 27, 38: record both outcomes. No bundle script (P-04's).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Read as owner | Valid session cookie, own attempt or instance | 200 example answer in the schema | No error expected |
| No session | No cookie | 401 `AUTH-*` | problem+json |
| State change without CSRF or wrong Origin | POST without header, or other Origin | 403 `AUTH-*` | problem+json, nothing changed |
| Not yours or missing | Other user's id, unknown id | the same 404 for both | no leak of existence |
| Flag submit | correct, wrong, decoy, other_instance, stale_epoch inputs | 200 with that `result`; flag text never echoed | — |
| Flag rate limit | more than 5 wrong in 10 min for one challenge | 429 with `Retry-After` | problem+json |
| Hints off | attempt with hints mode off | list and unlock refused (404) | problem+json |
| Wrong state | submit or reset when attempt or instance state forbids it | 409 `ATT-*` or `INST-*` | problem+json |
| Reset | ready instance | 202, epoch + 1, state `resetting` | 409 otherwise |
| Open ticket | ready instance | 200 with one-time URL and expiry | 409 not ready |
| Bad body | extra, missing or wrong-type field | 422 with `field` pointer | problem+json |
| Unknown path or method | any | 404 or 405 with `Allow` | problem+json |
| Secret in an answer | any GET schema or example holding a secret name | the check fails | exit 1 |

</frozen-after-approval>

## Code Map

- `contracts/orchestrator/orchestrator.openapi.yaml`, `orchestrator-api.md`, `examples/` (valid, invalid, `manifest.json`) -- conventions to copy: info block with DRAFT note, `components.{parameters,responses,schemas}`, `Problem`, `ErrorCode`, `InstanceId`, `State`, `Access`, `Health`, `Cursor`, `ChallengeKey`, closed schemas, open-points table.
- `scripts/check_orchestrator_contract.py` and `apps/api/tests/test_contract.py` -- pattern for the fragment check (openapi-spec-validator, jsonschema 2020-12, manifest paths, secret-name walk, fake-flag scan); wired in `package.json` `contracts:check` and `.github/workflows/ci.yml` (do not edit the workflow).
- `contracts/mocks/fake-orchestrator/server.mjs` -- Node ESM mock pattern (`node:http`, first stdout line `{"listening":true,"port":N}`, `--port`, bounded body, 405 with `Allow`).
- `contracts/api/lab/` (only `.gitkeep`) -- target folder; `contracts/api/platform/` and `bundle/` are P-04's, untouched.
- `docs/architecture/07-repo-and-workstreams.md` s3.1, s3.4, s3.5; `03-origins-and-access.md` (cookies, CSRF, ticket); `04-data-and-state.md` s2.5, 2.6, 10, 11; `05-key-flows.md`; PRD FR-SES, FR-INS, FR-FLG, FR-HNT, FR-ACH, FR-DSH, FR-DET -- sources for endpoints and enums. The citation "arch 07 s3.3" for IF-2 is stale (s3.1 and s3.4 are right).
- `docs/dev/HANDOFFS.md` -- H-78 (answer it), H-17 (P-04: internal endpoints), H-79 and H-06 (ports), H-12 to H-23 background; new rows for Akshay are added.
- Do not touch: other developers' tracker folders, IF-1/4/5/6 files, `.github/workflows`.

## Tasks & Acceptance

**Execution:**
- [x] `contracts/api/lab/lab.openapi.yaml` -- OpenAPI 3.1 for: instances (request, get, open ticket, reset, stop), attempts (get, start pending OI-22, submit), flag submit, score, challenges, hints (list, unlock), evidence, integrity flags with review decisions, per-candidate report, timeline; shared schemas and enums with sources; cookie and CSRF security scheme -- the contract
- [x] `contracts/api/lab/lab-api.md` -- prose: scope and ownership table, enums, auth and cross-cutting rules, error placeholders, forbidden fields, what is not here (P-owned routes), open-points table with proposals -- readable contract
- [x] `contracts/api/lab/examples/{valid,invalid}/` with `manifest.json` files -- one valid answer per operation and error, many invalid ones with expected JSON Pointer -- proof and mock data
- [x] `scripts/check_lab_contract.py` and `package.json` (`contracts:check`) -- validate the file, examples, operation set, secret-name and fake-flag rules; run with the other checks -- guard
- [x] `contracts/mocks/fake-lab/server.mjs` -- Node mock: every operation, cookie, CSRF and Origin checks, ownership 404, flag results by input, rate limit 429, state rules -- UI can be built now
- [x] `apps/api/tests/test_lab_contract.py` -- every mock answer validates against the OpenAPI response schemas; the matrix rows; checker negative tests (secret name added, operation removed) -- conformance
- [x] `scripts/e2e/lab.e2e.test.mjs` -- independent Node consumer drives the mock process over HTTP -- black-box check
- [x] `contracts/CHANGELOG.md`, `docs/dev/HANDOFFS.md` (answer H-78; rows for Akshay: layout and bundling, enums and codes, P-owned routes, OI-22, cross-cutting proposals; row for L-08 if needed), `initial.md` D-39 and `docs/adr/0019-lab-api-conventions.md` (route prefix, Node mock instead of Prism, scope; research sources) -- records
- [x] Documentation rule -- dev-log, CHANGELOG, traceability LB-9 and decisions, evidence in `docs/assets/l-05-lab-api/`; tick L-05 only after the developer confirms

**Acceptance Criteria:**
- Given the fragment and examples, when `pnpm run contracts:check` runs, then it passes, and fails when a secret name is added to a GET answer or an operation is removed.
- Given the mock, when each operation is called as in the matrix, then every answer validates against the OpenAPI schema and carries no secret.
- Given IF-5, when states, access and health are compared, then the values are identical.
- Given the repository, when searched, then no real-looking flag exists and no dependency was added.
- Given the handoff rows, when Akshay's Claude plans P-04, then the layout proposal, P-owned list and open points are there with defaults.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Pass 1 (2026-10-09, thorough, four lenses). About 55 findings from Blind Hunter (15), Edge Case Hunter (24), Verification Gap (2 gaps and 3 others) and Intent Alignment (descriptive). Verdict counts: medium 8, low 17, false 6, maybe-false 0. No intent_gap or bad_plan.

| Finding | Verdict | Route | Evidence |
|---|---|---|---|
| Mock session lookup accepts prototype keys as a signed-in user (Blind, Edge) | medium | patch | `USERS[cookie]` on an object literal; fixed with `Object.hasOwn`. |
| Reset or stop of a frozen instance accepted; timer reopens access after submit (Edge, Blind) | medium | patch | The reset checks only instance state; contradicts the freeze in the contract; fixed in the mock plus a test. |
| Owner of a learner attempt can decide integrity flags although the table says no (Blind) | medium | patch | Mock and table disagree; mock made to refuse, test added. |
| 422 test pointer assertion is always true; exact `field` not asserted for confirm, kind, decision, note (Verification, Blind, Edge) | medium | patch | `startswith(("/", ""))` is true for every string; exact field per row added. |
| Secret-name check covers GET answers only; missing enum compares None with None; non-string manifest value aborts the run (Blind, Edge) | medium | patch | Checker extended to all answer schemas, missing enum fails, bad manifest value reported. |
| Malformed percent-encoding gives an undeclared 500; CSRF compare can throw (Edge, Blind) | medium | patch | Both answered as 404 and 403. |
| Documented check order differs from the mock (413 first) (Blind) | medium | patch | Text changed to match IF-5 (oversize body refused first). |
| H-78 marked done though codes are placeholders; duplicate LB-5 traceability row; changelog spacing; dev-log base commit and files list (Blind) | low | patch | Real documentation errors; corrected. |
| Evidence `path` redaction, missing rate limits for other operations (Blind) | low | patch | Added as open points, not decided. |
| ADR 0019 external sources not read this session (Blind) | low | defer | Honestly labelled unverified; read the sources before accepting the ADR. |
| Node e2e test and mock-vs-spec drift not covered by `contracts:check` or CI (Verification, Blind) | medium | defer | Pytest covers the mock in CI; add the e2e file to CI with the contract CI story (1.6). |
| Duplicate timeline rows on repeated correct flags; deciding one held flag clears the others; hint level order; cursor format; query parameters ignored on other GETs; listen error; checker scope of fake-flag scan; Request suffix naming; e2e order dependence; loose count thresholds; header loop; 413 test swallows reset (Edge, Verification, Blind) | low | defer | Mock-only edge cases or test hardening; recorded in deferred work. |
| Submissions list never pruned (Edge) | false | none | In-memory test mock restarted per run. |
| Fake flag scan misses mock and tests (Edge) | false | none | A separate pytest scans `server.mjs`. |
| Sixth correct flag refused with 429 (Edge) | false | none | Matches the 5 wrong then lock rule (PRD FR-ACH-01). |
| Unauthenticated callers can probe routes (Edge) | false | none | Routing before auth is normal; ids are not leaked. |
| Intent: the mock carries rules the OpenAPI cannot express; IF-5 consistency checked for 3 enums; the docs disagreement is recorded, not edited (Intent) | false | none | Descriptive; the rules are proposals in the open points and D-39, matching the plan. |
## Design Notes

Ownership rule used: a route is lab-owned when it reads or changes the tables the lab owns (attempts runtime, instances, milestones, flag submissions, hints, evidence, integrity flags, scores) per architecture 07 s5; consent, invitations, cancel, withdraw, purge, exports and live stream are P. The mock keeps a small in-memory state per test session and is reset by restarting it.

## Verification

**Commands:**
- `pnpm run contracts:check` -- expected: PASS for all four contracts
- `uv run --locked --package vulnmart-api pytest -q` -- expected: all pass, none skipped
- `node --test "scripts/e2e/lab.e2e.test.mjs"` -- expected: all pass
- `node --test "scripts/*.test.mjs"` -- expected: 82 pass
- `git grep -n "VM{" -- contracts/api contracts/mocks/fake-lab` -- expected: only obviously fake test flags
