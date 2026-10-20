---
id: 4
type: story
title: "A modern shop interface that keeps every challenge working"
parent: none
covers: ["FR-SHP-01", "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C11"]
after: [3]
assignee: ""
refined: false
hitl: true
risk: medium
---

# A modern shop interface that keeps every challenge working

## Description

The shop pages were plain browser defaults. The developer asked for a modern interface and a unique experience for the learner. The look stays a believable everyday marketplace (no hacker theme, FR-SHP-01). Layout, styling and navigation change. Forms, field names, routes, escaping and every vulnerable path stay as they are.

## Acceptance Criteria

1. **One theme for every page**
   **Given** any shop page
   **When** it is opened
   **Then** it uses the shared top bar, theme and footer, in light or dark to match the browser, and it works at phone width.
2. **The top bar fits the role**
   **Given** a signed-in customer, seller, support agent, finance user or admin
   **When** the top bar is read
   **Then** it shows the links that role can open and marks the current page. It does not link the C05 operations area or the pages that hold the C07 and C09 flags.
3. **Challenges keep working**
   **Given** the new templates
   **When** the exploit tests and the local flag proof run
   **Then** every challenge still passes and still returns its own flag.
4. **No outside resources**
   **Given** the shop has no network
   **When** a page loads
   **Then** it needs no font, script or image from outside; the theme is inline.

## References

- parent — docs/bmad/initiative-lab/backlog/story-catalogue-fixes-and-local-flag-proof.md
- source — docs/design/challenge-specs.md (FR-SHP-01 neutral marketplace look)

## Notes

- Decision: 2026-10-20, the developer asked for a modern interface for the shop and for it to be ready end to end.
- Assumption: the navy, sand and coral palette and the lettered product tiles (no product photos) are acceptable; the developer can change them.
