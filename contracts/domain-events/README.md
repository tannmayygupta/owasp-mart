# IF-3: domain events (what the live stream carries)

Version **0.1.0** (story P-03). Owner: stream P (Akshay); stream L adds types by pull request. Consumers: the dashboards, the SSE hub (P-22) and stream L's publishers. Architecture: `docs/architecture/07-repo-and-workstreams.md` section 3.1 and ADR 0006. Requirements: FR-LIV-01, 05, 06, FR-DSH-01, 03, 06.

This contract lives in its own folder, not in `contracts/events/`: that folder is IF-4's in `contracts/registry.json`.

## What is here

| File | What it is |
|---|---|
| `domain-events.schema.json` | One closed JSON Schema: the `data` of one Server-Sent Event, seven types |
| `audiences.json` | Who may receive which type (user, org, admin), by attempt mode |
| `fixtures/session.json` | 18 published records in order: a learner practising, a candidate taking an assessment |
| `examples/valid`, `examples/invalid` | One valid event per type; each invalid one is in `examples/invalid/manifest.json` with the path and stage (schema or semantic) where it must fail |

## The event

What the browser reads as the `data` of an SSE message: `{ "schema_version": 1, "type", "occurred_at", "data" }`. The closed schema allows no other top-level member: the audience is **never** in the event.

| Type | Meaning | `data` |
|---|---|---|
| `instance.state_changed` | An instance moved to a new state | `instance_id`, `attempt_id`, `state`, `access`, `health`, `epoch`, `error_code` (an `INST-*` code of the error registry while `failed`, else null) |
| `attempt.state_changed` | An attempt moved to a new state | `attempt_id`, `mode`, `state`, `previous_state`, `deadline_at` |
| `attempt.milestone_reached` | A milestone M1, M2 or M3 was reached | `attempt_id`, `mode`, `challenge_key`, `milestone` |
| `attempt.flag_captured` | A capture that counts (not a held one, not a wrong one) | `attempt_id`, `mode`, `challenge_key` |
| `attempt.score_updated` | The score was recomputed | `attempt_id`, `mode`, `score` (0 to 1000), `computed_at`, `per_challenge` |
| `attempt.hint_unlocked` | A hint level was unlocked (the text is never in the event) | `attempt_id`, `mode`, `challenge_key`, `level` (1 to 3) |
| `stream.resync` | Control event, see below | `reason` |

Timestamps are UTC to the second and must be real dates (`format: date-time` plus a pattern). A failed instance has an `error_code` and any other state has none: the schema says so, so a non-Node consumer enforces it too. An event holds ids and states only. Never a flag, a flag digest, a seed, a key, an owner hash, a submitted text, a hint text, a host or personal data. State vocabularies and id shapes are copied from the lab API (IF-2) and the orchestrator API (IF-5); the validator fails when they drift.

## Who receives what

`audiences.json` is the rule; the relay resolves the real audiences on the server from the attempt, and a publisher never names a user or a company by hand. `user` is the owner of the attempt, `org` the company that owns the assessment of a **candidate** attempt, `admin` every admin.

- Learner practice never reaches an org (D-05, the privacy wall). A validator rule fails any table row that sends a learner event to an org.
- While OI-15 (when a candidate sees results) is open, the candidate does **not** receive their own milestones, captures or score live; the recruiter does. Change the table when OI-15 is decided.
- The admin receives instance state only. Recruiter-side, company approval and admin types are added by later stories as additive changes.
- An orchestrator infrastructure fault reaches the dashboards as `instance.state_changed` with state `failed` and an `error_code` (handoff H-22), not as a separate event.

## Publisher side: the Valkey streams

The outbox relay (P-05, P-22) writes each event to the stream of **each** audience it resolved (architecture 04, section 7):

| Audience | Stream key |
|---|---|
| `user:<id>` | `live:user:<id>` |
| `org:<id>` | `live:org:<id>` |
| `admin` | `live:admin` |

