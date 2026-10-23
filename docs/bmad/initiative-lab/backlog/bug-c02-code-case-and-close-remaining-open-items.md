---
id: 64
type: bug
title: "C02 redeem code rejected on case, plus FR-ACH-01 hard cap, settings wiring and an admin route for a silently escalated deletion request"
parent: none
covers: ["FR-CHL-03", "FR-ACH-01", "A-10", "L-11", "A-19", "FR-PRV-08"]
after: []
assignee: "tannmayygupta"
refined: true
hitl: false
risk: low
severity: P2
---

# C02 redeem code rejected on case, plus FR-ACH-01 hard cap, settings wiring and an admin route for a silently escalated deletion request

## Description

A tester reported C02 (Cryptographic Failures) as unsolvable ("purana redeem card dhundo but voh exist ni krta" — a redeem code that should work does not). Root cause: a correctly-forged code in uppercase or mixed-case hex was rejected as "malformed code," indistinguishable from the exploit not working. Alongside the fix, the leader asked for the remaining items on a prior open-items list to be implemented end to end where tractable: the FR-ACH-01 30-per-assessment hard cap on wrong flag pastes, three of the four dead admin settings found by the 2026-10-21 wiring audit (`instance_idle_minutes`, `instance_max_minutes`, `flag_submit_per_minute`), and A-19 (an admin route to decide a candidate deletion request the company never answered).

## Reproduction (C02)

Live, 2026-10-23, against the deployed instance (`tanmay-platform-prod.duckdns.org`), audit account `player.customer@vulnmart.test`:
1. Forge the lowercase code for serial 1 (`VM-c4ca4238a0b9` = md5("1")) and redeem it. Expected and observed: succeeds, flag credited.
2. Submit the identical code in uppercase (`VM-C4CA4238A0B9`). Expected: same result (a forged code should match regardless of hex case, since MD5 tools commonly print uppercase). Observed: `{"error":"malformed code"}` (400) — the bug.

## Acceptance Criteria

1. **A forged code in any hex case redeems the flag on the vulnerable build**
   **Given** a correctly-derived code for an unredeemed serial, in any case or with surrounding whitespace
   **When** it is submitted to `redeem()`
   **Then** it is accepted and the flag is returned, exactly as a lowercase code would be.
2. **The fixed build is unaffected**
   **Given** the fixed build's random-code + keyed-hash design
   **When** the same forged-code attack is tried
   **Then** it still fails, in any case.
3. **FR-ACH-01's hard cap**
   **Given** 30 wrong pastes for one (attempt, challenge) pair, however spread out in time
   **When** a 31st is submitted, wrong or right
   **Then** it is refused with the existing rate-limit error and a long retry-after, and a different challenge or a different attempt is unaffected.
4. **Settings wiring**
   **Given** an admin changes `instance_idle_minutes`, `instance_max_minutes` or `flag_submit_per_minute`
   **When** the next instance or attempt is created
   **Then** it uses the new value, with no API restart; an attempt already running keeps what it started with.
5. **A-19**
   **Given** a candidate deletion request whose company missed `deletion_decide_days`
   **When** an admin reads the escalated list and decides it (approve or decline)
   **Then** the outcome matches what the company's own decision would have produced, audited as the admin's action; a request not yet escalated, or already decided, is refused.

## References

- source — apps/shop/src/challenges/c02-gift-card-codes.mjs
- source — apps/api/src/vulnmart/flags/submit.py, lab/pg.py, lab/runtime.py
- source — apps/api/src/vulnmart/admin/ops.py, admin/api.py, privacy/deletion.py
- decision — docs/adr/0097-settings-wiring-hard-cap-and-admin-escalated-deletion.md

## Notes

- `hints_enabled_default` (the fourth dead setting from the wiring audit) is deliberately deferred; see the ADR and the dev-log for the exact reasoning and next action.
- Not started from the leader's longer list in this pass: A-20, A-21, L-19, accessibility audit, CI additions for browser suites, a second backup location, audit-anchor automation, candidate integrity signals; blocked-by-product-decision items (C-37/R-30, OI-33, C-30/X-19) are unchanged.
