# Message for Sahil's Claude session: second review of PR #14 (head 49f0c34), what is left

Paste everything below the line into your Claude Code session in the repo. Written 2026-10-16 by Tanmay's Claude session. Plain language, small steps. Read `CLAUDE.md` first and follow it (documentation rule, BMAD story, commit gate). Work on `sprint-2-sahil`; do not touch `apps/orchestrator`, `apps/api`, `apps/web`, other streams' tracker folders; do not tag.

---

The second review of your commit 49f0c34 found the shop-side blockers fixed (instance mode mounts the shop on the injected snapshot, real `auth.attempt` and `order.paid` events, refund and quantity guards, ticket and admin guards, cookie decode, import-service cap and flush). Shop tests 106/106 on the review machine. Not merged yet: the points below.

## A. Image healthchecks: nothing for you to change in the script

The release file `{commit, repo, images, healthchecks}` could not be loaded by the orchestrator (it refused `commit` and `repo`, refused the image `hello`, and passed the argv to Docker without `CMD`). Tanmay fixed this on the orchestrator side (new `ImageAllowlist.from_release`, handoff H-124, in the next Tanmay pull request): keep emitting the argv without `CMD` exactly as now (`/nodejs/bin/node ...`); the loader adds `CMD`. Do not add `CMD` yourself. What you must keep: argv[0] an absolute path, never a shell, wget, curl or nc; every role named in `healthchecks` has an image. Fix the sentence in `docs/dev-log/2026-10-16-sahillroy-pr14-review-response.md` that says the orchestrator "runs the argv as-is" (it adds `CMD`), and say the end-to-end proof is the first real CI release plus the demo.

## B. Must fix before merge

1. **Refund after dispute** (`apps/shop/src/domain/shop-service.mjs`, `requestRefund` about :229-258): the dispute guard refuses when a refund is settled, but the refund guard does not look at disputes. Open a dispute first, then request a refund: the item can be compensated twice. Refuse a refund when a dispute on the item is open, under review, escalated, or resolved with a refund. Add a test for the reverse order. If a later challenge plants this on purpose, that is a separate path; keep the baseline correct.
2. **Import service slowloris** (`services/import-service/src/server.mjs`): the connection cap (12) uses an idle timeout that resets on every byte, so twelve clients trickling a byte every 9 seconds starve everyone. Add an absolute per-connection deadline (about 15 s) in addition to the idle one, and a test.
3. **Docs must say what the code does.**
   - `docs/traceability.md`: FR-SHP-14 and FR-SHP-15 say "Done"; use "Partial" until a real Docker run of the healthcheck through the orchestrator (with Tanmay's loader) is recorded; the events are only `auth.attempt` and `order.paid` (say so; `shop.refund_decision` and the per-challenge events are challenge-epic work). LB-3 appears twice with different states: keep one.
   - `docs/dev/HANDOFFS.md`: H-28, H-29, H-31, H-36, H-37, H-38, H-40, H-44, H-47, H-52 and H-54 are all still `open` with no answer from you. For each row write a status and a short answer (done, partly done with what is missing, or deferred with the task that does it), dated.
   - `docs/dev/dev3-sahil.md` ticks T-03 and T-09 to T-14 while the story plans under `docs/bmad/initiative-target/` say `built`: untick what is not really done, or set a story to `done` only after you confirm it (CLAUDE.md task cycle step 4).

## C. Should fix (this PR, or a dated line in `deferred-work.md` with a reason)

- Before the first `/readyz` call every request gets a logged 500 "shop database is not ready": answer 503 for non-health routes until ready.
- `makeEmitter` has no in-flight cap: a login flood against a slow sidecar opens unbounded sockets. Cap it (about 32) and drop events above the cap.
- `safeMerge` at depth 8 assigns the rest unfiltered (skips the `__proto__`, `constructor`, `prototype` filter): drop the value at the cap or copy it with the filter.
- Check every cart write path (an update-quantity route, merge on add) against the 1..99 cap; add a test.
- **Session expiry and CSRF rotation:** you deferred them as possibly intended vulnerability. The reviewer found no session-expiry or fixation challenge in the specs (C07 is Authentication Failures: reset and brute force; confirm its scope in `docs/design/challenge-specs.md`). Treat a cookie that never expires as a baseline gap: add `iat`/`exp`, check them in `parse`, rotate the CSRF token at login and logout, or log it in `deferred-work.md` as a tracked defect with an owner and the C07 reading. Do not call it a planted weakness unless a challenge spec says so.
- Accepted as deferred: stock check with `BEGIN IMMEDIATE`, list paging, field length limits, seeded-password per-instance overwrite (D-02; the injector owner decides), as long as each has a line in `deferred-work.md`.

## D. After the changes

1. `pnpm install --frozen-lockfile`, `node --test` in `apps/shop` and `services/*`, `node --test "scripts/*.test.mjs"` (one known Windows failure: `generate-api-code.test.mjs`), `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`, `node scripts/check-contract-rules.mjs` (0 FAIL), `node scripts/images-matrix.mjs`, the instance harnesses and `node scripts/dev.mjs demo`.
2. Merge `origin/main` before you push (union for CHANGELOG and traceability; newest text for handoff rows).
3. Push the same branch and tell Tanmay: the answers to B.3, what you chose for the session point, and the test results.
