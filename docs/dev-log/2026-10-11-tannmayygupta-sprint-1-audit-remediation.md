# Sprint 1 audit remediation before the pull request (story 1.13)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | tannmayygupta |
| Branch / commit | sprint-1-tanmay, on top of a71234b; not committed when this entry was written (the developer commits) |
| Status | Done in the working tree; the full battery (docker, terraform, `ci:linux`, full suites, GitHub CI) is run by the developer and not recorded here. Story not marked done until the developer confirms |
| Report tag | quality, documentation truth, CI hardening, security hygiene |

## Requirements covered
D-37, D-41; LB-1 to LB-10, LE-1, LE-6, LE-8 (statements corrected); NFR-MNT-02 (CI), NFR-ISO-06 and NFR-CST-01 (IAM and firewall wording); handoffs H-82, H-101.

## Summary (plain language)
A six-reviewer audit of sprint 1 found false or stale statements, damaged text, ticks that went further than their Done-when and small safety gaps. This story corrects each against the evidence, keeps the developer's ticks but adds dated notes naming what was waived or is still open, hardens the first GitHub run, and adds a test that stops damaged text from coming back.

## Why
Nothing may reach the pull request that says something false. Source: `docs/bmad/initiative-lab/audit-2026-10-11-sprint-1.md` and the story plan `story-sprint-1-audit-remediation-before-the-pull-request-plan.md`.

## What was built
- Traceability rows LB-5, LB-6, LB-7, LB-9, LE-1, LE-6, LE-8 rewritten to the true state with the numbers from the evidence files (verify-hosts 94 checks, private-link-check 22, terraform test 30 and 10, pytest 393) and "GitHub CI not yet run" where true.
- Dev-log headers: real commit hashes and honest status for 11 entries; the AWS log no longer contradicts itself about the credit figure; the Oracle log says the live phase moved to AWS.
- "Closed with" notes (2026-10-11) under L-02, L-04, L-05, L-06, L-07, L-08 in `docs/dev/dev1-tanmay.md`; L-08 title and sprint 1 goal now say AWS (D-41). Done-when sentences untouched.
- ADR 0021 and 0022 status and source links; ADR README index.
- CHANGELOG: eaten characters, the glued heading and the false "L-08 stays open" line repaired.
- Text damage: a vertical-tab character that ate the letter "v" (CHANGELOG, twice), tab characters that ate "t" (Oracle dev-log, Oracle story plan, contract-checks dev-log, three places), a mojibake dash in the L-01 plan, a UTF-8 BOM on 11 evidence files. New `scripts/check-text-files.mjs` (control character, BOM, mojibake, replacement character) with `scripts/check-text-files.test.mjs`, picked up by `node --test "scripts/*.test.mjs"` and so by CI.
- HANDOFFS: a row for H-101 (merged into H-100), "answered (partial)" replaced by `open` plus "Partly answered" in H-59, H-74, H-78, a note on H-82.
- `initial.md`: D-15 and D-34 marked superseded in part by D-41; the stale D-38 sentence reworded.
- `.gitignore` has `/image.png`; `scripts/scan-secrets.mjs` fails on png, jpg or jpeg outside `docs/assets` and on the console URL form with an account id (patterns built at test time).
- `.github/workflows/ci.yml`: `scripts` job timeout 20 minutes; `cancel-in-progress` only for pull requests; `dev.e2e.test.mjs` added to the `compose` job (with pnpm and uv set up, because `dev.mjs doctor` reports them); a comment says why `contracts.e2e.test.mjs` is in no job.
- `infra/terraform/aws/iam-policy.json`: terminate, start, stop, `ModifyInstanceAttribute` and `ModifyInstanceMetadataOptions` moved into one statement limited to instances tagged `Project=vulnmart` in Sydney; test added. `verify-hosts` check names now say "host firewall placeholder rule for port N present". Runbook: paste the new policy, residual risk, do not rerun the firewall script on a host that runs Docker.
- Audit record marked with what the story did; pointer from `deferred-work.md`.

## How it works
Mostly document edits made with exact string replacements (each edit fails if the old text is not found), then re-reading. The new hygiene test walks `git ls-files` (tracked plus untracked but not ignored) and fails with file and line.

## Files changed
`docs/traceability.md`, `CHANGELOG.md`, `docs/dev/dev1-tanmay.md`, `docs/dev/HANDOFFS.md`, `initial.md`, `docs/adr/0021-*.md`, `0022-*.md`, `README.md` of `docs/adr/`, 11 files under `docs/dev-log/`, the L-01 and Oracle story plans, `docs/assets/` (BOM removed from 11 text files), `docs/runbooks/aws-account-and-vms.md`, `docs/bmad/initiative-lab/audit-2026-10-11-sprint-1.md`, `deferred-work.md`, `.gitignore`, `.github/workflows/ci.yml`, `infra/terraform/aws/iam-policy.json`, `scripts/scan-secrets.mjs` and test, `scripts/check-text-files.mjs` and test (new), `scripts/verify-hosts.mjs`, `scripts/cloud-hosts.test.mjs`, `scripts/check-network-rules.test.mjs`. Not touched: `README.md` (root), `image.png`.

