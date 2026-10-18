---
title: 'Audit log and key service'
type: 'feature'
ticket: '2'
created: '2026-10-18'
status: built
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
context:
  - '{project-root}/docs/architecture/04-data-and-state.md'
  - '{project-root}/docs/adr/0008-platform-data-backups-and-audit-anchor.md'
  - '{project-root}/docs/adr/0009-key-hierarchy-and-secrets.md'
  - '{project-root}/docs/prd/PRD.md'
---

<frozen-after-approval reason="human-owned intent: do not modify unless human renegotiates">

## Intent

**Problem:** The audit log and the key service exist only as in-memory fakes (story P-05): nothing is durable, nothing is tamper-evident, nothing can be shredded, and stream L's ingest, scoring and flag code runs against fake keys (FR-PRV-10, FR-PRV-12).

**Approach:** The real `AuditPort` on Postgres (hash chain, writers serialised by an advisory lock, append-only for the application role, verification, checkpoints, a daily anchor kept in the database and in a file outside it, pseudonymised subjects with a deletable mapping) and the real `KeyPort` (a per-attempt key wrapped by a versioned KEK in a separate `vm_keystore` database with its own role, AES-256-GCM sealing, shredding that records only the id, KEK rotation) with the event, flag and owner derivations over three master keys; wired into the API process and the compose stack; tested on real Postgres including a restore-after-shred test.

## Boundaries & Constraints

**Decisions (developer, 2026-10-18):** OI-28 answered: Postgres and Valkey run self-hosted on VM-P (not yet recorded in `initial.md`); "continue automatically", branch, pull request and merge per task. Claude's choices, in ADR 0047 (Proposed) for confirmation: the audit write in a transaction of its own, one adapter for pseudonyms, no foreign key on `subject_map`, details stored as canonical JSON text, the application role with SELECT and INSERT only instead of the architecture's separate `audit_writer` role, the anchor as a table row plus a signed line in a file (not the repository commit and email of ADR 0008), the keystore created by the migrate job, no caching of unwrapped keys.

**Always:** The chain is the same rule as the in-memory port, so both verify with one function; entries are numbered 1, 2, 3 with no gap; nothing secret is written (keys named like a secret and token-like values are refused); a user id never reaches the table (the adapter swaps it for a pseudonym); the application role can only read and insert audit rows; a DEK exists only wrapped; a shred deletes the wrapped key and records only the id; an unknown, shredded or foreign sealed value is told apart by the same errors as the fake; key values never appear in a log, a repr or a message.

