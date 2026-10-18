# Audit log and key service (P-17, story 4.2)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-3-akshay-1 / see the pull request |
| Status | Built and tested. Not built: the 12-month purge and the scheduled anchor job (P-24), the keystore snapshot after a shred and shipping the anchor file (operator steps, nothing run on a VM), audit entries of events that do not exist yet. Story 4.2 is `built`, awaiting the developer's confirmation |
| Report tag | audit log, hash chain, tamper evidence, pseudonymisation, key management, crypto-shredding, BMAD cycle |

## Requirements covered
FR-PRV-10 (the pseudonymised, hash-chained, append-only audit log, the anchor, the deletable identity mapping, no secrets), FR-PRV-12 (per-attempt keys, shredding, keystore kept apart from the data). OI-28 answered by the developer on 2026-10-18 (self-hosted on VM-P). Related: ADR 0047 (new), ADR 0008 and 0009, handoffs H-135 (answered for P-17), H-137 (new), spike S-10 (first half and the restore rule).

## Summary (plain language, 3-5 lines)
The platform now keeps a real activity log in which every entry is chained to the one before it by a hash, so a changed, removed or reordered entry is found, and the database refuses to let the application edit or delete it. People appear in it only under a random pseudonym, and deleting the mapping makes the old entries anonymous. Each attempt's evidence is locked with its own key, kept in a separate database; shredding the key makes the evidence unreadable even from a backup of the data.

## Why
The audit log and the key service were in-memory stand-ins (story P-05): nothing survived a restart, nothing was tamper-evident and nothing could be shredded. Consent (P-16), companies, invites and deletion all need them, and stream L's evidence code is waiting for a real `KeyPort`.

## What was built
- `kernel/audit.py`: `DbAuditPort` (the chain, an advisory lock, canonical JSON stored as text, refused secrets, `verify` from the latest checkpoint, `head`, `entries`), `AuditAnchors` (a signed line a day in `audit_anchor` and a sink outside the database, `check` of lines kept elsewhere), `FileAnchorSink`. Models `AuditLog`, `AuditCheckpoint`, `AuditAnchor`; migration 0007.
- `privacy/subjects.py`: `SubjectService` (pseudonyms, `forget`) and `PseudonymisingAudit` (replaces every user id in actor, subject and details); table `subject_map`.
- `kernel/keys.py`: `DbKeyPort` (a wrapped per-attempt key, AES-256-GCM sealing, shred, `rewrap` after a KEK rotation, the event, flag, decoy and owner derivations) and `KekRing`. `kernel/keystore.py`: the keystore tables and `ensure_keystore` (database `vm_keystore`, role `vulnmart_keys`). `kernel/migrate.py`: the migrate job runs Alembic and then the keystore setup.
- `kernel/settings.py`, `kernel/services.py` (`build_ports` builds the real audit port when a database is configured and the real key port when a keystore address is configured), `main.py` (`app.state.audit_anchors`), `accounts/sessions.py` (login, failed login and logout entries), `infra/compose/compose.yaml` (migrate command, keystore address, development keys).
- `docs/runbooks/keystore-and-audit-anchor.md`; ADR 0047 (Proposed); handoff H-137.

## How it works
`append` takes a lock on the chain in a transaction of its own, reads the head, writes entry n+1 with `SHA-256(previous hash || canonical JSON of the entry)` and commits; so entries are numbered 1, 2, 3 with no gap even with many writers. `verify` re-walks them. The adapter in front of the port swaps user ids for pseudonyms. A key service call reads the attempt's wrapped key from the keystore database, unwraps it with the KEK and seals or opens with AES-256-GCM; `shred` deletes the wrapped key and records only the attempt id, under a per-attempt lock so a racing create cannot bring the key back. Nothing is cached, so a shred is seen at once by every process.

## Files changed
- New: `kernel/{audit,keys,keystore,migrate}.py`, `privacy/subjects.py`, `migrations/versions/0007_audit_log_and_subject_map.py`, tests `test_audit_log.py`, `test_audit_postgres.py`, `test_keys.py`, `test_keys_postgres.py`, `test_session_audit.py`, `docs/adr/0047-*.md`, the plan of story 4.2, `docs/runbooks/keystore-and-audit-anchor.md`.
- Changed: `kernel/{models,settings,services}.py`, `privacy/models.py`, `main.py`, `accounts/sessions.py`, `migrations/env.py` (no change needed: the kernel models were already imported), `infra/compose/compose.yaml`, `test_kernel_settings.py` and `test_kernel_postgres.py` (head 0007, the new tables), `test_privacy_postgres.py` (head check), `test_data_minimum.py` (inventory rows), `scripts/e2e/platform-stack.e2e.test.mjs`, `docs/architecture/04-data-and-state.md` (audit and keystore tables as built), `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/adr/README.md`, `docs/bmad/initiative-platform/deferred-work.md`, `docs/progress/index.html`.

