---
title: 'Tag contracts v1.0.0 and start the change rules (preparation; the tag waits for sign-offs)'
type: 'feature'
ticket: '7'
created: '2026-10-11'
status: 'built'
baseline_revision: 'bfb333cb2136254daca1407454a0cb533f8ddb53'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The contracts cannot be tagged `contracts-v1.0.0`: there is no `COMPAT.md`, no approvals check, Tanmay's open points are unconfirmed, and the sign-offs of Akshay (P-08) and Sahil (T-03) do not exist yet.

**Approach:** Build and prove everything that does not need other streams (COMPAT.md, a CI approvals rule, a tag script, closed handoffs, docs). The real tag stays the last unchecked box.

## Boundaries & Constraints

**Always:** Decisions (developer, 2026-10-11): D1 Option A: everything except the real tag now; L-09 is not ticked and the story not done until the tag exists. D2 Claude decides design points (delegated); written proposals stand unless reading them shows a defect. D3 Branch protection on a private Free repository is probably not enforced (EF-30; the developer checks Settings, Branches), so approvals are checked by CI from the GitHub pull request reviews (read-only token, one step only). D4 The approvers table is read from the BASE copy of COMPAT.md (ADR 0026). D5 After the tag: an additive contract change needs one approval from the owner or a consumer, a BREAKING one needs every consumer (architecture 07, lines 340-341); the author's own review never counts; an approval counts only if the contract files did not change after it. D6 Streams: L = `@tannmayygupta`, P = `@akshaay29`, T = `@sahillroy` (from CODEOWNERS). Consumers: IF-2 P; IF-4 T, P; IF-5 P; IF-6 L, T; IF-7 P, L; DB L, T.

**Never:** push; create the tag `contracts-v1.0.0` in this repository (prove the tag path only in a temporary repository); change what any contract means; edit another developer's tracker folder, the Excel sheet or README.md; tick L-09.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No tag yet | pull request changes IF-6 | rule `approvals` NOT-APPLICABLE ("starts with the tag") | none |
| Additive change | tag exists, one consumer approved at head | PASS | none |
| Additive, no approval | tag exists | FAIL naming the consumers | exit 1 |
| BREAKING, one of two consumers | tag exists | FAIL naming the missing consumer | exit 1 |
| Stale approval | contract files changed after the approval | FAIL (approval ignored) | exit 1 |
| Self approval | only the author approved | FAIL | exit 1 |
| No COMPAT.md in base | bootstrap | NOT-APPLICABLE with notice | none |
| Reviews missing | `--require-reviews`, file absent or invalid | FAIL | exit 1 |
| Tag script, all green | `--dry-run` | prints the `git tag -a` commands, creates nothing | exit 0 |
| Tag script, anything red | pending approval, unchecked handoff, dirty tree, not on main, version mismatch | lists every failed precondition | exit 1 |
| Two tables in COMPAT.md | Versions, Approvals | `checkCompat` reads only the Versions table | none |

</frozen-after-approval>

## Code Map

