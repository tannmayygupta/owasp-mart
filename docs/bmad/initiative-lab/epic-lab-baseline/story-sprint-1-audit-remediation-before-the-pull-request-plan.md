---
title: 'Sprint 1 audit remediation before the pull request'
type: 'chore'
ticket: '13'
created: '2026-10-11'
status: 'in-progress'
baseline_revision: '873f980'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'none'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A brutal audit of sprint 1 (record: `docs/bmad/initiative-lab/audit-2026-10-11-sprint-1.md`) found false or stale statements, corrupted text, ticks that outran their Done-when, first-run CI risks and small safety gaps that must not reach the pull request.

**Approach:** Correct each against real evidence, keep the ticks the developer set but add dated notes naming every waived or open Done-when item, harden the CI first run, then run the whole battery on the final tree and record the real results.

## Boundaries & Constraints

**Always:** Truth over tidiness: a statement is changed to what the evidence shows; nothing is declared passed unless it ran. Real commit hashes from `git log`. No secret, account ID, address or personal data in any file. Keep decisions as they are (D-37, D-41). Keep LF line endings and UTF-8 without BOM. The audit record lists what is fixed and what is left; the larger findings stay in its backlog and become stories later.

**Never:** No redesign of any contract, no new decision, no change of the Done-when text of a task (only dated notes beside it), no removal of a finding from the audit record, no change to `README.md` or `image.png` (the developer decides about them; `image.png` is only ignored), no push, no pull request, no `terraform apply`.

</frozen-after-approval>

## Code Map

- `docs/dev/dev1-tanmay.md` (tick lines and Done-when text of L-02, L-04, L-05, L-06, L-07, L-08; title and goal wording that still say Oracle), `docs/traceability.md` (LB-5, LB-6, LB-7, LB-9, LE-1, LE-6, LE-8), `CHANGELOG.md`, `docs/dev-log/*` (headers: Branch / commit, Status, Evidence; "uncommitted", "not closed", "Partly done", empty placeholders), ADR 0021 and 0022 and `docs/adr/README.md`, `docs/dev/HANDOFFS.md`, `initial.md` (D-15, D-34, D-38), `.gitignore`, `scripts/scan-secrets.mjs` and its test, `.github/workflows/ci.yml`, `infra/terraform/aws/iam-policy.json` and its test, `scripts/verify-hosts.mjs` (check names), `docs/runbooks/aws-account-and-vms.md`.

## Tasks & Acceptance

