---
title: 'Instance event schema (IF-4) and app-event names'
type: 'feature'
ticket: '3'
created: '2026-10-08'
status: 'built'
baseline_revision: '2a059929a24a91ce5c86fa9f8a93dcccd7ea8565'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
context:
  - '{project-root}/docs/architecture/07-repo-and-workstreams.md'
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/architecture/05-key-flows.md'
  - '{project-root}/docs/architecture/06-security.md'
  - '{project-root}/docs/design/challenge-specs.md'
  - '{project-root}/contracts/instance/instance-contract.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The sidecar, the shop, the mock services, the bot and the platform ingest all send or receive instance events, but three documents describe the event differently (field names, identity, source values, signing). Without one contract each side invents its own, and nothing yet lets Sahil or the lab harness check an event.

**Approach:** Write the instance event contract IF-4 in `contracts/events/`: one JSON Schema for the signed wire event with per-type data rules, a human catalogue of every app-event name, the signing and transport rules, and examples. Add a fake ingest that verifies, de-duplicates and validates events, plus a command and tests so "the events validate" is one command.

## Boundaries & Constraints

**Always:** Version the contract 0.x and add an entry to `contracts/CHANGELOG.md`. Event data holds ids, classes, counts and hashes only; flag-like values appear only as a SHA-256 digest; the instance never holds the signing key. The signed event identity is `(instance_id, seq)`. Every value the architecture does not fix is a proposal listed in an "Open points (to confirm)" table. Use obviously fake flags, keys and ids in examples. Node, Ajv and `node:crypto` only; no new dependency.

**Never:** The orchestrator API (L-04), the stub shop and harness (L-06), the CI contract job (L-07), the catalogue schema (T-02), the error registry (P-02: refer to `EVT-*` by name only), database migrations, sidecar or ingest production code, the contents of `docs/design/challenge-specs.md`.

**Decisions (Tanmay, 2026-10-08):** (1) an event is identified by `(instance_id, seq)` only; the catalogue's `event_id` is dropped. (2) `proxy.flag_seen` carries `kind` (real, decoy or foreign), the `challenge_key` when it is this instance's, and the SHA-256 of the candidate. (3) `source` is fine-grained: sidecar, shop, import, mock, bot, orchestrator, platform. Sahil's approval of the names is optional (D-37).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid event | Correctly signed, every example type | Fake ingest answers 202 and stores it | No error expected |
| Duplicate | Same `(instance_id, seq)` again | 200, not stored twice | No error expected |
| Bad signature | Wrong key or altered body | 401 with problem-details body, nothing stored | Security event noted |
| Wrong instance | `instance_id` differs from the signing key's instance | 401 | Nothing stored |
| Malformed | Not JSON, wrong field type, unknown `type`, extra field | 422 naming the JSON path | Nothing stored |
| Oversize | Body above the size cap | 413 | Nothing stored |
| Flag value in data | A real-looking flag string in `data` | Rejected by the schema (422) | Nothing stored |
| Bot events | `source` is `bot` | `session_kind` must be `bot`; such events never count for player milestones | 422 if not |

</frozen-after-approval>

## Code Map

- `contracts/events/` -- empty (`.gitkeep`); new files go here. `contracts/mocks/` -- empty; the fake ingest goes here.
- `docs/design/challenge-specs.md` section 10 (lines 677 to 714) -- the 29 event types with source, challenge and data fields: the source of names and data fields.
- `docs/architecture/07` section 3.2 item 6 and 3.6, `04` section 2.6 (events table) and section 11, `05` lines 160 to 185 (signing, ingest answers 401, 200, 202), `06` lines 26 and 54, ADR 0005 and 0009 -- transport, key and storage rules.
- `contracts/instance/instance-contract.md` section 6 (event emission) and open points 22 and 26 -- the shop-to-sidecar transport that this story completes.
- `scripts/validate-contracts.mjs`, `scripts/validate-contracts.test.mjs`, `contracts/instance/examples/` -- the validator, manifest and example style to follow; `package.json` scripts; `scripts/e2e/contracts.e2e.test.mjs` -- fresh-checkout test.
- Do not change `.github/workflows/ci.yml`, `docs/design/challenge-specs.md`, or the instance contract text except to point at IF-4 where it says "to be defined by IF-4".

