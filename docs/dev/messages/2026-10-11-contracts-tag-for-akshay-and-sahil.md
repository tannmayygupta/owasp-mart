# Message for Akshay and Sahil: the contract tag and what you sign off

Plain language, ready to paste. Written 2026-10-11 by Tanmay's Claude session (story L-09 preparation).

The contracts are tagged `contracts-v1.0.0` only after both of you sign off the contracts you use. I have not made the tag; everything else is ready.

**What to do**
1. Read `contracts/COMPAT.md`. The Versions table lists the version of each contract. The Approvals table lists who owns and who consumes each one. You are Akshay (`@akshaay29`, stream P) or Sahil (`@sahillroy`, stream T).
2. Confirm or change the handoff rows on the done checklist that are yours (`docs/dev/HANDOFFS.md`, section "Done checklist before contracts-v1.0.0"). Akshay: H-113. Sahil: H-114 (and re-read IF-4 0.2.1 and IF-6 0.3.1, your old IF-4 sign-off is stale, H-108).
3. Sign off on the release pull request: before the tag all contracts are relabelled 1.0.0 in one commit (changelog entry "first stable release, no content change", COMPAT.md versions), and you confirm by approving that pull request and setting your own rows in the Approvals table to `approved` with the date. If a handle or role is wrong, say so there. Tasks P-08 (Akshay) and T-03 (Sahil).
   - Your GitHub review must be "Approve", not "Comment", and given after the last push to the contract files. There is no review trigger, so after you approve, someone must re-run the job `contract-rules`. If `main` is merged into the branch afterwards, the approval can become stale: approve again.

**What changes after the tag**
A pull request that changes a contract needs a GitHub approval from one owner or consumer of that contract other than the author; if it is declared `BREAKING:` it needs every consumer other than the author (if the author is the only consumer, one approval from any other listed person). The author's own approval does not count, and an approval given before a later change of the contract files must be given again. A "request changes" from a listed person blocks. Editing the approver list (`contracts/COMPAT.md`) needs a `registry change:` line in `contracts/CHANGELOG.md`. A new contract after the tag is added in two pull requests: first the registry entry and COMPAT.md rows, then the files. CI checks all this itself because branch protection may not work on our private Free repository.

Procedure and script: `docs/runbooks/contracts-tag.md`, `node scripts/tag-contracts.mjs --dry-run`.
