# Message for Akshay's Claude session: finish the stream P side of contracts v1.0.0

Paste everything below the line into your Claude Code session in the repo. Written 2026-10-13 by Tanmay's Claude session. Plain language, one small pull request.

---

You are working for Akshay (stream P). Read `CLAUDE.md` first and follow it (documentation rule, BMAD story, commit gate). Do one small story, no other work.

**Get the current state.** Tanmay's branch `sprint-2-tanmay` (and later `main`, once his pull request is merged) holds the new contracts. Until then: `git fetch origin` and `git switch -c sprint-2-akshay origin/sprint-2-tanmay`. If the branch is already merged, use `main`. Never overwrite rows of `docs/dev/HANDOFFS.md` with an older copy: merge first, then edit.

**What changed since your P-08 review (all by Tanmay, already in the branch):**
- Condition F-2 is done (story 1.16): the error bodies of IF-2, IF-4 and IF-5 are the closed IF-8 body (`type` `urn:vulnmart:error:<CODE>`, `title`, `status`, `code`, `request_id`, `field` or `errors`; no `message`, `detail`, `instance`). The Python client and fakes in `apps/api/src/vulnmart/ports/` were updated.
- IF-8 gained three codes that IF-5 already used: `ORCH-CURSOR-INVALID` (422), `ORCH-UNSUPPORTED-MEDIA-TYPE` (415), `ORCH-NOT-IMPLEMENTED` (501).
- Every contract is now labelled **1.0.0** (release commit). `contracts/COMPAT.md` names 1.0.0 everywhere.
- The orchestrator is a real service now (`apps/orchestrator`, IF-5 with signing, mTLS options and state reports). Handoff H-119 tells you what it does with state reports.

**Your tasks (stream P), in this order:**
1. `node scripts/check-contract-rules.mjs` must show 0 FAIL on your branch before you start.
2. Re-confirm the handoff rows your earlier commits (P-06 and P-08) overwrote with the old `(instance_id, seq)` text: H-04, H-07, H-08, H-09, H-83. Check each against the current text of the row (epoch design, ADR 0025: identity `(instance_id, epoch, seq)`, decision F-1 of 2026-10-12). If your built code differs (for example the `events` table migration or `KeyPort`), fix the code or tell Tanmay in the answer column. Set status and answer, with the date. Also read H-119 and H-120/H-121 context and answer H-119.
3. Update your own files that still say IF-2 keeps its own error bodies: `contracts/api/platform/platform-api.md` and the IF-1 notes. Run `node scripts/generate-api-code.mjs` and `pnpm run contracts:bundle`, commit what changes. Check your dashboards and API return IF-8 bodies for IF-1 errors (they should already).
4. Make `HttpInstanceHost` and its error mapping treat the three new codes (a 501 is "not implemented yet", a 422 cursor is a caller bug). Add or adjust a test.
5. **Sign off.** In `contracts/COMPAT.md`, table "Approvals", set every row with handle `@akshaay29` to `status` = `approved`, `date` = today (YYYY-MM-DD), `version` = `1.0.0` (rows: IF-1, IF-3, IF-8, DB as owner; IF-2, IF-4, IF-5, IF-6, IF-7 as consumer). Do this only if you really reviewed the 1.0.0 content against your code; if something does not fit, leave that row `pending` and write why in the handoff row and in the pull request. Update your review file `docs/reviews/2026-10-12-p08-contract-sign-off.md` with a short "after F-2" section.
6. Tick the lines of the section "Done checklist before contracts-v1.0.0 (L-09)" in `docs/dev/HANDOFFS.md` that are yours (marked Akshay), only for rows you really answered.
7. Run: `node scripts/check-contract-rules.mjs` (0 FAIL), `node scripts/tag-contracts.mjs --dry-run` (the `approvals` line must not list `@akshaay29` any more), `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`, and your own tests (`uv run --locked --package vulnmart-api pytest -q`, pnpm tests for `apps/web`). Dev-log, CHANGELOG line, traceability, story state in `docs/bmad/initiative-platform/` as usual. Open one small pull request.
8. Tell Tanmay: PR number, the dry-run result, and any row you could not approve.

Do not tag, do not push tags, do not touch `apps/shop`, `apps/orchestrator` or other streams' tracker folders.