- `scripts/check-contract-rules.mjs` -- `checkCompat` 466-488 (HEAD only; every `|` line is a row: restrict to the Versions table), `resolveTag`/`latestTag` 69-89 (tag baseline switches on by itself), `runRules` 548-626 (add rule `approvals` after `compat`, 624), `baseText` 99-103, CLI 642-661 (add `--reviews`, `--require-reviews`, `--pr-author`).
- `scripts/check-contract-rules.test.mjs` -- `makeRepo` 94-115, tag test 630-655, COMPAT tests 441-454, 693-709: add the matrix there.
- `.github/workflows/ci.yml` job `contract-rules` 53-93; `scripts/ci-workflow-shape.test.mjs` 31-54 (forbids tokens: amend narrowly); `scripts/ci-linux.mjs:33` mirror. `.github/CODEOWNERS`; `contracts/registry.json` (no change).
- `contracts/CHANGELOG.md` -- IF-6 has two `0.2.0` entries (lines 15, 40): renumber the template hardening to 0.3.0. Latest: IF-2 0.2.0, IF-4 0.2.0, IF-5 0.3.0, IF-6 0.2.0, IF-7 0.1.0, DB 0.1.0.
- Open-point tables: `contracts/events/app-events.md` 223 (row 4 stale: epoch checks missing; row 28 missing from H-82), `contracts/instance/instance-contract.md` 176, `contracts/orchestrator/orchestrator-api.md` 195.
- `docs/dev/HANDOFFS.md` -- "Done checklist before contracts-v1.0.0" 142-206 (59 lines; the tag script parses it); stale rows H-04, H-07, H-08, H-09, H-59, H-83; `docs/adr/0024` (Proposed, Akshay).
- New: `contracts/COMPAT.md`, `scripts/tag-contracts.mjs` (+ test), `docs/adr/0029-contract-approvals-by-ci-and-tag-procedure.md`, `docs/runbooks/contracts-tag.md`, a team message and handoff rows.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/check-contract-rules.mjs`, `.test.mjs` -- `checkCompat` reads only the `## Versions` table (tests first) -- COMPAT.md needs more tables
- [x] `contracts/COMPAT.md` -- Versions, Approvals (contract, stream, handle, role, version, date, status), tag preconditions -- single source for versions and approvers
- [x] `contracts/CHANGELOG.md`, `contracts/events/app-events.md` -- unique IF-6 versions; IF-4 row 4 epoch checks; non-breaking entries -- stale text found by the investigation
- [x] `scripts/check-contract-rules.mjs`, `.test.mjs` -- rule `approvals` with the matrix -- the approvals check of the task
- [x] `.github/workflows/ci.yml`, `scripts/ci-workflow-shape.test.mjs`, `scripts/ci-linux.*` -- fetch reviews with `pull-requests: read`, token in that step only; `registry change:` line in the contracts changelog -- wiring
- [x] `scripts/tag-contracts.mjs`, `.test.mjs` -- preconditions, `--dry-run`, never pushes; temporary-repo proof that the tag baseline rules switch on -- the tag procedure
- [x] `docs/dev/HANDOFFS.md` -- close Tanmay's rows (H-57 to H-62, H-64, H-65, H-69 to H-72, H-74, H-78, H-80 to H-82, H-58 after the ADR 0024 note); fix stale rows; rows needing a spike move to the after-the-tag list with a reason -- H-82, H-80
- [x] `docs/adr/0029-*`, `docs/runbooks/contracts-tag.md`, handoff rows and message for Akshay and Sahil, dev-log, CHANGELOG, traceability LB-8 (built, tag pending), `initial.md` D-48 -- documentation rule

**Acceptance Criteria:**
- Given the repository, when `node scripts/check-contract-rules.mjs` runs, then `compat` is PASS and `approvals` is NOT-APPLICABLE (no tag).
- Given a temporary repository with the tag, when a contract changes without the required approvals, then `approvals` is FAIL; with them, PASS.
- Given the tag script on the real repository, when run with `--dry-run`, then it exits 1 listing the pending sign-offs and open handoffs, and creates no tag.
- Given `git tag -l`, then no `contracts-v*` tag exists in this repository.

## Implementation Notes

Built 2026-10-11 (see docs/dev-log/2026-10-11-tannmayygupta-contracts-tag-preparation.md). Not done: the real tag (waits for P-08, T-03 and open checklist boxes); the story stays in-progress and L-09 is not ticked. Deviations: approval staleness also compares the working tree; H-61 and H-72 moved to the after-the-tag list; H-81 box stays unticked until P-02.

## Plan Change Log

## Review Triage Log

Pass 1 (thorough, lenses: blind-hunter, edge-case-hunter, verification-gap, intent-alignment). Intent Alignment: no divergence (reading A and B implemented; approvals rule and workflow proven locally only). No intent_gap, no bad_plan: no loopback.

