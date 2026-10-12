# Ports, in-memory fakes and table ownership (P-05, story 1.5)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | akshaay29 (Akshay) |
| Branch / commit | sprint-1-akshay-4 / local commit, not pushed |
| Status | Done; awaiting Tanmay's review (stream L's provisional ports, stream L's table rows, the edit of his package-contents test) and Sahil's (the catalogue rows) |
| Report tag | ports, fakes, table ownership, BMAD cycle |

## Requirements covered
PB-4 (ports between P and L as Python Protocols with in-memory fakes, and the table ownership file). Related: architecture 07 sections 3.5 and 7.7 row 7, architecture 04 sections 2 to 5 and 11, ADR 0009, ADR 0014, ADR 0025, D-35, handoffs H-05 to H-07, H-09, H-20, H-21, H-79, H-95, H-105.

## Summary (plain language, 3-5 lines)
Stream L and stream P can now write code against each other without waiting. The six services stream P provides (audit log, outbox, key service, scope, settings, quotas) and the three stream L provides (attempts, reports, instances, as P's proposal) are written as Python interfaces, each with an in-memory fake that behaves like the real thing. Every database table now has a recorded owning module, and stream L's ownership check passes.

## Why
Architecture 07 lists the ports and the table-owners file as the seventh sprint-zero deliverable: module work in both streams starts from them (P-06, P-07, L-13, L-16).

## What was built
- `apps/api/src/vulnmart/ports/`: `audit.py` (append-only, SHA-256 hash chain, `verify_chain` with checkpoints), `outbox.py` (IF-3 events with their data members, audiences resolved on the server, e-mail jobs by user id), `keys.py` (attempt keys, encrypt, decrypt, shred, the H-105 event key, flag and decoy HMACs, owner hash), `scope.py` (refuses a scoped call without scope), `settings.py` (a closed list), `quota.py` (user, then organisation, then global), `errors.py` (one class per IF-8 code); `attempts.py`, `reports.py`, `instances.py` (stream L's ports, provisional).
- `ports/fakes.py` and `ports/lab_fakes.py`: thread-safe in-memory fakes with test hooks.
- 13 module packages and `contracts/db/table-owners.yaml` (43 tables).
- 80 new tests; stream L's package-contents test extended (decision 5).

## How it works
Each port is a `typing.Protocol`, so a fake and the real implementation are interchangeable; tests check every fake with `isinstance` and against the rules in the docstrings. The key derivations are pure functions shared by fake and real service: the fake uses fake keys, and reproduces the shared HKDF vector of IF-4. The evidence fake does no encryption; it keeps the plaintext behind an opaque handle, so a test can still show that a shredded key makes evidence unreadable.

## Files changed
- `apps/api/src/vulnmart/ports/` (10 new modules, 2 fake modules), `apps/api/src/vulnmart/<module>/__init__.py` (13 new)
- `apps/api/tests/test_ports_platform.py`, `test_ports_lab.py`, `test_table_owners.py` (new); `test_contract.py` (two lists extended)
- `contracts/db/table-owners.yaml` (new), `contracts/CHANGELOG.md`, `CHANGELOG.md`
- `docs/architecture/07-repo-and-workstreams.md` (KeyPort row), `docs/dev/HANDOFFS.md`, `docs/traceability.md`, `docs/dev/dev2-akshay.md`
- `docs/bmad/initiative-platform/epic-platform-baseline/`: story plan with the review log

## Decisions made
No ADR. By the developer on 2026-10-12: (1) create all 13 module folders and list every table, stream L's rows to confirm by Tanmay; (2) stream P writes provisional `AttemptPort`, `ReportPort` and `InstancePort` for stream L to take over; (3) the catalogue tables belong to `admin` (the sync job), to confirm by Sahil and Tanmay; (4) `KeyPort` includes the derivations now; (5) at review: keep the extension of stream L's package-contents test. Chosen while building: `encrypt`/`decrypt` instead of `wrap`/`unwrap` (wrapping stays inside the key service), and a 4-byte big-endian length prefix for each part of the flag input.

## Tests
All on the developer's Windows 11 PC, Node 24.11.0, pnpm 12.10.1, uv 0.12.23. Outputs in `docs/assets/p-05-ports/`.
- `uv run --locked --package vulnmart-api pytest -q`: 869 passed (80 new).
- `python scripts/check_table_owners.py`: PASS, 43 tables. `node scripts/check-contract-rules.mjs`: 15 PASS, 0 FAIL (table-owners PASS).
- `node --test "scripts/*.test.mjs"`: 581 of 581. `pnpm run contracts:check`: pass.
- NOT run: CI on a pull request; `pnpm run ci:linux` in Docker.
- Traceability row: PB-4 in `docs/traceability.md`.

## Evidence
`docs/assets/p-05-ports/`. Review log: Review Triage Log of the story plan.

## Problems met and how they were fixed
- Stream L's ownership check needs an existing module folder for every owner, and only `ports/` existed: the 13 module packages were created (decision 1).
- Stream L's `test_contract.py` pins the files of `ports/` and `vulnmart/`; its comment asks for new modules to be added there, so its two lists were extended (decision 5).
- The independent review found a privacy-wall bug (an attempt event without a mode went to the company), a mutable audit record, a too-weak chain check, an over-eager shred, several classes per error code, thread-safety gaps, a wrong handoff answer (H-20) and handoff rows with no note: all fixed, with tests. The matrix audit found that the outbox did not record audiences.

## Security notes (vulnerable parts only)
None; no vulnerable code. No real key, flag or personal data: every key is a FAKE constant and every id is a placeholder.

## Limitations and follow-ups
- Not pushed or merged. Tanmay: take over the three provisional lab ports (H-06, H-79), confirm the stream L table rows (and `hint_unlocks`: attempts or scoring), and note the edit of `test_contract.py`. Sahil and Tanmay: the catalogue owner.
- The real implementations come later: audit and key service in P-17, outbox in P-09, scope and settings with the kernel in P-06.
- Open handoffs carried on: H-07 (events columns and migration), H-08, H-10 (P-17), H-104 (P-06), H-11 to H-15, H-18, H-83 (the platform side of IF-5).
