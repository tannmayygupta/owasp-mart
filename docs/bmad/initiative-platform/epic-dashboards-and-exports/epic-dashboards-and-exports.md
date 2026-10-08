---
type: epic
title: "Four role dashboards and data export"
parent: initiative-platform
covers: [FR-DSH-01, FR-DSH-02, FR-DSH-03, FR-DSH-04, FR-DSH-05, FR-DSH-06, FR-HNT-01, FR-HNT-02, FR-HNT-03, FR-EXP-01, FR-EXP-02, FR-EXP-03, FR-EXP-04]
after: []
assignee: "Akshay Gupta"
risk: medium
---

# Four role dashboards and data export

## Description

The learner, candidate, recruiter and admin dashboards show the right data to the right person, hints work in the UI, and users can export their data, with the privacy wall in every view.

## Outcome

Learners and recruiters get the two role-based views the project exists for; the signal is the acceptance criteria of FR-DSH, FR-HNT and FR-EXP passing on the deployed site.

## Requirements

Numbered source: docs/prd/PRD.md sections 5.11, 5.13 and 5.15 (FR-HNT-01 to 03, FR-DSH-01 to 06, FR-EXP-01 to 04). Open: result timing (OI-15), recruiter export (OI-27), browsers and accessibility (OI-30).

## Done when

1. The learner dashboard shows catalogue, stars, hints, flags, write-up after solving and instance controls; a learner sees only their own data.
2. The recruiter dashboard shows score, time, technique, tags, evidence, hints and integrity flags per candidate, and every view is audit-logged; the recruiter never sees practice history.
3. Automated tests try to read other users' and other companies' data with every role and all fail (FR-DSH-06).
4. Candidate and learner export produce a zip of JSON and CSV with no flag values and no other user's data.

## Boundaries

The dashboards and exports. Not scoring (initiative-lab) and not the catalogue content (initiative-target).

## References

- parent, docs/bmad/initiative-platform/initiative-platform.md
- prd, docs/prd/PRD.md, sections 5.11, 5.13, 5.15
- decision, initial.md D-05, D-08, D-22

## Notes

- Handoff: dashboards consume IF-2 (lab API) and IF-7 (catalogue); build against the Prism mock and the 11 catalogue stubs until real.
- Draft written 2026-10-08 by Claude Code for the user to approve; not yet confirmed.
