---
title: 'Deployed verification and ASVS checklist'
type: 'feature'
ticket: '10'
created: '2026-10-20'
status: blocked
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/prd/PRD.md'
blocked_at: "2026-10-20"
blocked_reason: "waits for stream L to deploy main's API and the dashboards (L-11) to vm-p; handoff H-358"
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** No platform epic has been verified on the deployed site and the ASVS 5.0 checklist of NFR-SEC-01 does not exist (task P-32; L-30 waits on it, EARLY PR).

**Approach:** A read-only script, `scripts/verify-deployed.mjs`, that checks a deployed origin without creating anything (health, page security headers, the http redirect, the error format, a refused cross-site POST, every dashboards page served by the dashboards app, every platform operation of the contract present); its tests; the ASVS 5.0 chapter table in `docs/traceability.md` from the official chapter list; a run against the live site recorded as evidence.

## Boundaries & Constraints

**Decisions (developer):** 2026-10-20 "Prepare now, verify later": the deployed site runs code from before P-26 and only stream L deploys (Tanmay's hosts and key); P-32 prepares the script and the checklist, runs it once, and waits for the redeploy (handoff H-358).

**Always:** read only against the live site; real results recorded; the checklist says it is at chapter level.

**Never:** no deploy from this story; no account created on the live site.

</frozen-after-approval>

## Tasks & Acceptance

**Execution:**
- [x] The verification script and its tests; a run against the live site (2026-10-20: 32 PASS, 29 FAIL, the reasons recorded).
- [x] The ASVS 5.0 chapter table.
- [ ] The run on a deployed site that has main's API and the dashboards (waits for H-358), then each epic verified.
- [ ] The per-requirement ASVS review (the "requirement ID" column of NFR-SEC-01).

## Plan Change Log

- 2026-10-20: blocked on the redeploy of main and the dashboards (L-11) by stream L: handoff H-358.

## Verification

- `node --test scripts/verify-deployed.test.mjs` -- 5 of 5
- `node scripts/verify-deployed.mjs --base https://tanmay-platform-prod.duckdns.org` -- 32 PASS, 29 FAIL (2026-10-20, the stale deploy)
