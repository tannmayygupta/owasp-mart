---
title: 'Domain event schema (IF-3) with fixtures and replay script'
type: 'feature'
ticket: '3'
created: '2026-10-11'
status: done
baseline_revision: 'd5e520cf2252ad9e9101c10e847a01ed40277539'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context:
  - '{project-root}/docs/architecture/07-repo-and-workstreams.md'
  - '{project-root}/docs/adr/0006-live-updates-sse-hub-valkey-streams.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** IF-3, the contract for what the live stream carries, does not exist. The SSE hub, the dashboards and the lab's publishers (the outbox relay writes to Valkey streams `live:user:<id>`, `live:org:<id>`, `live:admin`) cannot be built until the events, their audiences and their wire format are written down (FR-LIV-01, 05, 06; sprint-zero deliverable 5; P-06, P-07 and L's publishers wait on it).

**Approach:** Add the IF-3 contract: a JSON Schema for the domain events (one schema, a `type` switch), the audience rules (who may receive which type), the SSE wire format (`id`, `event`, `data`, `resync`), fixtures that validate, a validator with tests, and a replay script that emits the fixtures in order to a local consumer. Register the contract, check it in CI, and record the answer to handoff H-22.

## Boundaries & Constraints

**Always:** A domain event carries ids and states, never a flag, flag digest, seed, key, owner hash, submitted text or personal data beyond the ids the audience already has (privacy wall, FR-DSH-06, D-05). The audience of an event is decided on the server from the session and the data, never by a client. The schema is closed (`additionalProperties: false`). Adding a type is additive (minor version); renaming, removing or retyping is breaking. State vocabularies are copied from IF-2 and IF-5 (instance states, access, health, attempt states, milestones) and a check fails if they drift. The contract follows `contracts/registry.json` (registry entry, changelog entry, `registry change:` line).

**Decisions (developer, 2026-10-11):** (1) IF-3 lives in its own folder `contracts/domain-events/` with its own registry entry, not in IF-4's `contracts/events/`; the architecture line (`07`, sections 1 and 3.1) is updated to the new path. (2) The first catalogue is `instance.state_changed` (learner or candidate, admin), `attempt.state_changed`, `attempt.milestone_reached`, `attempt.flag_captured`, `attempt.score_updated`, `attempt.hint_unlocked` (the learner or candidate themself, and the recruiter's company for **candidate** attempts only, never for learner practice) and the control event `stream.resync`; recruiter-side, company approval and admin types are added later by additive change. (3) The replay script starts a tiny SSE server on 127.0.0.1 and a consumer client in the same process (no Docker) and checks wire format, order, audience filter, `Last-Event-ID` and `resync`. (4) H-22: `seq` is a 64-bit integer; events written by the orchestrator or the platform use a reserved range from 2^40 upward; `infrastructure_fault` is written by the orchestrator (source `orchestrator`) and dashboards see it as `instance.state_changed` with state `failed` and an `error_code`, not as a separate domain event.

**Never:** No publisher code, no outbox table or migration (P-05, P-06), no SSE hub (P-22), no dashboard code. No change to stream L's contracts. No new architecture decision beyond this contract.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid fixtures | the committed fixtures, in sequence order | each validates; the replay emits them in order; the local consumer receives the same ids, types and data | None |
| Unknown type, extra member, bad state value | an invalid example | fails at the expected path | Validator exit 1 |
| Forbidden content | a body that holds a flag-like value or a secret-named member | rejected by schema and by a scan | Validator exit 1 |
| Audience breach | a type delivered to an audience its rule does not allow | the replay check fails and names the type and audience | Exit 1 |
| Reconnect | consumer reconnects with `Last-Event-ID` | gets only the events after that id | Missing id: replay answers `resync` |
| Id too old or unknown | `Last-Event-ID` outside the buffer | one `resync` event, nothing replayed | None |
| State drift | an enum differs from IF-2 or IF-5 | validator names the file and value | Exit 1 |

</frozen-after-approval>

## Code Map

