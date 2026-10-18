# Demo rehearsal runbook, live smoke check and submission pack (story 8.6, L-30 live part and L-31)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay / not committed yet (working tree) |
| Status | Partly done: runbooks and scripts done and tested locally; no rehearsal and no live run has happened |
| Report tag | Demo readiness and report material |

## Requirements covered
LX-1, LX-3, LX-4 (as named in the epic); L-30 live part, L-31.

## Summary (plain language, 3-5 lines)
`docs/runbooks/demo-19-oct.md` has the timeline from 24 hours before, a pre-flight checklist, a 12-minute script with talk track, a failure table, the fallback switch, and two empty rehearsal tables for you to fill in. `scripts/live-smoke.mjs` does read-only GET checks of the deployed URLs and fails on a bad header. `scripts/check-submission-pack.mjs` checks that every document the college report needs is present, non-empty and free of secret-looking content, and it passes on the repository today.

## Why
The live demo is on 19 Oct and the report needs a clear document list. A rehearsal that is written down and a checker that tells you what is missing remove two last-minute risks.

## What was built
- `docs/runbooks/demo-19-oct.md`, `docs/runbooks/submission-pack.md`.
- `scripts/live-smoke.mjs` (+ test): env vars `SMOKE_BASE_URL` (required), `SMOKE_HEALTH_PATH`, `SMOKE_VERSION_PATH`, `SMOKE_EXPECT_VERSION`, `SMOKE_EXTRA_URLS`. Rules per URL: status 200, `x-content-type-options: nosniff`, no `x-origin-secret` or `x-powered-by`, HSTS required on https. GET only.
- `scripts/check-submission-pack.mjs` (+ test): 21 required items plus a secret-pattern scan over the pack folders.

## How it works
The checker reads a fixed `REQUIRED` list (the same table is in the runbook), reports PASS or FAIL per item with the path, and scans the pack's text files with narrow patterns (private key block, AWS key id and secret, GitHub and Slack tokens, JWT, a flag-shaped value that is not one repeated letter, a password/secret/token assignment with a long random value). It prints file and line, never the value. `live-smoke` fetches the URLs, checks headers and optional body text, and exits 1 if anything fails or nothing answers.

## Files changed
- `scripts/live-smoke.mjs`, `scripts/live-smoke.test.mjs`, `scripts/check-submission-pack.mjs`, `scripts/check-submission-pack.test.mjs` (new)
- `docs/runbooks/demo-19-oct.md`, `docs/runbooks/submission-pack.md` (new)
- `docs/assets/story-8-6-demo-and-pack/` (evidence)

## Decisions made
None recorded. Judgement calls to confirm: the header rules of `live-smoke` (the real site may not send `x-content-type-options` yet, which would show as a FAIL, and that is a finding for the Vercel header config); minimum counts in the checker (10 ADRs, 10 dev-logs, 5 evidence files) and minimum text sizes; the demo script's steps 2 and 3 name the rehearsed challenge generically because I do not know which exploit you will show.

## Tests
- `node --test scripts/live-smoke.test.mjs scripts/check-submission-pack.test.mjs`: 13 tests, 13 pass, 0 fail (`docs/assets/story-8-6-demo-and-pack/unit-tests.txt`).
- `live-smoke` against a local test server (`live-smoke-local.txt`): good headers give 2 PASS, exit 0; an answer carrying `x-powered-by` gives a FAIL line naming the header, exit 1. Unit tests also cover missing nosniff, `x-origin-secret` leak, HTTP 500, wrong or empty version body, nothing listening, and that only GET is sent.
- `node scripts/check-submission-pack.mjs` on this repository (`submission-pack-check.txt`): all 21 items PASS and "no hit" over the scanned files (328 at the time of the saved run, the count changes as other work adds files), exit 0. That count includes this story's own runbooks, so it was FAIL on the two missing runbooks before they were written.
- `node scripts/scan-secrets.mjs` PASS after fixing one test string. `node scripts/check-text-files.mjs` fails today on files that belong to other work (a BOM in `apps/edge/test/session-epoch.test.mjs`, `apps/orchestrator/tests/test_edge_attach.py` and three evidence files of other stories); none of this story's files has a hit (checked with `scanTextHygiene`).

## Evidence
`docs/assets/story-8-6-demo-and-pack/`: `unit-tests.txt`, `live-smoke-local.txt`, `submission-pack-check.txt`.

## Problems met and how they were fixed
- The first secret pattern for flags matched the repository's test flags (24 times the same letter) in `docs/assets/l-05-lab-api/flag-grep.txt`; the pattern now ignores a value made of one repeated character.
- First local server attempts failed: port 18999 is in a Windows excluded range (EACCES), and a synchronous child process blocked the in-process server; the evidence run uses port 0 and an asynchronous child.

## Security notes (vulnerable parts only)
Not a vulnerable part. `live-smoke` sends no secret and no write request.

## Limitations and follow-ups
- NOT done, developer steps: rehearsal passes 1 and 2 (the tables in the runbook say "not run"), the pre-flight on the deployed site, `live-smoke` against the real URLs, the fallback switch rehearsal.
- The checker proves presence and absence of obvious secrets, not correctness of the documents.
- If the deployed API has no `/api/v1/version` route, leave `SMOKE_VERSION_PATH` unset.
