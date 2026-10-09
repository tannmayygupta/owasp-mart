---
title: 'Close the review gaps of L-04, L-05 and story 1.10'
type: 'chore'
ticket: '11'
created: '2026-10-09'
status: 'in-progress'
baseline_revision: '9079153c6565355dd4023dc615fbbd2e228daf77'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Reviews of L-04, L-05 and 1.10 left gaps: ADR 0019 cites sources nobody read; the Node end-to-end tests (lab, orchestrator, events, mTLS) run in no CI job and have never run on Linux; the P-04 handoff pointer is missing; and the mocks and tests carry recorded weaknesses in `docs/bmad/initiative-lab/deferred-work.md`.

**Approach:** Fix each by its cause. Read the primary sources and correct the ADR and the IF-2 text where they disagree; add a CI job that runs the end-to-end tests after a Linux run proves them in Docker here; add the pointer; fix each recorded weakness in the mock or the check, with a test that fails before the fix.

## Boundaries & Constraints

**Always:** A fix changes the code or the contract that is wrong; a test is never loosened, skipped or deleted to pass. Every hardening fix has a test that fails on the old behavior (run it against the old code or show the failing assertion, and record the evidence). Real commands and real results only. CI action versions stay pinned by commit SHA as in `.github/workflows/ci.yml`. Linux proof means the exact CI commands run in a Linux container on this PC (Docker Desktop); a Windows pass is not Linux proof. The nested Python run inside `scripts/e2e/orchestrator.e2e.test.mjs` is kept for local use and switched off in CI only through one documented environment variable, because the `scripts` job already runs pytest. Sources for the ADR are read in this session (WebFetch or WebSearch); each cited with its URL and what it says.

**Never:** No contract meaning changes without evidence from a source; if a source contradicts a decision (for example the problem+json member names or the CSRF header design), do not change the contract silently: list each mismatch with the source and stop that part, and the main session asks the developer. No decision on the open items that belong to Akshay or the product: `first_seq` upper bound and the reset rule (H-59), error codes (H-81), OI-xx, the Windows CI job, pnpm supply-chain settings (these stay in deferred work). No new dependency, no Prism, no changes to other developers' tracker folders, no push, no pull request.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Repeated correct flag | Same challenge credited or held twice | one milestone row, no new timeline or integrity entry | idempotent answer |
| Several held flags, one decided | two open held flags on a challenge, one decided | challenge stays held until none is open | — |
| Hint order | level 3 before 1 and 2 | 409 `ATT-*` (placeholder) with a field pointer, nothing unlocked | problem+json |
| Cursor | `' 5'`, `1e1`, `0x10`, negative, or growing list between pages | 422 for non-decimal; pages are stable (no repeat, no skip) | problem+json |
| Query parameters | unknown or repeated parameter on any GET | 422 with `field` | problem+json |
| Server start | port in use or out of range | exit 2 with a message | no hang |
| Wrong-length CSRF, prototype cookie, bad percent-encoding | as fixed in 1.9 | unchanged, still covered | — |
| Declared headers | any response whose OpenAPI lists headers | each declared header present | test fails otherwise |
| 413 test | oversize body | the test sees 413, or a reset only where the contract allows it, proved separately | no silent pass |
| Certificates | expired, not-yet-valid, serverAuth used as client, TLS 1.1 client | handshake refused | `OrchestratorUnavailable` |
| `openssl` missing | `CI` set to `true` or `1`; to `false`, `0` or empty | fail only for `true` or `1`; otherwise skip | tested by running the branch |
| Linux run | CI commands in a Linux container | every suite passes, or each failure is fixed at its cause | recorded |
| CI job | pull request | job `e2e` runs the lab, orchestrator and events end-to-end files without the nested pytest | green |

</frozen-after-approval>

## Code Map

