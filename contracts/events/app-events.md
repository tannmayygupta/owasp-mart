# Instance event contract v0 (IF-4)

- **Version:** 0.2.0 (draft, 0.x until the tag `contracts-v1.0.0` in story L-09; 0.2.0 is BREAKING: epoch, seq lanes, new signing string and event key derivation, decision D-42, proposal until confirmed). See [../CHANGELOG.md](../CHANGELOG.md).
- **Owner:** stream L (Tanmay). Stream T (Sahil) reviews the event names as consumer; under D-37 his approval is optional. Stream P (Akshay) is told of the `EVT-*` placeholder codes.
- **Source:** `docs/architecture/07-repo-and-workstreams.md` sections 3.1 (IF-4), 3.2 item 6 and 3.6; `04-data-and-state.md` sections 2.6 and 11; `05-key-flows.md` flows 4 and 5; `06-security.md` section 6; `docs/design/challenge-specs.md` section 10 (the event names and fields).
- **Check it:** `pnpm run events:check` (or `node scripts/validate-events.mjs`). `pnpm run contracts:check` runs this check and the instance contract check.

Plain terms: an **instance event** is a small signed message that says "something happened in this instance" (a request went through the sidecar, a refund was decided, a flag-shaped string was seen). The sidecar, the shop, the mock services, the bot, the orchestrator and the platform produce them; the platform **ingest** receives them and the scoring worker turns them into milestones. This document is the one place that says what an event looks like, how it is signed, how it travels and what the ingest answers, so each side can be built alone. **Fake ingest** means the stand-in receiver in `contracts/mocks/fake-ingest/` that answers as the real one must.

What this contract does not cover: the orchestrator API (IF-5, L-04), the stub shop and lab harness (L-06), the catalogue schema and milestone definitions (IF-7, T-02), the error registry (IF-8, P-02), the database tables, and the sidecar and ingest production code. Where an error code is needed this document uses `EVT-*` names as placeholders until the registry is merged. Which events count for which milestone is the catalogue's job (OI-17); the "Used by" column below only repeats the challenge specs.

Machine-checkable parts: [instance-events.schema.json](instance-events.schema.json) (JSON Schema 2020-12) with one valid example per event type and invalid examples in `examples/`, the derived posted-body schema [instance-events.posted.schema.json](instance-events.posted.schema.json), signed request examples in `examples/valid/envelopes/`, and the fake ingest. The catalogue table in section 7 and the schema's type list must name the same types and sources; the check fails otherwise.

## 1. Purpose and identity

Three earlier documents describe the event in different words (the instance contract, the architecture and the challenge specs). This contract replaces them. Decisions taken by Tanmay on 2026-10-08:

1. **Identity.** An event is identified by `(instance_id, epoch, seq)` only (D-42, 2026-10-11, replaces the pair `(instance_id, seq)` of 0.1.0; the developer decided it on delegation, to be confirmed). `epoch` is the flag epoch that IF-5 already carries in create and reset (at least 1); every epoch restarts the sidecar counter at 1. The challenge specs' `event_id` is dropped; there is no second identifier. Idempotent ingestion rests on the unique triple (architecture 04 section 2.6).
2. **Flag sightings.** `proxy.flag_seen` carries `kind` (`real`, `decoy` or `foreign`), the `challenge_key` when the string is this instance's, and the SHA-256 of the candidate string. The value itself never travels.
3. **Sources are fine-grained.** `source` is one of `sidecar`, `shop`, `import`, `mock`, `bot`, `orchestrator`, `platform`. (Architecture 04 groups the shop-side ones as `app`; the database column can map them.)

Rules that hold for every event:

- **Data holds ids, classes, counts and hashes only** (FR-DET-08). The one exception is `evidence.capture`, which carries the capturing request, at most 8 KiB, with secrets redacted before it is sent.
- **A flag-like value never appears.** A flag-shaped value is rejected anywhere in `data`, including the evidence body and headers: any string holding `VM{` in any letter case, `VM%7B` (percent-encoded brace) or `VM` followed by a full-width brace. This is a **best-effort check, not a guarantee**; the real flag format belongs to FR-FLG-02 and the pattern follows it. Candidate strings are sent only as `candidate_sha256`; the platform recomputes the HMAC, so no key or flag enters an instance for this (architecture 04 section 11.4).
- **Evidence that contains a flag.** A capture may legitimately contain a flag-shaped string. The component that builds the evidence (the sidecar, or the collector in mock-services) replaces every flag-like string in the `evidence.capture` body and header values with the fixed marker `[FLAG-REDACTED]` before sending, so the event passes the rule above. The marker is an ordinary string; the schema does not treat it specially.
- **The instance never holds the signing key of the platform.** The sidecar holds one per-instance key (standard input at start, architecture 06 section 3); the shop, the bot, the mock services and the import service never see it, so they cannot sign.
- **Nothing in an event is trusted as proof.** Events from the shop are claims; the platform corroborates them with sidecar-observed traffic (architecture 06 section 6).

