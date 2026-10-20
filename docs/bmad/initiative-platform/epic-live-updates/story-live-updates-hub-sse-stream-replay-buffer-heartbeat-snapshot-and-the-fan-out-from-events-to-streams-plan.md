---
title: 'Live updates hub: SSE stream, replay buffer, heartbeat, snapshot and the fan-out from events to streams'
type: 'feature'
ticket: '1'
created: '2026-10-18'
status: done
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/architecture/05-key-flows.md'
  - '{project-root}/contracts/domain-events/README.md'
  - '{project-root}/docs/prd/PRD.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** Nothing moves a change to the browser: events are published into an in-memory stand-in, there is no replay buffer, no stream route and no snapshot, so a dashboard could only reload (FR-LIV-01, 02, 04, 06).

**Approach:** The IF-3 event goes into a database outbox (`domain_events`) in the transaction of its cause; a relay in the worker process resolves the audiences from the attempt and appends the event to the Valkey stream of each (one append per outbox row, trimmed by length and age); the hub in the API process serves `GET /api/v1/live` from the streams the session allows, with ids, `Last-Event-ID` replay, `stream.resync` for an unknown, too old or reset id, a 15-second heartbeat and no buffering; `GET /api/v1/live/snapshot` is the way back and the polling fallback. Migration 0013. The web proxy must not compress the stream.

## Boundaries & Constraints

**Decisions (developer):** "continue automatically", branch, pull request and merge per task; no open question of the PRD blocks this story. Claude's choices, in ADR 0052 (Proposed) for confirmation: the hub in the API process, ids from one counter, an idempotent append, the trim and reset facts, the placeholder sizes and caps (OI-25), audiences resolved by the relay from the attempt, the web proxy without compression.

**Always:** a publisher never names an audience; the audiences of a connection come from the session and nothing the client sends; learner practice never reaches a company; an event holds ids and states only; the relay appends each outbox row once per stream, in order; every resync reason ends the connection with one `stream.resync` and no id; the stream answer is `private, no-store` with `X-Accel-Buffering: no`; the session is checked again while the stream is open; a client that does not read is dropped.

**Never:** No browser client (the dashboards', epic 8); no `POST /api/v1/live/ticket` (pending spike S-14); no HTTP/2 or per-role authorisation tests beyond the session (story 7.2 / P-23); no events produced here (the lab and the platform publish them); no company-wide snapshot (P-27).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Publish | valid IF-3 event | row in `domain_events`, with its cause's transaction when given | EventInvalid naming the member |
| Relay | unpublished rows | appended to each audience stream once, in order, rows marked | attempt not found: wait, then drop after 20 passes, logged without content |
| Relay dies half way | append done, mark not | the next pass appends nothing twice | n/a |
| Open stream | session | `: stream open`, then only events after connecting, heartbeat comment every 15 s | no session: 401; too many streams: 429 |
| Reconnect | `Last-Event-ID` | the events after it, once, in order | not an id or newer than any: `id_unknown`; from before a reset: `buffer_reset`; older than a trim: `id_too_old`; one `stream.resync`, the connection ends |
| Session ends or its streams change | while open | the connection ends within 30 s | the client reconnects with a fresh session |
| Client does not read | queue full for 10 s | the connection is dropped | n/a |
| Snapshot | session | the caller's attempts and instances | no session: 401 |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/live/{models,publisher,relay,store,hub,snapshot,api}.py`, `migrations/versions/0013_domain_events.py` (single head 0013).
- `ports/outbox.py` (`check_event`, shared with the fake), `kernel/services.py` (`LiveOutbox`), `kernel/entrypoints/worker.py` (the relay loop), `kernel/settings.py`, `main.py`, `apps/web/next.config.mjs` (`compress: false`).
- Tests: `test_live_hub.py`, `test_live_relay.py`, `test_live_api.py`, `test_live_postgres.py`; stack test `scripts/e2e/platform-stack.e2e.test.mjs`.

## Tasks & Acceptance

**Execution:**
- [x] Outbox table, publisher and the shared event check.
- [x] The store (in memory and Valkey) with the idempotent append, trims and facts; the relay and its loop in the worker.
- [x] The hub and the two routes; the snapshot over the lab runtime.
- [x] Unit tests against both stores, Postgres tests as the application role, the real-stack test through the web origin.

**Acceptance Criteria:**
- Given a row in the event outbox, then it appears on an open stream through the web origin within a few seconds.
- Given the API was stopped, then a reconnect with `Last-Event-ID` gets what was missed, once and in order.
- Given another user's events, then they never reach this user's stream.
- Given an unknown id, then one `stream.resync` and the connection ends; the snapshot answers.
- Given a stream with nothing happening, then a heartbeat comment arrives.

## Implementation Notes

- The first run of the stack test showed that the web proxy (Next, `compress` on by default) holds back an SSE answer when the client accepts gzip, which every browser does: the first frame never arrived. `compress: false` in `next.config.mjs` fixes it for the local stack; Vercel and Caddy in front of production are not verified (S-2, S-14).
- A test with a non-ASCII digit showed that the id pattern used `\d`, which also takes the digits of other scripts; it is `[0-9]` now.
- The Starlette test client waits for a response to finish, so the route tests use finite streams (a short maximum age); endless behaviour is tested on the hub.

## Plan Change Log

## Review Triage Log

### 2026-10-18, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | The web proxy gzip-compressed the stream and held it back, so no frame reached the client | high | patch | found by the real-stack test; `compress: false`, first frame in 61 ms afterwards |
| 2 | The id pattern accepted non-ASCII digits | low | patch | found by a unit test; `[0-9]` |
| 3 | The relay lock could be removed without a test noticing | medium | patch | a test with four relays counts the appends (30, and 120 with the lock disabled, checked by hand) |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (after `docker compose -f infra/compose/compose.yaml --profile platform --profile web build api`) -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
