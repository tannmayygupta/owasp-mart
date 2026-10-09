# L-05: Lab fragment of the platform API (IF-2) with a mock (story 1.9)

| Field | Value |
|---|---|
| Date | 2026-10-09 |
| Developer | tannmayygupta |
| Branch / commit | sprint-1-tanmay, started from HEAD 3a08d3a (the plan's `baseline_revision` is f76f76d, an earlier commit made before the plan was approved); not committed and not pushed when this entry was written |
| Status | Done in code and tests; not closed: the developer has not yet confirmed, L-05 is not ticked in `dev1-tanmay.md`, the story is not marked done, and the CI run on GitHub has not happened |
| Report tag | contracts, IF-2, OpenAPI, mock, handoff, sprint 1 |

## Requirements covered
IF-2 (arch 07 s3.1, s3.4; the citation "arch 07 s3.3" is stale), traceability LB-9, FR-SES-01/02/05/09, FR-INS-01/04/07, FR-FLG-05/08, FR-HNT-01/02, FR-ACH-01/06/07, FR-SCR-09/10, FR-DSH-01/02/06, NFR-SEC-03, D-37, D-39 (new), handoff H-78 (answered) and the new H-84 to H-89. Open items kept open with both outcomes written: OI-14, 15, 21, 22, 23, 24, 25, 26, 27, 38.

## Summary (plain language)
The dashboards now have a written contract for the lab routes (instances, attempts, flags, hints, score, evidence, integrity flags, report, timeline) and a fake server that answers all of them, so Akshay can build against it today. A check fails if a secret-looking name appears in a read answer or an operation disappears. Everything the architecture did not fix is a proposal in a table, not a decision.

## Why
P-04 (Akshay) needed IF-2 and it did not exist: the folder was empty and the documents disagreed on paths and owners. Handoff H-78 asked that it agree with IF-5.

## What was built
- `contracts/api/lab/lab.openapi.yaml`: OpenAPI 3.1, 18 operations under `/api/v1/`, cookie and CSRF security schemes, closed answer schemas, problem+json errors, `Cache-Control` and `Retry-After`/`Allow` headers.
- `contracts/api/lab/lab-api.md`: scope and ownership tables, shared enums, cross-cutting rules, behaviour of each route, placeholder error codes, what is not here, 30 open points.
- `contracts/api/lab/examples/`: 38 valid and 82 invalid examples with manifests (each invalid one names its expected JSON Pointer).
- `scripts/check_lab_contract.py` (reuses the helpers of the IF-5 checker), added to `package.json` `contracts:check`.
- `contracts/mocks/fake-lab/server.mjs`: Node mock, no dependency.
- `apps/api/tests/test_lab_contract.py` (83 tests after the review fixes) and `scripts/e2e/lab.e2e.test.mjs` (12 tests).
- Records: `contracts/CHANGELOG.md`, `docs/dev/HANDOFFS.md` (H-78 answered, H-84 to H-89 added), `initial.md` D-39, ADR 0019, `CHANGELOG.md`, `docs/traceability.md` LB-9.

## How it works
A route is lab-owned when it reads or changes lab tables. The file copies the instance states, access and health of IF-5 word for word and the checker compares them. The mock decides the check order: route, session (401), Origin and CSRF (403), content type and size, lookup and ownership (404), body shape (422), state (409), rate limit (429). Missing and not-yours give the same 404. The flag text is compared and dropped; only the result is kept. Four fake flags (one repeated letter) decide the result in the mock; anything else is wrong.

## Files changed
- `contracts/api/lab/lab.openapi.yaml`, `lab-api.md`, `examples/valid/*` and `examples/valid/manifest.json`, `examples/invalid/*` and `examples/invalid/manifest.json` (new)
- `contracts/mocks/fake-lab/server.mjs` (new)
- `scripts/check_lab_contract.py` (new), `package.json` (one script extended; no dependency added)
- `apps/api/tests/test_lab_contract.py`, `scripts/e2e/lab.e2e.test.mjs` (new)
- `contracts/CHANGELOG.md`, `CHANGELOG.md`, `docs/dev/HANDOFFS.md`, `initial.md`, `docs/adr/0019-lab-api-conventions.md`, `docs/adr/README.md`, `docs/traceability.md`, `docs/assets/l-05-lab-api/*`

## Decisions made
D-39 and ADR 0019: `/api/v1/` prefix, Node mock instead of Prism, lab-owned routes only, start route pending OI-22 (all four confirmed by the developer on 2026-10-09, per the story plan). Alternatives are in the ADR.

## Tests
Real commands and results (this machine, 2026-10-09):
- `pnpm run contracts:check`: all parts PASS; last lines `lab contract: checked 18 operations, 38 valid and 82 invalid examples` and `lab contract: PASS`.
- `uv run --locked --package vulnmart-api pytest -q`: `317 passed in 125.71s` (62 of them in `test_lab_contract.py`; none skipped). This full run was made before the review fixes below; after them only the lab file was run again: `pytest -q apps/api/tests/test_lab_contract.py` gave 83 passed, and `node --test scripts/e2e/lab.e2e.test.mjs` 12 of 12; the full suite and the other commands are to be re-run by the coordinator.
- `node --test "scripts/e2e/lab.e2e.test.mjs"`: 12 tests, pass 12, fail 0 (run five times in a row after the fix below, all green).
- `node --test "scripts/*.test.mjs"`: 82 tests, pass 82.
- `git grep --no-index -n "VM{" -- contracts/api contracts/mocks/fake-lab`: only the repeated-letter fake flags in two examples and the mock source. `git diff` shows no change to a lockfile or dependency list.
Traceability row: LB-9. Outputs: `docs/assets/l-05-lab-api/`.
Not run: the GitHub CI (needs the pull request); no test of the workflow file (not edited).

## Evidence
`docs/assets/l-05-lab-api/` (contracts-check.txt, lab-e2e.txt, pytest-full.txt, unit-tests.txt, flag-grep.txt).

## Problems met and how they were fixed
- First negative test (add an operation) failed because the added path had an unresolved path parameter; used a path without one.
- A test of "second reset while resetting" was timing-dependent (the mock reached `ready` before the second call): it failed once in the full Python run. Fixed by testing it on a mock started with a long step delay, in both the Python and the Node test; repeated runs are stable.
- A PowerShell string edit turned a backtick-r in a comment into a carriage return and broke the Node test file; rewrote the line and removed stray carriage returns.
- The mock first parsed the body before the lookup, which would have let a bad body tell an existing id from a missing one; changed so the handler asks for the body only after the lookup (`take()`).
- `git grep` ignores untracked files, so the flag search used `--no-index`.

## Security notes (vulnerable parts only)
No vulnerable code. The contract forbids any flag, decoy, digest, seed, event key, owner hash, orchestrator address, host id or stack trace in an answer and the checker enforces it on GET schemas and answer examples. The mock holds four fake flags (a repeated letter each); no real flag exists anywhere.

## Review fixes (same day)
Mock: a prototype key (constructor, __proto__) is no longer a session; a CSRF header of another byte length is 403, not 500; malformed percent-encoding in a path is the uniform 404 REQ-ROUTE-UNKNOWN; reset and stop of a frozen instance or of an instance whose attempt is not running are 409 INST-INVALID-STATE (declared in the OpenAPI file for stop), and the timer keeps access frozen for a submitted attempt; the owner of a learner attempt cannot decide an integrity flag (answered 404 like anyone else, since the contract declares no 403 for it, so the permissions table stands). Checker: the secret-name walk covers every operation's response schemas; a missing State, Access or Health enum in either file fails. Tests: exact field pointers per row, new tests for each fix. Docs: open points 28 to 30, check order text, duplicate LB-5 row removed, H-78 set to answered (partial), blank lines in the changelogs.

## Limitations and follow-ups
- ADR 0019 names external standards (OpenAPI 3.1, RFC 9457, OWASP CSRF guidance, Prism documentation) that were NOT read this session. They must be checked before the ADR is accepted.
- Everything marked open in `lab-api.md` (27 points) is a proposal; Akshay's optional review via handoffs H-84 to H-89.
- The mock is a stateful stand-in with its own rules (for example a correct flag for C11 in a candidate attempt is held); it is not the real API.
- No row was added for L-08 (the plan said "if needed"): nothing in this task needed it.
- The "Handoffs:" pointer line under P-04 in `docs/dev/dev2-akshay.md` was not added (another developer's file).
- To do after the developer confirms: tick L-05 in `docs/dev/dev1-tanmay.md`, mark the story done with `bmad-ticket`, set Done = Yes in the Excel sheet, open the early pull request (EARLY PR: yes) and watch CI.