- `docs/adr/0019-lab-api-conventions.md`, `contracts/api/lab/lab-api.md`, `contracts/api/lab/lab.openapi.yaml` (`Problem`, security schemes), `contracts/orchestrator/orchestrator.openapi.yaml` (`Problem`, same media type) -- text to check against RFC 9457, OpenAPI 3.1, OWASP CSRF Prevention Cheat Sheet, Prism documentation.
- `.github/workflows/ci.yml` -- job `scripts` runs unit tests, pytest and `contracts:check`; add a job `e2e` (ubuntu-24.04, timeout 15, same pinned actions, pnpm install, uv 0.12.23) running `node --test` on `scripts/e2e/lab.e2e.test.mjs`, `orchestrator.e2e.test.mjs`, `events.e2e.test.mjs`; `contracts.e2e` and `dev.e2e` stay out (fresh-checkout parity and Docker are covered by other jobs).
- `scripts/e2e/orchestrator.e2e.test.mjs` -- nested pytest test; make it skip only when the documented variable is set. `scripts/e2e/lab.e2e.test.mjs` -- order dependence (one shared mock) and the `> 30` answers assertion.
- `contracts/mocks/fake-lab/server.mjs` -- issues from deferred work: repeated correct flags, held-flag clearing, hint order, cursor, unknown query parameters on GET, `listen` errors.
- `apps/api/tests/test_lab_contract.py` -- exact example counts from manifests, declared-header loop, 413 test; `apps/api/tests/test_mtls.py` and `support.py` -- certificate cases, `CI` parsing, missing-openssl branch; `apps/api/tests/test_http_service.py` -- oversize retry narrowed to reset and broken pipe, GET leak test parses JSON; `scripts/check_orchestrator_contract.py` -- negative test for `owner_hash` and `first_seq` in a GET schema.
- `docs/dev/dev2-akshay.md` (P-04 `Handoffs:` line), `docs/dev/HANDOFFS.md` rows H-84 to H-89.
- New: a script that runs the CI commands in a Linux container (`scripts/ci-linux.mjs`, `pnpm run ci:linux`) so any developer, including Mac, repeats the proof.
- Do not touch: IF-1, IF-4, IF-6, signing code, other trackers.

## Tasks & Acceptance

**Execution:**
- [ ] ADR research -- read the four sources, record URL and finding for each claim of ADR 0019, correct the ADR and the IF-2 text to match, list any mismatch with a decision for the developer (stop that part)
- [ ] `scripts/ci-linux.mjs` and `package.json` -- run the CI commands in a pinned Linux container with Docker; run it first on the current tree and record real results; fix failures at their cause
- [ ] `.github/workflows/ci.yml` and `scripts/e2e/orchestrator.e2e.test.mjs` -- job `e2e` and the documented switch for the nested pytest
- [ ] mock hardening in `contracts/mocks/fake-lab/server.mjs` and `apps/api/tests/test_lab_contract.py`, `scripts/e2e/lab.e2e.test.mjs` -- each matrix row fixed with a test that failed before
- [ ] TLS and L-04 test hardening in `apps/api/tests/test_mtls.py`, `support.py`, `test_http_service.py`, `scripts/check_orchestrator_contract.py` and its test
- [ ] `docs/dev/dev2-akshay.md` -- P-04 handoff pointer
- [ ] Documentation rule -- dev-log, CHANGELOG, traceability, ADR 0019 status text, evidence in `docs/assets/story-1-11-review-gaps/`; update `deferred-work.md` (fixed items marked, remaining items with reasons)

**Acceptance Criteria:**
- Given ADR 0019, when read, then every external claim has a source read this session, or the ADR says it is still unverified and why.
- Given the repository on Linux in Docker, when the CI commands and the three end-to-end files run, then all pass.
- Given a pull request, when CI runs, then job `e2e` exists, runs the three files, and the other jobs are unchanged.
- Given each hardening fix, when its new test runs against the old behavior, then it fails; against the new code it passes.
- Given the full local run, when finished, then pytest, unit tests, all end-to-end files and `contracts:check` pass.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Why a Linux container: the first GitHub run must not be the first Linux run (host name check, TLS 1.3 refusal mapping, `openssl` configuration differ from Windows). Why the switch for the nested pytest: the job `scripts` already runs it; running it again in `e2e` doubles minutes and tests nothing new.

## Verification

**Commands:**
- `pnpm run ci:linux` -- expected: all CI commands and the three end-to-end files pass in the container
- `uv run --locked --package vulnmart-api pytest -q` -- expected: all pass, none skipped
- `node --test "scripts/*.test.mjs"` and `node --test scripts/e2e/lab.e2e.test.mjs scripts/e2e/orchestrator.e2e.test.mjs scripts/e2e/events.e2e.test.mjs scripts/e2e/contracts.e2e.test.mjs` -- expected: all pass
- `pnpm run contracts:check` -- expected: PASS for all four contracts

**Manual checks:**
- Open the ADR and confirm each source line has a URL and the finding it supports.
