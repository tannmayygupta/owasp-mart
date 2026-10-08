# 0006. Live updates: SSE hub on Valkey Streams with an outbox

- **Status:** Proposed
- **Date:** 2026-10-08
- **Deciders:** (pending the user)
- **Requirements:** D-17; FR-LIV-01..06, FR-DSH-03, NFR-PRF-03

## Context
D-17 fixes SSE with IDs, replay, heartbeats and a polling fallback but not how events fan out or are replayed.

## Options considered
1. Domain-event outbox table in Postgres, relayed to Valkey Streams; stream IDs become SSE ids.
2. Valkey pub/sub only: no replay.
3. Postgres LISTEN/NOTIFY with table replay: loads the database with open connections.
4. In-process memory: lost on restart, breaks with several processes.

## Decision (proposed)
Option 1. A separate SSE-hub container (second entrypoint of the API codebase) reads streams with blocking reads that double as the 15-second heartbeat; audiences come from the session, never from the client; streams are trimmed by age or length; a missing or too-old id yields a `resync` event and a snapshot reload; the hub closes streams after a fixed age and the browser reconnects. Plan B (ticketed direct SSE with an exact-origin CORS route) needs the user's OK.

## Consequences
Postgres stays the truth; Valkey loss costs only a resync. Client code must handle that a 401 or 204 stops EventSource reconnecting.

## Evidence
https://html.spec.whatwg.org/multipage/server-sent-events.html (VERIFIED); https://valkey.io/commands/xadd/ and https://valkey.io/commands/xread/ (VERIFIED); https://caddyserver.com/docs/caddyfile/directives/reverse_proxy (VERIFIED, event-stream flush). Through a Vercel rewrite: UNVERIFIED (S-2, S-14).
