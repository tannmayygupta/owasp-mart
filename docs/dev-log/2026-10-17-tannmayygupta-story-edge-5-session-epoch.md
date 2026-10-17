# One active browser session end to end, handoffs and the vm-i runbook (edge story 5)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-3-tanmay`, baseline `601ba11` (not committed when this entry was written) |
| Status | Partly done: gate half proven locally, handoffs, ADR text and runbook written; the platform half (sessions, login bump) is Akshay's and not built; nothing run on vm-i or in a browser |
| Report tag | one active session, access epoch, FR-SES-11, FR-INS-10, D-65, D-67 |

## Requirements covered
FR-SES-11, FR-INS-10; decisions D-65 and D-67 (Proposed, not confirmed by the developer); handoffs H-64, H-75 (answered), H-340 to H-344 (new). Tasks L-17 and L-18 stay unticked until the developer confirms.

## Summary (plain language, 3-5 lines)
The PRD says a new login invalidates the older browser session for that attempt. The gate half of this is the access epoch: every open and every login raises it, and the gate refuses any cookie or ticket of an older epoch. A new test proves that locally. The platform half is written down as handoff rows for Akshay. A runbook lists the live steps for vm-i.

## Why
FR-SES-11 was split between the platform and the gate and nobody had written who does what.

## What was built
`apps/edge/test/session-epoch.test.mjs` (7 tests), handoff rows H-340 (ticket order), H-341 (login bump and platform session invalidation), H-342 (ingest port shape), H-343 (admin reachability, mine), H-344 (Sahil, shop behind the edge), notes on H-64 and H-75, ADR 0004 and ADR 0005 and ADR 0010 text, a note in `docs/architecture/03-origins-and-access.md`, `docs/runbooks/edge-vm-i.md` and a pointer (Part F) in `docs/runbooks/deploy.md`.

## How it works
Rule (D-65): the platform raises the access epoch on every open and login through IF-5 `access`; the orchestrator pushes the gate first; the gate refuses an older epoch; the platform invalidates its own older session at login. The gate never learns accounts or sessions.

## Files changed
- New: `apps/edge/test/session-epoch.test.mjs`, `docs/runbooks/edge-vm-i.md`, `docs/assets/story-edge-5-session-epoch/test-output.txt`
- Text: `docs/dev/HANDOFFS.md` (new section at the end, two notes), `docs/adr/0004-*.md`, `0005-*.md`, `0010-*.md`, `docs/architecture/03-origins-and-access.md`, `docs/runbooks/deploy.md`
- Not done: the separate message file for Akshay (the handoff rows hold the same content)

## Decisions made
D-65 and D-67 as in ADR 0004 (Proposed). PRD FR-SES-11 is Locked and states the rule, so nothing was left open on the second session; no assumption beyond the written proposal was needed. One choice of mine: if the login bump call to the orchestrator fails, the login still succeeds and the bump is retried (H-341, a default for Akshay to confirm).

## Tests
- `node --test apps/edge/test/session-epoch.test.mjs`: 7 passed.
- `node --test apps/edge/test/*.test.mjs`: 103 passed (96 before).
- `node scripts/scan-secrets.mjs`: PASS. `node scripts/check-text-files.mjs`: no FAIL in the files of this story.
- `node scripts/check-docs.mjs` was not run (it checks the commit; the CHANGELOG, traceability and tracker are the main session's).
Traceability rows (for the developer to add): FR-SES-11, FR-INS-10.

## Evidence
`docs/assets/story-edge-5-session-epoch/test-output.txt`.

## Problems met and how they were fixed
Frozen and closed instances answer with the paused and ended pages, not the 403 page, so the first version of the test, which expected 403 everywhere, failed twice; the test now expects any refusal for those states. The first rotation test did not prove removal of the previous key; rewritten to sign with the previous key and then remove it.

## Security notes (vulnerable parts only)
Not a vulnerable part. Known gap: between a login and a successful epoch bump, an older tab still works (H-341). The platform cannot make the gate learn a login any other way by design.

## Limitations and follow-ups
Live proof (certificate, DuckDNS wildcard S-16, vm-i, private link, real browser) is open until the developer runs `docs/runbooks/edge-vm-i.md`. The platform sessions and the real `InstancePort` are Akshay's (H-340, H-341).