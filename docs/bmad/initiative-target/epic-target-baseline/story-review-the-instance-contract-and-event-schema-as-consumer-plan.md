---
title: 'Review the instance contract and event schema as consumer'
type: 'chore'
ticket: '3'
created: '2026-10-09'
status: built
baseline_revision: 'a8cb691'
route: 'full'
route_source: 'pinned'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/contracts/instance/instance-contract.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The shop (T) builds against the instance contract (IF-6) and the instance event contract (IF-4), but the target stream has not reviewed them as a consumer or signed the versions it builds against (TB-2). IF-6 lists open points the architecture left to Sahil to confirm; IF-4 needs its shop-produced event names checked.

**Approach:** Review IF-6 (merged on `main`) and IF-4 (open PR on `origin/shared-L-03`) from the shop's perspective, confirm or push back on each open point owned by Sahil, raise change requests through the contract rules, and record the signed versions stream T builds against. The deliverable is a written consumer review and sign-off; no shop code changes here.

## Boundaries & Constraints

**Always:** Record real findings as a consumer. Sign only the versions actually reviewed (IF-6 v0.1.0, IF-4 v0.1.0). Raise contract changes as review comments for the owner (Tanmay) to merge, not by editing another stream's contract directly. Keep the review in `docs/` (co-owned).

**Never:** Do not edit `contracts/instance/` or `contracts/events/` content (that is a contract change through the owner's PR). Do not change shop code in this story. Do not invent answers to platform-owned open points (OI-23 etc.).

</frozen-after-approval>

## Code Map

- `contracts/instance/instance-contract.md` -- READ ONLY; IF-6, open-points table (rows owned by Sahil).
- `contracts/instance/*.schema.json` -- READ ONLY; injection, flags-file, instance-template schemas.
- `contracts/events/app-events.md`, `instance-events.posted.schema.json` (on `origin/shared-L-03`) -- READ ONLY; IF-4, the app events the shop produces.
- `apps/shop/` (on this branch) -- the consumer whose needs the review speaks for (T-01 skeleton).
- `docs/reviews/2026-10-09-target-if6-if4-consumer-review.md` -- new; the review and sign-off.

## Tasks & Acceptance

**Execution:**
- [ ] `docs/reviews/2026-10-09-target-if6-if4-consumer-review.md` -- write the consumer review: per-open-point confirmation for IF-6, the IF-4 event-coverage check, the change requests, and the signed versions.

**Acceptance Criteria:**
- Given every IF-6 open point owned by Sahil, when reviewed, then each is confirmed or has a written change request.
- Given the IF-4 event catalogue, when checked against the 11 challenges' milestone signals, then every shop-produced event the challenges need is present (or a change request names the gap).
- Given the review, when finished, then it records the versions stream T signs (IF-6 v0.1.0, IF-4 v0.1.0) and any condition on them.

## Implementation Notes

- 2026-10-09: Wrote `docs/reviews/2026-10-09-target-if6-if4-consumer-review.md`. Reviewed all 21 IF-6 open-point rows owned (or co-owned) by Sahil and confirmed each; the one change request (CR-1) is the `/version` env names vs the 13-name allowlist (open point 25), carried from the T-01 review, with a recommended shop-side fix that needs no contract change. Checked IF-4 (on `origin/shared-L-03`): all 18 shop/import/mock/bot event types the 11 challenges need are present; no IF-4 change request. Signed IF-6 v0.1.0 (conditional on CR-1) and IF-4 v0.1.0.
- No shop code changed. CR-1's shop-side fix is a follow-up; the deferred `/version` env item stays open until then.

## Plan Change Log

## Design Notes

This is a review/sign-off chore, not code, so the cycle's build/code-review/e2e steps collapse into writing and self-checking the review document. Change requests are filed as review comments for the contract owner; the one substantive request (the `/version` env-var names vs the IF-6 env allowlist) is carried from the T-01 review's deferred item.

## Verification

**Manual checks (if no CLI):**
- Every Sahil-owned open-point row in the IF-6 table is addressed in the review.
- Every `source: shop` / `import` / `mock` / `bot` event the 11 challenges rely on appears in the IF-4 catalogue and in the review's coverage list.
