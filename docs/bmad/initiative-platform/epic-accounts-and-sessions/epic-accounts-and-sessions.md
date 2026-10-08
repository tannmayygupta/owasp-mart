---
type: epic
title: "People can register, log in and stay secure"
parent: initiative-platform
covers: [FR-ACC-01, FR-ACC-02, FR-ACC-03, FR-ACC-04, FR-ACC-05, FR-ACC-06, FR-ACC-07, FR-ACC-08, FR-ACC-09, FR-ACC-10, FR-ACC-11]
after: []
assignee: "Akshay Gupta"
risk: medium
---

# People can register, log in and stay secure

## Description

Learners, candidates, recruiters and admins can register or be created, verify email, log in with server-side sessions, use multi-factor login where required, reset passwords and manage their account, with abuse protection and the account-type separation of D-19.

## Outcome

Every kind of user can get in and stays safe; the signal is the acceptance criteria of FR-ACC-01 to 11 passing on the deployed site and the ASVS level 2 authentication items evidenced.

## Requirements

Numbered source: docs/prd/PRD.md section 5.1 (FR-ACC-01 to FR-ACC-11). Open: CAPTCHA (OI-29), recruiter MFA later (OI-13).

## Done when

1. Signup, email verification, login, logout, session timeouts and password reset work on the deployed site with the cookie and CSRF rules of NFR-SEC-03; the account-deletion request endpoint exists and the deletion workflow is delivered by epic-privacy-audit-and-keys.
2. A Recruiter or Admin account cannot hold the Learner or Candidate role, and an Admin without TOTP cannot reach any admin function.
3. Error messages never reveal whether an email has an account, and repeated failures throttle without permanent lockout.
4. The ASVS authentication and session items for these requirements are checked with real test results.

## Boundaries

Identity, sessions and account types. Not companies (epic-companies-and-approval) or admin screens (epic-admin-and-operations).

## References

- parent, docs/bmad/initiative-platform/initiative-platform.md
- prd, docs/prd/PRD.md, section 5.1
- decision, initial.md D-19 and D-21
- constraint, docs/architecture/06-security.md

## Notes

- Decision: server-side session cookies with Argon2id (D-21); Argon2id cost tuned in spike S-12.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