- `docs/architecture/07-repo-and-workstreams.md` sections 3.1 and 7.7 (IF-3 owner P, L adds types by pull request, consumers dashboards, hub, L publishers), `docs/architecture/04-data-and-state.md` section 7 (streams `live:*`, trimmed, `resync`), `docs/architecture/05-key-flows.md` (domain event in the same transaction as the state change, relayed to audiences), ADR 0006.
- `contracts/events/` is IF-4's folder in `contracts/registry.json`: every file there belongs to IF-4 and `scripts/validate-events.mjs` scans it. `contracts/errors/` and its checks (`scripts/validate-errors.mjs`) are the pattern to copy (closed schema, manifest of expected paths, `registry change:` line, generated freshness check).
- `contracts/api/lab/lab.openapi.yaml` and `contracts/orchestrator/orchestrator.openapi.yaml`: the vocabularies to copy (instance `State` ten values, `Access`, `Health`, `AttemptState` ten values, `Milestone`, `FlagResult`); IF-2 `Instance` and `Attempt` objects show which fields a dashboard already receives.
- `docs/dev/HANDOFFS.md` H-22 (seq range, `infrastructure_fault`), H-16 and H-23 (state reports, `failed` can retry).
- `scripts/ci-linux.mjs` and `scripts/ci-linux.test.mjs`: each CI `run:` of the jobs it covers must also be a step there. `.github/workflows/ci.yml` job `scripts`.
- `apps/api/src/vulnmart/` (`main.py`, `problem.py`): nothing changes here; `OutboxPort` that publishes IF-3 events is P-05.
- Requirements: FR-LIV-01..06, FR-DSH-01, 03, 05, 06; PB-2.

## Tasks & Acceptance

**Execution:**
- [ ] `contracts/domain-events/`: `domain-events.schema.json`, the audience table, the SSE wire format text, `README.md`; `docs/architecture/07-repo-and-workstreams.md` path updated.
- [ ] `contracts/domain-events/fixtures/` and `examples/`: ordered valid fixtures for a learner session and a candidate session, a manifest of invalid examples with expected paths.
- [ ] `scripts/validate-domain-events.mjs` + tests; `package.json` script; vocabulary-drift check against IF-2 and IF-5.
- [ ] `scripts/replay-domain-events.mjs` + tests: emits the fixtures in order, checks the consumer side (ids, order, audience filter, `Last-Event-ID`, `resync`).
- [ ] `contracts/registry.json`, `contracts/CHANGELOG.md`, `.github/workflows/ci.yml`, `scripts/ci-linux.mjs`: register IF-3 and run both scripts in CI.
- [ ] Record the answer to H-22 in `docs/dev/HANDOFFS.md` (my row, with the answer and date).

**Acceptance Criteria:**
- Given the committed contract, when the validator runs, then it exits 0, and each broken example fails at its expected path.
- Given the fixtures, when the replay script runs, then the consumer receives every event in order with its id and the audiences see only what their rule allows.
- Given a `Last-Event-ID`, when the consumer reconnects, then only later events arrive; given an unknown id, one `resync` arrives.
- Given the contract rules engine (`node scripts/check-contract-rules.mjs`), then it passes with IF-3 registered.

## Implementation Notes

- Built directly in the main session. Found while planning: the registry (`contracts/registry.json`) gives every file under `contracts/events/` to IF-4 and `scripts/validate-events.mjs` scans that folder, so IF-3 went into `contracts/domain-events/` (the architecture path was updated). Stream L's merged contracts already fixed the state vocabularies, so the schema copies them and a check fails on drift. Handoff rows H-01 to H-04 (P-02) had not been answered when P-02 was built; they are recorded now as "answered, to confirm" with the deviations from stream L's defaults, next to the H-22 answer.
- Found by running it: a validator crash when an audience row or the table is missing or has a wrong shape (reported as problems now); a reset-barrier comparison that wrongly resynced a client holding the newest id.
- The local `.venv` sits under OneDrive and uv sometimes cannot replace a folder in it; runs here used `UV_PROJECT_ENVIRONMENT` outside OneDrive.
- No ADR: no architecture decision beyond the contract; the folder move is recorded in the architecture file and the changelog.

## Plan Change Log

## Review Triage Log

## Code Review

### 2026-10-11 Code review complete. 0 `decision-needed`, 22 `patch`, 4 `defer`, 12 rejected.

Four independent reviewers (blind-hunter, edge-case-hunter, verification-gap, intent-alignment) read a 2,325-line diff of 47 files (lockfiles, saved output and the tracker excluded). Verdicts were rendered by the main session.