## Tasks & Acceptance

**Execution:**
- [ ] `contracts/events/instance-events.schema.json` -- the wire event (fields in Design Notes) and one data rule per event type, JSON Schema 2020-12
- [ ] `contracts/events/app-events.md` -- the contract text (envelope, signing, transport, responses, size caps, batching, ordering) and the catalogue table of every type; open-points table
- [ ] `contracts/events/examples/` -- one valid example per event type, valid envelopes with signature headers, invalid examples with an expected path in a manifest
- [ ] `contracts/mocks/fake-ingest/` -- `ingest.mjs` (verify signature, size, schema, duplicate; answers 202, 200, 401, 413, 422) and `server.mjs` (`node contracts/mocks/fake-ingest/server.mjs --key <test key> --port <n>`), plus a signing helper used by tests and examples
- [ ] `scripts/validate-events.mjs`, `scripts/validate-events.test.mjs` -- schema, examples, catalogue table equals the schema's type list, fake-ingest behaviour for every matrix row; exit codes 0, 1, 2 like `validate-contracts`
- [ ] `package.json` -- `events:check`; `contracts:check` runs both checks
- [ ] `contracts/CHANGELOG.md`, `README.md`, dev-log, changelog, traceability row LB-4, evidence in `docs/assets/l-03-instance-events/`
- [ ] `scripts/e2e/` -- extend the fresh-checkout test so it also runs `pnpm run contracts:check` for both contracts

**Acceptance Criteria:**
- Given the repository, when `node scripts/validate-events.mjs` runs, then every example validates or fails at its manifest path, the catalogue table and the schema list the same types, and exit code is 0.
- Given the fake ingest and a test key, when each matrix row is replayed, then it answers exactly as the matrix says and stores nothing on a rejected event.
- Given an event type removed from the schema but still in the catalogue, when the command runs, then it exits non-zero.
- Given the contract files, when searched, then they hold no real flag, key or secret and no byte-order mark.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Pass 1 (thorough: blind-hunter BH, edge-case-hunter EH, verification-gap VG, intent-alignment IA; the first launch was cut off by a session limit and re-run). No bad_plan or intent_gap.

