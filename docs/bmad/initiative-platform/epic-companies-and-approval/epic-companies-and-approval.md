---
type: epic
title: "Recruiters join approved companies"
parent: initiative-platform
covers: [FR-ORG-01, FR-ORG-02, FR-ORG-03, FR-ORG-04, FR-ORG-05, FR-ORG-06, FR-ORG-07, FR-ORG-08]
after: []
assignee: "Akshay Gupta"
risk: medium
---

# Recruiters join approved companies

## Description

A recruiter signs up with a work email, the company waits for one admin approval, the owner approves colleagues, the company accepts the data-processing terms, and all company data is scoped in one place.

## Outcome

Only people from approved companies can invite candidates and no company can see another's data; the signal is the acceptance criteria of FR-ORG-01 to 08 and a cross-company read test failing as intended.

## Requirements

Numbered source: docs/prd/PRD.md section 5.2 (FR-ORG-01 to FR-ORG-08). Open: free email rule (OI-10), re-apply wait (OI-11).

## Done when

1. The recruiter state machine works from signup to active, rejected and suspended, including the approve and reject API an admin calls (the queue screen comes with epic-admin-and-operations), with reasons and audit entries.
2. A recruiter from company A cannot read, change or guess company B's assessments, invites or candidates (organization filter plus row-level security).
3. The data-processing terms are shown at approval and a company cannot invite before accepting them.
4. The invite cap per company is enforceable by an admin.
5. The approval-outcome email is verified through the outbox.
6. Deployed and verified on the platform VM once initiative-lab epic-environments-and-deployment is done.

## Boundaries

Companies, membership and the approve and reject API. Not invites (epic-assessments-and-invites) and not the admin queue screen (epic-admin-and-operations).

## References

- parent, docs/bmad/initiative-platform/initiative-platform.md
- prd, docs/prd/PRD.md, section 5.2
- decision, initial.md D-04, D-19
- architecture, docs/adr/0014-organization-scoping-app-filter-and-rls.md

## Notes

- Open question: free-email addresses for recruiters (OI-10) must be decided before FR-ORG-04 is built.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
