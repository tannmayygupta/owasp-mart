# Target-stream consumer review of IF-6 and IF-4

| Field | Value |
|---|---|
| Reviewer | Sahil Roy (stream T, the shop and services) |
| Date | 2026-10-09 |
| Task | T-03 (story 1.3, epic-target-baseline), covers TB-2 |
| Contracts reviewed | IF-6 instance contract v0.1.0 (`contracts/instance/`, merged on `main`); IF-4 instance event contract v0.1.0 (`contracts/events/`, open PR `origin/shared-L-03`) |
| Verdict | Both accepted as a consumer, subject to one change request (CR-1). Versions signed below. |

This is a review and sign-off, not a code change. Change requests are for the contract owner (Tanmay, stream L) to accept and merge; Sahil's approval is required for IF-6 (CODEOWNERS `/contracts/instance/`) and, per D-37, optional for IF-4. The shop reviewed here is the T-01 skeleton plus the planned flows in T-04 to T-32.

## 1. IF-6 instance contract — open points owned by Sahil

Each row of the IF-6 "Open points (to confirm)" table assigned to Sahil, with the shop's position.

| # | Open point | Position |
|---|---|---|
| 2 | Flag format `VM{` + 24 `A-Z2-7` `}` | **Confirm.** Matches the no-flag guard in the catalogue validator (T-02) and IF-4's flag-like check. One shared format across IF-4, IF-6 and IF-7. |
| 3 | Max 11 flags per document | **Confirm.** One per challenge C01–C11. |
| 4 | Seed 32–128 chars `A-Za-z0-9_-` | **Confirm.** Enough entropy for per-instance seeding; the shop only reads it. |
| 6 | Marker `/run/vm/injected`, empty, mode 0444 | **Confirm.** The shop gates `/readyz` on this file in T-04. |
| 7 | Flags file `/run/vm/flags.json`, mode 0400 | **Confirm.** Read by the shop's sentinel logic (C05, C08, C11). |
| 8 | Run user `65532:65532` | **Confirm.** The T-01 image already runs as uid/gid 65532. |
| 9 | Ports: shop 3000, mock-services 9101–9104, bot 9200 | **Confirm.** The T-01 shop listens on 3000. Mock/bot ports are T's to implement (T-11, T-13). |
| 11 | Memory-backed sizes (`/tmp` 64 MB shop, `/data` 256 MB, volumes) | **Confirm as workable.** The skeleton writes nothing to disk; later stories (snapshot copy T-08, imports) stay within these. Re-check when the real DB and snapshot land. |
| 13 | Paths: `/data/shop.db`, `/data/catalog.db`, `/run/vm/snapshot.db`, `/run/import/import.sock` | **Confirm.** `catalog.db` is the C03 read-only catalogue (D-35); the import socket is the C06 transport. |
| 14 | Mount targets exactly `/tmp`, `/data`, `/run/vm`, `/run/import`, `/run/placement/*` | **Confirm.** The shop mounts `/tmp`, `/data`, `/run/vm` (read-only), `/run/import`; it mounts neither placement volume (row 33). |
| 15 | Snapshot hand-over: injector writes to `/run/vm`, shop copies to `/data` before ready | **Confirm.** The shop will copy the snapshot before `/readyz` returns 200 (T-08, T-09). The T-01 skeleton does not yet; noted as the next step. |
| 16 | Placement volumes `/run/placement/import` and `/run/placement/mock` | **Confirm the consumers read these paths.** The import service reads `/run/placement/import` (C06), mock-services reads `/run/placement/mock` (C10), both read-only. |
| 18 | Import service: unix socket, no network, fresh process per job, socket healthcheck | **Confirm.** Matches the C06 design (T-12, T-24). |
| 19 | `decoy_placement` optional string, content defined by T | **Confirm T owns it.** The catalogue (IF-7) defines decoy locations in T-30; the field name is fine. |
| 22 | Event endpoint base `http://sidecar:9000`, mock base `http://mock-services` | **Confirm** (joint with Tanmay). The shop posts app events there (T-10); see IF-4 section below. |
| 24 | Env value ≤ 512 chars; flag-in-env reason 20–300 chars; only the shop may use the exception | **Confirm.** The catalogue validator (T-02) already requires a reason for `flag.delivery: env`; align the length bound there when a challenge uses it. |
| 25 | Env allowlist = the 13 names in section 2 | **Change request CR-1 (below).** The shop's `/version` currently reads two names not on the list. |
| 27 | Sentinel/file paths of placement kinds (file names from IF-7) | **Confirm.** The catalogue (T-02) owns file names; the directories are fixed by row 16. |
| 28 | Shop restart/data loss; no restart policy in v0; a dead shop → orchestrator resets (OI-23) | **Confirm as far as T is concerned.** The shop holds no durable state of its own; OI-23 is a platform decision, left to Tanmay/Akshay. |
| 32 | Injection document size limit and UTF-8 handling on stdin | **Confirm, left to the injector (T).** The injector entrypoint (T-04) will set a sane cap and reject non-UTF-8. |
| 33 | Who mounts the shared volumes | **Confirm.** The shop mounts `/run/vm` read-only and `/run/import`; it never mounts `/run/vm` read-write or either placement volume. |

