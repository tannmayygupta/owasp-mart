---
title: 'Sign off contracts v1.0.0 as provider and consumer'
type: 'chore'
ticket: '8'
created: '2026-10-12'
status: 'built'
baseline_revision: 'a31021bc54015d8c90780f5180b967ccfcdb621c'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'none'
review_source: 'auto'
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/docs/dev/HANDOFFS.md'
  - '{project-root}/contracts/orchestrator/orchestrator-api.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Contracts v1.0.0 cannot be tagged (L-09) until stream P has reviewed the contracts it provides and consumes, answered its rows of the "Done checklist before contracts-v1.0.0", and recorded the versions it builds against (PB-9). The story is human-in-the-loop: the approval of the contracts pull request is Akshay's own act.

**Approach:** Prepare a sign-off review page with every checklist row addressed to Akshay (default, what is built, recommendation), have Akshay decide the flagged rows and confirm the rest in one go, record every answer in `HANDOFFS.md`, and write `contracts/COMPAT.md` with stream P's versions.

**Decisions (developer, 2026-10-12):** batch review; COMPAT.md created with stream P's rows; the story stays `built` until Akshay approves the L-09 pull request. F-1: Tanmay writes the `events` migration (identity `(instance_id, epoch, seq)`), Akshay approves. F-2: the sign-off requires IF-2, IF-4 and IF-5 to move to the IF-8 error body before the tag (H-114). F-3: an impossible state-report transition is answered 204, stored as history, not applied, and alerted. All other rows confirmed as on the review page.

</frozen-after-approval>

## Implementation Notes

- Oneshot: documents only (no code). Files: `docs/reviews/2026-10-12-p08-contract-sign-off.md` (the review), `contracts/COMPAT.md` (stream P's nine rows; the rules engine's `compat` check passes), `docs/dev/HANDOFFS.md` (H-01 to H-04, H-07, H-08, H-10 to H-18, H-83 answered; H-114 added for Tanmay; checklist ticks), `docs/dev/dev1-tanmay.md` (Handoffs line of L-09), ADR 0023 (note on the events migration).
- Remaining human step: Akshay approves the contracts pull request of L-09 on GitHub when Tanmay opens it; then the ticket is marked done.

## Verification

**Commands:**
- `node scripts/check-contract-rules.mjs` -- result: 15 PASS, 0 FAIL (compat: 9 rows, every listed version exists)
- `node --test "scripts/*.test.mjs"` -- expected: all pass
