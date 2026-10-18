# Live updates hub: SSE, heartbeat, snapshot with polling fallback, fan-out (P-22, story 7.1)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-3-akshay-6 / see the pull request |
| Status | Built and tested at the server side, on the local stack through the web origin. Not built: the browser client and its polling fallback (the dashboards'), HTTP/2 and the per-role stream tests (P-23), the ticket route (pending spike S-14), any event publisher in the lab (stream L, H-142), a company-wide snapshot (P-27), purge of old outbox rows (P-24). Not verified: SSE through Vercel and Caddy (spikes S-2, S-14). Story 7.1 is `built`, awaiting the developer's confirmation |
| Report tag | live updates, Server-Sent Events, replay buffer, outbox relay, Valkey Streams, BMAD cycle |

## Requirements covered
FR-LIV-01 (SSE streams with ids and replay), FR-LIV-02 (heartbeat, no buffering), FR-LIV-04 (snapshot, polling fallback server side), FR-LIV-06 (fan-out through Valkey, nothing lost when an API process dies). FR-LIV-05 is built for the part that is the session (the streams come from it and are checked while open); its per-role tests and FR-LIV-03 (HTTP/2) are P-23. Related: ADR 0052 (new), ADR 0006, contracts IF-3 and IF-1, handoff H-142 (new). The epic `epic-live-updates` was incepted in this task (`tickets.toml`: stories 7.1 = P-22 and 7.2 = P-23). No open question blocks the story; the numeric target of NFR-PRF-03 waits for spike S-2.

## Summary (plain language, 3-5 lines)
A change in the platform now reaches an open dashboard connection: the event is stored in the database with the thing that caused it, a background relay copies it into a short replay buffer per user or company, and each open `GET /api/v1/live` connection receives the events its session may see, with ids. A reconnect after a drop (or after the API was restarted) asks for what it missed and gets it once and in order; if the buffer cannot tell, the connection says "reload" and the page reads the snapshot. A heartbeat keeps the connection open through proxies, and a client that does not read is dropped.

## Why
The dashboards (epic 8) need live progress, and there was nothing between the lab and the browser: events went into an in-memory stand-in and no stream or snapshot route existed.

## What was built
- `live/models.py`, migration 0013: `domain_events` (the IF-3 event as the browser reads it, no audience; the application role may add, read, delete and mark rows but not change an event).
- `live/publisher.py`: `DbEventPublisher` (in the cause's transaction when given its session) and `LiveOutbox`; `ports/outbox.py::check_event` shared with the in-memory outbox; `kernel/services.build_ports` gives every process with a database a durable event port.
- `live/store.py`: the replay buffer in memory and in Valkey (one Lua script per append: duplicate refusal, one id counter for all streams, facts, exact trims). `live/relay.py`: the relay (one at a time under a Postgres advisory lock, audiences resolved from the attempt, dropped after 20 passes) and its loop in the worker (`kernel/entrypoints/worker.py`, setting `live_relay_interval_seconds`).
- `live/hub.py`, `live/api.py`, `live/snapshot.py`: the hub (replay, three resync reasons, heartbeat, session check, maximum age, slow-client drop, caps), the routes `openLiveStream` and `getLiveSnapshot`, and the snapshot over the lab runtime.
- `main.py` wiring (`live_store`, `live_config`, `live_snapshot` for tests); `apps/web/next.config.mjs` `compress: false`; ADR 0052 (Proposed); handoff H-142; the epic breakdown and the plan of story 7.1.

## How it works
A publisher adds a row to `domain_events` in its cause's transaction. Every 250 ms the worker's relay takes the unpublished rows in order, looks up each attempt's owner and company, works out the streams from the audience table of the contract, and appends the event to each; a script in Valkey makes the append idempotent per outbox row, gives the entry an id from one counter, trims the stream and records what it removed. The hub reads the streams of the connection's session with a blocking read that also times the heartbeat, puts the frames in a bounded queue and writes them; a reconnect is checked against three facts (the newest id given out, the first since the store was empty, and what each trim removed) and either replayed or answered with one `stream.resync` and closed.

## Files changed
- New: `live/{models,publisher,relay,store,hub,snapshot,api}.py`, `migrations/versions/0013_domain_events.py`, tests `test_live_hub.py`, `test_live_relay.py`, `test_live_api.py`, `test_live_postgres.py`, `docs/adr/0052-*.md`, the plan of story 7.1, `tickets.toml` of the epic, `docs/assets/p-22-live-updates/`.
- Changed: `ports/outbox.py`, `ports/fakes.py`, `kernel/{services,settings}.py`, `kernel/entrypoints/worker.py`, `main.py`, `migrations/env.py`, `apps/web/next.config.mjs`, `test_kernel_settings.py` (head 0013 and the table list), `scripts/e2e/platform-stack.e2e.test.mjs`, `docs/architecture/04-data-and-state.md`, `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer: "continue automatically", branch, pull request and merge per task. By the builder, in ADR 0052 (Proposed) for confirmation: the hub in the API process (not a second container), ids from one counter, an idempotent append, trim and reset facts, the placeholder sizes and caps (OI-25), audiences resolved by the relay from the attempt, the web proxy without compression.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-22-live-updates/`.
- New tests, 137: `test_live_hub.py` 66 (the store and the hub; each store test runs against the in-memory store and the real Valkey: ids, the idempotent append, trims by length and age, facts and reset, replay, the three resync reasons, heartbeat, isolation between streams, session check, maximum age, slow client, caps, a store failure, 8 threads appending), `test_live_relay.py` 40 (the contract's audience table equals the code's, the contract's examples pass the event check, publishing and rollback, audiences by attempt, order, a relay killed after its second append and restarted, an attempt not there yet, dropping, batches, the loop surviving a failing pass), `test_live_api.py` 24 (the routes on SQLite: 401, headers, replay, no other user's events, the client cannot pick a stream, resync, caps, the streams per role, the snapshot), `test_live_postgres.py` 7 (as the application role: table and privileges, the relay over the real tables, four relays at once make 30 appends, with the lock removed by hand the same test counted 120, a published event through Postgres, the relay, Valkey and a hub connection, migration 0013 down and up).
- Full run of `pytest apps/api/tests` with the two containers on the final code: **2491 passed, 0 failed, 1 skipped** (435 s; the one skip is a Windows file-mode check in the lab tests). A run before the last fix had one failure (`test_every_table_of_the_metadata_is_in_the_table_owners_file`: its hard-coded list did not know `domain_events`; it only fails in a full run) and is kept as `pytest-run1-table-list-test-failure-2026-10-18.txt`.
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **27 of 27** on the final code (`platform-stack-e2e-2026-10-18.txt`). The new test, through the web origin: an unauthenticated stream is refused with 401; the first frame arrives at once; an event row appears on the open stream (**650 ms** from the insert to the frame, relay every 250 ms; the target is not set until spike S-2); an event published through the API's port arrives too; another user's event never arrives; a heartbeat comment comes; Valkey holds the stream with 3 entries; after the API container was stopped, two events published and the API started, a reconnect with `Last-Event-ID` gets the second and third and the two missed ones, once and in order; an unknown id gets one `stream.resync` without an id and the connection ends; the snapshot answers with the contract's shape; nothing is left unpublished or dropped. The first stack run failed the new test (see Problems) and is kept as `platform-stack-e2e-run1-gzip-buffering-2026-10-18.txt`; it also failed the older mail test on a Mailpit request timeout that did not repeat.
- `node scripts/check-contract-rules.mjs`: 16 PASS, 0 FAIL, 1 not applicable, alembic head 0013 (`contract-rules-2026-10-18.txt`). One run right after the full test run, in the same shell with the test environment set, reported the table-owners check as unable to run (its uv build step) and passed when rerun alone; the saved output is the passing one. The text-hygiene, progress-page, dev and demo script tests: 70 of 70. The web unit tests: 9 of 9.
- NOT run: a browser, the Vercel and Caddy path, HTTP/2, anything on the VMs, CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-22-live-updates/`: the test outputs, the two failed runs, and the proxy probe (`web-proxy-compression-probe-2026-10-18.txt`).

## Problems met and how they were fixed
- The real-stack test found that the web proxy (Next, gzip on by default) holds back a stream when the client accepts gzip, as every browser does: the first frame never arrived in 6 s, with `identity` it came in 143 ms. `compress: false` in `next.config.mjs` fixed it (61 ms). The production front (Vercel, Caddy) is not verified.
- A unit test with a non-ASCII digit showed the id pattern used `\d`, which also takes the digits of other scripts; it is `[0-9]` now.
- The Starlette test client waits for a response to finish, so the route tests use finite streams (a short maximum age) and the endless behaviour is tested on the hub and on the stack.
- The async Valkey client keeps connections that belong to the loop that opened them, so the tests share one loop; the sync client pool was too small for eight threads and was enlarged.
- The hard-coded table list of `test_kernel_settings.py` failed only in a full run (above).

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: the streams of a connection come from the session and nothing the client sends (a test sends other users' ids, query parameters and audience headers); learner practice has no company audience; an event holds ids and states only and the schema check refuses an audience or any other member; the application role cannot rewrite an event; the stream answer is `private, no-store`, `X-Accel-Buffering: no`; the session is checked every 30 s and the connection ends when it is gone or its streams changed; a client that does not read is dropped and the caps per user and per process hold; the relay logs only an id and a type when it drops an event.

## Limitations and follow-ups
- Nothing in the lab or the platform publishes events yet (H-142); the client, HTTP/2 and the per-role tests (P-23) and the dashboards are still to come. The caps are per API process; idle streams are trimmed only when appended to; old outbox rows are not purged (P-24, P-25).
- All sizes, caps and intervals are placeholders (OI-25) and the latency target waits for spike S-2. ADRs 0040 to 0052 are Proposed.
- Remind: Excel, P-22 Done = Yes; confirm story 7.1 so it can move to `done`.