**Never:** No purge of old audit rows (story P-24: it needs a privileged path that writes a checkpoint first); no scheduled anchor job (P-24); no keystore snapshot automation (the deployment tasks); no change to the shared `ports/` contracts of stream L; no new audit event of another story (each writes its own); no key rotation of the three masters.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Append | actor, action, subject, details | entry with the next number, chained to the head | ValueError for an empty actor, a bad action name, a secret-like key or value, a non-text key, details over 4 KiB |
| Eight writers at once | 8 threads x 25 entries | 200 entries numbered 1 to 200, no fork, chain verifies | n/a |
| Verify | a changed, removed or reordered entry | `ok` false with the first bad number and a reason | n/a |
| Verify after a purge | a checkpoint exists | verifies from the checkpoint | wrong checkpoint hash: found at the first remaining entry |
| Anchor | verified chain | one signed line a day in the table and the file; a second call the same day changes nothing | broken or empty chain: nothing anchored; sink failure: no row written |
| Check anchors | lines kept elsewhere | no problem for genuine lines | a forged line, a changed entry and a log cut short are named |
| Audit with a user id | actor, subject or details hold `u-...` | the table holds `s-...` | n/a |
| Delete a person | `forget(user_id)` | mapping gone, entries stay and identify nobody | n/a |
| Create a key | an attempt id | one wrapped key, idempotent, also under 8 simultaneous calls | after a shred: KeyShredded |
| Encrypt, decrypt | attempt id, plaintext, data | AES-256-GCM round trip | no key: AttemptNotFound; shredded: KeyShredded; another attempt's value or other data: KeyIntegrity |
| Shred | an attempt id | wrapped key deleted, id recorded; true once | none or already gone: false; a create racing with it never brings a key back |
| Restore of earlier data | ciphertext copied before the shred | shredded attempt unreadable, others readable | n/a |
| Rotate the KEK | a new highest version | new keys use it; `rewrap` moves the old ones; reading never stops | a retired version still in use: KekUnavailable |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/kernel/audit.py` (`DbAuditPort`, `AuditAnchors`, `FileAnchorSink`, `check_details`), `kernel/models.py` (`AuditLog`, `AuditCheckpoint`, `AuditAnchor`), `privacy/subjects.py` (`SubjectService`, `PseudonymisingAudit`), `privacy/models.py` (`SubjectMap`), `migrations/versions/0007_audit_log_and_subject_map.py` (single head 0007).
- `kernel/keys.py` (`DbKeyPort`, `KekRing`), `kernel/keystore.py` (`ensure_keystore`, the keystore tables), `kernel/migrate.py` (the migrate job), `kernel/settings.py` (keystore, KEK, masters, anchor file), `kernel/services.py` (`build_ports`, `key_port_from`), `main.py` (anchors on `app.state`), `accounts/sessions.py` (login, failed login and logout entries), `infra/compose/compose.yaml` (migrate command, keystore address and development keys).
- Tests: `test_audit_log.py`, `test_audit_postgres.py`, `test_keys.py`, `test_keys_postgres.py`, `test_session_audit.py`, `test_data_minimum.py` (inventory rows); stack test `scripts/e2e/platform-stack.e2e.test.mjs`; `docs/runbooks/keystore-and-audit-anchor.md`.

## Tasks & Acceptance

**Execution:**
- [x] Audit tables and migration 0007, `DbAuditPort`, verification, checkpoint support, anchors and the file sink.
- [x] Pseudonymous subjects and the adapter; login, failed login and logout entries.
- [x] The keystore database and role, `DbKeyPort`, `KekRing`, rotation, derivations, the migrate job, settings, wiring, compose.
- [x] Tests on SQLite and on real Postgres, including concurrency, privileges and the restore-after-shred test; the real-stack test; the runbook.

**Acceptance Criteria:**
- Given concurrent writers, then the chain has no gap and no fork and verifies; given any changed, removed or reordered entry, then verification names it.
- Given the application database role, then audit rows, checkpoints and anchors cannot be changed, deleted or truncated.
- Given a deleted subject mapping, then the entries stay and identify nobody.
- Given a shredded attempt, then nothing sealed with its key can be read, also from a restored copy of the data, and other attempts still read.

## Implementation Notes

- The audit entry is committed before the caller's transaction: a rolled-back action leaves an entry (safe direction); the port has no way to join the caller's transaction until a request-scoped session exists.
- The architecture's audit table has more columns (`actor_type`, `target_type`, `org_id`, `result`, `ip_trunc`, `meta`) than the IF-9 port carries (`actor`, `action`, `subject`, `details`). The port stands, so architecture 04 section 2.8 now describes the table as built; org-level views (recruiter sees own company's rows, candidate's view history) will need `org_id` in the details or a column, a decision for P-25 and P-27 (handoff H-137).
- The flag key has no version in `KeyPort.flag`, so instances created under an older key cannot be verified after a rotation; stream L's `flag_key_version` needs a port change (handoff H-137).
- OI-28 is answered but the placement of the object-storage backups (the 14-day dumps and the keystore snapshot) is an operator task, not code.

## Plan Change Log

## Review Triage Log

### 2026-10-18, self-review by the builder (lens: quick), loop 0
Same session as the builder, not an independent review. Things that actually went wrong while building (no defect of behaviour on Postgres was found by this pass): findings 1 to 3 were found by failing tests, finding 4 while writing the anchor check.

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | A non-text key in details (`{1: "x"}`) was accepted because JSON turns it into text before the check | low | patch | `_string_keys` checks the caller's own value; test added |
| 2 | The inventory test (story P-16) failed on the new `subject_map` table, as designed | low | patch (test) | the four new tables were added to the inventory on purpose |
| 3 | A test of "the keystore role cannot read the data" queried a database with no tables and failed for the wrong reason | low | patch (test) | the test makes a throwaway database with a table first |
| 4 | `AuditAnchors.check` first treated every missing entry as purged, which hides a log cut short | medium | patch | a missing entry beyond the latest checkpoint is "cut short"; test added |

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest apps/api/tests -q` with the Postgres and Valkey addresses set -- expected: pass
- `node --test scripts/e2e/platform-stack.e2e.test.mjs` (after `docker compose -f infra/compose/compose.yaml --profile platform --profile web build api`) -- expected: all pass
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL
