---
id: 11
type: story
title: "The learner console shows one challenge at a time with a countdown and account points"
parent: none
covers: ["LB-13", "D-80", "ADR 0063"]
after: ["9"]
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
---

# The learner console shows one challenge at a time with a countdown and account points

## Description

The live console showed an attempt "reported", no Start button and no challenges. The developer asked for a new simple, attractive UI from a UI-library theme with a researched font, a sandbox feel, one challenge visible at a time, and points on the account.

## Acceptance Criteria

1. One challenge is the stage; a rail shows progress; the others are not shown until reached.
2. A primary action at every step: Start my lab, Begin challenge (minutes by tier), Check flag, Next challenge, Start a new run.
3. The countdown ring runs from the server's clock and a challenge that ends shows its write-up and takes no flag.
4. Account points show in the top bar; a server that is not sequenced still works.
5. Light and dark, phone width without sideways scroll, no inline script or style, self-hosted open-licence fonts.
6. A stray 401 does not sign the learner out when the session is alive.

## References

- docs/plans/2026-10-20-handoffs-h355-to-h359.md (step 11); ADR 0063