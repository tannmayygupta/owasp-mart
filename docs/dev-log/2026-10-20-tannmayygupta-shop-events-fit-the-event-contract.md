# The shop's app events fit the event contract

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | `l-tester-login-hint-bugs` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | audit of stream T, event contract, milestones |

## Requirements covered
C01, C02, C04 to C11, FR-DET-04, FR-DET-08 (IF-4 posted events, milestone rules). Story: `docs/bmad/initiative-lab/backlog/story-shop-events-fit-the-event-contract.md`.

## Summary (plain language, 3-5 lines)
While auditing the target stream I made the local proof also check the events. The shop posted events the sidecar refuses, and two events were never posted, so on the live lab the first and second milestone of most challenges could not be credited (only the flag capture worked). I fixed the shop, the mock metadata service, one milestone rule value and the C02 decoys. The local proof now passes 65 checks with no failure.

## Why
The developer asked whether everything Sahil built is wired and answers correctly, and to fix what is not.

## What was built
- Shop emitters aligned to IF-4: C01 (`order_id`, `caller_user_id`, `caller_store_id`, `order_store_id`), C02 (`user_id`, `result`, `card_class`), C04 (`refund_id`, `amount`, `cumulative_after`; invariant event `paid`, `refunded_total`), C05 (`route`), C07 (reset request with `account_id` and `account_found`; wrong tries sent as batches of up to 50 or 10 seconds; completion with `account_id`), C08 (`order_id`, `verified`, `accepted`), C09 (`failure` and `success` on the legacy route), C10 (`job_id`, url class in the contract enum), C11 (outcomes `valid`, `invalid_verbose`, `provider_error_fallback`).
- C06: the shop now posts `import.job` (source import) after each import preview: `flagged_keys`, `polluted`, `audit_token_issued`, never the token.
- C10: the metadata mock posts `meta.request_served` (`ua_class` importer, rates or health); the importer sends the user agent `VulnMart-Importer/1.0`.
- C02: the injector plants the two unsold staff test cards (serials 2 and 3) the catalogue lists as decoys; the exploit tries one before the flag card.
- Helper `apps/shop/src/challenges/event-fields.mjs` (`safeId`, `safeClass`, `safeCount`) makes a value that came from a player fit the contract.
- `scripts/e2e-local-flags.mjs`: a stand-in for the sidecar's event door validates every posted event against the contract schema and checks the events of milestone 1 and 2 against the platform's rules.

## How it works
The sidecar refuses a posted body that does not fit `instance-events.posted.schema.json` (answer 422), so the shop must send exactly the members the schema names. The proof posts nothing itself: the shop and the mock services post to its fake event door, as they post to the sidecar in an instance.

## Files changed
- `apps/shop/src/challenges/c01` to `c11` modules, `event-fields.mjs`, `domain/import-client.mjs`, `web/routes-seller.mjs`, `instance/placements.mjs`.
- `services/mock-services/src/server.mjs` — `meta.request_served`.
- `apps/api/src/vulnmart/ingest/milestone_rules.json` and `apps/api/tests/test_ingest_engine.py` — C11 value `system_kyc_fallback`; `challenges/catalog/c11.yaml` text.
- `challenges/tests/c02-gift-card-codes/*`, `challenges/tests/c11-kyc-failopen/c11.test.mjs` — the exploit path and one assertion.
- `scripts/e2e-local-flags.mjs` (and its test), story and records.

## Decisions made
No ADR (a bug fix to meet an existing contract). The only judgement: the C11 event value loses its colon (stored value unchanged), recorded in the story notes.

## Tests
- Before: `node scripts/e2e-local-flags.mjs --docker` — 52 PASS, 16 FAIL (the failures listed in the story).
- After: same command — 65 PASS, 0 FAIL. Checks skipped on purpose, with the reason printed: C03 milestone 1 and 2 (events come from the sidecar, the bot and the collector) and C11 milestone 1 (the verbose error and the fail-open need two registrations; one account registers one store).
- `node --test` in `apps/shop` — 180 tests, 177 pass, 3 skipped, 0 fail. `node --test "challenges/tests/**/*.test.mjs"` — all pass. `node --test services/mock-services/test/*.test.mjs` — 8 of 8.
- `pytest apps/api/tests/test_ingest_engine.py` and the lab tests — pass.
- Not run: the live lab; C03 part B (`challenges/tests/c03-injection/live-loop.test.mjs`) after these changes.

## Evidence
Command output above; no flag is printed by the script.

## Problems met and how they were fixed
- My first PowerShell edits of two JavaScript files lost backticks and wrote a stray carriage return; fixed with line-based edits.
- C09's `failure` and the C11 colon were mismatches between the shop and the milestone rules, not only the schema; both fixed on the shop side (and one rule value).
- The exploit of C02 jumped to the flag card, so milestone 2 was never exercised; it now takes the intended path.

## Security notes (vulnerable parts only)
The weaknesses are unchanged. The events never carry a flag, a token or a pasted value. The planted decoy cards carry a marker text, not a flag.

## Limitations and follow-ups
- Part B of C03 and the sidecar's `proxy.crs_match` are not covered by this proof.
- Sahil's task records still describe these tasks as done with the old events; the developer decides whether to annotate them.
