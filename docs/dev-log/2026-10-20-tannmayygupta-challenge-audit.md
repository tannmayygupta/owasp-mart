# Audit of the eleven challenges

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | `l-tester-login-hint-bugs` (commit hash after the commit) |
| Status | Done as an audit; the proposals below wait for the developer |
| Report tag | challenge audit, OWASP 2025 tags, hints |

## Requirements covered
C01 to C11, FR-HNT-01, FR-HNT-02. Story: `docs/bmad/initiative-lab/backlog/story-audit-all-eleven-challenges.md`.

## Summary (plain language, 3-5 lines)
All eleven challenges are exploitable where intended and fixed where intended, each exploit test passing on the vulnerable build and failing on the fixed build. Hints, milestones, write-ups and OWASP 2025 tags exist for every challenge. I found no broken challenge. I found naming and file gaps (below). Nothing in the catalogue or the shop was changed.

## Why
The developer asked for the next story, the audit of all challenges (the second part of the tester request).

## What was built
Nothing in code. This record, the story, and the traceability rows C01, C02, C04 to C11 (they said "Not started" although the tests exist).

## How it works
The audit read every `challenges/catalog/cNN.yaml`, ran every test in `challenges/tests`, loaded the catalogue through the lab's own loader, and compared tags with the official OWASP Top 10:2025 page.

## Files changed
- `docs/traceability.md` — rows C01, C02, C04 to C11.
- `docs/bmad/initiative-lab/backlog/story-audit-all-eleven-challenges.md` and its plan — the story.
- `CHANGELOG.md`, this file.

## Decisions made
None. No ADR.

## Tests
- `node --test "challenges/tests/**/*.test.mjs"` — 42 tests, 42 pass (every challenge: pass on vulnerable, fail on fixed; plus extra checks for C01 support view, C03 bot, C09 web lock, C10 forms, C11 pending).
- `uv run --locked --package vulnmart-api python` loading `challenges/catalog` with `load_catalog` — all 11 challenges give three non-placeholder hint texts.
- The hint ladder through the real API and the real console: see the previous dev-log (C02 in real Chrome; `apps/api` tests 5 hint tests pass; API suite 2586 passed).
- OWASP: `https://top10.owasp.org/2025` fetched on 2026-10-20: A01 Broken Access Control, A02 Security Misconfiguration, A03 Software Supply Chain Failures, A04 Cryptographic Failures, A05 Injection, A06 Insecure Design, A07 Authentication Failures, A08 Software or Data Integrity Failures, A09 Security Logging and Alerting Failures, A10 Mishandling of Exceptional Conditions. The catalogue's 2025 tags for all eleven match. The page does not mention SSRF, so C10 = 2025 A01 rests on the project's own decision, not on that page.
- Not run: the real shop through the real pipeline on a local platform stack (only the live `scripts/e2e-live-exploits.mjs` does this, and it needs the live lab); the Postgres-backed API tests.

## Per challenge

| Challenge | Weakness (where) | Exploit test (vuln / fixed) | Hints fit the weakness | Gaps |
|---|---|---|---|---|
| C01 Broken Access Control | order detail by number with no store check (`c01-cross-store-order.mjs`) | pass / fail | yes | ownership is by store (a seller store reads a competitor store's order), not "User A / User B" accounts; same BOLA idea |
| C02 Cryptographic Failures | gift-card code is an unkeyed hash of a serial (CWE-328) | pass / fail | yes, hint 2 says "common hash, 32 hex characters" | hint 3 gives the full recipe |
| C03 Injection | A: SQL UNION in search; B: stored XSS run by the bot | pass / fail (both parts) | yes | none found |
| C04 Insecure Design | quick-refund limit checked per request, not summed | pass / fail | yes | hint 3 gives the recipe |
| C05 Security Misconfiguration | verbose error and open `/_ops/` | pass / fail | yes | hint 3 says what to request |
| C06 Supply chain | prototype pollution in the import merge (import service) | pass / fail | yes | catalogue title still the 2021 name; milestone 3 wording is not about a flag capture |
| C07 Authentication Failures | short reset code with no attempt limit | pass / fail | yes | none found |
| C08 Integrity Failures | unsigned payment webhook accepted | pass / fail | yes | none found |
| C09 Logging Failures | legacy login route skips the security log | pass / fail | yes | title lacks the word "Security" of the official name |
| C10 SSRF | blocklist by text, bypassed by another address form | pass / fail | yes | none found |
| C11 Exceptional Conditions | KYC provider error fails open | pass / fail | yes | none found |

## Evidence
Commands and results above. Catalogue dump: run `load_catalog` on `challenges/catalog`.

## Problems met and how they were fixed
The first `node --test challenges/tests` (a folder path) ran as one failing file; a glob is needed (`"challenges/tests/**/*.test.mjs"`).

## Security notes (vulnerable parts only)
No flag value or secret was read or written. All weaknesses stay in the target only; the tests in the previous entry show the platform kept its own controls (for example the activity gate holds an unsupported capture).

## Limitations and follow-ups
Gaps and proposals, each for the developer to approve (the catalogue and shop belong to Sahil's stream):
1. `fixed_build: challenges/fixed/cNN` in all eleven files points to folders that do not exist (only `.gitkeep`). The fixed build is a switch (`VM_CHALLENGE_*=fixed`). Proposal: change the field text or drop it.
2. C06 title: change to the 2025 name "Software Supply Chain Failures" (keep the 2021 name in the tags). C09: "Security Logging and Alerting Failures". Titles show in the console and the dashboards.
3. C06 milestone 3 summary: "the worker exits; the pollution does not escape" does not describe a flag capture. Needs a look by whoever wrote the signal.
4. Hint 3 of C02, C04, C05 and C10 is nearly the full recipe. The console labels hint 3 "Nearly the answer", so this may be intended. The tester brief asks for a "strong clue, leave the verification to the learner". Proposal: keep, or soften C02 and C04 only.
5. C01 scenario: keep the store-scoped order IDOR (it is a real database record exposed by a missing ownership check, with an event and a flag), or add a User A / User B wording to the start text. Not a code gap.
6. Hints are off for company assessment attempts until stream P sets them (placeholder in `hints_enabled`); not changed.
7. Run the real shop through the real pipeline on a local platform stack (today only the live script does it).
