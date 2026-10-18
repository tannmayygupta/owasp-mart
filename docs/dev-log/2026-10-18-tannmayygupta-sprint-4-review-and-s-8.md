# Sprint 3 and 4 cumulative BMAD review, fixes and S-8 decision

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | tannmayygupta |
| Branch / commit | sprint-4-tanmay |
| Status | Done for the review; open findings listed below |
| Report tag | review, regression, S-8 |

## Requirements covered
L-15, L-29 (NFR-ISO-01 to 07, spikes S-3, S-8, S-15), review of L-13 to L-28.

## Summary
The branch diff against origin/main (about 196 code files, 1.1 MB) was split into four chunks (api, py-attempts, edge/orchestrator/sidecar, infra/scripts). One reviewer per chunk applied three lenses (blind, edge cases, verification gaps) and checked each finding against the files. Reports: 8, 12, 10 and 11 findings; none rated high except B1.

## Fixed in this change (each with a test or an existing suite)
- B1 (high): an attempt reported before its freeze window ended never had its instance destroyed (`engine.py` `_step`, `store.py` `due`). Test `test_reported_before_freeze_ends_still_destroys_instance`.
- A1 and A2: `start_attempt` built an instance for a submitted, cancelled or withdrawn attempt and leaked an instance when a later step failed. Now refused with ATT-INVALID-STATE, and the instance is destroyed on any failure. Test `test_start_after_withdrawal_is_refused_and_creates_no_instance`.
- B11a: the `due()` sort used `datetime.max`; replaced by a key that cannot overflow.
- D5: `scan-flags` treated an unreadable `docker logs` as clean; now it stops with an error.
- C6: the edge refuses a non-integer port or rate setting at start (was NaN, silently dead relay).
- Test bug: `generate-api-code.test.mjs` compared LF output with a CRLF Windows checkout; now line-ending neutral.
- My own mistake: a PowerShell edit re-encoded `CHANGELOG.md` and broke non-ASCII text; caught by `check-text-files.test.mjs`, restored from git and redone with explicit UTF-8.

## Not fixed (open, judged not blocking the demo)
- Runtime (api): reset races and readiness wait under the lock (A3 to A5), review decision not atomic with credit (A6, B6), state report from-state not checked (A7).
- Attempts: freeze failure blocks destroy (B2), grace window vs tick (B3), withdraw race with tick (B4), second withdrawal after undo (B5), reset limit check-then-act (B9), warning catch-up (B10), caller-supplied ready time (B8), loose Rules.from_dict (B12).
- Edge/sidecar: gate sync 409 after an orchestrator restart (C1, most important), secrets blanked before CRS so password-field SQLi is not seen (C2), relay bind default 0.0.0.0 (C3), gate cookie has no expiry (C4), arm64 build hardcoded to amd64 (C7).
- Infra/scripts: audit does not read the VULNMART-LABS chain or all container flags (D1, D2), audit flags the orchestrator port 9443 (D3), compose rules skipped when the profile is removed (D4), harness product-sidecar forwarding check (D6), others D7 to D11.
These need their own stories; none was verified live.

## Tests run (real results)
- `npm test`: 1013 tests, 1011 pass, 2 skipped, 0 fail.
- `uv run pytest -q` in packages/py-attempts: 351 passed. In apps/api and apps/orchestrator: 467 passed (workspace run, 4 warnings).
- Edge and scan-flags node tests: 114 pass.

## S-8
Live experiments skipped by the developer's decision (the remote Docker config change was also refused by the automatic safety check). Reasoning only: `docs/research/s-8-instance-sandboxing.md`. Nothing on vm-i changed.

## Limitations and follow-ups
Review findings were checked by reading code, not by exploit tests. L-30 and L-31 need the deployed platform and shop (P-32, T-32) and a human rehearsal.