# Close the review gaps of L-04, L-05 and story 1.10 (story 1.11)

| Field | Value |
|---|---|
| Date | 2026-10-09 |
| Developer | tannmayygupta |
| Branch / commit | sprint-1-tanmay, committed as d44313c (base f4fad33); not pushed |
| Status | Done for this story; story 1.12 (RFC 9457 error body) is pending by the developer's decision |
| Report tag | testing and quality; CI |

## Requirements covered
IF-2 (lab API mock and contract), IF-5 (tests), NFR-SEC-03, D-37, D-39, handoffs H-84 to H-89 (pointer). Items of `docs/bmad/initiative-lab/deferred-work.md`.

## Summary (plain language)
Reviews of L-04, L-05 and story 1.10 left gaps. The ADR for the lab API cited standards nobody had read; the Node end-to-end tests ran in no CI job; the mock and the tests had recorded weaknesses. The sources were read, a CI job `e2e` was added after the same commands passed in a Linux container on this PC, and each weakness was fixed in the mock or the test, with a test that failed on the old behaviour.

## Why
The first GitHub run must not be the first Linux run, and a test that was never run in CI protects nothing.

## What was built
- ADR 0019 evidence table with a URL and a finding per claim; mismatches M1 to M3 listed. Decided by the developer on 2026-10-09: M1 adopt RFC 9457 (change pending in story 1.12, not made); M2 signed, session-bound CSRF token (contract text and OpenAPI description updated, mock keeps the simple equality check, implementation is Akshay's in P-05); handoffs H-90 and H-91.
- `scripts/ci-linux.mjs` and `pnpm run ci:linux`: runs the CI commands in a pinned Linux container (node 24.21.0, pnpm 12.10.1, uv 0.12.23, Debian bookworm), repository copied in, nothing in the working tree changed.
- CI job `e2e` (lab, orchestrator, events end-to-end files); the nested pytest of `orchestrator.e2e.test.mjs` is skipped only when `VULNMART_E2E_SKIP_NESTED_PYTEST` is `true` or `1`.
- Mock fixes (`contracts/mocks/fake-lab/server.mjs`): repeated correct flag is idempotent; a challenge stays held until no held flag is open; hint levels unlock in order (409 `ATT-INVALID-STATE`, `field` `/level`, placeholder code reused, no new code); cursor must be the canonical decimal offset; every GET refuses unknown or repeated query parameters (422 declared on every GET in the OpenAPI file); listen errors and port range exit 2; an oversize body is answered with 413 and drained up to 1 MiB before the connection closes.
- Test hardening: exact example counts from the manifests, every declared response header asserted, deterministic 413 test plus a separate huge-body test, order independent lab end-to-end tests with an exact answer count, expired / not-yet-valid / wrong-usage certificates on both sides, a TLS 1.1 client, a positive control for the dated certificates, `CI` parsing (`true` or `1` only) in Python and Node with the real missing-openssl branch run, narrowed oversize retry, JSON-parsed GET leak test, negative test of the orchestrator checker for `owner_hash` and `first_seq`.
- Handoff pointer: P-04 in `docs/dev/dev2-akshay.md` now lists H-84 to H-89.

## How it works
`ci-linux.mjs` builds a small image from the node and uv images, mounts the repository read-only, copies it (without node_modules, .venv, .git) and runs each CI command, printing `=== RESULT <step>: PASS|FAIL`. `scripts/ci-linux.test.mjs` keeps its commands in step with `ci.yml` without Docker.

## Files changed
- `scripts/ci-linux.mjs`, `scripts/ci-linux.test.mjs`, `scripts/env-flag.mjs`, `scripts/env-flag.test.mjs`, `scripts/fake-lab.test.mjs` (new); `package.json` (`ci:linux`)
- `.github/workflows/ci.yml` (job `e2e`)
- `contracts/mocks/fake-lab/server.mjs`, `contracts/api/lab/lab.openapi.yaml`, `contracts/api/lab/lab-api.md`
- `apps/api/tests/test_lab_contract.py`, `test_mtls.py`, `support.py`, `test_http_service.py`, `test_contract.py`
- `scripts/e2e/lab.e2e.test.mjs`, `scripts/e2e/orchestrator.e2e.test.mjs`
- `docs/adr/0019-lab-api-conventions.md`, `docs/dev/dev2-akshay.md`, `docs/bmad/initiative-lab/deferred-work.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/assets/story-1-11-review-gaps/`

## Decisions made
No new ADR. ADR 0019 stays Proposed with the evidence table. The placeholder code `ATT-INVALID-STATE` is reused for hint order so no error code is added (H-81 stays open). The nested-pytest switch is one documented environment variable.

## Tests
Real results are in `docs/assets/story-1-11-review-gaps/`:
- Baseline on Linux before any change: `ci-linux-baseline.txt` (338 pytest, 82 unit, 34 end-to-end, all PASS).
- Old behaviour: `before-fix-lab-contract.txt` (23 failed, 13 passed of the selected new tests against the old mock), `before-fix-fake-lab-unit.txt` (both failed; the old mock also hangs on a used port, the test was stopped by hand), `before-fix-env-flag.txt` (2 failed with the old `CI` check), `before-fix-check-orchestrator-mutation.txt` (2 failed with the two names removed from the checker).
- After: `after-fix-mtls-and-lab-contract.txt`; Linux run `ci-linux-after.txt` (95 unit, 387 pytest, contracts check PASS, `uv lock --check` PASS, 33 end-to-end passed and 1 skipped by design); `windows-local-run.txt`.
- First Linux attempt `ci-linux-attempt1-uv-network-timeout.txt` failed only because uv timed out downloading a wheel; `UV_HTTP_TIMEOUT=180` was added to the container and the run repeated.
Traceability: row LB-10.

## Evidence
`docs/assets/story-1-11-review-gaps/`.

## Problems met and how they were fixed
- A first edit script mangled a file because a PowerShell double-quoted here-string expands `$` and backticks; edits were redone with the edit tool.
- A `\n` inside a PowerShell single-quoted string was written literally into a Python file; fixed by hand.
- The first version of the drain function was joined into a one-line comment by the same mistake and broke the mock (`Illegal return statement`); found by `node --check`.
- Several new tests passed on the old mock: the 70 KiB 413 test (the reset is a race that did not happen on this PC) and the timeline stability test (rows are only appended). They are kept as guards and listed honestly as not failing before.
- Expired certificates: `openssl x509 -req` cannot set a start date before OpenSSL 3.4, so `openssl ca` is used; a positive control test proves the method itself does not cause the refusals.

## Limitations and follow-ups
- M1: story 1.12 changes IF-5 and IF-2 to RFC 9457 members (not done here). M2 and M3: text updated, implementation is Akshay's (H-90).
- Open, recorded in `lab-api.md` row 31 (OI-38): when one of several open held flags is accepted, are `solved` and `held` both true? The mock credits and keeps held while another flag is open.
- End-to-end files that stay out of CI: `scripts/e2e/contracts.e2e.test.mjs` (a fresh-checkout install run; the same commands already run in the job `scripts`) and `scripts/e2e/dev.e2e.test.mjs` (needs the host Docker; the job `compose` covers `dev.mjs hello`). The job `compose` is not repeated in `ci:linux` (Docker inside Docker).
- Deferred low items: timeline sorted by the `at` string while the cursor is an offset (rows share timestamps); no examples yet for the new 422 unknown-query answer and the hint-order 409; the TLS 1.1 test cannot show whether the client or the server refused; one certificate helper shared by Python and Node.
- Review follow-ups done: 413 now has `Connection: close` and the socket is destroyed when the drain ends, at the cap or after the stall time (unit tests with raw sockets); `--port` accepts only 1 to 5 digits; the missing-openssl tests use an empty PATH and prove openssl is absent first; `ci-linux.test.mjs` checks both directions with `ci.yml`; `--only` runs the install first when needed.
- Not done (reasons in `deferred-work.md`): one certificate helper shared by Python and Node; runtime of the mTLS tests; `first_seq` bound (H-59); error codes (H-81); Windows CI job; pnpm supply-chain settings; OI-xx.
- The first run on GitHub is still to be recorded.


## Close-out note (2026-10-10)
The story was marked done by the developer with the GitHub CI result pending: the pull request is raised after all sprint 1 tasks. The first real CI result is to be recorded in docs/dev/sprint-1-pr-checklist.md and here; a failure becomes a bug story.
