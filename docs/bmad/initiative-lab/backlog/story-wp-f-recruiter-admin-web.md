---
id: 63
type: story
title: "Recruiter and admin dashboards complete, cohort board screen, browser and accessibility tests (work package F)"
parent: none
covers: ["FR-DSH-02", "FR-DSH-05", "FR-ORG-02", "FR-ORG-03", "FR-ORG-08", "FR-ASM-01", "FR-ASM-03", "FR-SES-07", "FR-SCR-07", "FR-ADM-01", "FR-PRV-08", "FR-ACC-09", "OI-30", "D-93"]
after: []
assignee: "tannmayygupta"
refined: true
hitl: false
risk: medium
---

# Recruiter and admin dashboards complete, cohort board screen, browser and accessibility tests

## Description

The audit gaps R-05, R-06, R-08, R-09, R-14, R-17, R-24, R-26, R-28, A-04, A-24 and OI-30: the recruiter and admin screens draw every route that exists on main (template new and edit, invite actions single and bulk, cancel attempt, cohort board, colleagues, deletion requests, delete a record, company directory with the invite cap and suspend, reinstate, delete, change email), and every main page is checked with axe-core in a real browser.

## Acceptance

- Browser suite: recruiter, admin, account and accessibility specs pass against the production build (`pnpm --filter "@vulnmart/web" test:e2e`).
- No screen draws a control for a route that does not exist; every API refusal is shown in words.
- ADR 0076; dev-log; changelog; traceability row WP-F; role-scenario rows updated.

## Follow-ups (not done here)

- Break-glass opened in the browser on a real candidate attempt (the suite has none for an admin to open).
- Manual screen-reader and mobile pass.
- The deletion requests that were escalated to the admins (A-19) have no admin screen: the company sees the escalated mark only.