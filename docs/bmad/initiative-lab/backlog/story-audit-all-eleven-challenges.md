---
id: 2
type: story
title: "Audit the eleven challenges against the tester checklist and report gaps"
parent: none
covers: ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C11", "FR-HNT-01", "FR-HNT-02"]
after: [1]
assignee: ""
refined: false
hitl: true
risk: low
---

# Audit the eleven challenges against the tester checklist and report gaps

## Description

Check each of the eleven challenges for: a real vulnerability in the target, an exploit that passes on the vulnerable build and fails on the fixed build, three hints that fit the weakness, milestone and flag signals, scoring and persistence, the write-up and fix text, and the OWASP 2025 tag. Report gaps. Changes to the catalogue or the shop are listed for the developer to approve one by one; none is made in this story.

## Acceptance Criteria

1. **Every challenge is checked and the result is written down**
   **Given** the catalogue and the tests
   **When** the audit is done
   **Then** the dev-log holds a table with one row per challenge and a list of gaps, each with evidence.
2. **Tests were really run**
   **Given** the audit claims a challenge works
   **When** the record is read
   **Then** each claim names the command and its real result.
3. **No challenge file is changed without approval**
   **Given** a gap needs a change to the catalogue or the shop
   **When** the story closes
   **Then** it is listed as a proposal for the developer.

## References

- source — challenges/catalog/*.yaml, challenges/tests/
- source — docs/design/challenge-specs.md
- parent — docs/bmad/initiative-lab/backlog/bug-tester-cannot-see-shop-login-or-c02-hint.md

## Notes

- Decision: 2026-10-20, the developer said "start" for this audit after story 1.
- Assumption: titles and hints are Sahil's catalogue; only proposals are made here.
