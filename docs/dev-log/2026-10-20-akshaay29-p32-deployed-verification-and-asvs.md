# Deployed verification and ASVS checklist

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `shared-P-32` (EARLY PR) |
| Status | Partly done: the script and the ASVS chapter table are done; the deployed verification waits for stream L's redeploy (story `blocked`, handoff H-358) |
| Report tag | platform, security, deployment, sprint 4 |

## Requirements covered
NFR-SEC-01, NFR-SEC-02, NFR-SEC-03 (the checklist and the deployed checks); "done when" of every platform epic (not met yet: the deployed site is stale). Story 10 of `epic-platform-baseline` (ref 1.10, task P-32). Also marks P-31 done (merged in pull request 65).

## Summary (plain language, 3-5 lines)
A new script checks a deployed VulnMart platform without changing anything: health, security headers, the https redirect, the error format, that a cross-site form post is refused, that every page is the real dashboards app, and that every platform route of the contract exists. Run against the live site, it showed the site is behind: it serves the old lab console instead of the dashboards and lacks the routes of P-26 to P-31. The ASVS 5.0 checklist is now in the traceability file, one row per chapter. The deployed verification waits for Tanmay's redeploy.

## Why
Task P-32: verify every platform epic on the deployed site and fill the ASVS 5.0 rows (NFR-SEC-01). L-30 (Tanmay) waits on it.

## What was built
- `scripts/verify-deployed.mjs` and `scripts/verify-deployed.test.mjs`.
- The ASVS 5.0 chapter table in `docs/traceability.md` (17 chapters from the official `OWASP/ASVS` `5.0/en` list, read 2026-10-20).
- Handoff H-358; the P-32 story in `epic-platform-baseline` (blocked).

## How it works
The script reads the bundle, takes every platform operation without a path parameter (not the public ones, not the lab's, not `createLiveTicket` which is pending on purpose) and asks the deployed origin without a session: anything but 404 proves the route exists (401 is the expected answer). It also checks the headers of the root page, the redirect from http, an unknown route's IF-8 body, a POST with a foreign Origin, and that each dashboards page carries Next.js assets (a static page answering every path would pass a plain 200).

## Files changed
- New: `scripts/verify-deployed.mjs`, `scripts/verify-deployed.test.mjs`, the story plan, `docs/assets/p-32-deployed-verification/`.
- Changed: `docs/traceability.md`, `docs/bmad/initiative-platform/epic-platform-baseline/tickets.toml`, `docs/dev/HANDOFFS.md` (H-358), `docs/dev/dev2-akshay.md`, `CHANGELOG.md`; P-31's story, task line and dev-log marked done.

## Decisions made
By the developer (2026-10-20): "Prepare now, verify later" (the redeploy is stream L's). No new decision record.

## Tests
- `node --test scripts/verify-deployed.test.mjs`: 5 of 5 (a current deploy passes; a stale route, missing headers and a site serving another page on every path fail; bad arguments are refused).
- `node scripts/verify-deployed.mjs --base https://tanmay-platform-prod.duckdns.org` (read only, 2026-10-20): **32 PASS, 29 FAIL** (`verify-deployed-2026-10-20.txt`). Fails: 12 pages are the lab console, not the dashboards; 15 routes of P-26 to P-31 answer 404; no nonce CSP on the pages; port 80 refuses connections (no redirect). Passes include health, HSTS, nosniff, an IF-8 404 with a request id, a refused cross-site POST, and the routes of P-01 to P-25 and P-28.
- A first run counted the 12 pages as passing (the console answers every path with 200); the check now asks for the dashboards' `/_next/` assets.
- `node --test "scripts/*.test.mjs"`: 921 tests, 916 pass, **3 fail on this PC** (the three generator tests: `datamodel-codegen` is not installed here; CI has it) (`script-tests-2026-10-20.txt`).
- NOT run: anything on a current deploy (there is none yet); the per-requirement ASVS review.

## Evidence
`docs/assets/p-32-deployed-verification/`.

## Problems met and how they were fixed
- The first tag filter called `live` a lab tag; the live routes are the platform's (P-22) and are checked; `createLiveTicket` is pending on purpose and skipped.
- A cited test file name in the checklist was wrong (`test_sessions.py`); it is `test_sessions_service.py`.

## Security notes (vulnerable parts only)
None: platform code and documentation.

## Limitations and follow-ups
- The deployed verification of each epic waits for H-358 (deploy main's API with migration 0016 and the dashboards to vm-p; decide port 80).
- The ASVS table is at chapter level; the per-requirement review (requirement ID column) is open.
- L-11 (Vercel) is not done; the dashboards are not deployed anywhere yet.
