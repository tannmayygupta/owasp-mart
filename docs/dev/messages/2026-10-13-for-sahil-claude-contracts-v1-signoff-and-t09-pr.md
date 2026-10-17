# Message for Sahil's Claude session: finish the stream T side of contracts v1.0.0 and bring T-09 to T-13 into main

Paste everything below the line into your Claude Code session in the repo. Written 2026-10-13 by Tanmay's Claude session, updated after the merge of Tanmay's sprint 2 pull request (#15) into `main`. Plain language, small steps.

---

You are working for Sahil (stream T). Read `CLAUDE.md` first and follow it (documentation rule, BMAD story, commit gate). Two small jobs, one at a time.

**Get the current state.** Tanmay's sprint 2 (new contracts, real orchestrator, local demo) is merged into `main`. Run `git fetch origin`, then merge `origin/main` into your `sprint-2-sahil` branch. Conflicts will be in `CHANGELOG.md`, `docs/traceability.md`, `docs/dev/HANDOFFS.md`, `docs/dev/dev3-sahil.md`, possibly `infra/images.json`: resolve CHANGELOG and traceability as unions; for any handoff row keep the newest text and answer (an older copy of a row must never replace a newer one). After the merge run `pnpm install --frozen-lockfile`, `node scripts/verify-skills.mjs` and `node scripts/check-contract-rules.mjs` (0 FAIL).

**What changed that touches you (all in main now):**
- Every contract is labelled **1.0.0**. IF-4 error answers of the ingest are the closed IF-8 body now (`type` `urn:vulnmart:error:<CODE>`, `title`, `status`, `code`, `request_id`; no `message`/`detail`). IF-6 only had wording changes (0.3.2 to 1.0.0): the template schema, user 65532:65532, env patterns and limits are unchanged.
- The real orchestrator (`apps/orchestrator`, Docker backend) builds an instance from the template: keeper first, injector gets the document on stdin, the shop starts only after the injector exits 0 and is ready only when its health check passes. Your shop must meet the instance contract in that order. `node scripts/dev.mjs demo` runs this locally with your shop image from `apps/shop`: run it once on your PC and tell Tanmay what you see. The shop image has no `wget`; the image manifest `infra/images.json` now has an optional per-role `healthchecks` entry (the shop role uses it): look at it before you add your roles.
- The CI workflow changed: the jobs `api` and `compose` run `pnpm install --frozen-lockfile`. The job `contract rules` prints a short report and runs the checker of `main` with `--trusted`.
- **Format of the Approvals table in `contracts/COMPAT.md`: the rows have no outer pipes** (`IF-4 | T | @sahillroy | consumer | 1.0.0 | - | pending`). This is on purpose (the checker that was on main before read every line starting with `|` as a version row). Keep that form when you edit your rows; the checker reads both forms.

**Job 1: sign off (small).**
1. Re-read IF-4 (`contracts/events/app-events.md` sections 3, 4, 7 and the changelog entries 0.2.1, 0.3.0, 1.0.0), IF-6 (`contracts/instance/instance-contract.md`, changelog 0.3.1, 0.3.2, 1.0.0), IF-7 and DB as far as you consume or own them. Check them against your built shop (`apps/shop`) and catalogue.
2. In `contracts/COMPAT.md`, table "Approvals", set every row with handle `@sahillroy` to `status` = `approved`, `date` = today (YYYY-MM-DD), `version` = `1.0.0` (rows: IF-4 consumer, IF-6 consumer, IF-7 owner, DB consumer). Do it only if you really checked; if something does not fit, leave that row `pending` and write why in handoff H-121 and in the pull request. An edit of COMPAT.md needs a `registry change:` line in `contracts/CHANGELOG.md` (the rules check it).
3. Answer handoff H-121 and tick the lines of the section "Done checklist before contracts-v1.0.0 (L-09)" in `docs/dev/HANDOFFS.md` that are yours (marked Sahil), only for rows you really answered.
4. Run `node scripts/check-contract-rules.mjs` (0 FAIL) and `node scripts/tag-contracts.mjs --dry-run` (the `approvals` line must not list `@sahillroy` any more).

**Job 2: bring T-09 to T-13 into main.** Your branch `origin/sprint-2-sahil` holds T-09 (health, readiness after the injector marker), T-11 (mock services), T-12 (import service) and T-13 (bot controller), but `main` does not have them, so the demo and the orchestrator cannot use them. After the merge above: run your suites (`pnpm` tests of `apps/shop`, the exploit runner tests, `node scripts/dev.mjs harness`), then `node --test "scripts/*.test.mjs"`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`. Update dev-log, CHANGELOG, traceability and your story states in `docs/bmad/initiative-target/` as usual, tick only what is really done in `docs/dev/dev3-sahil.md`. Open **one pull request** now (do not wait for the rest of the sprint: the demo and the orchestrator wait for your roles: import service, mock services, bot controller as images in `infra/images.json` if you can add them in the same pull request; ask Tanmay if you are unsure how the image pipeline lists a role). Keep new Node tests and servers that import packages working in CI: the jobs install the pnpm workspace, so add your dependencies to the lockfile (`pnpm install`, commit `pnpm-lock.yaml`).

**When done, tell Tanmay:** the PR numbers, the dry-run result, any row you left `pending`, and anything in the contracts that does not fit your shop.

Do not tag, do not push tags, do not touch `apps/orchestrator`, `apps/web`, `apps/api` or other streams' tracker folders.
