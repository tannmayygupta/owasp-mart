# Contract sign-off, current versions (story P-08, stream P)

**Date:** 2026-10-20. **Reviewer:** Akshay (stream P), with Claude Code, at the developer's request "complete sprint 1 remaining task". **Replaces** the review of 2026-10-12 (`2026-10-12-p08-contract-sign-off.md`), which was against IF-4 0.2.0, IF-6 0.2.0 and DB 0.2.0 and does not satisfy the tag (COMPAT.md).

## What was checked

All checks run on main at `493ecb6` plus this branch (output: `docs/assets/p-08-contract-sign-off-current/contract-checks-2026-10-20.txt`):

| Check | Result |
|---|---|
| `node scripts/validate-contracts.mjs` | PASS (4 schemas, 7 valid and 192 invalid examples) |
| `node scripts/validate-events.mjs` | PASS (29 event types, 29 valid events, 3 signed envelopes, 6 valid posted bodies, 69 invalid examples) |
| `python scripts/check_orchestrator_contract.py` | PASS (9 operations, 20 valid and 74 invalid examples) |
| `python scripts/check_lab_contract.py` | PASS (20 operations, 41 valid and 101 invalid examples) |
| `python scripts/check_platform_contract.py` | OK (66 operations; bundle valid) |
| `node scripts/validate-catalog.mjs` | OK (11 entries) |
| `node scripts/check-contract-rules.mjs` | 16 PASS, 0 FAIL, 1 not applicable |
| `node scripts/tag-contracts.mjs --dry-run` | versions and release labels PASS; the approvals now fail only on Sahil's IF-6 row (signs 1.0.0, the contract is 1.0.1); 18 checklist lines are Sahil's or Tanmay's, and H-79 needs Tanmay too |

## As owner

| Contract | Version | What changed since 1.0.0 | Decision |
|---|---|---|---|
| IF-1 | 1.6.0 | Additive only: deletion and view history (1.1.0, P-25), candidate invites (1.3.0, P-26), recruiter routes (1.4.0, P-27), exports (1.5.0, P-29), audit log and break-glass (1.6.0, P-31); the admin area (1.2.0, P-28). No `BREAKING:` entry; no new error code. | **approved** at 1.6.0. Note: the OpenAPI `info.version` of `platform.openapi.yaml` still says 1.0.0 (each additive entry left the label to the owner's confirmation); the tag procedure (L-09) decides whether labels must match. |
| IF-3 | 1.0.0 | No change. | **approved** |
| IF-8 | 1.0.0 | No change (the codes added on 2026-10-12 for F-2 are in 1.0.0). | **approved** |
| DB | 2.1.0 | 2.0.0: five lab tables (Tanmay); 2.1.0: `data_views` (P-25). `break_glass_sessions` was already listed (architecture 04); P-31 created it without changing the contract. | **approved** |

## As consumer

| Contract | Version | How the platform uses it | Findings | Decision |
|---|---|---|---|---|
| IF-2 | 1.2.0 | The dashboards (P-26, P-27) call attempts, instances, flags, hints, score, challenges (with `brief`, `start`, `write_up` of 1.2.0), withdraw and undo (1.1.0), report, evidence, integrity flags and timeline. | `startAttempt` is declared (pending OI-22) but the lab does not serve it, so a candidate cannot start (handoff H-356); the contract labels it pending, so the sign-off stands and the gap is the provider's to close. | **approved** at 1.2.0 |
| IF-4 | 1.0.0 | Not called by platform code; the lab's ingest consumes it in the same process. | None for stream P. | **approved** |
| IF-5 | 1.1.0 | The platform's `HttpInstanceHost` client and the fakes (P-05); in production the lab runtime in the API process drives the host. `reportActivity` (1.1.0) is called by the lab runtime, not by platform code. | None for stream P. | **approved** at 1.1.0 |
| IF-7 | 1.2.0 | The catalogue is shown in the dashboards; `brief` and `write_up` (1.1.0) reach the page through IF-2. | 1.2.0 is data only (start texts name the documented demo accounts, no secret). | **approved** at 1.2.0 |

## Handoffs answered here
- **H-83** re-confirmed against the current IF-5 text (1.1.0): the open points stand as written; nothing in IF-5 1.0.0 to 1.1.0 changes stream P's side.
- **H-79** (stream P's part): the provisional `InstancePort`, `AttemptPort` and `ReportPort` of P-05 stand; since P-25 the platform reaches the lab in process (`LabRuntime`: `force_stop`, `attempts`, the read side used by the exports and break-glass). Stream L closes the row and ticks the checklist line.
- **H-352**: stream P's approval rows are set (this pull request).

## Later the same day
- IF-1 1.7.0 (story 3.6, the caller's session routes, additive): re-approved by the developer in that pull request; COMPAT.md updated.
