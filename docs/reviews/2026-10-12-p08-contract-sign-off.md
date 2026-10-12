# Contract sign-off for contracts-v1.0.0: stream P (story P-08)

Date: 2026-10-12. Author: Akshay (stream P), prepared with Claude Code. Readers: Tanmay (L-09 tag, IF-2, IF-4, IF-5, IF-6), Sahil (IF-7).

Stream P signs as **provider** of IF-1, IF-3, IF-8 and DB (table owners), and as **consumer** of IF-2, IF-4, IF-5, IF-6 and IF-7. This page lists the versions stream P builds against (also in `contracts/COMPAT.md`), then every row of the "Done checklist before contracts-v1.0.0" in `docs/dev/HANDOFFS.md` that is addressed to Akshay, with its default, what the code already does, and the decision. Rows marked **DECISION** were decided by Akshay in the P-08 session; Akshay confirmed all the others as written on this page (2026-10-12).

## 1. Versions stream P targets

| Contract | Role of stream P | Version | Note |
|---|---|---|---|
| IF-1 Platform API | provider | 0.1.0 | sprint-2 slice, 25 operations (P-04) |
| IF-2 Lab API | consumer (dashboards) | 0.2.0 | bundled with IF-1; its error body is still IF-2's own (see F-2) |
| IF-3 Domain events | provider | 0.1.0 | P-03 |
| IF-4 Instance events | consumer (key service, ingest keys) | 0.2.0 | epoch on the wire, HKDF event keys (D-42) |
| IF-5 Orchestrator API | consumer (`InstanceHost` client, state reports) | 0.3.0 | the 38 open points of its table, see section 3 |
| IF-6 Instance contract | consumer (flag material, owner hash) | 0.2.0 | |
| IF-7 Challenge catalogue | consumer (catalogue route, sync job) | 0.1.0 | key form `c03` versus `C03`, mapped by the API |
| IF-8 Error codes and format | provider | 0.3.0 | 56 codes |
| DB Table owners | provider | 0.2.0 | 43 tables; stream L's rows to confirm by Tanmay |

## 2. Checklist rows addressed to Akshay

| Row | Default | Built so far | Decision |
|---|---|---|---|
| H-01 ORCH codes | 15 codes; the two fake-only codes out | P-02 registered the 15, plus ORCH-ROUTE-UNKNOWN, ORCH-INTERNAL (both are in IF-5 0.3.0 and the fake) and ORCH-UNAVAILABLE (the client's own) | Confirm as built |
| H-02 INST codes | six codes, exit codes 10 to 13 | registered as proposed, plus the five IF-2 instance codes | Confirm as built; "image missing" stays unregistered until a component raises it |
| H-03 EVT codes | four codes; EVT-STORE-FULL fake-only | the four plus EVT-STORE-FULL | Confirm as built |
| H-04 problem format | IF-8 carries `message` | IF-8 is RFC 9457 members plus `code`, `request_id`, `field`/`errors`, closed (Akshay, 2026-10-11) | Confirm; the alignment of IF-2, IF-4 and IF-5 is F-2 |
| H-07 events table | IF-4 0.1 columns, identity `(instance_id, seq)`; migration author undecided | `events` listed with owner `ingest` (L); not migrated yet | **DECISION F-1** (identity and author) |
| H-08 ingest signature | `X-VM-Signature` HMAC over instance, seq, body hash | key service derives the event key (P-05) | Confirm the form of IF-4 **0.2.0** (it adds the epoch to the signed lines, D-42), not the older text of the row |
| H-10 request keys | two keys, one per direction; distribution undecided | none | Confirm H-105: two random secrets with a key id, one per direction, as secret files under `/run/secrets` (architecture 06 s3), old and new accepted during a rotation |
| H-11 signing form | ADR 0024 HMAC v1 lines, 60 s, 5 min nonce | `HttpInstanceHost` (stream L) implements it, signing vector shared | Confirm ADR 0024 as written; the nonce store (H-58) is Tanmay's |
| H-12 call behaviour | IF-5 OP 1, 14, 24, 25 | fake and client follow them | Confirm IF-5 0.3.0 |
| H-13 create and reset bodies | IF-5 OP 8 to 11, 21, plus `owner_hash` (OP 32) | KeyPort derives flags, decoys, event key and owner hash (P-05) | Confirm |
| H-14 access rules | starts `closed`, epoch 0, grows only | | Confirm |
| H-15 list, host, health | OP 15, 16, 18 | | Confirm (P-28 reads `GET /v1/host`) |
| H-16 state report | 204, at-least-once, platform decides impossible transitions | not built (IF-5 platform side) | Confirm IF-5 0.3.0 (OP 17 and 34: `transition`, 204 new, 200 identical, 409 different); **DECISION F-3** for impossible transitions |
| H-17 internal endpoints | undecided | P-04 decision 5: they stay in IF-4 and IF-5, never in the browser bundle or the generated clients; the bundler refuses `/internal/` | Confirm P-04 decision 5; enums of IF-1 and IF-2 equal IF-5's |
| H-18 limits and retries | 20/s, burst 40, `Retry-After` exposed | client exposes `retry_after` | Confirm; the platform worker retries 429 after `Retry-After`, at most 3 times, and a network error with a new nonce and timestamp |
| H-83 IF-5 open points | all 38 stand | see section 3 | Confirm all, except OP 36 (F-2) |

## 3. IF-5 open points (H-83)

All 38 rows of the table "Open points (to confirm)" in `contracts/orchestrator/orchestrator-api.md` are confirmed as written, with these notes:

- OP 22 (retry limit) and OP 26 (reset capacity) stay open by design (OI-24, L-13).
- OP 27 (nonce memory per process): accepted for v1.0.0; a shared store is H-58 (Tanmay).
- OP 32 (owner hash): computed by `KeyPort.owner_hash` (P-05).
- OP 36 (open problem schema, `detail`, `https://vulnmart.invalid/problems/` type): differs from IF-8 (closed, `urn:vulnmart:error:` type, no `detail`): see F-2.

## 4. Decisions taken in the P-08 session (Akshay, 2026-10-12)

- **F-1 (H-07, events table).** Identity `(instance_id, epoch, seq)` (D-42, IF-4 0.2.0). Stream L owns the table, so Tanmay writes the `events` migration as the next revision of the one Alembic history; Akshay approves it. ADR 0023's note that Akshay widens the column is superseded.
- **F-2 (IF-8 alignment).** Stream P signs off on condition that IF-2, IF-4 and IF-5 move to the IF-8 error body before contracts-v1.0.0 is tagged (story 1.12, handoff H-114): after the tag the change would be breaking.
- **F-3 (H-16, impossible transitions).** A state report with an impossible transition is answered 204 (valid IF-5), stored as history, does not move the instance's state, and raises a log warning and an ops alert.
- Every other row of section 2 and every IF-5 open point except OP 36: confirmed as on this page.

## 5. What remains after this page

- Akshay approves the contracts pull request of L-09 on GitHub when Tanmay opens it (the human step of P-08).
- Tanmay and Sahil add their rows to `contracts/COMPAT.md` (L-09, T-03).
- The rows of the checklist addressed to Sahil and Tanmay are theirs.