## 2. The wire event

The body is one JSON object, UTF-8, with these fields (all names lowercase snake case, no extra fields). The schema is [instance-events.schema.json](instance-events.schema.json).

| Field | Type | Rule |
|---|---|---|
| `schema_version` | string | Constant `"0.1"` |
| `instance_id` | string | `i-` plus 16 Base32 characters (instance contract open point 1) |
| `epoch` | integer | At least 1; the flag epoch of IF-5 create and reset. The sidecar receives it in its start input and stamps it on every event; posters never send it |
| `seq` | integer | At least 1; set by the sidecar, strictly increasing within one `(instance_id, epoch)` and restarting at 1 in every epoch. Each source has its own lane (section 6): sidecar, shop, import, mock and bot 1 to 2^40-1, orchestrator 2^40 to 2^41-1, platform 2^41 to 2^42-1, all below 2^53; the schema enforces it |
| `type` | string | A name from the catalogue (section 7) |
| `source` | string | `sidecar`, `shop`, `import`, `mock`, `bot`, `orchestrator` or `platform`; each type allows only its own sources |
| `session_kind` | string | `player`, `bot`, `anon` or `internal`. Source `bot` requires `bot`; `internal` is only for the sources `import`, `orchestrator` and `platform`; the two orchestrator-side types require `internal` |
| `user_id` | string or null | The shop's user id (letters, digits, `_`, `.`, `-`, up to 64) or `null` |
| `ts` | string | UTC, RFC 3339 with `Z` (for example `2026-01-01T00:00:00Z`) |
| `challenge_key` | string, optional | `C01` to `C11`. Required for `evidence.capture` |
| `data` | object | The per-type fields of section 7; no extra fields |

The instance clock is not trusted for ordering: the platform records its own arrival time and orders by `(epoch, seq)`.

Bot events never count for player milestones (FR-DET-09): the scoring side ignores any event with `session_kind` `bot` for milestones. The schema makes that checkable by forcing `session_kind` `bot` on every event with source `bot`.

## 3. Shop to sidecar (app events)

The shop, the import service, the mock services and the bot controller do not sign. They post to the sidecar on the instance network:

- **Endpoint:** `POST` to the base URL in `VM_SIDECAR_EVENTS_URL` (instance contract section 2, port 9000) plus the path `/v1/events`.
- **Only POST, only `application/json`.** Any other method or content type is refused. A GET (for example from a server-side request forgery in the shop) cannot create an event.
- **Body:** the wire event of section 2 **without** `instance_id`, `epoch` and `seq`, and with `source` set by the poster to `shop`, `import`, `mock` or `bot` (the sidecar refuses `sidecar`, `orchestrator` and `platform` from this path, and refuses a `type` whose allowed sources do not include the posted `source`). The machine-checkable form is [instance-events.posted.schema.json](instance-events.posted.schema.json), **derived** from the wire schema by `node scripts/validate-events.mjs --write-posted`; the check fails when the file is stale. Examples are in `examples/valid/posted/` and `examples/invalid/posted/`.
- **The import service never posts.** It has no network (instance contract section 8) and so cannot reach the sidecar. The shop posts `import.job` (with `source` set to `import`) on the import service's behalf, after the shop has received the job result over the unix socket. The posted schema and the examples do not change; only the poster does. (Handoff H-50.)
- **Caps per poster:** every body posted by the shop, import service, mock services or bot is at most 4 KiB. So an `evidence.capture` posted by a collector in mock-services has a `data.body` of at most 2 KiB (the posted schema enforces 2048 characters). The sidecar's own `evidence.capture`, built inside the sidecar and not posted, may carry a body up to 8 KiB; the wire cap is 16 KiB.
- **What the sidecar does:** adds `instance_id`, the `epoch` of its start input and the next `seq`, validates against the schema, signs (section 4) and forwards (section 5). It buffers when the ingest is unreachable. The counter is **write-ahead**: the sidecar saves the next value to a small state file in its own `/tmp` before the event is queued, so a restart of the sidecar process inside one epoch continues from the saved value and never reuses a `seq` (a crash can leave a gap, which is allowed; the buffered events of a killed process are lost). The file belongs to one `(instance_id, epoch)`: a start document of a new epoch starts again at 1. `/tmp` is memory-backed and private to the container, so the counter does **not** survive the loss of the container: a replaced sidecar container has to be treated as an instance loss (reset, new epoch), see open point 32.

