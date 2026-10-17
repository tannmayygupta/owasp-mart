# Password reset, password quality and account self-service (P-14, story 3.4)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-2-akshay-6 / see the pull request |
| Status | Built and tested at API level. Not built: the forgot-password, reset, signup and account pages (dashboards), an email change. Story 3.4 is `built`, awaiting the developer's confirmation |
| Report tag | password reset, password quality, breached passwords, account self-service, BMAD cycle |

## Requirements covered
FR-ACC-08 (reset by email, reject known-breach passwords, single-use hashed expiring links, no account oracle, throttling that ends), FR-ACC-09 (profile and password change; no email change). Related: FR-ACC-03 (session value changes at a password change), FR-ACC-10 (limits), handoffs H-127 and H-132 (the admin-created admin's link is a reset link), H-134 (for P-15 and P-26), ADR 0044.

## Summary (plain language, 3-5 lines)
A person who forgot their password can ask for a link by email; the link works once, and using it sets a new password and signs the account out everywhere. Passwords are now checked: too short, too repetitive, built from your own name or email, or on a list of the 10,000 most common passwords are refused with a plain sentence (an optional switch also asks a breach service, sending only a 5-character fingerprint). A signed-in user can change their display name and their password, and a password change signs out every other browser.

## Why
FR-ACC-08 and 09 close the account lifecycle: without a reset a forgotten password means a lost account, and without a quality check the strong hashing of P-11 protects weak passwords.

## What was built
- `accounts/passwords.py`: `PasswordPolicy` (length, variety, own details ignoring spaces and separators, the bundled list, an optional breach range check), `CommonPasswordList`, `PwnedPasswordsRange`, `make_policy`; the list `data/common-passwords-10k.txt` with provenance and licence in `data/README.md`.
- `accounts/service.py`: `request_reset`, `confirm_reset` (a weak password does not use up the link; success ends every session, verifies the address, clears the other reset links); signup now applies the policy; `InvalidInput` carries a reason kind.
- `accounts/self_service.py` (`SelfService`): profile update and the one-transaction password change; `sessions.py` got `rotate_in` and `revoke_all_in`.
- Routes: `password_api.py` (reset request and confirm), `me_api.py` (`getMe`, `updateMe`, `changePassword`); `problem.py` has the fixed sentences; settings `breach_check` and the reset limits; the admin seed uses the policy with 16 characters.

## How it works
A reset request writes a hashed single-use token and a mail in one transaction (for unknown addresses it only spends the same time and answers the same 202). Confirming first looks at the link without changing anything, runs the password rules, hashes, and only then claims the link with one conditional update; that update, the new password, the verified address and the ending of all sessions happen together. A password change checks the current password (wrong guesses are counted per account like a login's), applies the rules, and in one transaction stores the new hash, gives the session a new value and ends the others.

## Files changed
- New: `apps/api/src/vulnmart/accounts/{passwords,self_service,password_api,me_api}.py`, `accounts/data/{common-passwords-10k.txt,README.md}`, tests `test_passwords.py`, `test_password_reset.py`, `test_me_api.py`, `docs/adr/0044-*.md`, the plan of story 3.4.
- Changed: `accounts/{service,sessions,http,admins,seed_admin}.py`, `problem.py`, `main.py`, `kernel/settings.py`, `ports/settings.py`, `test_accounts_service.py`, `test_roles_and_admins.py`, `test_role_gates.py`, `test_accounts_postgres.py`, `scripts/e2e/platform-stack.e2e.test.mjs`, `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer (2026-10-17): "continue automatically", branch, pull request and merge per task. By the builder, in ADR 0044 (Proposed) for confirmation (the requirements fix only the outcome): the bundled list as the default and the range API as an opt-in, accept with a warning when that service is down, no composition rules, own details refused, a reset verifies the address, a weak password keeps the link alive.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-14-passwords/`.
- `pytest apps/api/tests` with the two containers: **1416 passed, 0 failed, 0 skipped** (401 s, `pytest-2026-10-17.txt`).
- New tests: the policy (20: the list loads, every rule, order of rules, the range client's request and response parsing including padding and failures, the settings), reset and signup at service and HTTP level (20), profile and password change (20), Postgres (4: 8 simultaneous uses of one link give one winner, a reset ends all sessions, a password change leaves one live session, two simultaneous changes never leave two).
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **19 of 19**, including the whole path through the web proxy: a reset mail holding only its link, an unknown address answered the same, a common password refused with the fixed sentence and the link surviving, the link used once, both old sessions ended, the old password refused, the profile renamed, a wrong current password refused with the session kept, a password change giving a new cookie and ending the other session, and the token not stored.
- `node scripts/check-contract-rules.mjs`: 15 PASS, 0 FAIL. `node --test` on `check-text-files`, `progress-page`, `dev` and `demo`: 70 of 70. The whole `scripts/*.test.mjs` suite was not re-run for this story.
- NOT run: the range client against the live service inside a test (it was called once by hand to see the format: lines of `SUFFIX:COUNT`, padding with count 0); a real browser; CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-14-passwords/`.

## Problems met and how they were fixed
- The own-details rule missed "Ada  Lovelace" and "ada_lovelace"; it now ignores spaces, dots, underscores and hyphens (found by my own test).
- My examples of "common" passwords were not on the list ("password1234" passes a 10k list); tests now read entries from the list, and the limit is written down in ADR 0044.
- Several of my text-replacement commands in PowerShell swallowed line breaks and produced code that did not compile; each was caught at once by an import or the test run and fixed by hand. I switched to precise edits for source files.
- Existing tests that used a repeated-character password or a display name that appeared inside the password were updated to the new rules.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: no oracle in the reset request, single-use hashed reset links claimed atomically, every session ended at a reset and a change, wrong current-password guesses throttled, refusal sentences that never repeat the password, a third party contacted only by explicit opt-in and then only with a 5-character hash prefix.

## Limitations and follow-ups
- A 10,000-entry list misses most breached passwords; the choice of default is the developer's (ADR 0044, deferred-work).
- No pages (dashboards, H-134); no email change; no "password changed" mail.
- In `hibp` mode an outage only logs a warning.
- Remind: Excel, P-14 Done = Yes; confirm story 3.4 so it can move to `done`.