- One entry per audience, with one field `event` that holds the event JSON exactly as the browser receives it. The stream id Valkey gives the entry (`<milliseconds>-<sequence>`) becomes the SSE `id`.
- Streams are trimmed by age or length (the numbers are decided with the hub in P-22). A hub read after a trim, or after a Valkey reset, ends in `stream.resync`.
- `scripts/replay-domain-events.mjs` mirrors this with `streamKey()` and derives its ids from `occurred_at` so the checks are deterministic; the real ids are Valkey's.

## The wire (SSE)

```
id: 1791709660000-0
event: attempt.milestone_reached
data: {"schema_version":1,"type":"attempt.milestone_reached","occurred_at":"2026-10-11T09:07:40Z","data":{...}}

: heartbeat
```

- `id` is the stream id, `<milliseconds>-<sequence>`: the time the hub inserted the entry, which can be slightly later than `occurred_at`. Ids only grow. `event` equals the `type`.
- A heartbeat comment about every 15 seconds (FR-LIV-02, `HEARTBEAT_MS` in the replay script); the response is `text/event-stream`, `Cache-Control: private, no-store`, `X-Accel-Buffering: no`. The `retry:` field is not used.
- A connection **without** `Last-Event-ID` receives only the events published after it connects: the page first reads its snapshot from the API (FR-LIV-04) and then follows the stream.
- On reconnect the browser sends `Last-Event-ID`; the hub replays the events after it that this connection may see, and never one its audiences may not see.
- An id that is not a stream id or is newer than the newest, one older than the oldest the buffer kept, or one from before a Valkey reset gets one **`stream.resync`** event and the hub **ends the connection**. Reasons: `id_unknown`, `id_too_old`, `buffer_reset`. The event has no `id` and is never stored; its `occurred_at` is the time the hub sent it. A client holding exactly the newest id before a reset is up to date and is not resynced.
- After `stream.resync` the client discards what it holds, reloads the snapshot and opens a **new** connection without `Last-Event-ID`. A native `EventSource` keeps its last id when it reconnects by itself, so the client calls `close()` and creates a new `EventSource`.

## Delivery rules

- **At least once.** A client may see an event twice (a reconnect overlaps): it ignores any event whose id is not greater than the last one it applied.
- **Audiences are checked while the stream is open.** The hub closes a connection when the session ends, is revoked or the user's audience changes (FR-LIV-05); the client reconnects with a fresh session. Connection caps and slow-consumer handling are decided with the hub in P-22.
- **No event is ever a source of truth.** The database is; the dashboards re-read the snapshot on `stream.resync` (ADR 0006).

## Sequence numbers outside the sidecar (handoff H-22)

The `seq` of instance events (IF-4) is a 64-bit integer in the database. Events written by the orchestrator or the platform use a reserved range from 2^40 up to 2^53 - 1, so they never meet the sidecar's counter and JSON and JavaScript clients still read the number exactly. `infrastructure_fault` is written by the orchestrator (source `orchestrator`); the platform shows it to dashboards as `instance.state_changed` with state `failed`. P-06 sizes the column accordingly.

## Changing it

- **Adding** a type or an optional member is additive: minor version bump in `contracts/CHANGELOG.md`; add the audience row, a valid example, and a fixture if it matters.
- **Renaming, removing or retyping** is breaking: every consumer approves.
- Application code publishes through `OutboxPort` (P-05); it does not build events by hand.

## Checks

`pnpm run domain-events:check` runs `node scripts/validate-domain-events.mjs` (schema, audience rules, IF-2 and IF-5 vocabulary drift, examples, fixtures with one user, company and mode per attempt, a consistent state chain and non-decreasing epochs, secrets) and `node scripts/replay-domain-events.mjs`. The replay starts a small SSE hub on `127.0.0.1` that stands in for the platform hub (it takes the audiences from a **test header**; the real hub takes them from the session) and a consumer that checks order, ids, audience filtering, `Last-Event-ID`, all three `resync` reasons, live-only fresh connections and heartbeats. CI runs both.
