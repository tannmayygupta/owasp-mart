---
id: 12
type: story
title: "The invite and the attempt move together; the template's settings, the quotas and the rate limits reach the lab"
parent: none
covers: ["F-05", "F-06", "F-07", "F-08", "FR-SES-07", "FR-HNT-02", "FR-ASM-01", "FR-ADM-05", "D-102"]
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P1
---

# The invite and the attempt move together; the template's settings, the quotas and the rate limits reach the lab

## Description
From the wiring audit (F-05, F-06, F-07, F-08, section 3) and the role-scenario audit: an invite never became `started`, a revoked or expired invite left a startable attempt, the template's challenge subset, hints, hint cost and flag limit were stored and ignored, the admin's quotas were write-only, the costly lab routes had no rate limit, the deployed API could silently fall back to fakes, and a learner's held capture could never be released.

## Acceptance Criteria
1. Start moves a consented invite to `started`; a started invite does not expire. A revoked, declined, expired or cancelled invite makes Start answer 409 and cancels the attempt; `revoke` and the scheduler's expiry cancel a ready attempt.
2. A repeat invite after a closed one takes the next generation and gets an attempt of its own (no dangling attempt id).
3. The template's challenge subset, hints mode, hint cost (percentage times the level), flags per minute and write-up flag reach the attempt rules; the lab lists, scores, hints and accepts flags only for the attempt's own challenges; the score is out of 1000 over them.
4. The admin's user, company and platform quotas are enforced at the start, with places reserved for assessments; practice and assessment are counted apart.
5. The costly routes (instance start, ticket, stop, reset, release, cancel, integrity decision) have per-account hourly limits that are admin settings.
6. Staging and production refuse to start with a fake instance host or an in-memory lab store.
7. A learner's practice never holds a capture (flag only).
8. The recruiter can cancel a ready or running attempt (`cancelAttempt`, IF-2 2.2.0).
9. A full platform or a busy orchestrator is 503 `INST-NO-CAPACITY` with `Retry-After` (IF-8 2.0.0), never a 429.
10. A candidate's withdrawal writes the `withdrawn` consent record once; an undo keeps the attempt withdrawn and a re-invite gives a fresh attempt.
11. A practice run and an assessment of the same person stay separate (own instance, own counting, own list entry) and a recruiter reads nothing of the practice.

## References
- docs/audit/2026-10-21-wiring-audit.md (F-05 to F-08, sections 3 to 6), docs/audit/2026-10-21-role-scenarios.md

## Notes
- 2026-10-21: implemented by the leader and Claude, status in-review. Decisions and the research are in ADR 0071. Tests: `test_invite_lifecycle.py`, `test_template_settings_reach_the_lab.py`, `test_lab_quota.py`, `test_lab_production_guard.py` (real routes and real services; only the orchestrator and the mail provider are fakes). Not done here: the candidate write-up, the mails for cancel and withdrawal (the notification work), the recruiter buttons in the web app, and the live check of the new routes after deploy.
