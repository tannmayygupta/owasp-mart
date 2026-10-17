---
title: 'Password reset, password quality and account self-service'
type: 'feature'
ticket: '4'
created: '2026-10-17'
status: built
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/contracts/api/platform/platform.openapi.yaml'
  - '{project-root}/docs/architecture/06-security.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** A person who forgets a password is locked out, passwords are only checked for length, and a signed-in user cannot change their name or password (FR-ACC-08, FR-ACC-09). The link in the mail to an admin created by an admin has nothing to consume it.

**Approach:** The routes `requestPasswordReset`, `confirmPasswordReset`, `getMe`, `updateMe` and `changePassword` of IF-1; one password policy (length, variety, own details, a bundled list of the 10,000 most common passwords, optionally the Pwned Passwords range API) used by signup, reset, change and the admin seed; a reset that ends every session; a password change that is one transaction and gives a new session value.

## Boundaries & Constraints

**Decisions (developer, 2026-10-17):** "continue automatically", branch, pull request and merge per task. Claude's choices, in ADR 0044 (Proposed) for confirmation (the requirements say only "known breach lists" and "password quality rules"): a bundled local list as the default and the HIBP k-anonymity API as an opt-in (a third party would see a hash prefix), fail-open with a warning if that service is down, no composition rules, the person's own details refused, a reset also verifies the address, a weak password does not use up the link.

**Always:** The answer to a reset request is 202 and about equally slow for every address; a reset link is single use, stored only as a hash, expires; a successful reset or password change ends the other sessions; the current password is needed for a change and wrong guesses are counted and throttled; a refusal names the rule in a fixed sentence and never repeats the password; passwords are never logged.

**Never:** No email change (needs its own verification step, later); no second factor (P-15); no dashboards pages; no "your password was changed" mail (not in the list of FR-NTF-01); no contract change.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Reset request | any address | 202 `{"status":"accepted"}`; mail only for an active account; older links die | 429 per address and per email |
| Confirm | good link, good password | 204; password set; every session ends; the address is verified; the failed-login wait is cleared | link used again: 400 AUTH-TOKEN-INVALID |
| Expired, unknown, wrong-kind link | any | 400 AUTH-TOKEN-INVALID, identical | n/a |
| Weak password | common, trivial, own details, breached | 422 with a fixed sentence at `/new_password`; the link is not used up | n/a |
| getMe | live session | the user | 401 without a session |
| updateMe | display name | 200 with the cleaned name | CSRF and Origin first; empty body, extra member, bad name: 422 |
| changePassword | right current, good new | 204, new session cookie, every other session ends, old value dead | wrong current: 401, session stays, counted; 10 in 15 minutes: 429 |
| Same password again | new equals current | 422 `password_same` | n/a |
| Breach service down | HIBP mode, no answer | accepted on the other rules, warning logged | n/a |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/accounts/passwords.py` (policy, `CommonPasswordList`, `PwnedPasswordsRange`, `make_policy`), `data/common-passwords-10k.txt` and `data/README.md` (provenance and licence).
- `accounts/service.py` (`request_reset`, `confirm_reset`, `check_new_password`, `InvalidInput.kind`), `self_service.py` (`SelfService`), `sessions.py` (`rotate_in`, `revoke_all_in`).
- `accounts/password_api.py` (reset routes), `me_api.py` (me routes), `http.py` (`userview_body`), `problem.py` (fixed password sentences), `main.py`, `kernel/settings.py` (`breach_check`), `ports/settings.py` (reset limits), `admins.py` and `seed_admin.py` (the policy for admin passwords).
- Tests: `test_passwords.py`, `test_password_reset.py`, `test_me_api.py`, `test_accounts_postgres.py` (P-14 part); stack test `scripts/e2e/platform-stack.e2e.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] Password policy with the bundled list (provenance recorded) and the optional range API; used at signup, reset, change and the seed.
- [x] Reset request and confirm; profile and password change routes; one-transaction change; fixed sentences in the problem answers.
- [x] Tests (policy, service, HTTP, real Postgres races) and the real-stack test through the web proxy.
- [ ] (dashboards) The forgot-password, reset and account pages.

**Acceptance Criteria:**
- Given a reset mail, when its link is used with a good password, then the password is set, every session ends and the link cannot be used again; an expired link is refused.
- Given a password from the common list, one made of the person's own details, or a trivial one, then it is refused with a fixed sentence at signup, reset and change.
- Given a signed-in user, then they can change the display name and the password; a wrong current password is refused and counted.

## Implementation Notes

- A 10,000-entry list does not know every breached password (for example `password1234` is not on it); the opt-in range API covers hundreds of millions. Recorded as a limit, not hidden.
- The reset link of an admin created by an admin (P-13) is consumed by the same `confirm_reset`.
- The list was downloaded from SecLists (MIT) at a pinned commit and checked before use (data/README.md).

## Plan Change Log

## Review Triage Log

### 2026-10-17, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review. 2 medium, 2 low; all patched.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | A password with extra spaces or separators ("Ada  Lovelace", "ada_lovelace") slipped past the own-details rule | medium | patch | the comparison ignores spaces, dots, underscores and hyphens; tests |
| 2 | A password change in three transactions could leave other sessions alive after a crash | medium | patch | `rotate_in` and `revoke_all_in` run in the one transaction of the change |
| 3 | A test assertion that could pass for two different answers (`or`) | low | patch | now asserts the one answer |
| 4 | My tests used a password that is not on the list ("password1234") | low | patch | tests use entries read from the list |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
