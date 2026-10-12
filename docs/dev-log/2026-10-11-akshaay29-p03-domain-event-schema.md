# Domain event schema (IF-3) with fixtures and replay script (P-03, story 1.3)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-1-akshay-2 / local commit, not pushed |
| Status | Done; awaiting Tanmay's review (publisher side, audience table, `stream.resync`); not pushed or merged |
| Report tag | contracts, live updates, BMAD cycle |

## Requirements covered
PB-2 (domain event schema IF-3 with fixtures and replay script). Related: FR-LIV-01, 02, 04, 05, 06, FR-DSH-01, 03, 06, D-05, D-17, ADR 0006, architecture 07 sections 3.1 and 7.7 row 5, handoff H-22.

## Summary (plain language, 3-5 lines)
The live stream now has a written contract: seven event types as one closed JSON Schema, a table of who may receive each one, the Valkey stream layout and the SSE wire format, and ordered fixtures. A validator checks it (including against the lab and orchestrator contracts and the error registry), and a replay script plays the fixtures through a small local SSE hub to a consumer and checks order, ids, who sees what, reconnects and resyncs. The SSE hub, the dashboards and the lab's publishers can now be built against it.

## Why
The SSE hub, the dashboards and stream L's publishers wait on this contract (FR-LIV-01, 05, 06; sprint-zero deliverable 5; P-06, P-07 and the publishers). It also answers handoff H-22.

## What was built
- `contracts/domain-events/`: `domain-events.schema.json` (closed; `instance.state_changed`, `attempt.state_changed`, `attempt.milestone_reached`, `attempt.flag_captured`, `attempt.score_updated`, `attempt.hint_unlocked`, control event `stream.resync`; real dates; a failed instance has an `error_code`), `audiences.json`, `README.md` (stream layout, wire format, delivery rules), `fixtures/session.json` (18 records: a learner practising and a candidate taking an assessment), 8 valid and 25 invalid examples with a manifest.
- `scripts/validate-domain-events.mjs`: schema, audience rules (learner practice never goes to a company), vocabulary drift against IF-2 and IF-5, `INST-*` codes against the error registry, examples, fixtures (audiences, one user, company and mode per attempt, state chain, epochs, time order), no flag-like value or secret-named member.
- `scripts/replay-domain-events.mjs`: a local SSE hub (replay buffer, stream ids, per-audience filtering, `Last-Event-ID`, `resync` for unknown, too old and reset ids, heartbeats) and a consumer; 14 checks.
- Registry entry IF-3, changelog, CODEOWNERS line, architecture path update, `pnpm run domain-events:check` in CI and in `ci:linux`, handoff answers.

## How it works
A publisher hands the outbox an event; the relay resolves the audiences from the attempt (user, company for candidate attempts, admin), writes the event to each audience's Valkey stream (`live:user:<id>`, `live:org:<id>`, `live:admin`), and the hub reads the stream and sends SSE frames (`id`, `event`, `data`). A client with no `Last-Event-ID` reads its snapshot from the API and then follows the stream; a client with a stale id gets one `stream.resync` and a closed connection, then reloads and reconnects. An event holds ids and states only; no flag, hint text, secret or personal data.

## Files changed
- `contracts/domain-events/` (new), `scripts/validate-domain-events.mjs`, `scripts/replay-domain-events.mjs` and their two test files (new)
- `contracts/registry.json`, `contracts/CHANGELOG.md`, `.github/CODEOWNERS`, `.github/workflows/ci.yml`, `scripts/ci-linux.mjs`, `package.json`
- `docs/architecture/07-repo-and-workstreams.md` (the IF-3 path), `docs/dev/HANDOFFS.md`
- `docs/bmad/initiative-platform/`: story plan with the review log, `deferred-work.md`

## Decisions made
No ADR. By the developer on 2026-10-11: (1) IF-3 lives in `contracts/domain-events/`, not in IF-4's `contracts/events/`; (2) the first catalogue is the seven types above with the audience table of `audiences.json`; (3) the replay script has its own local SSE hub and consumer; (4) H-22: `seq` is 64-bit, orchestrator and platform events use a reserved range from 2^40, infrastructure faults are shown as `instance.state_changed` with state `failed`. Decided during review, to confirm: a fresh connection receives only new events (the snapshot comes from the API); the reserved `seq` range stops at 2^53 - 1 so JSON and JavaScript read it exactly; while OI-15 is open the candidate does not receive their own milestones, captures or score live.

## Tests
All on the developer's Windows 11 PC, Node 24.11.0, pnpm 12.10.1, uv 0.12.23. Outputs in `docs/assets/p-03-domain-events/`.
- `pnpm run domain-events:check`: OK, 7 event types, 8 valid and 25 invalid examples, 18 fixture records; 14 replay checks pass.
- `node --test scripts/validate-domain-events.test.mjs scripts/replay-domain-events.test.mjs`: 29 pass (a broken copy of the contract for every rule: audiences, drift of every shared enum and pattern in IF-2 and IF-5, registry codes, secrets, byte order mark, examples and manifest, fixtures; a stalled hub, CRLF frames, reset, fresh connections).
- `node --test "scripts/*.test.mjs"`: 526 of 526 pass (includes stream L's check that CI and `ci:linux` agree). `node scripts/check-contract-rules.mjs`: 12 PASS, 0 FAIL, 4 NOT-APPLICABLE with IF-3 registered. `pnpm run errors:check` and `pnpm run contracts:check`: pass. `pnpm install --frozen-lockfile`, `uv lock --check`, `node scripts/verify-skills.mjs`: exit 0.
- NOT run: CI on a pull request; the full Python and end-to-end suites (no Python or Docker file changed); a real hub, relay or Valkey (they do not exist yet).
- Traceability row: PB-2 in `docs/traceability.md`.

## Evidence
`docs/assets/p-03-domain-events/`. Review log: Code Review section of the story plan; deferred items in `docs/bmad/initiative-platform/deferred-work.md`.

## Problems met and how they were fixed
- The registry gives all of `contracts/events/` to IF-4 and its validator scans it, so IF-3 could not live at the architecture's path; moved to its own folder and the architecture updated.
- Handoff rows H-01 to H-04 (P-02) had not been answered when P-02 was built, and several of my P-02 choices differ from stream L's defaults; recorded now as "answered, to confirm".
- The validator crashed on a missing audience row and on a wrong-shaped audience file (found by tests that break the contract on purpose); a hub boundary bug resynced a client that held the newest id before a reset.
- Independent code review (4 reviewers): 22 patches applied (impossible dates, the failed-instance rule in the schema, drift tests for every shared value, deeper fixture checks, hub and consumer fixes, flaky sleeps, README gaps), 4 deferred, 12 rejected (details in the plan).
- uv could not replace folders in the `.venv` under OneDrive; runs used a virtual environment outside OneDrive.

## Security notes (vulnerable parts only)
None; no vulnerable code. No flag, secret or personal data in any file; the schema forbids such members and the validator scans for flag-like values.

## Limitations and follow-ups
- Not pushed or merged. Tanmay should review the publisher side (`live:*` layout), the audience table and `stream.resync`; his IF-4 and IF-5 text does not yet carry the H-22 decision.
- Deferred (see `docs/bmad/initiative-platform/deferred-work.md`): the mapping from orchestrator faults to `INST-*` codes, a mode to point the replay at the real hub, audience resolution from an attempt (the relay), and trim size and connection caps (P-22 and spike S-2).
- Recruiter-side, company approval and admin event types come with their own stories as additive changes.
