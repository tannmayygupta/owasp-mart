# My sessions: list, sign out one, sign out everywhere (story 3.6)

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | akshaay29 |
| Branch / commit | `sprint-4-akshay-3-6-session-routes` |
| Status | Done (story `built`; marked done once merged) |
| Report tag | platform, accounts, security |

## Requirements covered
FR-ACC-04 (the second acceptance criterion); D-21 (ASVS level 2, V7 session management).

## Summary (plain language, 3-5 lines)
A signed-in user can now see where they are signed in, sign out one of those sessions, or sign out everywhere, through three new IF-1 routes (1.7.0) and a section on the account page. The functions existed since P-12; the routes waited for a contract change. While wiring them a flaw was found and fixed: the session handle went into a SQL LIKE match, so a handle made of `%` signed out all of the user's own sessions at once. Asked by the developer: "if anything is pending then continue".

## Why
FR-ACC-04 asks that a user can list and revoke their own sessions and log out everywhere; P-12 left the routes to story 3.6.

## What was built
- IF-1 1.7.0: `listMySessions`, `revokeMySession`, `logOutEverywhere`; schemas `SessionRef`, `MySession`, `MySessionList`.
- Routes in `accounts/session_api.py`.
- `SessionService.revoke` refuses a ref that is not 16 lower-case hex characters and audits `auth.session_revoked`; new `log_out_everywhere` audits `auth.logout_all` with the count; `created_at` of a session comes from the service clock.
- Account page: "Where you are signed in" (device kind, network prefix, times, "this one", sign out, sign out everywhere).

## How it works
The list shows the caller's live sessions (the newest 100): a `ref` (the first 16 hex characters of the stored SHA-256 of the session value, useless as a credential), times, the IPv4 /24 or IPv6 /48 prefix and the client kind. Ending a ref the caller does not have, or one already ended, answers 204: the answer says nothing about other people's sessions and the list shows what is left. Ending the current session, or all of them, clears the cookie. Both endings need the CSRF header and the right Origin.

## Files changed
- `contracts/api/platform/platform.openapi.yaml`, `contracts/api/bundle/*`, `packages/py-models/src/vulnmart_models/api.py`, `packages/ts-client/src/api.d.ts`: the contract and the regenerated code.
- `contracts/CHANGELOG.md` (1.7.0 and a registry-change line), `contracts/COMPAT.md` (IF-1 1.7.0, re-approved).
- `apps/api/src/vulnmart/accounts/session_api.py`, `sessions.py`: routes and the service changes.
- `apps/web/app/account/page.tsx`, `apps/web/lib/api.ts`: the account page section.
- Tests: `test_my_sessions_api.py` (new), `test_sessions_service.py` (wildcard ref), pins in `test_platform_contract.py`, `test_privacy_wall.py`, `test_role_gates.py`.

## Decisions made
- The developer chose to re-approve IF-1 at 1.7.0 in this pull request (question of 2026-10-20), so the tag's version check still matches.
- No new error code: ending an unknown ref is 204 (alternative: a new not-found code, rejected because it needs an IF-8 change and tells nothing useful).
- `logOutEverywhere` ends the current session too and clears the cookie (the password change keeps the current one; that is a different route).

## Tests
- `.venv/Scripts/python -m pytest apps/api/tests -q -p no:cacheprovider` (Postgres and Valkey containers): 4 failed (the pins named above), 2883 passed, 1 skipped; after updating the pins the affected files: 135 passed.
- The wildcard test fails on the old code (`assert (None is not None)`: both sessions were ended) and passes on the new.
- `node scripts/check-contract-rules.mjs`: 18 PASS, 0 FAIL. `node scripts/tag-contracts.mjs --dry-run`: versions PASS (IF-1 1.7.0); approvals fail only on Sahil's IF-6 row, as before.
- `node --test "scripts/*.test.mjs" "apps/*/test/**/*.test.mjs"`: 1215 pass, 3 fail (the generator tests, tool not installed locally; CI has it).
- `npm run build` (apps/web): compiled.
- Traceability: FR-ACC-04.

## Evidence
`docs/assets/story-3-6-session-routes/`.

## Problems met and how they were fixed
- The newest-first order failed in a test: `created_at` came from the database clock (one-second resolution in SQLite), not the service clock; it is now set by the service, like `last_seen_at`.
- The `%` ref (see Summary).

## Security notes (vulnerable parts only)
None (platform code). Fixed flaw: LIKE wildcards in the session ref; only the caller's own sessions were reachable, so the impact was self-inflicted sign-out.

## Limitations and follow-ups
- The account page section is not browser-tested; the real-stack test was not run for this change.
