---
title: 'PR 3 review remediation (Sahil review of 2026-10-11)'
type: 'chore'
ticket: '15'
created: '2026-10-11'
status: 'built'
baseline_revision: '5c05b66'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [reviewer-pr3]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** The consumer review of pull request 3 (by the Target developer) blocks the merge on four items and names five dependent items and seven majors. The developer asked for all of it to be fixed at once so no second review round is needed.

**Approach:** One story, four parts: (A) merge origin/main and fix the four must-fix items; (B) contract fixes; (C) rules engine fixes; (D) infrastructure as code and tests (the developer applies). Design points were decided by Claude on the developer's explicit delegation on 2026-10-11 (the developer said "I want you to decide") and are open to revision by the developer.

## Boundaries & Constraints

**Always:** Decisions (recorded as ADRs 0023 to 0027 only as proposals marked "decided on delegation"; D-numbers in initial.md only after the developer confirms): D-42 IF-4: epoch on every event, identity (instance_id, epoch, seq), per-source seq lanes (sidecar group 1 to 2^40-1, orchestrator 2^40 to 2^41-1, platform 2^41 to 2^42-1), signed epoch, ingest accepts epoch <= current and rejects epoch > current with 401, ordering by (epoch, seq), first_seq removed, HKDF per-instance per-epoch event key, sidecar counter persisted on a volume. D-43 labs host isolation (H-103): two subnets, egress allowlist (443, DNS, NTP, 9444 to the platform host only), NACL, DOCKER-USER default deny, IMDS block, lab containers never privileged or host-network. D-44 IAM: remove ModifyInstanceAttribute, deny other instance types on RunInstances. D-45 Terraform state: S3 backend with native lock, SSE-S3, versioning, bootstrap script (developer migrates). D-46 rules engine: checker, registry and pins from a second checkout of the base commit; whole-contract deletion is breaking; exact case-sensitive BREAKING: marker; CODEOWNERS on checker paths. Story 1.12 (RFC 9457 Problem) is folded in.
Real commands and real output only. Never run terraform apply, never call AWS, no real secrets or addresses in the repo. Do not touch the developer's README.md edit (stash it, restore it after). No push without the developer asking.

**Never:** No force push, no change of remote, no heavy run of ci:linux unless asked, no edit of another developer's tracker folder, no edit of the Excel sheet.

## Acceptance Criteria

- origin/main is merged; the 7 conflicts are resolved as unions; IF-7 is in the registry and contracts CHANGELOG; ADR 0017 and 0018 of this branch are 0023 and 0024 with all references fixed; the IF-4 sign-off is marked stale.
- Each review finding has a fix and a test that failed before it, or a written reason.
- All suites, contract-rules, text and secret checks pass on the merged tree (real output).
- A reply comment for the reviewer lists each finding, the fix and the evidence.

</frozen-after-approval>

## Code Map

contracts/ (events, orchestrator, instance, lab-api, mocks, registry.json, CHANGELOG.md), apps/api, scripts/check-contract-rules.mjs, scripts/oasdiff.mjs, .github/workflows/ci.yml, infra/terraform/aws/, host scripts, docs/adr, docs/dev/HANDOFFS.md.

## Tasks & Acceptance

- [x] A. Merge main, conflicts, IF-7, ADR renumber, stale sign-off
- [x] B1. IF-4 epoch, seq lanes, keys, fake ingest, sidecar volume
- [x] B2. IF-6 schema hardening
- [x] B3. IF-5 transition number, strict seq, RFC 9457 Problem (story 1.12)
- [x] B4. IF-2 stable timeline paging
- [x] C. Rules engine
- [x] D. Terraform network, IAM, backend, host scripts
- [x] Docs, battery, review reply

## Implementation Notes

Built 2026-10-11: part A (merge) by the developer's Claude session; B1 IF-4, B2 IF-6, B3 IF-5, B4 IF-2, C rules engine, D infrastructure by helper agents, verified by the session. Real results are in `docs/dev-log/2026-10-11-tannmayygupta-pr3-review-remediation.md`: unit 515/515, pytest 640, e2e 72/72 after the fix (71/72 first), harness PASS, contract rules 18 PASS. Not done or not proven: the trusted checker has not run on GitHub; infrastructure is not applied; `terraform plan` not run; conformance vs template schema, IF-2 evidence cursor and duplicate-key rejection are open (H-110). Decisions D-42 to D-46 are Proposed (taken on the developer's delegation) and are not in initial.md Section 15 until the developer confirms.

## Plan Change Log

## Review Triage Log

## Verification

Full local battery as in the story 1.13 dev-log, plus the merged-tree checks.