# Runbook: tag the contracts (contracts-v1.0.0)

Decision: `docs/adr/0029-contract-approvals-by-ci-and-tag-procedure.md`. Table of versions and approvers: `contracts/COMPAT.md`. Owner: Tanmay.

## Before the tag
1. Akshay (P-08, handoff H-113) and Sahil (T-03, handoff H-114) read the contracts and confirm their handoff rows.
2. Tanmay confirms the remaining handoffs and ticks each line of "Done checklist before contracts-v1.0.0 (L-09)" in `docs/dev/HANDOFFS.md`. The last line, H-80, is the tag decision.
3. **Release commit (one pull request).** Relabel every contract 1.0.0: each contract's section in `contracts/CHANGELOG.md` gets a `1.0.0` entry "first stable release, no content change"; the Versions table and the Approvals versions in `contracts/COMPAT.md` become `1.0.0`; the edit of COMPAT.md needs a `registry change:` line in `contracts/CHANGELOG.md`. The approvers confirm by approving this pull request: set their own Approvals rows to `approved` with the date in it (the rows of the base copy count, so each approver's own row is set in this pull request and merged with it).
   - A review must be "Approve" (not "Comment"), given after the last push to the contract files. There is no review trigger: after approving, someone must re-run the job `contract-rules`. Merging `main` into the branch after an approval can make that approval stale; approve again.
4. Merge it. On `main`: `git switch main`, `git fetch origin`, `git pull`. Check that CI of the merge commit on `main` is green.

## Check
`node scripts/tag-contracts.mjs --dry-run` prints PASS or FAIL for each precondition and lists every failure (clean tree, main, HEAD equals origin/main, tag absent, versions match the changelog, every contract 1.0.0, every sign-off approved, every checklist line ticked). Exit 0 means ready; exit 1 means not.

## Make the tag
`node scripts/tag-contracts.mjs --create` creates the annotated local tag `contracts-v1.0.0` (message: the versions of COMPAT.md). It does not push. Push by hand, over SSH, only when you decide: `git push origin contracts-v1.0.0`.

## After the tag
- From the next pull request the rule `approvals` is active and the breaking comparison also runs against the tag. Check once that the GitHub run shows the step "Fetch the pull request reviews" green and the check `approvals` PASS or FAIL (not NOT-APPLICABLE). Also open Settings, Branches and write down whether branch protection is enforced on this private repository (EF-30).
- Additive change: one approval from the owner or a consumer other than the author. BREAKING change: every consumer other than the author; if the author is the only consumer, one approval from any other listed person.
- Editing `contracts/COMPAT.md` (the approver list) needs a `registry change:` line in `contracts/CHANGELOG.md` and the review of all three owners.
- **Adding a NEW contract after the tag takes two pull requests.** First: the registry entry in `contracts/registry.json`, its section in `contracts/CHANGELOG.md`, and its rows in `contracts/COMPAT.md` (with a `registry change:` line); merge it. Second: the contract files. Otherwise nobody is listed to approve the files and the rule FAILs.

## If the tag is wrong
Before pushing: delete it locally (`git tag -d contracts-v1.0.0`). After a push: **never delete or move it.** Publish the next tag (`contracts-v1.0.1` or the next version) and tell the team in the chat.