| Finding | Verdict | Route | Evidence / action |
|---|---|---|---|
| BH: flag evidence is rejected by the contract's own `VM{` rule | medium | patch | Real gap in the text: the sidecar must replace flag-like strings with a fixed marker before sending evidence. State it, add an example. |
| BH, EH: signature checked over decoded text, not raw bytes | medium | patch | Real: `raw.toString` before verify. Hash the raw buffer; test with non-UTF-8 bytes. |
| BH, EH: unknown instance returns before any HMAC, so timing differs from a wrong signature | low | patch | Compute a dummy HMAC, keep identical bodies. |
| BH, EH: duplicate `(instance_id, seq)` with a different body answered 200 and lost; memory unbounded | medium | patch | Keep a body digest; identical body 200, different body 409 `EVT-DUPLICATE-MISMATCH` (placeholder); document the new answer; cap stored size. |
| BH, EH: fake ingest server reads the whole body before 413; no error or abort handler | medium | patch | Stop at the cap, add handlers and a timeout, test with a large body. |
| BH, EH: `VM{` detection only literal | low | patch | Case-insensitive and `VM%7B` forms; state the limit. |
| BH, EH(claim): shop-to-sidecar posted body has no machine-checkable form; its refusals untested | medium | patch | Derive a posted-body schema from the wire schema, with examples and tests. |
| BH: 4 KiB shop cap and 8 KiB evidence body conflict for mock-sourced evidence | low | patch | Clarify per poster in the text. |
| BH: instance contract changed in substance but changelog says editorial | low | patch | Add an IF-6 entry in `contracts/CHANGELOG.md`. |
| BH, IA: significant decisions (signing scheme, identity, source, flag_seen) have no ADR; old documents not marked superseded | medium | patch | ADR 0017 and D-38 by the coordinator; supersession notes in architecture 04, 07 and README (not in `challenge-specs.md`, which the plan forbids touching). |
| BH: traceability lacks challenge numbers; tracker and tick | low | patch | Add C01 to C11; tracker and tick are done at close. |
| VG, EH: oversize evidence matrix row uses a double-encoded character, so it hits the wrong cap | medium | patch | Verified in the file (code points 195 and 169). Use the real character. |
| VG, EH: e2e test title overstates; tamper case depends on the word "browser"; spawned server not awaited | low | patch | Rename, mutate a parsed field, await exit. |
| EH: error path can echo a flag-like property name | low | patch | Redact in paths. |
| EH: valid leap-second timestamp reported as "in the future" | low | patch | Distinct message. |
| EH: server options accept a flag as a value; bad `--instance` unchecked | low | patch | Validate. |
| EH: validator crashes on a null envelope; header case mismatch `X-VM-Signature` | low | patch | Guard, case-insensitive header. |
| EH: `challenge_key` may differ between envelope and `flag_seen` data | low | patch | Semantic check in validator and fake ingest, with an invalid example. |
| EH: `session_kind` `internal` allowed for shop, sidecar, mock events | low | patch | `internal` only for import, orchestrator and platform. |
| EH: BOM and secret scan covers only `contracts/events` | low | patch | Also the mock and the two scripts. |
| BH: key rotation could drop events on 401 | false | rejected | The key is fixed per instance and `event_key_version` is stored on the instance row; no rotation inside an instance. |
| BH, EH: `import.meta.main` needs a recent Node | low | rejected | `.node-version` pins 24.21.0, CI uses it, and `doctor` checks the major. |
| BH: errors returned before authentication leak schema detail | low | defer | Open point 4 names the order; a uniform 401 is a later hardening for the real ingest. |
| BH: CI does not run `events:check` or the e2e tests | low | defer | The unit tests include the check; L-07 builds the CI contract job. |
| IA: tests lock in proposals; no real producer exercises the contract | info | defer | L-06 stub shop and Sahil's shop are the real producers. |

## Design Notes

Proposed wire event (all fields lowercase snake case): `schema_version` (const "0.1"), `instance_id` (`i-` plus 16 Base32), `seq` (integer at least 1, set by the sidecar), `type` (the catalogue name), `source` (sidecar, shop, import, mock, bot, orchestrator, platform), `session_kind` (player, bot, anon, internal), `user_id` (shop user id or null), `ts` (UTC, RFC 3339), optional `challenge_key` (`C01` to `C11`), `data` (object, additionalProperties false per type). Shop to sidecar: body without `instance_id`, `seq` and `source`, plus a `source` of shop, import, mock or bot given by the poster; POST only, `application/json`, to `VM_SIDECAR_EVENTS_URL` path `/v1/events` (a GET from an SSRF cannot post an event). Sidecar to ingest through the edge relay `POST /internal/v1/events`, one event per request, header `X-VM-Signature: v1=<hex>` = HMAC-SHA256 with the per-instance event key over `instance_id`, a newline, `seq`, a newline and the hex SHA-256 of the request body; the key derivation is ADR 0009. Ingest answers 202 new, 200 duplicate, 401 bad signature or wrong instance, 413 too large, 422 schema; error bodies use problem-details with `EVT-*` placeholder codes. Proposed caps: shop to sidecar 4 KiB; wire event 16 KiB; `evidence.capture` body 8 KiB; timestamp skew 10 minutes. `proxy.flag_seen` data: `kind` (real, decoy or foreign), optional `challenge_key`, `candidate_sha256`. `instance.flags_injected` and `infrastructure_fault` are listed with source orchestrator or platform and do not pass through the sidecar.

## Verification

**Commands:**
- `node scripts/validate-events.mjs` -- expected: exit 0, counts printed
- `pnpm run contracts:check` -- expected: exit 0, both checks pass
- `node --test "scripts/*.test.mjs"` -- expected: all pass
- `pnpm install --frozen-lockfile` and `pnpm audit` -- expected: exit 0, no known vulnerabilities

**Manual checks (if no CLI):**
- Sahil reads the catalogue table; under D-37 his approval is optional.
