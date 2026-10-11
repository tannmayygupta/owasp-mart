---
title: 'Ports, in-memory fakes and table ownership (IF-9, IF-10)'
type: 'feature'
ticket: '5'
created: '2026-10-12'
status: 'built'
baseline_revision: '5d526b62be95cfd88b00726f6df505f7cb2cb948'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/docs/architecture/07-repo-and-workstreams.md'
  - '{project-root}/docs/architecture/04-data-and-state.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stream L builds scoring, ingest and the orchestrator worker against stream P's services (audit, outbox, keys, scope, settings, quotas), and P builds screens against L's attempts, reports and instances, but no port exists except `InstanceHost`, and no table has a recorded owner (PB-4; P-06, P-07, L-13, L-16 wait on it).

**Approach:** Write the six P ports as `typing.Protocol`s in `apps/api/src/vulnmart/ports/` with in-memory fakes, add fakes of the three L ports, and write `contracts/db/table-owners.yaml` from architecture 04, so tests run against the fakes and the table-owners check passes.

## Boundaries & Constraints

**Always:** Follow the style of `ports/instance_host.py`: `@runtime_checkable` Protocols with docstrings that name the errors, frozen slotted dataclasses for values, secrets `repr=False`, one exception class per IF-8 code. Fakes take an injectable clock, keep state in memory, raise the same typed errors as the real implementation will, and are thread-safe like `ReportIngest`. Fakes use only the standard library (no new runtime dependency). Audit follows architecture 04 section 4 (hash chain); org scope follows ADR 0014 (a scoped call without scope raises); key derivations follow H-105 and architecture 04 section 11, and the fake reproduces `contracts/events/examples/event-key-vector.json`. A contract test checks every fake against its Protocol. The table-owners file validates with `scripts/check_table_owners.py`.

**Decisions (developer, 2026-10-12):** (1) Create empty packages for all 13 modules of CODEOWNERS (P: kernel, accounts, orgs, assessments, privacy, admin, notifications, live; L: attempts, instances, scoring, ingest, flags), each with a one-line docstring, and list every table of architecture 04 with its owner; L's rows are marked "to confirm by Tanmay". (2) P writes provisional `AttemptPort`, `ReportPort` and `InstancePort` Protocols with in-memory fakes, marked "proposal, owner L confirms"; `InstancePort` sits above `InstanceHost` and does not redefine it. (3) The catalogue tables (`challenges`, `challenge_milestones`, `challenge_hints`, `challenge_writeups`) belong to `admin` (the sync job), to confirm with Sahil and Tanmay. (4) `KeyPort` includes the derivations: event key (HKDF, H-105 vector), flag HMAC (architecture 04 s11) and owner hash (H-20), with fake keys only. (5) Added at review, 2026-10-12: stream L's package-contents test (`test_contract.py::test_the_ports_package_holds_only_the_three_modules`) may have its two lists extended with the new files and folders, as its own comment asks; nothing else in that file changes.