- [x] [Review][Patch] The validator crashed on a missing audience row, an unusable audience table, a malformed manifest or a schema without `properties.type.enum`; each is now a reported problem [scripts/validate-domain-events.mjs]
- [x] [Review][Patch] A timestamp was only a digit pattern and accepted impossible dates; the schema now adds `format: date-time` (ajv-formats), the hub refuses an unreal time, and two invalid examples cover it [contracts/domain-events/domain-events.schema.json, scripts/replay-domain-events.mjs]
- [x] [Review][Patch] "A failed instance has an error_code, any other state has none" lived only in the validator; the schema now says it, so non-Node consumers enforce it too [domain-events.schema.json]
- [x] [Review][Patch] The vocabulary-drift check was mostly untested and its test did not do what its title said; a table-driven test now adds and removes a value of every shared enum in IF-2 and IF-5 and changes every shared pattern, and every replacement must change the text [scripts/validate-domain-events.test.mjs]
- [x] [Review][Patch] Fixtures were only checked for audiences, one user and one company, and time order; now also one mode per attempt, a state chain (`previous_state` follows the attempt and differs from `state`), non-decreasing epoch, and one row per challenge in a score [validate-domain-events.mjs]
- [x] [Review][Patch] `audiences.json` `modes` is compared with the schema's `Mode`; tests find fixture records by what they are, not by position [validate-domain-events.mjs, tests]
- [x] [Review][Patch] The stub hub left the connection open after `resync` (the client is told to reload and reconnect) and leaked it; it now ends the connection [replay-domain-events.mjs]
- [x] [Review][Patch] `buffer_reset` was documented but never produced; the hub has `reset()` and a check covers it, including that the newest pre-reset id is not resynced [replay-domain-events.mjs]
- [x] [Review][Patch] A fresh connection without `Last-Event-ID` replayed the whole buffer; it is now live-only (the snapshot is read from the API), with a test-only `?replay=all` [replay-domain-events.mjs]
- [x] [Review][Patch] `readSse` swallowed timeouts, so a stalled hub passed "nothing was sent" checks; it now throws, and it parses CRLF frames, skips frames without data and stops at `maxEvents` [replay-domain-events.mjs]
- [x] [Review][Patch] Fixed `setTimeout` sleeps made the live-delivery checks flaky; they now wait for the hub to hold the connection [replay-domain-events.mjs]
- [x] [Review][Patch] Reconnect was tested only for the learner and one assertion could pass vacuously; all four audiences are tested and results must be non-empty [replay-domain-events.mjs]
- [x] [Review][Patch] Resync `occurred_at` was 1970; it is now the time the hub sent it; the heartbeat default is the 15 seconds the README states [replay-domain-events.mjs]
- [x] [Review][Patch] README: the wrong example id; the Valkey stream layout the intent names (`live:user:<id>`, `live:org:<id>`, `live:admin`, one `event` field, the stream id is the SSE id); delivery rules (at least once, dedupe by id, audiences checked while open); the `EventSource` reconnect loop (close and create a new one); what a fresh connection receives; `seq` stays below 2^53 [contracts/domain-events/README.md]
- [x] [Review][Patch] Handoff checklist ticked H-01 to H-03 while their rows said "to confirm"; unticked [docs/dev/HANDOFFS.md]
- [x] [Review][Defer] No mapping from orchestrator infrastructure faults to an `INST-*` code — deferred: needs stream L's fault classes.
- [x] [Review][Defer] The H-22 decision is not yet in IF-4 and IF-5 (stream L's files) — deferred to their story.
- [x] [Review][Defer] The replay cannot be pointed at another hub; no code resolves audiences from an attempt — deferred to P-22 and the relay.
- [x] [Review][Defer] Trim size, connection caps and slow-consumer handling — deferred to P-22 and spike S-2.

**Rejected**
- Low, not worth fixing: duplicated CLI parsing and the audience pattern across scripts (the same style as the other validators); the version string repeated in four places; a magic count of passing checks; drift checks for ranges (score, level) that no other contract states; a fixture jump from epoch 1 to a failed instance at epoch 2 and a candidate attempt with no instance stop (illustrative fixtures); a points-versus-score sum rule (no rule exists to copy); digits in an `INST-*` code (the registry pattern, IF-8, allows capitals only).
- An unissued id inside the buffer range is treated as known: ids are shared across audiences and a stream accepts any id in range, so this matches Valkey; the README states which ids are resynced.
- Accepted by design: the audiences are supplied by the fixtures and compared with the table; the relay that resolves them from an attempt is P-05 and P-22.

## Design Notes

Proposed envelope of an event on the wire (SSE `data`): `{ "schema_version", "type", "occurred_at", ...payload }`; the SSE frame supplies `id` (the stream id) and `event` (the type). Routing (which audience) is not in the payload the browser receives; the publisher passes audience hints to `OutboxPort` and the relay resolves the real audiences.

## Verification

**Commands:**
- `node scripts/validate-domain-events.mjs` -- expected: exit 0
- `node scripts/replay-domain-events.mjs` -- expected: exit 0, events received in order
- `node --test "scripts/*.test.mjs"` -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
- `uv run --locked --package vulnmart-api pytest -q` and `pnpm run contracts:check` -- expected: pass
