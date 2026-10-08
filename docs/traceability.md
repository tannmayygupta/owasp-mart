# Traceability matrix

Requirement -> code -> test -> result. Updated with every task (rule in `CLAUDE.md`). IDs come from `initial.md`.
Status values: Not started / In progress / Done / Blocked. Fill "Result" only with real test outcomes.

## Functional requirements

| ID | Requirement (short) | Status | Code | Tests | Result | Dev-log |
|---|---|---|---|---|---|---|
| F1 | Provision isolated instance per user in bounded time | Not started | | | | |
| F2 | 11 challenges tagged OWASP 2025 + 2021, each exploitable end to end | Not started | | | | |
| F3 | Unique per-instance flags, automatic detection + paste-the-flag | Not started | | | | |
| F4 | Learner dashboard (hints, progress, flags, solution after solving) | Not started | | | | |
| F5 | Recruiter dashboard (score, time, technique, tags, evidence, hints used) | Not started | | | | |
| F6 | Tear down / reset after configurable inactivity | Not started | | | | |
| F7 | Log every attempt and capture; no cross-user visibility | Not started | | | | |
| F8 | Multiple concurrent isolated instances on one host | Not started | | | | |
| F9 | Recruiter signup, email verification, admin approval, candidate invites | Not started | | | | |
| F10 | Consent screen, retention + auto-delete, result export, audit log | Not started | | | | |
| F11 | Per-assessment hint settings, score never below zero | Not started | | | | |

## Challenges (D-06)

| ID | Theme | 2021 / 2025 tag | Status | Code | Tests (exploit verified) | Result | Dev-log |
|---|---|---|---|---|---|---|---|
| C01 | Broken Access Control | A01 / A01 | Not started | | | | |
| C02 | Cryptographic Failures | A02 / A04 | Not started | | | | |
| C03 | Injection | A03 / A05 | Not started | | | | |
| C04 | Insecure Design | A04 / A06 | Not started | | | | |
| C05 | Security Misconfiguration | A05 / A02 | Not started | | | | |
| C06 | Outdated Components / Supply Chain | A06 / A03 | Not started | | | | |
| C07 | Authentication Failures | A07 / A07 | Not started | | | | |
| C08 | Software or Data Integrity Failures | A08 / A08 | Not started | | | | |
| C09 | Logging (and Alerting) Failures | A09 / A09 | Not started | | | | |
| C10 | Server-Side Request Forgery | A10 / A01 | Not started | | | | |
| C11 | Mishandling of Exceptional Conditions | none / A10 | Not started | | | | |
