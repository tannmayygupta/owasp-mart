# 0029. Contract approvals checked by CI, and the tag procedure for contracts-v1.0.0

- **Status:** Proposed (decided on the developer's delegation 2026-10-11; open: the author-who-is-consumer rule and the branch protection fact)
- **Date:** 2026-10-11
- **Deciders:** Tanmay (stream L), on delegation (decision D-48). Akshay and Sahil sign off the contracts they consume (handoffs H-120, H-121).
- **Requirements:** LB-8, D-37, D-46, architecture 07 sections 7.7 and 7.8 (rules 1, 2, 3 and 9), EF-30, ADR 0026

## Context
After the tag `contracts-v1.0.0` the change rules of architecture 07 apply: an additive change needs one consumer's approval, a breaking one needs every consumer. GitHub branch protection would enforce this, but the repository is private on a Free account and enforcement there is not established (EF-30; the developer checks Settings, Branches). Pull request review is also optional during initial development (D-37), so nothing else would stop an unapproved contract change after the tag. There was no `COMPAT.md`, no approvals check and no tag procedure.

## Options considered
1. **Rely on branch protection and CODEOWNERS.** Pros: no code. Cons: possibly not enforced on this plan (UNVERIFIED, see Evidence); CODEOWNERS here lists "any one of" and cannot express "every consumer".
2. **A CI rule that reads the pull request reviews** (chosen). Pros: works whatever the plan; can express additive versus BREAKING; testable offline. Cons: it needs a read-only token in CI; it is only as good as the review data.
3. **A GitHub App or a `pull_request_review` workflow.** Cons: more moving parts and a bigger permission surface.

## Decision
- `contracts/COMPAT.md` is the single source for contract versions (`## Versions`) and approvers (`## Approvals`: contract, stream, handle, role owner or consumer, version, date, status). It is a guarded file: an edit needs a `registry change:` line in `contracts/CHANGELOG.md`, and `/contracts/COMPAT.md` has a CODEOWNERS entry with the three owners.
- Rule `approvals` in `scripts/check-contract-rules.mjs` starts with the first tag `contracts-v*` (before it: NOT-APPLICABLE). A pull request that changes the files of a contract needs one approval from any listed person of that contract other than the author. If the new changelog entry declares `BREAKING:` (or the contract is removed) it needs every consumer other than the author; if the author is the only consumer, one approval from any other listed person. If nobody but the author is listed, the rule FAILs. A latest review of "request changes" by another listed person FAILs the contract, whatever others approved.
- An approval counts only if the reviewer is listed, is not the author, the reviewer's latest decisive review (comments ignored, a dismissed review is not an approval) is APPROVED, and no file of the contract folders differs between the reviewed commit and the head (an unknown commit counts as stale).
- The approvers table is read from the **base** copy of COMPAT.md (ADR 0026), so a pull request cannot add itself. A tag with no COMPAT.md in the base FAILs; no tag and no COMPAT.md is NOT-APPLICABLE.
- The reviews come from one CI step with `pull-requests: read` and `continue-on-error: true` that runs `gh api --paginate --slurp` into a file; the checker reads the file and never holds the token. CI passes `--require-reviews`, so a missing or invalid file FAILs after the tag (before it the rule is NOT-APPLICABLE); a local run without the file is NOT-APPLICABLE. There is no review trigger: after approving, re-run the job.
- `scripts/tag-contracts.mjs`: `--dry-run` (default) lists every failed precondition (clean tree, branch main, HEAD equals origin/main, tag absent, COMPAT versions equal the newest changelog entries, every contract labelled 1.0.0, every approval row `approved`, every line of the done checklist ticked) and prints the `git tag -a` and push commands; `--create` makes the local annotated tag; it never pushes. Procedure: `docs/runbooks/contracts-tag.md`.
- **Labelling (decided on the developer's delegation, 2026-10-11):** the contracts are relabelled 1.0.0 in ONE release commit before the tag. Each contract changelog gets a `1.0.0` entry "first stable release, no content change"; the Versions and Approvals versions in COMPAT.md become 1.0.0; the approvers then confirm by approving that commit's pull request. The tag marks that commit.
- `compat` reads only the `## Versions` table.

## Consequences
Easier: the change rules are enforced and tested without depending on the plan. Harder: the rule is itself part of the rules engine (a change to it needs a `registry change:` line); the first real run on GitHub is unproven (the workflow cannot run locally; its shape is pinned by tests on the parsed workflow).
**Still open:** (1) is the author who is also a consumer excused from the BREAKING list (chosen here)? (2) does Settings, Branches enforce reviews on this private repository (if it does, it can be added on top)? The ADR stays Proposed until the developer confirms these.

## Evidence
- Real runs: the covering tests and the command outputs are saved in `docs/assets/contracts-tag-preparation/`.
- Read on 2026-10-11, and they did not settle whether the Free plan enforces branch protection or required reviews on a private repository: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches, https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets, https://github.com/orgs/community/discussions/174400, https://www.ssw.com.au/rules/which-github-plan. That fact stays UNVERIFIED.
- `gh api --paginate --slurp` and the REST "List reviews for a pull request" shape (`user.login`, `state`, `commit_id`, `submitted_at`) are from general knowledge and were not run against GitHub.
