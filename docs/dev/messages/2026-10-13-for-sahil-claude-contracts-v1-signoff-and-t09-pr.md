# Message for Sahil's Claude session: finish the stream T side of contracts v1.0.0 and bring T-09 to T-13 into main

Paste everything below the line into your Claude Code session in the repo. Written 2026-10-13 by Tanmay's Claude session. Plain language, small steps.

---

You are working for Sahil (stream T). Read `CLAUDE.md` first and follow it (documentation rule, BMAD story, commit gate). Two small jobs, one at a time.

**Get the current state.** Tanmay's branch `sprint-2-tanmay` (and later `main`, after his pull request) holds the new contracts and the real orchestrator. Until it is merged: `git fetch origin`. Merge `origin/sprint-2-tanmay` (or `origin/main` when it is in) into your `sprint-2-sahil` branch. Conflicts will be in `CHANGELOG.md`, `docs/traceability.md`, `docs/dev/HANDOFFS.md`, `docs/dev/dev3-sahil.md`: resolve them as unions, and for any handoff row keep the newest text and answer (an older copy of a row must never replace a newer one). After the merge run `node scripts/verify-skills.mjs` and `node scripts/check-contract-rules.mjs` (0 FAIL).

**What changed that touches you (already in Tanmay's branch):**
- Every contract is labelled **1.0.0**. IF-4 error answers of the ingest are the closed IF-8 body now (`type` `urn:vulnmart:error:<CODE>`, `title`, `status`, `code`, `request_id`; no `message`/`detail`). IF-6 only had wording changes (0.3.2 to 1.0.0): the template schema, user 65532:65532, env patterns and limits are unchanged.
- The real orchestrator (`apps/orchestrator`, Docker backend) builds an instance from the template: keeper first, injector gets the document on stdin, the shop starts only after the injector exits 0 and is ready only when its health check passes. Your shop must meet the instance contract in that order. `node scripts/dev.mjs demo` (Tanmay, story 1.17) runs this locally with your shop image from `apps/shop`; run it once on your PC when it is in the branch and tell Tanmay what you see.

**Job 1: sign off (small).**
1. Re-read IF-4 (`contracts/events/app-events.md` sections 3, 4, 7 and the changelog entries 0.2.1, 0.3.0, 1.0.0), IF-6 (`contracts/instance/instance-contract.md`, changelog 0.3.1, 0.3.2, 1.0.0), IF-7 and DB as far as you consume or own them. Check them against your built shop (`apps/shop`) and catalogue.
2. In `contracts/COMPAT.md`, table "Approvals", set every row with handle `@sahillroy` to `status` = `approved`, `date` = today (YYYY-MM-DD), `version` = `1.0.0` (rows: IF-4 consumer, IF-6 consumer, IF-7 owner, DB consumer). Do it only if you really checked; if something does not fit, leave that row `pending` and write why in handoff H-121 and in the pull request.
3. Answer handoff H-121 and tick the lines of the section "Done checklist before contracts-v1.0.0 (L-09)" in `docs/dev/HANDOFFS.md` that are yours (marked Sahil), only for rows you really answered.
4. Run `node scripts/check-contract-rules.mjs` (0 FAIL) and `node scripts/tag-contracts.mjs --dry-run` (the `approvals` line must not list `@sahillroy` any more).

**Job 2: bring T-09 to T-13 into main.** Your branch `origin/sprint-2-sahil` holds T-09 (health, readiness after the injector marker), T-11 (mock services), T-12 (import service) and T-13 (bot controller), but `main` does not have them, so the demo and the orchestrator cannot use them. After the merge in the first section: run your suites (`pnpm` tests of `apps/shop`, the exploit runner tests, `node scripts/dev.mjs harness`), then `node --test "scripts/*.test.mjs"` (one known failure may appear on Windows: `generate-api-code.test.mjs` "CRLF alone is not stale", not yours), `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`. Update dev-log, CHANGELOG, traceability and your story states in `docs/bmad/initiative-target/` as usual, tick only what is really done in `docs/dev/dev3-sahil.md`. Open **one pull request** now (do not wait for the rest of the sprint: Tanmay's L-13 and the demo wait for your roles: import service, mock services, bot controller as images in `infra/images.json` if you can add them in the same pull request; ask Tanmay if you are unsure how the image pipeline of story 2.4 lists a role).

**When done, tell Tanmay:** the PR numbers, the dry-run result, any row you left `pending`, and anything in the contracts that does not fit your shop.

Do not tag, do not push tags, do not touch `apps/orchestrator`, `apps/web`, `apps/api` or other streams' tracker folders.