**Never:** No change to `InstanceHost`, its fake or HTTP client, their tests, `support.py`, the harness fixtures, `scripts/check_table_owners.py`, `scripts/check-contract-rules.mjs` (stream L's). No database, SQLAlchemy model or migration (P-06). No real cryptography in a fake (no AES; the evidence fake keeps plaintext behind an opaque handle). No real key material in any file.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Audit chain | three appends | sequence 1..3, each `row_hash = SHA-256(prev || canonical JSON)`; `verify()` true | a changed record makes `verify()` false |
| Scope missing | scoped call with no organisation | refused | `ScopeMissing` |
| Event key | the vector's master, instance id, epoch | the vector's key | — |
| Shredded key | decrypt after `shred(attempt)` | refused | `KeyShredded` |
| Outbox | publish an IF-3 event | recorded in order with its audiences | an unknown event type is refused |
| Quota | user, org and global limits | the most specific limit wins | — |
| Lab fakes | cancel a finished attempt | refused | the IF-2 state error |
| Table owners | the YAML | PASS | duplicate or unknown owner: FAIL |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/ports/instance_host.py` -- pattern to copy (Protocol, dataclasses, `OrchestratorError` family with `code`/`http_status`, `ERRORS_BY_CODE`, `ReportIngest` with `threading.Lock`). Do not edit.
- `apps/api/src/vulnmart/ports/fake_instance_host.py` -- fake style: keyword-only constructor, injected `now`, public record lists, test hooks. Do not edit.
- `apps/api/tests/conftest.py`, `support.py`, `test_protocol.py` -- `isinstance(host, InstanceHost)` check and parametrised contract tests; reuse the idea in new test files, do not edit these.
- `docs/architecture/07-repo-and-workstreams.md` s3.5 -- port list: L provides `AttemptPort` (create from consent, state, cancel, withdraw, purge), `ReportPort` (score, per challenge, evidence read, integrity flags), `InstancePort` (request, open ticket, reset, stop, force-stop, capacity); P provides `AuditPort` (append), `OutboxPort` (publish domain event, enqueue email), `KeyPort` (create, wrap, unwrap, shred), `ScopePort`, `SettingsPort`, `QuotaPort`.
- `docs/architecture/04-data-and-state.md` s2.1-2.8 (tables per stream), s3 (scope), s4 (audit chain), s5.2-5.3 (DEK per attempt, shred), s11 (flag HMAC) -- source for the YAML and fake behaviour.
- `contracts/db/table-owners.schema.json` -- `version: 1`, `tables: [{table, owner, note?}]`; `scripts/check_table_owners.py` requires every owner to be a folder `apps/api/src/vulnmart/<owner>/` and a line in `.github/CODEOWNERS` (kernel, accounts, orgs, assessments, privacy, admin, notifications, live for P; attempts, instances, scoring, ingest, flags for L). Only `ports/` exists today.
- `contracts/domain-events/domain-events.schema.json`, `audiences.json` -- event types and audiences the outbox fake accepts.
- `contracts/events/examples/event-key-vector.json` -- HKDF test vector (H-105).
- `contracts/registry.json` entry `DB`, `contracts/CHANGELOG.md` section "Table owners (DB)" -- the YAML needs a changelog entry.
- `docs/dev/HANDOFFS.md` H-05 to H-15, H-18, H-20, H-21, H-79, H-83, H-90, H-95, H-104, H-105 -- rows to answer.

## Tasks & Acceptance

**Execution:**
- [x] `apps/api/src/vulnmart/ports/{audit,outbox,keys,scope,settings,quota}.py` -- Protocols, value types and errors for the six P ports -- the contract L codes against.
- [x] `apps/api/src/vulnmart/ports/fakes.py` (or one `fake_<port>.py` each) -- in-memory fakes of the six -- L's tests and P's own.
- [x] `apps/api/src/vulnmart/ports/{attempts,reports,instances}.py` and their fakes -- the three L ports, provisional (decision 2) -- P's screens code against them.
- [x] `apps/api/src/vulnmart/<module>/__init__.py` (13) and `contracts/db/table-owners.yaml` -- every table of architecture 04 with its owning module (decisions 1, 3).
- [x] `apps/api/tests/test_ports_*.py` -- Protocol conformance and the matrix rows.
- [x] `contracts/CHANGELOG.md`, `docs/dev/HANDOFFS.md`, `docs/architecture/07-repo-and-workstreams.md` (if a name changes) -- records.

**Acceptance Criteria:**
- Given each fake, when checked with `isinstance(fake, <Port>)`, then it satisfies its Protocol, and the tests of the matrix pass under `uv run --locked --package vulnmart-api pytest -q`.
- Given `contracts/db/table-owners.yaml`, when `python scripts/check_table_owners.py` and `node scripts/check-contract-rules.mjs` run, then the table-owners check is PASS (not NOT-APPLICABLE) and nothing else fails.

## Implementation Notes

- Built directly in the main session (developer's choice). Files: `ports/{errors,audit,outbox,keys,scope,settings,quota,attempts,reports,instances}.py`, `ports/fakes.py` (P), `ports/lab_fakes.py` (L), 13 module packages, `contracts/db/table-owners.yaml` (43 tables), tests `test_ports_platform.py`, `test_ports_lab.py`, `test_table_owners.py`.
- Port errors carry IF-8 codes and take their HTTP status from the generated registry: ScopeMissing, UnknownSetting and KeyIntegrity are REQ-INTERNAL (a bug when they happen), EventInvalid is EVT-SCHEMA, KeyShredded is AttemptGone (ATT-GONE).
- KeyPort names its evidence methods `encrypt` and `decrypt` instead of `wrap` and `unwrap`: wrapping the DEK with the KEK stays inside the key service. Architecture 07 s3.5 is updated.
- The outbox fake resolves audiences from a copy of `audiences.json` (a test keeps them equal), so the privacy wall is testable at the port; found by the matrix audit.
- Stream L's `test_contract.py::test_the_ports_package_holds_only_the_three_modules` pins the package contents and says a new module is added there on purpose: its two lists now include the new files and folders (nothing else changed). Tanmay is told in the handoffs.
- Flag input framing (4-byte big-endian length per part) is chosen here; architecture 04 s11.1 only says "length-prefixed".
- Review (quick lens): 12 findings fixed or resolved, 1 rejected; see the Review Triage Log. Verification after the patches: 869 pytest, 581 script tests, table-owners PASS, contract rules 0 FAIL.

## Plan Change Log

## Review Triage Log

### 2026-10-12, quick review (lens: quick), loop 0
Verdicts: 1 high, 6 medium, 4 low, 1 false; 1 resolved by the developer (boundary). All patches applied; nothing deferred.

| # | Finding | Verdict | Route | Evidence / action |
|---|---|---|---|---|
| 1 | Outbox: an attempt event without `data.mode` went to `user` and `org`; a flag member in `data` was accepted | high | patch | Confirmed with `examples/invalid/attempt-missing-mode.json` (privacy wall broken). `DATA_MEMBERS` per type (IF-3: all required, none extra), mode required for attempt types; `audiences_for` refuses to guess. Test with both invalid examples. |
| 2 | Audit: shallow copy of `details`, so a caller could change a stored record; mixed key types raised TypeError late | medium | patch | Deep copy through canonical JSON before storing; ValueError for mixed keys and NaN (`canonical_json` now refuses NaN). Tests. |
| 3 | `verify_chain` did not check the first sequence number and could not follow a checkpoint | medium | patch | `start_seq` and `prev_hash` parameters; first seq checked. Tests. |
| 4 | Key fake: shredding an id without a key blocked it for good | medium | patch | Only a real shred is remembered. Test. |
| 5 | Errors: several classes per code; `KeyShredded` an alias of `AttemptGone` | medium | patch | `PortMisuse` is the one REQ-INTERNAL class (ScopeMissing, UnknownSetting, KeyIntegrity subclass it); `KeyShredded` subclasses `AttemptGone`; `ERRORS_BY_CODE` maps one code to one class. Test. |
| 6 | Edit of stream L's `test_contract.py` against the frozen Never list | medium | resolved | Developer decided to keep the edit (decision 5 added to the frozen block): the package-contents test asks for new modules to be added. |
| 7 | Report, settings and quota fakes not thread-safe; `cancelled_by` written outside the lock | low | patch | Locks added; quota reads a snapshot. Thread test for the report fake. |
| 8 | Docstrings claimed every fake takes a clock | low | patch | Wording: every fake that records a time. |
| 9 | `evidence_body` answered "attempt not found" for an unknown evidence id; `InstancePort.request` did not list AttemptGone | low | patch | Kept the same 404 on purpose (missing and not yours are the same answer, IF-2) and documented it; docstring of `request` completed. Test. |
| 10 | Fake tickets expired at issue | low | patch | `expires_at` = issue + 60 s. Test. |
| 11 | H-20 said IF-5 has no owner-hash field (it has `owner_hash`); H-07 ticked although not settled; glued text | medium | patch | H-20 answer rewritten; H-07 back to open and unticked. |
| 12 | Rows H-08, H-10 to H-15, H-18, H-83, H-104 addressed to P-05 had no recorded answer | medium | patch | A note in each: not settled by P-05 (InstanceHost untouched), carried to P-17, P-06 or the IF-5 platform story; status stays open. |
| 13 | No dev-log, root changelog or traceability row yet | false | rejected | They are written at close-out, before the commit; the commit gate checks them. |

## Design Notes

Proposed methods (refined while writing, reviewed in the pull request): `AuditPort.append(actor, action, subject, details) -> AuditRecord`; `OutboxPort.publish(event, audiences)` and `enqueue_email(template, to_user_id, params)`; `KeyPort.create_attempt_key`, `encrypt`, `decrypt`, `shred`, `event_key(instance_id, epoch)`, `flag(instance_id, challenge_key, epoch)`, `owner_hash(user_id)`; `ScopePort.current() -> Scope` and `require_org()`; `SettingsPort.get(name)` over a closed list of names with defaults; `QuotaPort.max_instances(user_id, org_id)`.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest -q` -- expected: all pass
- `uv run --locked --package vulnmart-api python scripts/check_table_owners.py` -- expected: PASS
- `node scripts/check-contract-rules.mjs` -- expected: 0 FAIL, table-owners PASS
- `node --test "scripts/*.test.mjs"` -- expected: all pass
