# Review the instance contract and event schema as consumer (T-03)

| Field | Value |
|---|---|
| Date | 2026-10-09 |
| Developer | Sahil Roy |
| Branch / commit | sprint-1-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 1, consumer sign-off of IF-6 and IF-4 |

## Requirements covered
TB-2 (the target stream has reviewed the instance contract IF-6 and the instance event schema IF-4 as consumer). BMAD story 1.3 of `epic-target-baseline`.

## Summary (plain language, 3-5 lines)
Reviewed the two contracts the shop builds against — the instance contract (IF-6, merged) and the instance event contract (IF-4, open PR on `shared-L-03`) — from the shop's point of view. Confirmed every open point in IF-6 the architecture left to Sahil, raised one change request (the `/version` environment names), checked that IF-4 carries every app event the 11 challenges need, and signed the versions the target stream builds against. Output is a written consumer review.

## Why
The shop and its services consume IF-6 and IF-4. The contract rules require the consumer to review and sign the versions before building against them (TB-2). IF-6 also lists open points the architecture left for Sahil to confirm.

## What was built
A consumer review and sign-off: `docs/reviews/2026-10-09-target-if6-if4-consumer-review.md`. It records, per IF-6 open point owned by Sahil, a confirm or a change request; the IF-4 event-coverage check across all 11 challenges; the one change request (CR-1); and the signed versions (IF-6 v0.1.0 conditional on CR-1, IF-4 v0.1.0).

## How it works
Not code. The review reads IF-6 (`contracts/instance/`) and IF-4 (`contracts/events/` on `origin/shared-L-03`) and speaks for the shop consumer (the T-01 skeleton and the planned T-04..T-32 flows).

## Files changed
- `docs/reviews/2026-10-09-target-if6-if4-consumer-review.md` — new; the review and sign-off.

## Decisions made
No ADR. Signed IF-6 v0.1.0 and IF-4 v0.1.0 as the versions stream T builds against. Recommended the shop-side resolution of CR-1 (bake the build id at image build, derive catalogue version from the catalogue file) so the IF-6 env allowlist stays closed with no contract change.

## Tests
No automated tests (a review artifact). Verification: every Sahil-owned IF-6 open-point row is addressed, and every `source: shop`/`import`/`mock`/`bot` event the 11 challenges rely on appears in the IF-4 catalogue (coverage table in the review).

## Evidence
The review document itself (`docs/reviews/2026-10-09-target-if6-if4-consumer-review.md`).

## Problems met and how they were fixed
IF-4 (L-03) is not merged to `main`; it is an open PR on `origin/shared-L-03`. Reviewed it from that branch (read-only via `git show`) rather than waiting for the merge, which matches the task's "open pull requests" wait.

## Security notes (vulnerable parts only)
None. The review confirms the no-flag-in-events rule and the flag-in-env reason requirement, which the shop and the catalogue validator both honour.

## Limitations and follow-ups
- CR-1 is open: Tanmay to decide the `/version` env-names question; the shop-side fix is a small follow-up, after which the deferred T-01 `/version` item closes.
- IF-6 and IF-4 sign-offs should be recorded in `contracts/COMPAT.md` when stream L creates that file.
- The sign-off is for v0.1.0; a breaking change before `contracts-v1.0.0` needs re-signing.
