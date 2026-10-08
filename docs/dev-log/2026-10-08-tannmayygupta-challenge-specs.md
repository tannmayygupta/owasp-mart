# Challenge specifications and decisions DC-1 to DC-15 (D-32)

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Developer | tannmayygupta (with Claude Code) |
| Branch / commit | `main`, committed locally, not pushed |
| Status | Done as baseline design; refined per story during implementation |
| Report tag | Design: challenge catalogue |

## Requirements covered
FR-CHL-01 to FR-CHL-17, FR-DET-05, FR-SCR-01 to FR-SCR-03; resolves PRD open items OI-16 to OI-20; decision D-32.

## Summary
A research agent completed the design of all 11 challenges (13,000 words): start state, milestone events M1 to M3 with exact detection signals, flag location, hints, write-up outline, tags, test outline and risks. It also designed the missing stored-XSS part of C03, fitted C04 into the refund model, set the difficulty-to-tier mapping, and listed seeded accounts, cross-challenge conflicts, an event catalogue and a shop feature checklist. The user accepted all 15 recommended decisions.

## Why
The PRD left five items open (OI-16 to OI-20) and could not state milestones, so the shop developer and the scoring engine had nothing precise to build against.

## What was built
`docs/design/challenge-specs.md` (new). `initial.md` D-32. PRD statuses updated for FR-CHL-04, FR-CHL-05, FR-CHL-11, FR-CHL-17, FR-DET-05 and a note on the open-item register.

## How it works
Each challenge defines three automatic milestones. A platform rule gives the best milestone reached on any valid path once (20, 40, 100 percent). C03 combines two independent parts; C04 hides one missing check in a separate "quick refund" path; the support bot is limited to tickets and its profile so one exploit cannot solve another challenge.

## Files changed
New `docs/design/challenge-specs.md`, this entry. Changed `initial.md`, `docs/prd/PRD.md`, `CHANGELOG.md`.

## Decisions made
D-32 (DC-1 to DC-15, all recommended options). Industry evidence in `initial.md` D-32.

## Tests
No code. The lead checked the file structure, read the C03 and C04 sections, and scanned for real-looking flags, keys or secrets (0 matches). Checked against sources: OWASP A09:2025 (CWE-778 listed), PortSwigger logic-flaw and SSRF pages, PortSwigger and Hack The Box difficulty tiers, assessment-platform partial credit. Not run: any exploit test, the spikes (Node 24 prototype pollution, SQLite ATTACH and load_extension, host blocking, bot tagging).

## Evidence
Links in `initial.md` D-32. No screenshots.

## Problems met and how they were fixed
1. The agent proposed 15 decisions, some of which interact (the bot scope protects C01 and C09; C10 start state avoids depending on C11). The interactions are written into the cross-challenge conflict section.
2. A tool fetch redirected for the OWASP testing guide page; it was not needed and was skipped.

## Security notes
No flag values appear in the spec. Cross-challenge isolation rules (separate catalog store, isolated import service, allow-listed bot session, synthetic diagnostics object, forged-paid orders not refundable) are the main design protection.

## Limitations and follow-ups
- The 11 cards were skim-checked, not line-reviewed; each story's acceptance criteria must re-check them.
- DC-11 needs confirmation by the owner of the shop-to-platform contract once the work-streams are assigned.
- Decoy flag locations are not placed. WSTG IDs and some tag fits are unverified.
