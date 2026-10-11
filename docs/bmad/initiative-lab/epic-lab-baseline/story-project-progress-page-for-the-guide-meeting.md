---
id: 14
type: story
title: "Project progress page for the guide meeting"
parent: epic-lab-baseline
covers: [LX-3]
after: [13]
hitl: false
risk: low
---

# Project progress page for the guide meeting

## Description

A small local website (node scripts/progress-page.mjs --serve) that tells a visitor what VulnMart is, shows that it is achievable through what already runs, and lists, for the Lab, the Platform and the Target stream, what is done, what is being implemented and what is next. It is generated from the three developers' task files (each can be read from the developer's own branch), no dependency, no charts, no secrets. Needed for the college guide meeting.

## Acceptance Criteria

Verify: The page serves on 127.0.0.1 and shows all three streams with task statuses taken from the task files; statuses follow the ticks and the sprint dates; the text check, secret scan and unit tests pass.

## References

- parent — docs/bmad/initiative-lab/epic-lab-baseline/epic-lab-baseline.md
