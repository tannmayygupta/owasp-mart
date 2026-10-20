# Contracts compatibility

Single source of truth for two things: the current version of every contract, and who may approve a change to it (architecture 07 section 7.8, rules 1, 2, 3 and 9). `scripts/check-contract-rules.mjs` reads this file (rules `compat` and `approvals`); `scripts/tag-contracts.mjs` reads it before the tag. The procedure is in `docs/runbooks/contracts-tag.md`, the decision in `docs/adr/0029-contract-approvals-by-ci-and-tag-procedure.md`.

Streams: **L** = Tanmay (`@tannmayygupta`), **P** = Akshay (`@akshaay29`), **T** = Sahil (`@sahillroy`).

## Versions

Every version listed here must be an entry of the contract's own section in `contracts/CHANGELOG.md` (or a tag `contracts-vX.Y.Z`); CI fails when it is not. Contracts are `0.x` until the tag `contracts-v1.0.0`.

| Contract | Version | Owner | Folder |
|---|---|---|---|
| IF-1 | 1.6.0 | P | `contracts/api/platform/` |
| IF-3 | 1.0.0 | P | `contracts/domain-events/` |
| IF-8 | 1.0.0 | P | `contracts/errors/` |
| IF-2 | 1.3.0 | L | `contracts/api/lab/` |
| IF-4 | 1.0.0 | L | `contracts/events/` |
| IF-5 | 1.1.0 | L | `contracts/orchestrator/` |
| IF-6 | 1.0.1 | L | `contracts/instance/` |
| IF-7 | 1.2.0 | T | `contracts/catalog/` |
| DB | 2.2.0 | P | `contracts/db/` |
| GATE | 1.0.0 | L | `contracts/edge/` |

## Approvals

One row per contract, person and role. The **owner** writes and merges the contract. A **consumer** builds against it. The `version` is the contract version that the person signs off before the tag; `status` is `pending` until that sign-off exists and `approved` after it (the tag script refuses while any row is `pending`). The rule `approvals` in CI looks only at the contract, the handle and the role; `status` does not change who may approve a later pull request.

The table below is written without the outer pipes on purpose: the checker of the base commit (before the tag) reads every line that starts with a pipe as a row of the table of versions, so lines with outer pipes would fail it. It is still a normal table on GitHub.

After the tag, a pull request that changes the files of a contract needs: one approval from any listed person of that contract (an additive change), or the approval of every consumer other than the author (a change declared `BREAKING:` in its new changelog entry; if the author is the only consumer, one approval from any other listed person). The author's own review never counts, a "request changes" from a listed person blocks, and an approval counts only if the contract files did not change after it. The table that counts is the one in the base branch, never the one in the pull request. An edit of this file needs a `registry change:` line in `contracts/CHANGELOG.md`.

Contract | Stream | Handle | Role | Version | Date | Status
---|---|---|---|---|---|---
IF-1 | P | @akshaay29 | owner | 1.6.0 | 2026-10-20 | approved
IF-3 | P | @akshaay29 | owner | 1.0.0 | 2026-10-20 | approved
IF-8 | P | @akshaay29 | owner | 1.0.0 | 2026-10-20 | approved
IF-2 | L | @tannmayygupta | owner | 1.3.0 | 2026-10-20 | approved
IF-2 | P | @akshaay29 | consumer | 1.3.0 | 2026-10-20 | pending
IF-4 | L | @tannmayygupta | owner | 1.0.0 | 2026-10-19 | approved
IF-4 | T | @sahillroy | consumer | 1.0.0 | 2026-10-15 | approved
IF-4 | P | @akshaay29 | consumer | 1.0.0 | 2026-10-20 | approved
IF-5 | L | @tannmayygupta | owner | 1.1.0 | 2026-10-19 | approved
IF-5 | P | @akshaay29 | consumer | 1.1.0 | 2026-10-20 | approved
IF-6 | L | @tannmayygupta | owner | 1.0.1 | 2026-10-20 | approved
IF-6 | L | @tannmayygupta | consumer | 1.0.1 | 2026-10-20 | approved
IF-6 | T | @sahillroy | consumer | 1.0.0 | 2026-10-15 | approved
IF-7 | T | @sahillroy | owner | 1.2.0 | 2026-10-20 | approved
IF-7 | P | @akshaay29 | consumer | 1.2.0 | 2026-10-20 | approved
IF-7 | L | @tannmayygupta | consumer | 1.2.0 | 2026-10-20 | approved
DB | P | @akshaay29 | owner | 2.2.0 | 2026-10-20 | pending
DB | L | @tannmayygupta | consumer | 2.2.0 | 2026-10-20 | approved
DB | T | @sahillroy | consumer | 2.2.0 | 2026-10-20 | pending
GATE | L | @tannmayygupta | owner | 1.0.0 | 2026-10-19 | approved

Stream P recorded its review in story P-08 (`docs/reviews/2026-10-12-p08-contract-sign-off.md`) against IF-4 0.2.0, IF-6 0.2.0 and DB 0.2.0, which are older than the versions above, and with a condition (F-2: the IF-2, IF-4 and IF-5 error bodies move to IF-8 before the tag). Stream L met F-2 on 2026-10-12 (IF-2 0.3.0, IF-4 0.3.0, IF-5 0.4.0, IF-6 0.3.2 editorial, IF-8 0.4.0 with three added codes). The Akshay rows stay `pending` until he confirms the current versions. **Re-confirmed 2026-10-20 (story P-08, `docs/reviews/2026-10-20-p08-contract-sign-off-current.md`):** stream P approves IF-1 1.6.0, IF-3 1.0.0, IF-8 1.0.0 and DB 2.1.0 as owner and IF-2 1.2.0, IF-4 1.0.0, IF-5 1.1.0 and IF-7 1.2.0 as consumer.

All rows must be re-confirmed at 1.0.0 (release commit 0a2a43b); the P-08 review of 2026-10-12 does not satisfy the tag.

Accepted risk (audit 2026-10-13): the rules-engine guard accepts a self-written `registry change:` line and CODEOWNERS needs one owner; GitHub branch protection with required code-owner review is the control; check Settings > Branches (open question to the developer, ADR 0029).

## Tag preconditions

`node scripts/tag-contracts.mjs --dry-run` checks all of these and lists every one that fails. It never pushes.

1. Every row of the Approvals table above is `approved`: Akshay signs off in task P-08, Sahil in task T-03, Tanmay when he decides the tag (handoff H-80).
2. Every line of the section "Done checklist before contracts-v1.0.0 (L-09)" in `docs/dev/HANDOFFS.md` is ticked.
3. The working tree is clean, the current branch is `main`, and `HEAD` equals `origin/main` (run `git fetch origin` first).
4. Every version in the Versions table is the newest entry of that contract in `contracts/CHANGELOG.md`, and every Approvals row carries the same version as the Versions table.
5. Every contract is labelled `1.0.0` (release commit below).
6. The tag `contracts-v1.0.0` does not exist yet.

**Release commit (decided on the developer's delegation, 2026-10-11, ADR 0029):** the contracts are relabelled 1.0.0 in one commit before the tag. Each contract changelog gets a `1.0.0` entry "first stable release, no content change"; the Versions and Approvals versions above become 1.0.0; the approvers then confirm by approving that commit's pull request. The tag marks that commit. See `docs/runbooks/contracts-tag.md`.