Sidecar answers on `/v1/events` (proposal, the sidecar is stream L's). The shop must not wait on or retry an answer in a way that blocks a player request.

| Answer | When |
|---|---|
| `202` | The event was queued |
| `400` | The body is not JSON |
| `405` | The method is not POST |
| `413` | The body is above 4 KiB |
| `415` | The content type is not `application/json` |
| `422` | The body does not match the posted schema (including a forbidden source, a type that cannot be posted, or `instance_id`, `epoch` or `seq` sent by the poster) |
| `503` | The sidecar cannot give the event a sequence number (its lane is full or its state file cannot be written); the shop does not retry in a way that blocks a player request |

`proxy.*` events and `evidence.capture` from the sidecar, and `collector.hit` from the collector, start inside L's or T's own components and take the same signing path.

## 4. Signing

Sidecar to ingest, one event per request. The signature is in a request header, not in the body, so the body is exactly the bytes that are signed.

```
X-VM-Signature: v1=<64 lowercase hex characters>
signature = HMAC-SHA256( event_key,  instance_id + "\n" + epoch + "\n" + seq + "\n" + hex(SHA-256(body)) )
```

The label stays `v1` while the contracts are `0.x`; the string changed in 0.2.0 (`epoch` added), which is a BREAKING change recorded in the changelog. `epoch` and `seq` are written in decimal without leading zeros.

- `event_key` is the event key of one `(instance_id, epoch)`, derived by the platform (ADR 0009 for the master, ADR 0025 for the rule) and the same rule is used by the ingest; see "Event key derivation" below. The fake ingest derives it from a fake master (`--master`) with the same function the mocks share (`contracts/mocks/fake-ingest/event-key.mjs`); `--key` gives it one fixed key for every epoch (harness only).
- `body` is the raw request body, byte for byte; the signature is checked over the received bytes, not over a decoded string. Invalid UTF-8 bytes decode to U+FFFD for parsing, so a correctly signed body with such a byte is accepted if the schema allows it and answered `422` otherwise; altering one such byte without re-signing is a `401`. `seq` is written in decimal without leading zeros.
- The signature covers `instance_id`, `epoch` and `seq`, so an event cannot be moved to another instance, another epoch or given another sequence number. The key itself is also per epoch, so the key of an old epoch cannot sign events of a new one.
- Comparison is constant time. A missing header, a header that does not match `v1=` plus 64 hex characters, an unknown instance and a wrong signature all answer the same `401` (the answer does not say which, so it is not an oracle for instance ids; the ingest records the reason as a security event).
- `examples/valid/envelopes/` holds three complete requests signed with the fake test key `FAKE-EVENT-KEY-NOT-REAL-0000000000000000` (epoch 1); `contracts/mocks/fake-ingest/sign.mjs` is the reference implementation.

### Event key derivation (D-42)

```
event_key = base64url( HKDF-SHA256( ikm = K_evt, salt = "vm-evt-salt-v1",
                                    info = "vm-event-key-v1" 0x00 instance_id 0x00 decimal(epoch), L = 32 ) )
```

- HKDF is RFC 5869 (extract then expand, SHA-256). `K_evt` is the platform's master: 32 random bytes, never in the repository, never in an instance. Salt and info are UTF-8; `0x00` is one zero byte; `decimal(epoch)` has no leading zeros. The output is 32 bytes, written as base64url without padding: 43 characters, which fits the shape IF-5 and the sidecar start document already allow (32 to 128 URL-safe characters).
- The epoch is in `info`, so **a reset always gets a new key** and a late event signed with the old key cannot pass as the new epoch. The platform derives the key once per create or reset, passes it as `event_key` in the IF-5 body, and the ingest derives the same key to verify. A master rotation (ADR 0009 `K_evt[v]`) is outside this rule: it changes `K_evt` and is a platform matter.
- Test vector: `examples/event-key-vector.json` (a **fake** master given as hex, instance ids, epochs and the expected keys). `scripts/validate-events.mjs` recomputes it with the shared function; `scripts/e2e/events.e2e.test.mjs` recomputes it with its own hand-written HKDF.

## 5. Sidecar to ingest and the answers

The sidecar posts `POST /internal/v1/events` to the edge relay (port 8081), which forwards over the private link to the ingest (architecture 05 flow 4, ADR 0005). One event per request; `Content-Type: application/json`.

The ingest checks in this order and stops at the first failure:

1. Size above the cap: `413`.
2. Content type, valid JSON, a JSON object, and a usable `instance_id`, `epoch` and `seq` (needed to check the signature): `422`.
3. Signature and instance (the key is the one of the claimed `(instance_id, epoch)`): `401`. Then, still `401`: an `epoch` **above** the current epoch of the instance (the platform has not started it, so the event cannot be real; a security event is raised). An `epoch` equal to or below the current one goes on.
4. `evidence.capture` body above 8 KiB (UTF-8 bytes): `413`.
5. Schema (including the per-type data rule, the allowed source, the bot and `internal` rules, and the check that `proxy.flag_seen` has the same `challenge_key` in the envelope and in `data` when both are present): `422` naming the JSON path of each problem. A property name that looks like a flag is shown as `<redacted>` in the path.
6. `ts` that cannot be read as a time (for example the leap second `23:59:60Z`): `422` at `/ts`, message "ts is not a usable time". `ts` more than 10 minutes in the future: `422` at `/ts`. Old timestamps are accepted, because a buffered event is sent late on purpose.
7. `(instance_id, epoch, seq)` already seen: the ingest keeps a SHA-256 of the body of each stored event. The same body answers `200` (not stored twice); a different body answers `409`, not stored.
8. The store is full (the fake ingest keeps at most 100000 events): `503`, code `EVT-STORE-FULL` (fake ingest only; the real ingest has a database).
9. Otherwise: `202`, stored.

For the signature check the ingest does the same HMAC work for an unknown instance as for a known one (with a fixed dummy key), so timing does not show which instance ids exist.

| Answer | Meaning | Body | Stored |
|---|---|---|---|
| `202` | New event accepted, stored under its own `epoch` | `{ "status": "accepted", "instance_id", "epoch", "seq" }` | yes |
| `200` | Duplicate `(instance_id, epoch, seq)` with an identical body, ignored (idempotent) | `{ "status": "duplicate", ... }` | no |
| `409` | Same `(instance_id, epoch, seq)` already accepted with a different body | problem details, code `EVT-DUPLICATE-MISMATCH` | no |
| `401` | Bad signature, unknown instance, `instance_id` that is not the signing key's instance, or an `epoch` above the instance's current epoch. A security event is raised | problem details, code `EVT-BAD-SIGNATURE` | no |
| `413` | Body above 16 KiB, or `evidence.capture` body above 8 KiB | problem details, code `EVT-TOO-LARGE` | no |
| `422` | Not JSON, wrong field type, unknown `type`, extra field, flag-like value, wrong source or session kind, `ts` unreadable or too far ahead | problem details, code `EVT-SCHEMA`, `errors` as a list of `{ "path", "message" }` | no |

Error bodies are problem details (RFC 9457 style, architecture 07 section 3.6): `type`, `title`, `status`, `code`, `message`, `request_id` and, for `422`, `errors`. The messages never repeat the value that was wrong, so a flag-like string is not echoed. No stack trace. The `EVT-*` names are placeholders until the registry (P-02) is merged.

The sidecar keeps an event until it gets `202` or `200`. On `401`, `409`, `413` and `422` it drops the event and raises a local alarm (retrying would not help). On no answer it retries later; its buffer is bounded and drops the oldest request summaries first, never a flag or state event (architecture 05 flow 4).

## 6. Size caps, batching, ordering

| Item | Cap (all proposals, see open points) |
|---|---|
| Body posted to the sidecar (shop, import, mock, bot) | 4 KiB |
| Wire event (sidecar to ingest body) | 16 KiB |
| `evidence.capture` `data.body`, built by the sidecar | 8 KiB (8192 bytes UTF-8; the schema also limits it to 8192 characters) |
| `evidence.capture` `data.body`, posted by a collector | 2 KiB (2048 characters, from the 4 KiB posting cap) |
| Events kept by the fake ingest | 100000 |
| Timestamp ahead of the ingest clock | 10 minutes |
| A text value in `data` | 200 characters for routes and paths, 512 for header values |

- **No batching on the wire.** One event per request. Volume is controlled at the source: the sidecar aggregates `proxy.request` (optional `count`) and the shop aggregates `auth.reset_confirm_batch` per 10 seconds, so brute force does not produce thousands of events.
- **Where the counter starts (D-42).** In every epoch the sidecar counter starts at 1: there is no `first_seq` any more (removed from IF-5 create and reset and from the sidecar start input). The sidecar gets the `epoch` in its start input (the `epoch` of the IF-5 create or reset body) and stamps it. A reset starts a new epoch, so the new sidecar counts from 1 again without any event of the old epoch being at risk of a clash: identity is `(instance_id, epoch, seq)`. Inside one epoch the counter is write-ahead and survives a restart of the sidecar process (section 3).
- **Lanes.** Every source counts in its own range of `seq`, enforced by the schema (all below 2^53): `sidecar`, `shop`, `import`, `mock`, `bot` use 1 to 2^40-1 (the shop, import service, mock services and bot post through the sidecar, which numbers them from its one counter); `orchestrator` uses 2^40 to 2^41-1; `platform` uses 2^41 to 2^42-1. The producers of the two upper lanes are not the sidecar: each keeps its own counter per `(instance_id, epoch)` starting at the bottom of its lane (how the platform stores it is stream P's decision). So an orchestrator event never takes a `seq` of the sidecar. The ingest orders by `(epoch, seq)`, which also puts the lanes apart.
- **Epochs at the ingest.** The platform knows the current epoch of each instance (it started it). After the signature check: an event with an `epoch` **above** the current one is `401` (the signature is valid, but the platform has not started that epoch); an event with an `epoch` equal to or below it is accepted and stored **under its own epoch**. A late event of an old epoch (buffered before a reset) is therefore history: it is never credited to the new epoch, and the scoring side reads each epoch separately. The old epoch's key is still derivable, so the late event verifies.
- **Ordering.** Within one `(instance_id, epoch)`, `seq` starts at 1 and rises by one per event the sidecar emits (a gap is possible after a crash, see section 3). Events may arrive late or out of order; the ingest does not require order, and the platform sorts by `(epoch, seq)`. A gap means an event was dropped or is still buffered; it is not an error.
- **Events that do not pass through the sidecar.** `instance.flags_injected` (orchestrator) and `infrastructure_fault` (orchestrator or platform) share the same schema and the same `(instance_id, epoch, seq)` identity, with `seq` in their own lanes (above).

## 7. Event catalogue

29 event types. Fields without "(optional)" are required. Field rules (types, ranges, allowed values) are in the schema; the table is the human summary. The challenge columns repeat `docs/design/challenge-specs.md` section 10; the milestone mapping is OI-17.

| Event type | Source | Session kind | Fields in `data` | Emitted when | Used by |
|---|---|---|---|---|---|
| `proxy.request` | sidecar | any | method, route_template, status, resp_len, client_class, count (optional) | Each proxied request (summary; the sidecar may aggregate, then `count` is set) | all (timing, activity); C09 M1 backup |
| `proxy.crs_match` | sidecar | any | rule_ids, tags, anomaly_score, route_template | A CRS rule matches (detect-only) | C03A M1; technique label |
| `proxy.flag_seen` | sidecar | any | kind, challenge_key (optional), candidate_sha256, route_template (optional), request_ref (optional) | A response holds a string matching the flag format. `kind` foreign means a flag-shaped string that is not this instance's; `challenge_key` is set for real and decoy only | M3 for C01 to C11 |
| `evidence.capture` | sidecar, mock | any | request_ref, body, headers_redacted | A capture is credited. The only event with a body (8 KiB cap, secrets redacted before sending). Envelope `challenge_key` is required | all M3 evidence |
| `shop.cross_store_order_read` | shop | any | order_id, caller_user_id, caller_store_id, order_store_id | Order detail returns an order of another store | C01 M1, M2 |
| `shop.giftcard_attempt` | shop | any | user_id, result, card_class | Each redeem call | C02 |
| `shop.catalog_query_error` | shop | any | route, error_class | Search query raised a SQL error | C03A M1 |
| `shop.ticket_markup_stored` | shop | any | ticket_id, message_id, user_id | A ticket message with an HTML tag is stored | C03B M1 |
| `bot.visit` | bot | bot | visit_id, ticket_id, phase, duration_ms (optional) | Each visit step | C03B (and exclusion of bot traffic) |
| `collector.hit` | mock | any | collector_id_ok, bot_tagged, candidate_sha256 (optional), size | A request reaches the collector (`candidate_sha256` only when the request carried a flag-shaped value) | C03B M2, M3 |
| `shop.refund_decision` | shop | any | order_id, refund_id, path, amount, decision, cumulative_after | A refund is decided (amounts in minor currency units) | C04 M1, M2 |
| `shop.refund_invariant_broken` | shop | any | order_id, paid, refunded_total | Reconcile finds refunds above amount paid | C04 M3 |
| `shop.verbose_error` | shop | any | route, handler | A verbose error is served | C05 M1 |
| `ops.page_served` | shop | any | path, client_class | An `/_ops/*` page is served | C05 M2, M3 |
| `import.job` | import | any | job_id, store_id, flagged_keys, polluted, audit_token_issued | Each preview job ends; posted by the shop on the import service's behalf (the import service has no network), `source` stays `import` | C06 |
| `auth.reset_requested` | shop | any | account_id, account_role, account_found | `/auth/forgot` called | C07 M1 |
| `auth.reset_confirm_batch` | shop | any | account_id, fail_count, ok_count, window_s | Every 10 s while confirms arrive (aggregated) | C07 backup |
| `auth.password_reset_completed` | shop | any | account_id, account_role | A reset ends with a new password | C07 M2 |
| `auth.attempt` | shop | any | route, account_id, result | Every login attempt on every route (platform telemetry, separate from the shop's security log) | C09 M1, M2 |
| `shop.security_event_written` | shop | any | account_id, kind | The shop's own security-event pipeline writes a row | C09 M2 (zero count), alerts |
| `webhook.received` | shop | any | order_id, source, verified, sandbox_header, accepted | Webhook called | C08 M1, M2 |
| `order.paid` | shop | any | order_id, verified, via | An order becomes paid | C08 M2 |
| `gateway.ledger_entry` | mock | any | order_id, amount | The mock gateway records a payment | C08 backup rule |
| `importer.fetch_attempt` | shop | any | job_id, url_class, blocked, status | Each image import (`status` 0 when blocked or no answer) | C10 M1 |
| `meta.request_served` | mock | any | path, ua_class | `vm-meta` serves a request | C10 M2, M3 |
| `kyc.result` | shop | any | store_id, outcome | KYC call finished | C11 M1 |
| `store.approved` | shop | any | store_id, approved_by | A store becomes approved | C11 M2 |
| `instance.flags_injected` | orchestrator | internal | challenge_ids | Injection done, before "ready" (FR-INS-11). Written by the orchestrator side, does not pass through the sidecar | all |
| `infrastructure_fault` | orchestrator, platform | internal | fault_class, detail_code (optional) | An instance is lost or re-created after a fault (architecture 05 flows 9 and 10). Written by the orchestrator or the platform, does not pass through the sidecar | recruiter fault notice; clock rules |

Notes.

- `proxy.flag_seen`: `challenge_key` is required for `real` and `decoy` and forbidden for `foreign` (a flag-shaped string that is not this instance's, for example a flag pasted into the shop from another instance). The platform decides credit; the event is evidence, not a score.
- `proxy.flag_seen`: when the envelope `challenge_key` and `data.challenge_key` are both present they must be equal (JSON Schema cannot compare two values, so `scripts/validate-events.mjs` and the fake ingest check it; the answer is `422` at `/challenge_key`).
- `session_kind` `internal` is only for the sources `import`, `orchestrator` and `platform`.
- `evidence.capture` is the only event whose data may hold a request body. Flag-like strings in it are replaced by `[FLAG-REDACTED]` (section 1). The sidecar redacts `Authorization`, cookies and password fields before sending; the platform encrypts it per attempt on arrival (architecture 04 section 5).
- `import.job`: `flagged_keys` is a list of class names, not flag values. `status` in `importer.fetch_attempt` is 0 when no HTTP status exists.
- Amounts (`amount`, `paid`, `refunded_total`, `cumulative_after`) are whole numbers in the smallest currency unit.
- `instance.flags_injected` and `infrastructure_fault` have no `shop` form; a shop that posts them is answered `422` at `/source`.

## 8. How this differs from the three earlier descriptions

| Item | Challenge specs section 10 | Architecture 07 section 3.2 item 6 | This contract |
|---|---|---|---|
| Name field | `type` | `name` | `type` |
| Identity | `event_id` | `instance_id` plus `seq` | `(instance_id, epoch, seq)` only (0.2.0) |
| Source values | sidecar, shop, import, mock, bot | `source: app` | seven fine-grained values |
| Actor | `session_kind`, `user_id` | `actor_role` | `session_kind`, `user_id` (no `actor_role`) |
| Signing | "signed with the per-instance key" | "the sidecar signs" | header `X-VM-Signature`, HMAC-SHA256 over id, epoch, seq and body digest |
| Flag sighting | `challenge_hint` | not stated | `kind` and `challenge_key` |
| Challenge on the event | `challenge_id` in some data | optional `challenge_key` | optional `challenge_key` in the envelope; `evidence.capture` requires it |

The instance contract (`contracts/instance/instance-contract.md`) section 6 now points here.

## Versioning

`0.x` until the tag `contracts-v1.0.0` (L-09). Adding an event type, an optional field or an allowed value is additive (minor bump); renaming or removing a type or field, or making an optional field required, is breaking and needs every consumer's approval. After v1.0.0: additive is minor, breaking is major. Every change adds an entry to [../CHANGELOG.md](../CHANGELOG.md). The check fails when the catalogue table and the schema list different types.

## Open points (to confirm)

Every value below was chosen by this draft because the architecture does not fix it. Tanmay (L), Sahil (T) and Akshay (P) please confirm, change or reject each one.

| # | Value | Proposal in v0 | To confirm by |
|---|---|---|---|
| 1 | Signature header and form | `X-VM-Signature: v1=<hex>`, HMAC-SHA256 over `instance_id`, newline, `epoch`, newline, `seq`, newline, hex SHA-256 of the body. The label stays `v1` while the contracts are 0.x; the epoch was added in 0.2.0 (BREAKING, D-42) | Tanmay, Akshay (ingest) |
| 2 | Per-instance key derivation | **Proposal D-42 (decided on delegation 2026-10-11, to be confirmed):** HKDF-SHA256 (RFC 5869) from the platform master `K_evt`, salt `vm-evt-salt-v1`, info `vm-event-key-v1` 0x00 `instance_id` 0x00 decimal `epoch`, 32 bytes, base64url (43 characters); one key per `(instance, epoch)`, so a reset gets a new key; vector in `examples/event-key-vector.json`; ADR 0025. Closes the "not defined" of 0.1.0; master rotation `K_evt[v]` stays with ADR 0009 | Akshay, Tanmay |
| 3 | Size caps | Posted body 4 KiB; wire event 16 KiB; `evidence.capture` body 8 KiB; timestamp 10 minutes ahead | confirmed on delegation (Tanmay, 2026-10-11) |
| 4 | Order of ingest checks and answers for malformed bodies | Size (413), then content type, JSON and a usable id, epoch and seq (422), then signature and an epoch above the instance's current one (both 401), then evidence size (413), schema (422), clock (422), duplicate (200 or 409), store full (503, fake only), else 202 (section 5) | confirmed on delegation (Tanmay, 2026-10-11) |
| 5 | `EVT-*` codes | `EVT-BAD-SIGNATURE`, `EVT-TOO-LARGE`, `EVT-SCHEMA`, `EVT-DUPLICATE-MISMATCH` (placeholders; one code for all 401 causes) | Akshay (registry P-02) |
| 6 | Sidecar answers to the shop | 202, 400, 405, 413, 415, 422, and 503 when the sidecar cannot give the event a sequence number (0.2.0) | Tanmay, Sahil |
| 7 | Shop to sidecar path and cap | `/v1/events`, POST only, `application/json`, 4 KiB | Tanmay, Sahil |
| 8 | Sequence numbers across a reset | **Resolved by D-42 (proposal until confirmed):** identity is `(instance_id, epoch, seq)` and every epoch restarts the sidecar counter at 1, so a reset cannot repeat an event. `first_seq` is removed from IF-5 and from the sidecar start input. A late event of an old epoch is stored under its own epoch (history); an epoch above the current one is `401` (section 6) | Tanmay, Akshay |
| 9 | `seq` for events written by the orchestrator or platform | **Resolved by D-42 (proposal until confirmed):** lanes in the schema: sidecar, shop, import, mock, bot 1 to 2^40-1; orchestrator 2^40 to 2^41-1; platform 2^41 to 2^42-1 (all below 2^53). Open for stream P: how the orchestrator and platform producers persist their per-`(instance, epoch)` counters | Tanmay, Akshay |
| 10 | Name `infrastructure_fault` | Listed as `infrastructure_fault` (no dot), source `orchestrator` or `platform`, data `fault_class` and optional `detail_code` | Tanmay, Akshay |
| 11 | Data field shapes the specs leave open | Ids are letters, digits, `_`, `.`, `-` (1 to 64); class names are `a-z0-9_` (1 to 32); `method` is a fixed list; CRS `rule_ids` are 3 to 9 digit strings | Sahil, Tanmay |
| 12 | Fields the specs name loosely | `import.job` `flagged_keys` is a list of class names; `refund_decision` `decision` and `amount` are a class name and a whole number of minor units; `status` is 0 to 599 | Sahil |
| 13 | `proxy.request` `count` | Optional count when the sidecar aggregates a window | confirmed on delegation (Tanmay, 2026-10-11) |
| 14 | `proxy.flag_seen` extra fields | Optional `route_template` and `request_ref` kept from the challenge specs | confirmed on delegation (Tanmay, 2026-10-11) |
| 15 | `challenge_key` on events | In the envelope (optional; required for `evidence.capture`); `proxy.flag_seen` also has it in `data` as decided; when both are present they must be equal | Tanmay, Sahil |
| 16 | No flag-like text anywhere | Any string containing `VM{` (any letter case), `VM%7B` or `VM` plus a full-width brace is rejected in `data`; the flag format is itself a placeholder (FR-FLG-02), so this pattern follows it | Tanmay, Sahil |
| 17 | `user_id` shape | Same id pattern as other ids, or `null` | Sahil |
| 18 | `session_kind` for mock and collector events | Examples use `anon`; any value except `internal`, and except a wrong one for source `bot`, is allowed | Sahil |
| 19 | Sidecar-side check of posted events | The sidecar refuses a source the type does not allow; the posted body has its own derived schema (row 25) | confirmed on delegation (Tanmay, 2026-10-11) |
| 20 | Fake ingest options | `--key` (one fixed key for every epoch, harness only) or `--master` (64 hex characters, a fake master: keys derived per epoch), `--instance` (its id, default `i-AAAAAAAAAAAAAAAA`), `--epoch` (current epoch, default 1), `--port` (default 8081); `GET /_fake/events` lists what was stored ordered by `(epoch, seq)`; `POST /_fake/epoch` sets the current epoch (not part of IF-4) | confirmed on delegation (Tanmay, 2026-10-11) |
| 21 | Duplicate with a different body | `409` with placeholder code `EVT-DUPLICATE-MISMATCH` for the same `(instance_id, epoch, seq)`; the ingest keeps a SHA-256 of each accepted body | Tanmay, Akshay (registry P-02) |
| 22 | Fake ingest store cap | At most 100000 events, then `503` `EVT-STORE-FULL` (fake only) | confirmed on delegation (Tanmay, 2026-10-11) |
| 23 | Evidence redaction marker | `[FLAG-REDACTED]` replaces every flag-like string in the evidence body and header values before sending | Tanmay, Sahil |
| 24 | Per-poster caps | Posted bodies 4 KiB, so a collector's evidence body is at most 2 KiB; the sidecar's own evidence body up to 8 KiB | Tanmay, Sahil |
| 25 | Posted-body schema | `instance-events.posted.schema.json`, derived from the wire schema by `--write-posted` (no `instance_id`, `epoch` or `seq`); sidecar answers 202, 400, 405, 413, 415, 422, 503 | Tanmay, Sahil |
| 26 | `session_kind` `internal` | Only for the sources `import`, `orchestrator` and `platform` | Tanmay, Sahil |
| 27 | Best-effort flag check | The pattern rejects `VM{` in any case, `VM%7B` and a full-width brace; it is not a guarantee (FR-FLG-02 owns the format) | confirmed on delegation (Tanmay, 2026-10-11) |
| 28 | Unreadable `ts` | A `ts` that parses to no time (leap second) answers `422` "ts is not a usable time" | confirmed on delegation (Tanmay, 2026-10-11) |
| 29 | Epoch on the event and the seq lanes | `epoch` (integer at least 1) is a required wire field stamped by the sidecar; lanes per source in the schema (open point 9) | Tanmay, Akshay |
| 30 | Epoch rules at the ingest | After the signature check, an epoch above the instance's current epoch is `401`; an epoch equal or below is accepted and stored under its own epoch, never credited to a later epoch (section 6). The platform supplies the current epoch; the fake sets it with `--epoch` or `POST /_fake/epoch` | Akshay, Tanmay |
| 31 | Sidecar counter persistence | Write-ahead (the next value is saved before the event is queued), in a state file in the sidecar's own `/tmp` (`/tmp/vm-sidecar-seq.json`, owner and instance and epoch inside); a restart of the sidecar process continues, a lost container does not (memory-backed `/tmp`). Reserve no new volume now; see open point 32 | Tanmay, Akshay |
| 32 | Lost sidecar container inside one epoch | If the sidecar container is replaced, the counter file is gone and the new sidecar would restart at 1 in the same epoch and collide (409, dropped). Proposal: the orchestrator treats a replaced sidecar as an instance loss and resets (new epoch). Alternative: a small memory-backed volume kept alive like the four of IF-6 open point 36 (template schema change). Not decided here | Tanmay, Akshay |
| 33 | `EVT-*` answer for an epoch above the current one | Same `401` and code `EVT-BAD-SIGNATURE` as other 401 causes, so the answer is no oracle for the platform's epoch | Akshay (registry P-02) |
