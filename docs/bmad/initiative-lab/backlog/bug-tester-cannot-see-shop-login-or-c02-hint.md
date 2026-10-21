---
id: 1
type: bug
title: "Tester cannot see the shop login in the Network panel and does not see the Cryptographic Failures hint"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
---

# Tester cannot see the shop login in the Network panel and does not see the Cryptographic Failures hint

## Description

A tester working through Broken Access Control (C01) could not find the shop login request, with the email and password, in the browser Network panel, and saw a gateway-looking request path. The same tester pressed the hint button of Cryptographic Failures (C02) and did not see the hint. Both should work for a learner: the login request and its form fields are visible, and each revealed hint stays readable on the page.

## Reproduction

Local, on 2026-10-20, headless Chrome driven over the DevTools protocol:

1. Start the real shop in the vulnerable C01 build, open `/login`, submit the harbor staff account. Expected and observed: `POST /login` with form fields `csrf`, `email`, `password`, then `302` to `/shop`.
2. Start the real lab API (fake instance host) and the real console, sign in as a learner, press Start, open C02, press Reveal three times. Expected and observed: hints 1, 2 and 3 of the catalogue appear on the page, in order, and stay.
3. Not reproduced: the live lab (needs a login the assistant may not type).

## Cause Hypothesis

- A: the console opens the shop in a new tab (`window.open`, opener removed). DevTools opened on the console tab shows none of it. In the shop tab, the login is a form post followed by a redirect, and Chrome clears the Network list on navigation unless Preserve log is ticked. The first request a learner sees after Open is the gate entry `/_vm/enter?t=...`. No code path hides the fields. Unverified: the Preserve-log behaviour (not observable over the protocol).
- B: before commit 45683c2 (2026-10-20) a revealed hint appeared only in a one-line status message and the button read "Hint (0/3)". The live console may predate that commit. Separately, the live e2e hint check accepts the "not written yet" placeholder (35 characters, limit 20), so a missing catalogue file would still pass.

## Acceptance Criteria

1. **The learner is told where to look for the login request**
   **Given** a ready instance in the console
   **When** the learner reads the Open area
   **Then** it says the shop opens in a new tab, that DevTools must be opened in that tab, and that Preserve log must be ticked.
2. **A hint that is not written cannot pass the live check**
   **Given** the live end-to-end hint sweep
   **When** a hint text equals the placeholder
   **Then** the sweep fails for that challenge and level.
3. **A hint reveal that fails is shown next to the hint**
   **Given** an attempt where the unlock call answers an error
   **When** the learner presses Reveal
   **Then** the error text appears on that hint row, not only in the status line.
4. **Tests cover the fixes**
   **Given** the suite
   **When** it runs
   **Then** console tests cover criteria 1 and 3, and a script test covers criterion 2.

## References

- source — challenges/catalog/c01.yaml, c02.yaml
- source — apps/lab-console/app.js
- source — scripts/e2e-live.mjs, section "hint ladder"

## Notes

- Decision: 2026-10-20, the developer chose bug story A and B first; the all-challenge audit is a later story.
- Decision: 2026-10-20, local reproduction first, then the live lab. The live step needs the developer to sign in (the assistant does not type passwords).
- Open question: which console build the tester used (before or after 45683c2) and whether Preserve log was on.