Rows owned by Tanmay/Akshay alone (1 instance-id shape, 5/10/12/17/20/21/23/26/29/30/31 and others) are not re-decided here; where the shop is a joint owner (1, 2, 22, 28) the position is above.

## 2. CR-1 — the `/version` env names versus the IF-6 env allowlist (open point 25)

**Finding.** IF-6 open point 25 fixes the environment allowlist at the 13 names in section 2. The shop's `/version` endpoint (T-01) reads `VM_BUILD_ID` and `VM_CATALOG_VERSION`, neither of which is on that list (the closest is `VM_CATALOG_DB_PATH`). As written, the orchestrator could not legally set those names and `/version` would always report `dev`.

**Options.**
1. **Shop-side fix (recommended).** The shop does not take a build id or catalogue version from the environment at all: bake the build id into the image at build time (a Docker `ARG`/`LABEL`) and derive the catalogue version from the catalogue file it already ships. Then the 13-name allowlist stays closed and no contract change is needed. The shop would drop `VM_BUILD_ID`/`VM_CATALOG_VERSION` in a follow-up.
2. **Contract-side fix.** Add `VM_BUILD_ID` and `VM_CATALOG_VERSION` to the IF-6 env allowlist as two more non-secret names (a minor, additive bump to IF-6).

**Request to Tanmay:** confirm which path. The target stream prefers option 1 (no contract change). This is the item deferred from the T-01 code review.

## 3. IF-4 instance event contract — event coverage as producer

The shop, import service, mock-services and bot produce app events by posting the "posted" body (`instance-events.posted.schema.json`) to the sidecar (`POST /v1/events` at `VM_SIDECAR_EVENTS_URL`, no `instance_id`/`seq`/signature from the poster, ≤ 4 KiB). The shop does not sign and must not block a player request on the sidecar's answer. **Accepted.**

Coverage check — every shop-side event the 11 challenges rely on is present in the IF-4 catalogue (section 7):

| Challenge | Events the shop/import/mock/bot emit | Present |
|---|---|---|
| C01 | `shop.cross_store_order_read` | yes |
| C02 | `shop.giftcard_attempt` | yes |
| C03 | `shop.catalog_query_error`, `shop.ticket_markup_stored`, `bot.visit`, `collector.hit` | yes |
| C04 | `shop.refund_decision`, `shop.refund_invariant_broken` | yes |
| C05 | `shop.verbose_error`, `ops.page_served` | yes |
| C06 | `import.job` | yes |
| C07 | `auth.reset_requested`, `auth.reset_confirm_batch`, `auth.password_reset_completed` | yes |
| C08 | `webhook.received`, `order.paid`, `gateway.ledger_entry` | yes |
| C09 | `auth.attempt`, `shop.security_event_written` | yes |
| C10 | `importer.fetch_attempt`, `meta.request_served` | yes |
| C11 | `kyc.result`, `store.approved` | yes |

No missing event type for any challenge. The field sets match the milestone signals in `docs/design/challenge-specs.md` section 2. Accepted with these confirmations:

- The shop puts only ids, classes, counts and hashes in `data` (never a flag value); this matches the catalogue validator's no-flag rule. Confirmed the shop will honour it, including redaction in any `evidence.capture` a collector posts.
- `shop.refund_decision.amount` / `cumulative_after` etc. are whole numbers in the smallest currency unit — the shop's money model (T-18) will use integer minor units.
- The shop aggregates `auth.reset_confirm_batch` per 10 s itself (not one event per failed confirm), per section 6.

No IF-4 change request. One observation for later (not blocking): the milestone-to-event mapping is OI-17 / the catalogue's job (IF-7); the shop only emits the events, so nothing to change in IF-4.

## 4. Signed versions

Stream T (the shop and services) builds against:

- **IF-6 instance contract v0.1.0** — signed, conditional on CR-1 being resolved (either option keeps the shop conformant).
- **IF-4 instance event contract v0.1.0** (as on `origin/shared-L-03`) — signed. Approval optional under D-37; the target stream raises no change request.

If either contract takes a breaking change before `contracts-v1.0.0` (L-09), the target stream re-signs. Recommend recording these target sign-offs in `contracts/COMPAT.md` when stream L creates it.

## 5. Actions for the team

- **Tanmay:** decide CR-1 (recommend the shop-side fix, no contract change). The rest of IF-6 and all of IF-4 are accepted by the consumer.
- **Sahil:** post this review's confirmations on the IF-6 record and the IF-4 PR (`shared-L-03`); apply the CR-1 shop-side fix in a shop follow-up if option 1 is chosen; drop the deferred `/version` env-var item once done.
