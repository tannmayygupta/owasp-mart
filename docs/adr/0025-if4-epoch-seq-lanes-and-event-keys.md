# 0025. IF-4 event identity with epoch, seq lanes per source and per-epoch event keys

- **Status:** Accepted (D-42, on the developer's delegation 2026-10-11; revisable)
- **Date:** 2026-10-11
- **Deciders:** Tanmay (stream L), on delegation ("decided on delegation", decision D-42). Akshay (stream P, ingest and orchestrator caller) and Sahil (stream T, consumer) to confirm.
- **Requirements:** IF-4 (instance events), IF-5 (orchestrator API), IF-6 (instance contract, sidecar start input), D-42, D-37, ADR 0009 (event key master), ADR 0020 (sidecar start input), ADR 0023 (event identity, signing, source). Replaces the `first_seq` rule of IF-4 0.1.0 section 6 (open point 8) and fills open points 2 and 9 of IF-4 and open point 33 of IF-5.

## Context
A consumer review of the pull request showed that the sequence and epoch rules of IF-4 0.1.0 were broken:

- Identity was `(instance_id, seq)`, and a reset was kept apart from earlier epochs only by `first_seq`, a number the platform had to compute ("highest stored `seq` plus one") and send in every create and reset. If the platform's number was wrong, or an old sidecar's late events arrived after the reset, events of two epochs could collide or be credited to the wrong epoch.
- The sidecar's range and the range of events written by the orchestrator or the platform were only a proposal ("from 2^40 upward"), not in the schema, so nothing stopped an orchestrator event from taking a sidecar number.
- The event key was "derived from a master and the instance id", the same key after a reset unless a version was raised (IF-5 open point 33). So a reset did not change what could sign events, and the derivation was not written down, so the fake ingest could not test it.

## Options considered
1. **Keep `first_seq` and move the range.** The platform keeps giving the next number; the contract only moves or widens the reserved range. Pros: no wire change. Cons: the platform still has to be right about the highest stored `seq` across crashes and late events; the sidecar and the ingest still cannot tell the epoch of an event; a late event of the old epoch is indistinguishable from a new one; the key problem is untouched. **Rejected.**
2. **A uuid `event_id` or a producer id** (a random id per event or per sidecar start, as in other event systems). Pros: no counter to restore after a crash. Cons: brings back the second identifier that decision 1 of IF-4 dropped on purpose (architecture 04 section 2.6 relies on the unique `(instance_id, seq)` pair); loses the cheap ordering and gap detection that scoring uses; a random id does not tie an event to an epoch, so the late-event problem remains. **Rejected.**
3. **`epoch` on the event, a counter that restarts at 1 in every epoch, lanes per source in the schema, and an HKDF key per `(instance, epoch)`** (chosen).

## Decision
1. **A required wire field `epoch`** (integer, at least 1) on every instance event: the flag epoch that IF-5 already carries in create and reset. The sidecar gets it in its start input and stamps it on every event it signs. The shop's posted schema does not contain `epoch`; a poster that sends it gets 422.
2. **Identity is `(instance_id, epoch, seq)`.** Every epoch restarts the sidecar counter at 1. `first_seq` is removed from the IF-5 create and reset bodies, from the sidecar start input and from every example.
3. **Seq lanes per source, in the JSON schema** (if/then on `source`, all below 2^53): `sidecar`, `shop`, `import`, `mock`, `bot` use 1 to 2^40-1; `orchestrator` uses 2^40 to 2^41-1; `platform` uses 2^41 to 2^42-1.
4. **Signing string `v1`:** `instance_id`, newline, `epoch`, newline, `seq`, newline, hex SHA-256 of the body (the epoch is new). The label stays `v1` while the contracts are 0.x; the change is recorded as BREAKING.
5. **Ingest rules.** Dedup on `(instance_id, epoch, seq)`: same body 200, other body 409. After the signature check, an event whose epoch is above the instance's current epoch is 401; an event of an equal or lower epoch is accepted and stored under its own epoch (a late old-epoch event is history, never credited to the new epoch). Order by `(epoch, seq)`.
6. **Event key per `(instance, epoch)`:** HKDF-SHA256 (RFC 5869) from the platform master `K_evt` (32 random bytes), salt = UTF-8 `vm-evt-salt-v1`, info = `vm-event-key-v1` 0x00 `instance_id` 0x00 decimal `epoch`, L = 32, encoded base64url without padding (43 characters). The IF-5 create and reset bodies still carry `event_key`: the platform derives it per `(instance, epoch)` and passes it, so a reset always gets a new key because the epoch is in `info`. A test vector with a fake master is in `contracts/events/examples/event-key-vector.json`; the fake ingest derives keys with one shared function (`contracts/mocks/fake-ingest/event-key.mjs`, Node `hkdfSync`) and `scripts/e2e/events.e2e.test.mjs` recomputes them with a separate hand-written HKDF.
7. **Sidecar counter persistence.** The counter is write-ahead: the next value is saved to a small state file in the sidecar's own `/tmp` (`/tmp/vm-sidecar-seq.json`: instance id, epoch, next value; atomic rename) before the event is queued. A restart of the sidecar process inside one epoch continues from the saved value and never reuses a number (a crash can leave a gap, which IF-4 allows). A start document of a new epoch starts again at 1. No new volume, mount or path was added to the template.

## Consequences
- The platform no longer computes or stores a number for the sidecar; a wrong guess cannot cause a collision. A reset cannot repeat an event, and a late event of an old epoch is kept as history of that epoch.
- Orchestrator and platform events cannot take a sidecar number: the schema rejects it. Open for stream P: where those two producers keep their per-`(instance, epoch)` counters.
- A reset gets a new key, and the key of an old epoch cannot sign events of a new one. The ingest needs the current epoch of each instance (the platform has it) and the master `K_evt`.
- Breaking change to IF-4 (0.2.0), IF-5 (0.2.0) and IF-6 (0.2.0); every consumer of the event wire format, the signing string and the sidecar start document must update. The Python host, the fake orchestrator, the stub instance, the harness and the fake ingest were updated in story 1.15.
- **Watch (residual risk):** `/tmp` of the sidecar is memory-backed and private to its container, so the counter survives a restart of the sidecar process but not the loss of the container. A replaced sidecar container inside one epoch would restart at 1 and collide (409, event dropped with an alarm). Proposal: the orchestrator treats a replaced sidecar as an instance loss and resets; the alternative is a small kept-alive volume (a template schema change). Not decided (IF-4 open point 32).
- The derivation rule fixes `K_evt` as one 32-byte master per deployment; rotation (`K_evt[v]`, ADR 0009) is not covered and needs a version in the key rule when it is designed.

## Evidence
- RFC 5869, HMAC-based Extract-and-Expand Key Derivation Function (HKDF): https://www.rfc-editor.org/rfc/rfc5869 (extract with a salt, expand with `info`, output of at most 255 hash lengths; the vector in this repository is checked against two independent implementations: Node `hkdfSync` and a hand-written HMAC construction in the e2e test; one extra check with Python `hmac` was run by hand while building).
- RFC 9147, DTLS 1.3, section 4.2.1 (epoch and sequence number: a new epoch restarts the record sequence number, and the epoch is part of the record identity and of the keying): https://www.rfc-editor.org/rfc/rfc9147
- Apache Kafka KIP-98, Exactly Once Delivery and Transactional Messaging (producer id and epoch with a per-partition sequence number: a producer epoch fences old producers and sequence numbers restart with it; idempotent dedup on the producer id, epoch and sequence): https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging
- Real runs of the tests are in the dev-log entry of story 1.15 (not yet written by this task; the coordinator writes it).
- Unverified: the exact wording of the three sources above was not re-read in full while writing this record; the design follows what those documents are known for (the stated purpose of HKDF, DTLS epochs, Kafka producer epochs). Re-read the cited sections before the decision is confirmed.
