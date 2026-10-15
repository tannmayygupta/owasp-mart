# Contracts tag preparation: COMPAT.md, approvals rule, tag script (story L-09, tag pending)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | tannmayygupta |
| Branch / commit | sprint-2-tanmay, base bfb333c (not committed yet when written) |
| Status | Partly done: everything except the real tag; L-09 is not ticked |
| Report tag | contracts, change rules, CI |

## Requirements covered
LB-8, D-37, D-46, D-48 (new), EF-30, handoffs H-58, H-80, H-81, H-82 and the other Tanmay rows, H-120, H-121.

## Summary
The contracts cannot be tagged until Akshay (P-08) and Sahil (T-03) sign off. Everything that does not need them is built and tested: `contracts/COMPAT.md`, a CI rule that checks approvals after the tag, a tag script, closed handoffs and the documents. The tag is the last open box.

## Why
Architecture 07 rules 2 and 3 need approvals after the tag, and branch protection on a private Free repository is probably not enforced (EF-30), so CI checks the pull request reviews itself.

## What was built
- `contracts/COMPAT.md`: Versions table, Approvals table (owner and consumer per contract), tag preconditions.
- `compat` reads only the `## Versions` table; the Approvals table is validated for shape.
- Rule `approvals` (NOT-APPLICABLE until a `contracts-v*` tag exists): additive needs one listed person, BREAKING needs every consumer; the author's review, a listed-nobody review, a later-changed contract and a missing review file do not count; approvers come from the base copy of COMPAT.md.
- CI: a step with `pull-requests: read` writes the reviews with `gh api --paginate --slurp`; the checker gets `--reviews`, `--require-reviews`, `--pr-author`.
- `scripts/tag-contracts.mjs`: preconditions, `--dry-run` (default), `--create` (local tag only), never pushes.
- Contract text: IF-6 duplicate `0.2.0` renumbered `0.3.0`; entries IF-4 0.2.1 and IF-6 0.3.1; IF-4 open point 4 corrected (epoch checks, store-full); owners of IF-4 points 3, 4, 13, 14, 19, 20, 22, 27, 28 and IF-6 points 20, 21, 26 marked confirmed.
- HANDOFFS: Tanmay's rows answered, stale rows H-04, H-07, H-08, H-09, H-59, H-83, H-93, H-94 corrected, H-61 and H-72 moved to the after-the-tag list (need a host check or spikes), H-120 and H-121 added, 13 checklist boxes ticked.
- ADR 0029, ADR 0024 revisit note, runbook, message for Akshay and Sahil, D-48.

## How it works
See ADR 0029. The reviews file is data; only one CI step holds the token.

## Files changed
`scripts/check-contract-rules.mjs`, `.test.mjs`, `scripts/tag-contracts.mjs`, `.test.mjs`, `scripts/ci-workflow-shape.test.mjs`, `scripts/ci-linux.mjs` (comment), `.github/workflows/ci.yml`, `contracts/COMPAT.md`, `contracts/CHANGELOG.md`, `contracts/events/app-events.md`, `contracts/instance/instance-contract.md`, `docs/dev/HANDOFFS.md`, `docs/adr/0024-*`, `docs/adr/0029-*`, `docs/runbooks/contracts-tag.md`, `docs/dev/messages/2026-10-11-contracts-tag-for-akshay-and-sahil.md`, `initial.md`, `CHANGELOG.md`, `docs/traceability.md`.

## Decisions made
ADR 0029 (D-48), decided on the developer's delegation. Options: branch protection only, CI rule (chosen), GitHub App.