## Decisions made
None new. D-37 and D-41 stand. No ADR needed.

## Tests
Real runs on this PC (Windows, Node), 2026-10-11:
- `node --test scripts/scan-secrets.test.mjs scripts/check-text-files.test.mjs scripts/check-network-rules.test.mjs scripts/cloud-hosts.test.mjs scripts/ci-linux.test.mjs`: 108 tests, 108 pass.
- `node --test scripts/check-contract-rules.test.mjs`: 54 tests, 54 pass (the file reads docs and COMPAT files).
- `node scripts/scan-secrets.mjs`: PASS. `node scripts/check-network-rules.mjs`: PASS. `node scripts/check-text-files.mjs`: PASS (it failed first on 15 files, then passed after the repairs).
Not run by me, by instruction: docker, terraform, ssh, `ci:linux`, the full unit, pytest and end-to-end suites, `node scripts/check-contract-rules.mjs --base origin/main`, `verify-skills`, GitHub CI. The new `compose` job steps and the IAM tag condition are therefore unproven until then.
Traceability: the rows named above plus a new row LB-11.

## Evidence
Command outputs above; no screenshots. Audit record: `docs/bmad/initiative-lab/audit-2026-10-11-sprint-1.md`.

## Problems met and how they were fixed
- The first run of the new text check found a literal replacement character in the check script itself; replaced by a code point. The story plan quoted mojibake as an example and failed the check; reworded to describe it.
- A helper that edited files by string replacement flattened single-pair argument lists and stopped half way; the remaining files were redone and verified one by one.
- `dev.e2e.test.mjs` runs `doctor`, which needs pnpm and uv; the `compose` job only had Node, so the two setup steps were added with the same pinned actions.
- Several files in the working copy use CRLF, others LF; each edit kept the file's own endings, and `.gitattributes` normalises in git.

## Security notes (vulnerable parts only)
Not applicable (no vulnerable lab code). Security hygiene: IAM tag conditions (written from the AWS documentation, not yet applied to the account), screenshots refused outside `docs/assets`, console URL form refused. Residual risk: `ModifyInstanceAttribute` cannot be limited by instance type.

## Limitations and follow-ups
- The developer must paste the new `iam-policy.json` into the IAM user policy, apply once and record any denied action (runbook Part A6).
- The S-11 live-field table is still empty; the budget alert, other developers' keys, stop and start rehearsal and idle observation stay open in `docs/dev/sprint-1-pr-checklist.md`.
- ADR source links were recorded from the pages the ADRs name and not re-read.
- The team approval of the BMAD trees and the task lists is not recorded in the repository; the two dev-logs now say so (ask the team).
- The larger audit findings stay in the audit record's backlog and become stories later.
- Remind the developer: set Done = Yes in the Excel sheet where relevant; the commit needs the docs gate (this entry, CHANGELOG, traceability are in place).

## Verification on the final tree (2026-10-11, developer PC, Windows)
- Unit tests 
ode --test scripts/*.test.mjs contracts/mocks/stub-instance/**/*.test.mjs: 434 of 434. pytest: 378 passed and 15 skipped in the full run (the 15 mTLS tests skipped because openssl was not on that shell's PATH), then 	est_mtls.py alone with openssl: 27 of 27, so 393 in total. End-to-end files (harness, dev, contracts, lab, orchestrator, events): 61 of 61. 
ode scripts/dev.mjs harness: PASS (20 rules), no container left. contracts:check: four contracts PASS. check-contract-rules --base origin/main: 17 PASS, 0 FAIL, 4 NOT-APPLICABLE. Text, secret and network-rule scans PASS; erify-skills OK (217 files).
- Terraform in the pinned toolchain: alidate valid for both folders; 	erraform test oci 10 of 10; aws 30 of 30 on a clean copy. On the developer's own checkout the aws run showed 29 of 30 because the local git-ignored 	erraform.tfvars (with m_i_running = false) leaks into the test run: the AWS Terraform tests are not hermetic (added to the audit backlog).
- **Not done:** pnpm run ci:linux on the final tree was stopped twice by the system for low memory, so no Linux-in-Docker run is recorded after these changes (the earlier ones passed before them). GitHub CI has never run on this branch: its first run is the real Linux proof.
