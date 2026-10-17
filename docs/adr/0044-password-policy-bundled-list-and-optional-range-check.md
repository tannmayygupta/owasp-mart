# 0044. Password policy: rules, a bundled common-password list, an optional breach range check

- **Status:** Proposed (the builder's design for the developer to confirm; the requirements say "known breach lists" and leave the quality rules to be tuned)
- **Date:** 2026-10-17
- **Deciders:** Claude Code (design); the developer to confirm
- **Requirements:** FR-ACC-08, FR-ACC-09, D-21, NFR-SEC-01

## Context
FR-ACC-08 asks to reject passwords that appear in known breach lists and to reset a forgotten password by email without revealing whether an account exists. It does not say which list, whether a third party may be asked, what to do when that party is down, or which other rules apply. RS-D only says "breached-password check".

## Options considered
1. **Breach data:** (a) a bundled list of the most common passwords, no third party; (b) the Pwned Passwords range API (k-anonymity: only 5 characters of a SHA-1 are sent), far larger coverage, a third party and an outbound call; (c) a large offline copy of the Pwned Passwords hashes (about 40 GB), no.
2. **If the range API is down:** refuse every new password / accept on the other rules and log a warning.
3. **Other rules:** composition rules (upper, digit, symbol) / length, variety and "not your own details" only. NIST SP 800-63B and ASVS advise against composition rules.
4. **A reset link and a weak password:** use up the link / keep it so the person can try again.
5. **Reset and the address:** leave the address as it was / mark it verified, since the link proves control of the mailbox.

## Decision
- Rules: 12 to 128 characters (the contract), at least 4 different characters, not containing the person's email address, the part before the `@` or display name (4 characters or more, ignoring spaces, dots, underscores and hyphens), and not on the bundled list of the 10,000 most common passwords (SecLists, MIT, pinned commit, checked on download, case-insensitive). No composition rules.
- The range API is opt-in (`VULNMART_BREACH_CHECK=hibp`); the default is `local`, so no third party sees anything. `off` exists for dev and test only and the service refuses to start in staging or production with it. If the range API does not answer, the password is accepted on the other rules and a warning is logged.
- A refusal is a 422 with a fixed sentence at the field (too easy to guess, appeared in a breach, contains your details, too short or long, same as the current one); the password is never in an answer or a log.
- A weak password does not use up a reset link; a successful reset ends every session, clears the failed-login wait and marks the address verified.
- A password change is one transaction: new hash, new session value, every other session ended; the current password is required and wrong guesses are counted per account.

## Consequences
- A 10,000-entry list misses most breached passwords (the tests show `password1234` is accepted); the opt-in range API closes that gap at the price of telling a third party a 5-character hash prefix. Choosing the default is the developer's call.
- The `hibp` mode needs outbound HTTPS from the API host; its behaviour during a long outage is "accept with a warning", which weakens the check silently unless someone reads the log.
- Refusing passwords that contain the person's name can annoy someone called "Password Manager"; the rule only applies from 4 characters.
- The wording of the refusal sentences is a first draft.

## Evidence
- NIST SP 800-63B and OWASP ASVS 5.0 (no composition rules, blocklist check, allow long passwords): **from memory, not re-read during this story.**
- SecLists `10k-most-common.txt`, commit `913b327317496d062bcc7cace524aaad8a693be2` (2026-09-08), MIT licence read 2026-10-17; 10,001 distinct entries, plain ASCII, no control characters (`apps/api/src/vulnmart/accounts/data/README.md`).
- The Pwned Passwords range API was called once by hand with the prefix `5BAA6` (the SHA-1 prefix of the word "password") on 2026-10-17: the answer is lines of `SUFFIX:COUNT`, the suffix of "password" was present with a large count, and padding lines carry a count of 0 (`test_passwords.py` reproduces that format with a fake). The client was **not** run against the live service in the tests.
- Real stack: signup, reset, profile and password change through the web proxy, 19 of 19 end-to-end tests (`platform-stack.e2e.test.mjs`).