## Tests
- `node --test scripts/check-contract-rules.test.mjs`: 75 tests, 73 passed on the first run, 2 failed because of my test helper (a default parameter swallowed `undefined`); fixed, the 9 new approvals tests then passed.
- `node --test scripts/ci-workflow-shape.test.mjs scripts/ci-linux.test.mjs`: 17 of 17 pass.
- `node --test scripts/tag-contracts.test.mjs`: 10 of 10 pass (one test expectation was off by one line and was fixed).
- `node --test "scripts/*.test.mjs"`: 483 of 483 pass. `check-text-files` PASS, `scan-secrets` PASS.
- `node scripts/check-contract-rules.mjs`: 19 PASS, 0 FAIL, 4 NOT-APPLICABLE; `compat` PASS, `approvals` NOT-APPLICABLE.
- `node scripts/tag-contracts.mjs --dry-run`: exit 1 (dirty tree, not on main, 16 sign-offs pending, 46 checklist lines open); `git tag -l "contracts-v*"` prints nothing.
- The compat tests were written after the code, not before (the plan said tests first).
Traceability: LB-8.

## Evidence
Real output of the dry run, the contract rules and the covering tests after the review fixes: docs/assets/contracts-tag-preparation/ (tag-dry-run.txt, check-contract-rules.txt, tests.txt). No screenshots.

## Problems met and how they were fixed
PowerShell `Add-Content` wrote one CRLF into an LF-pinned file (fixed, used LF writes after). A PowerShell string turned a backtick-a into a control character in a workflow comment (found and fixed). `HANDOFFS` row editing needed a cell parser; done with a one-off script outside the repository.

## Security notes
No vulnerable part. Threat model of the token step and the reviews file:
- **Who can write the file:** only the step "Fetch the pull request reviews", which runs one fixed command (`gh api --paginate --slurp` into `$RUNNER_TEMP/reviews.json`). The file lives outside both checkouts. The pull request head cannot write it: no step runs head code before it, the head is checked out with `persist-credentials: false` into `head/`, and the job has no `pull_request_target` trigger. The step is `continue-on-error`, so a failure leaves a missing or partial file, which the checker treats as missing or invalid (FAIL after the tag).
- **What a forged file could do:** list an approval from a listed person and so let a contract change pass. It could not add approvers (the approver table is read from the base copy of COMPAT.md) and cannot bypass the stale check (the commit ids are compared with the real git history). Producing a forged file would need control of the runner or of the step, which is the same trust as the workflow itself (CODEOWNERS covers `.github/workflows/`).
- **What the read-only token can read:** with `contents: read` and `pull-requests: read` it can read this repository's code and pull request data, including reviews. It cannot write, and it is held by that one step only (tests parse the workflow and check this). The checker step receives only the file path and the author login.
- The GitHub run itself has not happened.

## Review fixes (same day)
After review: the rule approvals now FAILs when nobody but the author is listed, when another listed person's latest review requests changes, and when a tag exists but the base has no COMPAT.md; loadReviews skips comments and pending reviews before checking fields; contracts/COMPAT.md is a guarded file with a CODEOWNERS entry; the reviews step has continue-on-error; the shape test parses the workflow with js-yaml; tag-contracts has the preconditions up-to-date and release-labels (all contracts 1.0.0, one release commit before the tag, decided on delegation, ADR 0029); docs wording and runbook content updated. IF-6 renumbering check: the live references to the template hardening were root CHANGELOG, handoff H-108 and the message to Sahil (fixed to 0.3.0); ADR 0025 and H-93/H-94 refer to the real 0.2.0 (sidecar start) and stay; contracts/instance/instance-contract.md still says Version 0.1.0 in its header (stale before this story, not changed); schemas and the examples manifest carry no contract version.

## Limitations and follow-ups
- The tag is not made. Waits for H-120, H-121 and the unticked boxes (H-01 to H-23 etc., H-79, H-81, H-80).
- Not run on GitHub: `gh api --paginate --slurp` and the review JSON shape are from general knowledge.
- Open: renumber contracts to 1.0.0 at the tag? Does branch protection enforce reviews? Is a consumer-author excused from the BREAKING list (chosen: yes)?
- A stricter check than the plan: an approval is also stale if the working tree differs from the reviewed commit (same result in CI).
