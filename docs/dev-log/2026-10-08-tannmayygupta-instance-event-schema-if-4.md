# Instance event schema (IF-4) and app-event names (story L-03)

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Developer | tannmayygupta |
| Branch / commit | shared-L-03 (base 2a05992; early pull request, not yet opened) |
| Status | Built, reviewed (thorough, one round with four reviewers) and tested; waiting for the pull request and CI. Event names and open points are to be confirmed by Sahil and Akshay in the team chat (D-37) |
| Report tag | contracts, IF-4, sprint zero |

## Requirements covered
IF-4 (architecture 07 section 3.1, sprint-zero row 4); touches C01 to C11 (event names and milestone inputs), FR-DET-04, FR-DET-08, FR-DET-09, FR-FLG-03, FR-FLG-04, D-01, D-02, D-37. Traceability row LB-4.

## Summary (plain language, 3-5 lines)
There is now one written, versioned description of an instance event: a Markdown contract with the catalogue of 29 event types, one JSON Schema with a data rule per type, signed examples, and a fake ingest that verifies, de-duplicates and validates events. One command (`pnpm run events:check`) checks all of it, and `pnpm run contracts:check` runs it together with the instance contract check. Every value the architecture does not fix is in a table of 28 open points to confirm.

## Why
The sidecar, shop, mock services, bot and ingest each send or receive events, and three documents described the event differently (field names, identity, source values, signing). Without one contract each side would invent its own (story L-03).

## What was built
- `contracts/events/app-events.md`: identity `(instance_id, seq)`, wire event, shop-to-sidecar and sidecar-to-ingest transport, signing, answers, size caps, batching and ordering, the 29-type catalogue, a comparison with the three earlier descriptions, versioning, 28 open points.
- `contracts/events/instance-events.schema.json`: JSON Schema 2020-12; the envelope, one data rule and allowed sources per type, the bot rule, the proxy.flag_seen kind rule, and a pattern that rejects any data string holding `VM{`.
- `contracts/events/examples/`: 29 valid events (one per type, named after it; the evidence one shows the `[FLAG-REDACTED]` marker), 3 signed requests, 6 valid and 10 invalid posted bodies, 51 invalid events, each invalid one with its expected error path in a manifest. `instance-events.posted.schema.json` is the shop-to-sidecar body schema, derived from the wire schema by `node scripts/validate-events.mjs --write-posted`; the check fails when it is stale.
- `contracts/mocks/fake-ingest/`: `ingest.mjs` (checks, answers 202, 200, 401, 413, 422), `server.mjs` (HTTP front, command line), `sign.mjs` (signing helper and fake test key).
- `scripts/validate-events.mjs` and tests; `package.json` scripts `events:check` and `contracts:check` (both checks); `scripts/validate-contracts.mjs` now exports `scanSecrets` so both checks use the same secret scan.
- `contracts/instance/instance-contract.md`: three pointer edits only (scope note, section 6, open point 22).

## How it works
The sidecar signs each event: `X-VM-Signature: v1=` plus the hex HMAC-SHA256 of `instance_id`, newline, `seq`, newline, the SHA-256 of the body. The ingest checks size, JSON, signature, schema, clock and duplicates, in that order, and stops at the first failure. Decisions of 2026-10-08 (Tanmay): identity is `(instance_id, seq)` only (the catalogue `event_id` is dropped); `proxy.flag_seen` carries `kind`, the `challenge_key` when it is this instance's, and the SHA-256 of the candidate; `source` has seven fine-grained values; Sahil's approval of the names is optional (D-37).

## Files changed
- `contracts/events/app-events.md`, `contracts/events/instance-events.schema.json`, `contracts/events/examples/**` (new; the `.gitkeep` of `contracts/events` removed)
- `contracts/mocks/fake-ingest/ingest.mjs`, `server.mjs`, `sign.mjs` (new; the `.gitkeep` of `contracts/mocks` removed)
- `scripts/validate-events.mjs`, `scripts/validate-events.test.mjs` (new)
- `scripts/validate-contracts.mjs` (one word: `scanSecrets` exported)
- `scripts/e2e/contracts.e2e.test.mjs` (fresh-checkout test also runs both checks; two new tests)
- `package.json` (`events:check`, `contracts:check`), `README.md`, `CHANGELOG.md`, `contracts/CHANGELOG.md`, `docs/traceability.md`
- `contracts/instance/instance-contract.md` (pointers to IF-4 only)
- `docs/assets/l-03-instance-events/` (command outputs)

## Decisions made
No ADR: the decisions above were recorded by the developer in the story and the contract; the architecture already fixes the transport and the key rules (ADR 0005 and 0009). Alternatives not taken: a second identifier (`event_id`); one `app` source value; putting the signature in the body (it would not cover exactly the bytes sent, so it is in a header). The signature form, the size caps and the 20 open points are proposals, not decisions.

## Tests
Real commands and results (outputs saved in `docs/assets/l-03-instance-events/`):
- `node scripts/validate-events.mjs`: exit 0; 1 schema, 29 event types, 29 valid events, 3 signed envelopes, 6 valid posted bodies, 61 invalid examples, 34 of 34 fake-ingest matrix checks; `events: PASS`.
- `pnpm run contracts:check`: exit 0; both checks print PASS.
- `node --test "scripts/*.test.mjs"`: 82 tests, 82 pass, 0 fail.
- `node --test "scripts/e2e/contracts.e2e.test.mjs"`: 9 tests, 9 pass (includes a fresh-checkout copy with `pnpm install --frozen-lockfile` and `pnpm run contracts:check`, the real fake-ingest server as a command, and a broken copy that exits 1).
- `node --test "scripts/e2e/events.e2e.test.mjs"` (written by the QA step; real fake-ingest server as a separate process, requests signed by an independent copy of the signing rule): 9 tests, 9 pass, stable over 5 runs; with a deliberately wrong signing key in a temporary copy 6 of 9 fail, so the tests do depend on the real rule.
- `pnpm install --frozen-lockfile`: lockfile up to date. `pnpm audit`: No known vulnerabilities found.
Traceability: LB-4.

## Evidence
`docs/assets/l-03-instance-events/` (`validate-events.txt`, `contracts-check.txt`, `unit-tests.txt`, `e2e-contracts.txt`, `e2e-events.txt`, `pnpm-install.txt`, `pnpm-audit.txt`); QA summary in `docs/bmad/initiative-lab/test-summary-l-03-instance-events/`.

## Review fixes (2026-10-09)
Signature now checked over the raw bytes (documented outcome for invalid UTF-8); same HMAC work for unknown instances; duplicate `(instance_id, seq)` with a different body answers 409 `EVT-DUPLICATE-MISMATCH` and the fake ingest keeps at most 100000 events (503); flag-like pattern ignores case and sees `VM%7B` (best effort); `session_kind` `internal` only for import, orchestrator and platform; `proxy.flag_seen` envelope and data `challenge_key` must agree; evidence redaction marker `[FLAG-REDACTED]`; derived posted-body schema with a stale check; per-poster caps (collector evidence at most 2 KiB); error paths redact flag-like property names; leap second gives "ts is not a usable time"; fake ingest server stops reading past the cap, has error handlers, a 10 second timeout and option checks; the validator scans the mock and its own scripts for secrets and a byte-order mark. IF-6 section 6 and open point 22 changed in substance (path `/v1/events`), recorded in `contracts/CHANGELOG.md` 0.1.1.

## Problems met and how they were fixed
- A first edit of `scripts/validate-events.mjs` through PowerShell turned the character e-acute into two characters, so the 8 KiB evidence test row used the wrong bytes; fixed to `'é'.repeat(4097)` and the row now exercises the cap.
- The fake ingest server first answered 422 instead of 413 for a very large body: it stopped collecting the body when a single chunk was bigger than the cap, so the ingest saw an empty body. It now keeps the first chunk past the cap. A unit test covers it.
- Signature before schema: a malformed body still has to be signed to get a 422, because the ingest only checks the schema after the signature. Only a body without a usable `instance_id` or `seq` is refused (422) before the signature, since the signature cannot be computed without them. This order is open point 4.
- PowerShell 5.1 wrote the saved command outputs as UTF-16; they were converted to UTF-8.

The first review launch was cut off by a session usage limit (no findings returned) and was re-run the next day; the implementation agent stalled once during the fixes and was resumed with a shorter, ordered brief; one of its replace commands garbled letters in two files, which it repaired (checked afterwards: tracked files show only the intended changes).

## Security notes (vulnerable parts only)
Not a vulnerable part. Security rules in the contract: the instance never holds the platform key, flag-like text is rejected in every data field and never echoed in an error, an event from the shop is a claim and not proof. The examples use the fake key and the fake flag `VM{` plus 24 times `A`; no real flag, key or secret is in any file.

## Limitations and follow-ups
- Not done on purpose (other stories): orchestrator API (L-04), stub shop and harness (L-06), CI contract job (L-07), catalogue schema (T-02), error registry (P-02). `.github/workflows/ci.yml` was not changed, so CI does not yet run `events:check`; the existing CI scripts job runs the unit tests, which include it.
- Open points to settle: `seq` after a reset and for events written by the orchestrator or platform (points 8 and 9), the key derivation (point 2), the `infrastructure_fault` name (point 10).
- No sidecar-side input schema for the shop's posted body is provided (point 19).
- The tracker state for story 3 (`docs/bmad/initiative-lab/`) was not changed by this work.