**Execution:**
- [x] `docs/dev/dev1-tanmay.md`: under L-02, L-04, L-05, L-06, L-07 and L-08 add one dated line (2026-10-11) "Closed with: ..." listing exactly what the Done-when promised and was not met or not yet proven (L-02: Sahil's approval waived by D-37, handoffs H-24 to H-35 open; L-04, L-06, L-07: GitHub CI never run; L-05: Akshay's consumer review waived by D-37, H-84 to H-89 open, ADR 0019 Proposed; L-08: budget alert e-mail unconfirmed, only one developer key installed, start rehearsal and idle observation open, tracked in `docs/dev/sprint-1-pr-checklist.md`); change the L-08 title and sprint 1 goal wording from Oracle to the AWS hosts with a pointer to D-41; do not change any Done-when sentence.
- [x] `docs/traceability.md`: rewrite the stale rows named above to the true state with the real numbers from the evidence files (for example verify-hosts 94 checks, private-link-check 22, pytest 393, terraform test 30 and 10); say "GitHub CI not yet run" where true.
- [x] Dev-logs: fix every header that says uncommitted, not committed, not closed, Partly done, or has an empty placeholder, using real commit hashes (`git log`); in the AWS log remove the contradiction about the credit figure (USD 120 read by the developer on 2026-10-11).
- [x] `CHANGELOG.md`: repair eaten characters ("erify-hosts" and similar), the glued heading and the false "Not done yet ... L-08 stays open" line; scan every tracked text file (excluding binaries, lock files and `.terraform`) for control characters other than tab, LF and CR, BOM and mojibake (a UTF-8 dash or quote read as Windows-1252, for example the lead characters U+00E2 then U+20AC or U+201E) and repair them from context (three known documents: the Oracle dev-log line about terraform, the contract-checks dev-log line about test names, the Oracle story plan); re-save BOM files without BOM; add a test or extend an existing script test so a control character or BOM in a tracked text file fails (use `scripts/scan-secrets.mjs` style walk or a new small script wired into the unit tests).
- [x] ADR 0022: status line to what is true (applied and verified live 2026-10-11 with the numbers), add source links to ADR 0021 and 0022 (AWS Free Tier plans page, EC2 free tier usage page, penetration testing policy, acceptable use policy, VPC pricing, IMDS configuration page, Terraform provider releases; Oracle pages for 0021; HashiCorp provider page), mark the 0021 and 0022 rows of the README index.
- [x] `docs/dev/HANDOFFS.md`: H-101 gap (add a row saying it was merged into H-100, or renumber consistently and fix every reference), statuses outside the vocabulary of the file header ("answered (partial)") replaced with the allowed words plus the answer text, H-82 a recorded note that the written default was applied for L-03 and L-04.
- [x] `initial.md`: add "superseded in part by D-41" pointers to D-15 and D-34, fix the stale D-38 sentence about D-37 being on the sprint branch.
- [x] `.gitignore` add `/image.png`; `scripts/scan-secrets.mjs` fails on any png, jpg or jpeg in the repository root or outside `docs/assets` and on the console URL form `<12 digits>-<hash>.<region>.console.aws.amazon.com` (patterns built at test time), with tests.
- [x] `.github/workflows/ci.yml`: `scripts` job timeout 20 minutes; `concurrency.cancel-in-progress` only for pull requests; add `node --test scripts/e2e/dev.e2e.test.mjs` to the `compose` job; comment why `contracts.e2e.test.mjs` is not in a job (fresh-checkout install parity is covered by the `scripts` job commands); keep `scripts/ci-linux.test.mjs` passing.
- [x] `infra/terraform/aws/iam-policy.json`: add tag conditions (`aws:ResourceTag/Project` = `vulnmart`) to StartInstances, StopInstances, TerminateInstances, ModifyInstanceAttribute and ModifyInstanceMetadataOptions where AWS supports the key, keep the instance-type condition on RunInstances, update its test, and write in the runbook and the audit record that the developer must paste the new policy into the IAM user policy and that changing the instance type of a tagged instance stays possible (residual risk); add the runbook warning that `vulnmart-firewall.sh` must not be rerun on a host that runs Docker (it saves the whole iptables state); `verify-hosts` check names "host firewall accepts port N" become "host firewall placeholder rule for port N present" with tests updated.
- [x] Audit record: mark in `docs/bmad/initiative-lab/audit-2026-10-11-sprint-1.md` what story 1.13 fixed; add a pointer from `docs/bmad/initiative-lab/deferred-work.md`; dev-log `docs/dev-log/2026-10-11-tannmayygupta-sprint-1-audit-remediation.md`, CHANGELOG line, traceability row.

**Acceptance Criteria:**
- Given the audit's list, when each named statement is read again, then it matches the evidence and no stale phrase (uncommitted, not closed, Partly done, still to be produced, nothing has been applied, pending live run) remains where it is false.
- Given the tracked text files, when scanned, then none has a control character or BOM, and a test fails if one appears.
- Given `ci.yml`, when read, then the timeout, concurrency, e2e coverage and comment are as stated and `ci-linux.test.mjs` passes.
- Given the IAM policy, when its test runs, then the tag conditions and the RunInstances type condition are asserted.

## Implementation Notes

Implemented 2026-10-11 in the working tree (nothing committed or added to git). Deviations: the `compose` job also gets pnpm and uv setup steps because `dev.e2e.test.mjs` runs `dev.mjs doctor`; the H-101 gap was closed by adding a row; the S-11 live-field table was left empty (no evidence to fill it); the status of the BMAD trees and task lists in two dev-logs says the team approval is not recorded. Not run by the implementer (by instruction): docker, terraform, ssh, ci:linux, full suites, check-contract-rules against origin/main, GitHub CI. Run: 5 touched test files (108 pass), check-contract-rules tests (54 pass), scan-secrets, check-network-rules, check-text-files (PASS).

## Plan Change Log

## Review Triage Log

Review none by decision: the six-lens audit just performed is the review input; this story only corrects documents, CI settings and small checks.

## Verification

**Commands:**
- `node --test "scripts/*.test.mjs" "contracts/mocks/stub-instance/**/*.test.mjs"` -- expected: all pass
- `node scripts/scan-secrets.mjs` and `node scripts/check-network-rules.mjs` and `node scripts/check-contract-rules.mjs --base origin/main` -- expected: PASS
- `git ls-files` text scan for control characters and BOM -- expected: none