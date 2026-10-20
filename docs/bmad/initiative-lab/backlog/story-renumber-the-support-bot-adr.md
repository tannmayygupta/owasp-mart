---
id: 7
type: bug
title: "Two decision records are numbered 0058"
parent: none
covers: ["H-357"]
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P3
---

# Two decision records are numbered 0058

## Description

Handoff H-357 from Akshay: `docs/adr/` holds two records numbered 0058, the candidate invite routes (Akshay, merged first) and the support bot in jsdom (Tanmay). A number must name one record.

## Reproduction

`Get-ChildItem docs/adr -Filter 0058-*` lists two files.

## Cause Hypothesis

Two branches took the same next free number and the second merge did not renumber.

## Acceptance Criteria

1. **One record per number**
   **Given** the folder `docs/adr`
   **When** it is listed
   **Then** the support-bot record is `0061-...` and `0058-...` names only the invite routes.
2. **References follow**
   **Given** every place that cites the jsdom decision
   **When** they are searched
   **Then** they say ADR 0061 (comments in the bot service, its Dockerfile, the changelogs, the traceability row, the dev-log, the index); references to Akshay's 0058 are unchanged.
3. **Handoff closed**
   **Given** `docs/dev/HANDOFFS.md`
   **When** row H-357 is read
   **Then** it says done with the date and what changed.

## References

- parent — docs/plans/2026-10-20-handoffs-h355-to-h359.md
- source — docs/dev/HANDOFFS.md row H-357

## Notes

- Decision: 2026-10-20, the number 0061 (free) as the handoff proposed; 0062 is Akshay's and 0063 is this branch's.