| # | Finding (lens) | Verdict | Route | Evidence |
|---|---|---|---|---|
| 1 | Author is the only listed person: zero approvals needed (edge, own) | medium | patch | `missing` is empty when `eligible` minus the author is empty; guard line shown in the finding |
| 2 | BREAKING by the sole consumer untested (verification-gap) | medium | patch | no test uses `change: 'breaking'` with author = only consumer |
| 3 | Owner approval of an additive change never asserted (verification-gap) | low | patch | all passing approvals in tests come from the consumer `bob` |
| 4 | Removed contract has no approvals test (verification-gap) | medium | patch | `dropContract` tests assert only `breaking[B]` |
| 5 | Another listed reviewer's CHANGES_REQUESTED is ignored (edge) | medium | patch | `latest` loop skips non-APPROVED states of other people |
| 6 | One review without commit_id fails every pull request (edge, blind) | medium | patch | `loadReviews` returns an error for the whole file; COMMENTED/PENDING reviews are irrelevant |
| 7 | Tag exists but base has no COMPAT.md: rule silently NOT-APPLICABLE (edge) | medium | patch | the NA branch does not look at `tag`; the tag script requires COMPAT.md, so the case means deletion |
| 8 | Review-fetch step can fail every pull request before the tag exists (blind) | medium | patch | the step is unconditional; the rule is NA before the tag |
| 9 | Edits to contracts/COMPAT.md (the approver list) are not gated (blind, own) | medium | patch | the file is outside every contract folder and outside GUARDED_FILES |
| 10 | No re-run after a late approval; review mechanics missing from the message and runbook (edge, blind) | medium | patch (docs) | no `pull_request_review` trigger; adding one would run every job on every review, so the procedure is "approve, then re-run the contract-rules job" |
| 11 | A new contract cannot be added after the tag (edge, blind) | medium | patch (docs) | base COMPAT.md has no rows for it; two-step procedure to document |
| 12 | Renumbering to 1.0.0 undecided; sinceVerdict compares with tag 1.0.0 while contracts are 0.x (blind, implementer) | medium | patch | decided on the developer's delegation (D2): a release commit relabels every contract 1.0.0 before the tag; the tag script refuses `contracts-v1.0.0` while a Versions row is not 1.0.0 |
| 13 | Tag script does not check local main equals origin/main (edge, blind) | medium | patch | only the branch name is checked |
| 14 | Pushed-tag rollback, CI-green check and wording of the "every consumer" claim missing (blind, edge) | low | patch (docs) | runbook covers an unpushed tag only; claim omits the author exception |
| 15 | ADR 0029 Accepted and open-point cells say "confirmed (Tanmay)" while the developer did not confirm (blind) | medium | patch | CLAUDE.md: record a decision after the developer confirms; wording becomes "decided on delegation" and the ADR status Proposed |
| 16 | ADR 0024 note does not quantify the replay window; ADR 0029 cites no URLs; dev-log has no threat model; no outputs under docs/assets (blind) | low | patch (docs) | CLAUDE.md rule 5 and the evidence rule |
| 17 | ci-workflow-shape guard parses YAML by indentation (blind) | low | patch | js-yaml is a devDependency; a reindent would silently weaken the token guard |
| 18 | Stale references after the IF-6 renumbering (blind) | maybe-false | patch (check) | grep the live docs; fix only what refers to the hardening entry |
| 19 | Typo "What text corrected" in H-07 (edge) | low | patch | direct correction |
| 20 | Real `gh api --slurp` output never fed to the checker (verification-gap) | maybe-false (medium if true) | defer | needs a real pull request; the missing-file case fails closed after the tag |
| 21 | Approval goes stale when main is merged into the branch (edge, blind) | low | reject | conservative by design; a fix would compare the pull request's own diff (complex); documented in the runbook |
| 22 | BREAKING by the sole consumer should fall back to owners only (edge) | low | reject | the documented rule is one approval from another listed person; kept and worded precisely (see 14) |
| 23 | Approved row needs a date; tag script format variants of the checklist; unsigned tag; printed command quoting; `--reviews` without a value; Approvals versions not checked by compat (edge, blind) | low | reject | unlikely in everyday use and the fixes are guards; the tag script already checks versions and ticks |
| 24 | Undeclared BREAKING with one approval (blind) | false | reject | the separate `breaking[...]` rule fails an undeclared breaking change (existing since-tag tests) |
| 25 | Shallow clone makes approvals uncomparable (verification-gap) | false | reject | the head checkout uses `fetch-depth: 0` (ci.yml, job contract-rules) |
## Design Notes

The approvals rule needs the PR diff and the reviews. The diff comes from the existing changed-contract detection; the reviews come from `gh api` into a file in a separate step, so the checker never holds the token. An approval is valid when the reviewer is a listed approver in the BASE table, is not the author, its latest state is APPROVED, and `git diff --quiet <review commit> HEAD -- <contract folders>` shows no later change.

## Verification

**Commands:**
- `node --test scripts/check-contract-rules.test.mjs scripts/ci-workflow-shape.test.mjs scripts/tag-contracts.test.mjs` -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL, `compat` PASS, `approvals` NOT-APPLICABLE
- `node scripts/tag-contracts.mjs --dry-run` -- expected: exit 1, lists the pending items, `git tag -l "contracts-v*"` prints nothing
- `node --test "scripts/*.test.mjs"`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass