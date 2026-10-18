---
title: 'Real ingest verifier: signature, replay, epoch and limits, through the edge relay'
type: 'feature'
ticket: '4'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/contracts/events/app-events.md', '{project-root}/docs/dev/HANDOFFS.md']
---

<frozen-after-approval reason="human-owned intent, do not modify unless human renegotiates">

## Intent

**Problem:** Only a Node fake ingest exists (`contracts/mocks/fake-ingest/ingest.mjs`); `apps/api/src/vulnmart/kernel/entrypoints/ingest.py` serves health routes only. A forged or replayed event is not rejected by anything real (Done-when 3, H-75, H-08).

**Approach (D-64):** Port the fake's rules into Python in the stream-L folder `apps/api/src/vulnmart/ingest/` (its `__init__.py` says stream L fills it): `verify.py` (headers and signature: `X-VM-Signature: v1=<64 hex>`, HMAC-SHA256 over `instance_id \n epoch \n seq \n hex(SHA-256(raw body))` with the key from `KeyPort.event_key(instance_id, epoch)`, constant-time compare, an unknown instance costs the same HMAC work with a fixed dummy key), `schema.py` (JSON Schema `contracts/events/instance-events.posted.schema.json` plus the semantic rules the fake has in `semanticEvent`), `store.py` (an `EventStore` Protocol, an in-memory `MemoryEventStore` keyed `(instance_id, epoch, seq)`; the Postgres store belongs to the events table migration of P-06, H-07, and is not written here), `handler.py` (the check order of H-08: size 413, content type, JSON and usable ids and epoch and seq 422, signature 401, epoch above the current one 401, evidence body over 8 KiB 413, schema 422, `ts` 422 and at most 10 minutes ahead, duplicate identical 200 or other body 409, store full 503, else 202). The route `POST /internal/v1/events` is added to the ingest app (small edit of the K-06 entrypoint, flagged to Akshay, handoff row in story 5). A current-epoch source: a port `InstanceEpochs` (in-memory, set from the orchestrator state reports `POST /internal/v1/orch/state`, H-106, when that receiver exists; until then the test sets it). Raise a security event on every 401 (reason recorded, no key or signature in the log).

## Boundaries & Constraints

**Always:** Same answers and same order as the fake and IF-4 section 5; one event per request (an array or a batch is 422, IF-4 section 6); the raw bytes are what is signed and stored, never a re-serialisation. Never log event data, keys or signatures (type and seq only, like the fake). The conformance test feeds the same request vectors (`contracts/events/examples/`, the signing vector `event-key-vector.json`, plus the cases in `contracts/mocks/fake-ingest` tests) to the Python handler and to `createIngest` of the fake and requires identical status and error code per vector. End-to-end test: the stub sidecar (`contracts/mocks/stub-instance/sidecar.mjs`) posts to the real relay of story 2 which forwards to the Python ingest started with uvicorn on loopback; assert 202, the stored triple, then replay (200, one row), forge (401), tamper body (401), foreign epoch (401).

**Never:** Postgres, migrations, `contracts/db/**`; changing IF-4 or any contract; the platform's other endpoints or non-port code of Akshay beyond the one route registration; keys or master values in tests other than throwaway ones; commits and pushes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Good event | valid, signed, current epoch | 202, stored once | none |
| Identical repeat | same bytes | 200, still one row | none |
| Same triple, other body | replay with changes | 409 `EVT-DUPLICATE-MISMATCH` | problem body |
| Forged | wrong key, bad hex, missing header, unknown instance | 401 `EVT-BAD-SIGNATURE`, same body for all | security event |
| Epoch above current | signed with a future epoch | 401 | security event |
| Old epoch | below current | follows IF-4 s5 (stale rule as the fake) | as fake |
| Oversize, wrong type, two events | 17 KiB, text/plain, JSON array | 413, 415-or-422 as the fake, 422 | problem body |
| Bad ts | unreadable or 11 min ahead | 422 "ts is not a usable time" | problem body |
| Store full | cap reached (fake store only) | 503 | none |

</frozen-after-approval>

## Code Map

- `contracts/mocks/fake-ingest/ingest.mjs:16` (`LIMITS`), `:44` (`semanticEvent`), `:54` (`schemaErrors`), `:80` (`createIngest`), `:119-183` (`handle`: the order to port); `sign.mjs`, `event-key.mjs`, `server.mjs` (HTTP front, 10 s read timeout, drop connection past the cap).
- `apps/api/src/vulnmart/ports/keys.py:50` (`derive_event_key`), `:97-127` (`KeyPort.event_key`), `fakes.py:173` (`FakeKeyPort.event_key`) -- the key source, read only.
- `apps/api/src/vulnmart/kernel/entrypoints/ingest.py:1-4` -- register the route; `apps/api/src/vulnmart/kernel/service.py:102` (`create_service_app`) to see how routes and the size cap are added.
- `apps/api/src/vulnmart/ingest/__init__.py` -- new modules beside it; `contracts/db/table-owners.yaml:37-39` (`events`, owner `ingest`, migration in P-06) -- no change.
- `contracts/events/app-events.md` sections 4 to 6 (signing, answers, caps), `docs/dev/HANDOFFS.md` H-08, H-75, H-103 to H-105 (read; answer H-75 for the ingest part).
- Tests: `apps/api/tests/test_ingest_verify.py`, `test_ingest_conformance.py` (spawns `node` for the fake, skip with a message without node), `scripts/e2e/ingest-relay.e2e.test.mjs` (new; the real relay and uvicorn).
- Docs: dev-log, CHANGELOG, traceability FR-DET-04, FR-INS-10 (Done-when 3 part), evidence `docs/assets/story-5-4-ingest/`.

## Tasks & Acceptance

**Execution:**
- [ ] `ingest/verify.py`, `schema.py`, `store.py`, `handler.py` and the route -- as above
- [ ] unit tests per matrix row; the conformance test; the relay end-to-end test
- [ ] docs -- dev-log with real output, CHANGELOG, traceability, H-75 answer, story `built`

**Acceptance Criteria:**
- Given the vectors, when the Python handler and the Node fake run them, then status and code are equal for every vector.
- Given a sidecar event through the relay, then it is stored once; a replay stays one row; a forged, tampered or future-epoch event is 401 and not stored.
- Given a request over 16 KiB, then 413 is sent without reading the whole body.

## Design Notes

Proposed (decided on the developer's delegation): D-64 the relay is key-free and the real ingest is a Python port with an in-memory store behind a port, because the table migration is P-06's and Akshay's non-port code stays his (one route registration, handoff row). Risk for the 19th: until P-06's migration exists, events live in memory in the ingest process; the demo must say so. The story reuses the written vectors instead of new cryptography choices (H-105).

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_ingest_verify.py apps/api/tests/test_ingest_conformance.py` -- expected: pass
- `node --test scripts/e2e/ingest-relay.e2e.test.mjs` -- expected: pass (Docker not needed if the relay runs as a Node process; with the edge image when Docker is running)
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests` -- expected: pass (nothing else broke)
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass

## Implementation Notes

Built 2026-10-17 (python side only; the relay end-to-end test `scripts/e2e/ingest-relay.e2e.test.mjs` is NOT written in this build and stays open).

- New in `apps/api/src/vulnmart/ingest/`: `verify.py` (HMAC check, identity checks), `schema.py` (jsonschema over `contracts/events/instance-events.schema.json`, the fake's semantic rule, ECMAScript `$` rule for patterns), `store.py` (ports `EventStore`, `InstanceEpochs`, `EventSink`, `SecuritySink` and in-memory classes; the engine's `process` fits `EventSink`), `handler.py` (`IngestHandler`, order of the fake), `route.py` (`POST /internal/v1/events`, stops reading past 16 KiB).
- One edit in Akshay's `kernel/entrypoints/ingest.py`: import and `install_event_route(app)`. Without `app.state.ingest_handler` the route answers REQ-INTERNAL (500); nothing wires keys and stores yet.
- Schema used is the full wire schema `instance-events.schema.json` (as the fake does), not the `.posted.` one named in the plan text.
- Tests: `test_ingest_verify.py` 61 passed; `test_ingest_conformance.py` 3 passed (156 vectors, Node fake run as a process, status and code equal for every vector); both together 64 passed. Whole api suite: 1166 passed, 7 skipped (Postgres DSN not set). `check-text-files` and `scan-secrets` PASS. Raw output: `docs/assets/story-edge-4-ingest-verifier/test-output.txt`.
- Open: `jsonschema` is only a dev dependency of `apps/api/pyproject.toml`; the running ingest needs it as a runtime dependency (pyproject and lock change not made here). H-75 answer, docs and the relay end-to-end test remain.