## Decisions made
By the developer: OI-28 (2026-10-18): self-hosted on VM-P; earlier "continue automatically", branch, pull request and merge per task. By the builder, in ADR 0047 (Proposed) for confirmation: the audit write in a transaction of its own (a rolled-back action leaves its entry), one adapter for pseudonyms, no foreign key on `subject_map`, details stored as canonical JSON text, the application role with SELECT and INSERT only instead of a separate `audit_writer` role, the anchor as a table row plus a signed line in a file (not the repository commit and email of ADR 0008), the keystore created by the migrate job, no caching of unwrapped keys.

## Tests
On the developer's Windows 11 PC, Python 3.14.8, Node 24.11.0, Docker 28.5.1, with throwaway Postgres 18.6 and Valkey 9.0.6 containers. Output in `docs/assets/p-17-audit-keys/`.
- New tests: `test_audit_log.py` 50, `test_audit_postgres.py` 21, `test_keys.py` 34, `test_keys_postgres.py` 25, `test_session_audit.py` 8. On Postgres: 8 threads write 200 entries with no gap and no fork and the chain verifies; the application role is refused UPDATE, DELETE and TRUNCATE on the audit tables; the keystore role can do nothing beyond its job and the application role cannot connect to the keystore; a create racing with a shred never brings a key back; a shred in one process is seen at once by another; a copy of the data taken before a shred leaves exactly the shredded attempt unreadable (spike S-10, restore rule); the migrate job runs both histories and the keystore twice.
- The real service and the in-memory fake give the same result or error for every call of one sequence (`test_the_real_service_and_the_fake_agree_on_every_error_and_result`).
- Full run of `pytest apps/api/tests` with the two containers: **2026 passed, 0 failed, 1 skipped** (512 s; the one skip is a Windows file-mode check in the lab tests) (`pytest-2026-10-18.txt`).
- Stack end to end on real Docker, `node --test scripts/e2e/platform-stack.e2e.test.mjs`: **22 of 22** (`platform-stack-e2e-2026-10-18.txt`), after `docker compose ... build api`. The new test: a failed and a good login through the proxy leave `auth.login_failed` and `auth.login` entries under a pseudonym, the user id and the address are in no audit row, the API database role is refused UPDATE, DELETE and TRUNCATE, and inside the API container the real ports create, use and shred a key in `vm_keystore`, verify the chain and anchor it. The dev volume already held 0006: the run applied 0007 and created the keystore database on it, which also shows the upgrade path.
- `node scripts/check-contract-rules.mjs`: 16 PASS, 0 FAIL, 1 NOT-APPLICABLE (`contract-rules-2026-10-18.txt`). The text-hygiene, progress-page, dev and demo script tests: 70 of 70.
- NOT run: anything on the VMs, object storage, a real scheduler, a restore from backup files; the whole `scripts/*.test.mjs` suite; CI on GitHub (see the pull request).

## Evidence
`docs/assets/p-17-audit-keys/`: the test outputs.

## Problems met and how they were fixed
- A non-text key in `details` was accepted because JSON turns it into text before my check; a failing test showed it, and the keys of the caller's own value are now checked.
- The inventory test of P-16 failed on the new `subject_map` table, as designed; the four new tables were added to it.
- A test of "the keystore role cannot read the data" queried a database that had no tables and failed for the wrong reason; it now makes a throwaway database with a table.
- A mistake of mine in one command: I mixed Python into a PowerShell script and nothing ran; and a duplicated block in `kernel/models.py` from a script that wrote twice, which I removed and checked.
- The first idea for `AuditAnchors.check` treated every missing entry as purged, which would hide a log cut short; a missing entry beyond the latest checkpoint is now reported.

## Security notes (vulnerable parts only)
None; no vulnerable code. Security-relevant: the audit log cannot be changed through the application (privilege, tested on real Postgres and the real stack) and a change is found by `verify`; a rewrite of the whole chain is found only against an anchor kept elsewhere, which is why the anchor exists and why the runbook says to ship the file off the machine; no secret-like key or token-like value is accepted; no user id or address reaches the table; a DEK exists only wrapped, the application role cannot reach the keystore, key values are not in repr, logs or messages (a shred log line does not name the attempt).

## Limitations and follow-ups
- Not every sensitive action writes an entry yet; each story writes the entries of its own events. The 12-month purge and the scheduled anchor are P-24; org-level audit views need a decision (H-137).
- The audit write is committed before the caller's transaction: a rolled-back action leaves its entry; an audit outage fails the action that needed the entry.
- The keystore snapshot after a shred and the anchor file's trip off VM-P are operator steps and were not run anywhere; the shredding test uses a copy of the data, not a restore from backup files.
- `KeyPort.flag` has no key version (H-137, for stream L); the masters have no rotation procedure; the development keys in Compose must never be reused.
- OI-28 and OI-37 are answered but not yet in `initial.md`. ADRs 0040 to 0047 are Proposed.
- Remind: Excel, P-17 Done = Yes; confirm story 4.2 so it can move to `done`.
