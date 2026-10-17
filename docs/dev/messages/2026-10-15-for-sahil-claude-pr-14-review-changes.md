# Message for Sahil's Claude session: changes requested on PR #14 (sprint 2 stream T)

Paste everything below the line into your Claude Code session in the repo. Written 2026-10-15 by Tanmay's Claude session after a full review of PR #14 at head `5d6de91`. Plain language, one item at a time.

---

You are working for Sahil (stream T). Read `CLAUDE.md` first and follow it (documentation rule, BMAD story, commit gate). The review of PR #14 asks for changes. The merge with main is clean and the sign-off rows are fine to keep. Your shop tests (90), service tests and the repo checks pass on the review machine. The points below are what is still open. Work on `sprint-2-sahil`, one story per group, and do not touch `apps/orchestrator`, `apps/api`, `apps/web` or other streams' tracker folders. Do not tag.

## A. Must fix before merge

**A1. The new images cannot become healthy under the orchestrator.**
- `infra/images.json` cannot carry a per-role health check: `scripts/images-matrix.mjs` (line 12, `KEYS`) rejects any key other than `name`, `context`, `dockerfile`, `platforms`, `public`. `scripts/images-release.mjs` writes only `{commit, repo, images}`.
- The orchestrator ignores the Dockerfile `HEALTHCHECK`. Without a per-role entry it falls back to `wget` (http), `nc` (tcp) or `test -S` (socket), and none of these exist in your distroless images. All four roles would end in `INST-HEALTH-TIMEOUT`. The demo passes only because the demo's own manifest has a shop entry.
- Do: add an optional `healthchecks` field (role to argv list, run inside the container, no shell tools) to `images.json`, to the validator in `images-matrix.mjs`, and to what `images-release.mjs` writes. Look at how `apps/orchestrator` reads `healthchecks` (`images.py`, `builder.py`) and match that format. Add node-based entries: shop `/readyz`, mock-services port 9101 `/healthz`, bot-controller port 9200 `/healthz`, import-service socket connect (as in its Dockerfile). Add tests to `scripts/images-matrix.test.mjs`. Change `.github/workflows/images.yml` path filters (both) to include `services/**`.
- Tell Tanmay what format you wrote. Tanmay checks that the orchestrator loads the release manifest with the new field and the `commit`/`repo` keys.

**A2. FR-SHP-14 (events) and FR-SHP-15 (instance mode) are overstated.**
- `shopEvent` and `postEvent` (`apps/shop/src/instance/instance.mjs:71,78`) are called only by tests and the harness. `VM_SIDECAR_EVENTS_URL` is never read in `apps/shop/src`.
- In instance mode `server.mjs` calls `createApp` with no database, so the shop pages return 404. Only `/healthz`, `/readyz`, `/version` answer.
- Yet `docs/traceability.md` says FR-SHP-14 is Done, T-10 is ticked, and the IF-4 consumer row is signed.
- Do one of: (a) wire it for real: open the database in instance mode after the injector marker, mount the shop routes, read `VM_SIDECAR_EVENTS_URL`, emit at least the events of the flows you already built, and extend the instance harness to check that a real shop action reaches the fake ingest; or (b) mark FR-SHP-14, FR-SHP-15, T-09 and T-10 as Partial in traceability, the dev-logs and `dev3-sahil.md` (untick), and say plainly in H-121 that the emit path is proven but the shop does not emit on its own yet. Choose (a) if it is a small change; tell Tanmay which you chose.

**A3. Refund double payout** (`apps/shop/src/domain/shop-service.mjs:227`). The guard blocks only `requested` and `approved`. After a refund is `processed`, a second `requestRefund` is accepted and can be paid again. It also does not check the item status (a cancelled item can be refunded), and `openDispute` (`:239`) ignores refunds. Fix: block any refund that is not `rejected` for the item, or sum refunds against `unit_price_cents * quantity`; refuse cancelled items; make the dispute path use the same rule. Add tests for each case.

**A4. Quantity has no upper bound** (`shop-service.mjs:76-82`). A huge quantity (for example 1e15) is accepted and the cart total loses precision. Fix: cap the quantity at 1 to 99, cap the cart line and total, use `Number.isSafeInteger`. Add tests.

## B. Should fix in this PR (or write a dated deferred-work line with a reason)

- **Sessions** (`apps/shop/src/web/session.mjs:60-67`, `routes.mjs:48-51`): add `iat`/`exp` and check them; rotate the CSRF token at login and logout; wrap `decodeURIComponent` of the cookie in try/catch (a bad cookie gives a 500 now).
- **Seeded passwords** (`apps/shop/seed/contributions/010-challenge-accounts.mjs:34-42`): fixed plaintext passwords are in the snapshot. D-02 needs a per-instance overwrite, except for accounts a challenge weakens on purpose. Wire it (injector or entrypoint) or record exactly which story does.
- **Tickets** (`staff-service.mjs:59-78`): `assignTicket` reopens a resolved ticket and `resolveTicket` checks no state. Add a ticket state machine.
- **import-service** (`services/import-service/src/server.mjs`): `MAX_INFLIGHT` 8 against `pids_limit` 64 and 512 MB (each Node worker needs about 6 to 11 threads and 40 to 50 MB): lower it to 2 or 3, or limit threads, and measure under the real limits. Add a connection cap and check the in-flight limit before the body is read. Use the send callback before exit in `worker.mjs:16/20` (`process.send(msg, () => process.exit(0))`). Add a depth cap for the merge.
- **Unbounded lists**: products, orders, tickets, disputes, payouts, users have no LIMIT. Add paging or a cap.
- Smaller: length limits for shipping fields, ticket and review text; log the error in the 500 handler (server side only); stop an admin suspending themselves or the last admin; check the item status before a review; check stock before inserting the payment and use `BEGIN IMMEDIATE`.
- Confirm that the orchestrator passes `VM_GATEWAY_SIGNING_KEY` to mock-services, or the key stays at the dev default (`services/mock-services/src/server.mjs:21`). Tell Tanmay if the env name is missing from the allowlist.

## C. Documentation and process

- **Restore Tanmay's evidence.** `docs/assets/local-demo/demo-output.txt` was overwritten with your `--no-web` run. Restore the version from `origin/main` and save yours as `docs/assets/t03-contracts-signoff/demo-output.txt` (and the harness outputs of T-09 to T-13 in `docs/assets/<task-slug>/`).
- **Ticks and plan states disagree**: T-09 to T-16 are `[x]` in `docs/dev/dev3-sahil.md` but the story plans say `built`. Untick what is not really done (see A2), and set a story to `done` only after you (Sahil) confirm.
- **Stale wording**: the T-03 dev-log header and the CHANGELOG line say Docker is pending, but the runs happened; the "nothing conflicts" sentence in H-121 should read "no conflict found for the posted schema and the sidecar answers"; `docs/bmad/initiative-target/deferred-work.md` uses "H-120 (C11 KYC)" and "H-121 (C10 metadata)" as labels, which clash with the real H-120/H-121 rows: rename them. Word the 2026-10-15 `registry change:` line as "approval status only".
- The bot controller's "~17 MiB" is one idle sample without a browser, so do not write it as the S-5 result. If the catalogue calls the import challenge XXE: the import is a JSON merge and the planted challenge is prototype pollution, so make the wording match.
- Keep in the dev-logs: real commands and real results only, a Summary and a Security section.

## D. After the changes

1. `pnpm install --frozen-lockfile`, `node --test` in `apps/shop` and `services/*`, `node --test "scripts/*.test.mjs"`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`, `node scripts/check-contract-rules.mjs` (0 FAIL), `node scripts/images-matrix.mjs`, the instance harnesses and `node scripts/dev.mjs demo` (Docker, with the web dashboards).
2. Merge `origin/main` once more (it has docs-only changes on top) before you push; keep CHANGELOG and traceability as unions.
3. Push to the same branch and tell Tanmay: what you chose for A2, the `healthchecks` format, and the test results.
