---
id: 41
type: story
title: "The learner and candidate screens of apps/web follow the sequenced run and the mode, with real browser tests"
parent: none
covers: ["F-14", "F-16", "FR-DSH-01", "FR-DSH-04", "FR-NTF-04", "D-80", "ADR 0063", "ADR 0070"]
after: ["11"]
assignee: ""
refined: true
hitl: false
risk: medium
severity: P1
---

# The learner and candidate screens follow the sequenced run and the mode

## Description

Audit finding F-14 (docs/audit/2026-10-21-wiring-audit.md): the lab is deployed with `VULNMART_LAB_SEQUENCE=1`, but the Next.js dashboards cannot begin a challenge (no `beginChallenge`, no `current_key`), so flags and hints answer 409 for a learner there. Gap 2 and 7 of the same audit: a learner and a candidate attempt must never be drawn as each other, and no browser test had ever run the learner or candidate flow.

## Acceptance Criteria

1. **Sequenced learner run in apps/web**
   **Given** a learner on a lab with sequenced runs
   **When** they start a run, begin a challenge, reveal a hint, paste the flag and go on
   **Then** one challenge is on stage with its own countdown drawn from the server clock, nothing ahead is listed, the account points show, a challenge that runs out shows its write-up, and a finished run offers a new run.
2. **Mode is never mixed**
   **Given** an account with a practice run and a company assessment
   **When** the dashboard, the assessment page or the lab console is opened
   **Then** a candidate attempt is never drawn as practice (the console and the dashboard only link to /assessment/<id>) and a practice run is never drawn as an assessment.
3. **Candidate screens**
   **Given** an invited candidate
   **When** they accept, consent, start, work, submit or withdraw
   **Then** the clock starts when the instance is ready, the 15 and 5 minute warnings show, hints show only when the attempt says `hints_enabled`, results show only after the attempt ended and when the invite allows or the recruiter released them, a withdrawal can be undone while the deletion is scheduled, and a closed invite has its own message.
4. **Real browser tests**
   **Given** the production build of apps/web and the real API app on a throw-away database
   **When** `pnpm --filter @vulnmart/web test:e2e` runs
   **Then** sign-up, the learner flow, the candidate flow and the recruiter release pass in a real browser; unit tests cover the countdown and skew arithmetic, the mode filter and the state selection.

## References

- docs/audit/2026-10-21-wiring-audit.md (F-14, F-16, section 6 gaps 2 and 7), docs/audit/2026-10-21-role-scenarios.md
- docs/adr/0063 (sequenced runs), docs/adr/0070 (browser tests)

## Notes

- Out of scope and untouched by this story: the company, admin and recruiter pages, the invite actions, apps/api/src, contracts.