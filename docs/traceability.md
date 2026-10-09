# Traceability matrix

Requirement -> code -> test -> result. Updated with every task (rule in `CLAUDE.md`). IDs come from `initial.md`.
Status values: Not started / In progress / Done / Blocked. Fill "Result" only with real test outcomes.

## Functional requirements

| ID | Requirement (short) | Status | Code | Tests | Result | Dev-log |
|---|---|---|---|---|---|---|
| F1 | Provision isolated instance per user in bounded time | Not started | | | | |
| F2 | 11 challenges tagged OWASP 2025 + 2021, each exploitable end to end | Not started | | | | |
| F3 | Unique per-instance flags, automatic detection + paste-the-flag | Not started | | | | |
| F4 | Learner dashboard (hints, progress, flags, solution after solving) | Not started | | | | |
| F5 | Recruiter dashboard (score, time, technique, tags, evidence, hints used) | Not started | | | | |
| F6 | Tear down / reset after configurable inactivity | Not started | | | | |
| F7 | Log every attempt and capture; no cross-user visibility | Not started | | | | |
| F8 | Multiple concurrent isolated instances on one host | Not started | | | | |
| F9 | Recruiter signup, email verification, admin approval, candidate invites | Not started | | | | |
| F10 | Consent screen, retention + auto-delete, result export, audit log | Not started | | | | |
| F11 | Per-assessment hint settings, score never below zero | Not started | | | | |

## Challenges (D-06)

| ID | Theme | 2021 / 2025 tag | Status | Code | Tests (exploit verified) | Result | Dev-log |
|---|---|---|---|---|---|---|---|
| C01 | Broken Access Control | A01 / A01 | Not started | | | | |
| C02 | Cryptographic Failures | A02 / A04 | Not started | | | | |
| C03 | Injection | A03 / A05 | Not started | | | | |
| C04 | Insecure Design | A04 / A06 | Not started | | | | |
| C05 | Security Misconfiguration | A05 / A02 | Not started | | | | |
| C06 | Outdated Components / Supply Chain | A06 / A03 | Not started | | | | |
| C07 | Authentication Failures | A07 / A07 | Not started | | | | |
| C08 | Software or Data Integrity Failures | A08 / A08 | Not started | | | | |
| C09 | Logging (and Alerting) Failures | A09 / A09 | Not started | | | | |
| C10 | Server-Side Request Forgery | A10 / A01 | Not started | | | | |
| C11 | Mishandling of Exceptional Conditions | none / A10 | Not started | | | | |

## Build baseline (L-01)

| ID | Requirement (short) | Status | Code | Tests | Result | Dev-log |
|---|---|---|---|---|---|---|
| LB-1 | Repository skeleton, pinned tools, CI, CODEOWNERS, Compose, dev.mjs | Done | `scripts/dev.mjs`, `infra/compose/compose.yaml`, `.github/` | `scripts/dev.test.mjs`, `scripts/e2e/dev.e2e.test.mjs` | 19 unit and 10 end-to-end tests pass on real Docker; lockfile and compose checks pass; CI 4/4 jobs green on pull request #1 (merged) | [2026-10-08-tannmayygupta-repository-skeleton](dev-log/2026-10-08-tannmayygupta-repository-skeleton.md) |
| LB-2 | Docker works on Tanmay's PC (WSL and data on D:, memory cap) | Done | `docs/assets/l-01-repository-skeleton/` | `node scripts/dev.mjs doctor` and `hello` | WSL repaired, doctor 6 of 6 PASS, hello exit 0, 8 GB cap set, Docker data moved to D: (junction) | [2026-10-08-tannmayygupta-repository-skeleton](dev-log/2026-10-08-tannmayygupta-repository-skeleton.md) |
| LB-3 | Instance contract v0 (IF-6): contract text, 3 JSON Schemas, examples, validator (touches F1, F3, FR-INS-02, FR-INS-05, FR-FLG-03, FR-SHP-15, NFR-ISO-03, D-02) | Done (merged in PR #2, CI green; consumer rows still to be confirmed by Sahil) | `contracts/instance/`, `contracts/CHANGELOG.md`, `scripts/validate-contracts.mjs` | `scripts/validate-contracts.test.mjs`, `node scripts/validate-contracts.mjs` | 40 of 40 script tests and 7 of 7 end-to-end tests pass (fresh-checkout run of the CI command included); validator PASS on 3 schemas, 5 valid and 129 invalid examples (see dev-log) | [2026-10-08-tannmayygupta-instance-contract-v0](dev-log/2026-10-08-tannmayygupta-instance-contract-v0.md) |
| LB-4 | Instance event contract v0 (IF-4): contract text, schema with 29 event types, examples, fake ingest, validator (touches C01 to C11 (event names and milestone inputs), FR-DET-04, FR-DET-08, FR-DET-09, FR-FLG-03, FR-FLG-04, D-01, D-02, D-37) | Done, names and open points await review (Sahil optional under D-37, Akshay for EVT-* codes) | `contracts/events/`, `contracts/mocks/fake-ingest/`, `scripts/validate-events.mjs`, `contracts/CHANGELOG.md` | `scripts/validate-events.test.mjs`, `scripts/e2e/contracts.e2e.test.mjs`, `node scripts/validate-events.mjs` | 82 of 82 script tests and 9 of 9 contract end-to-end tests pass; validator PASS on 1 schema, 29 types, 29 valid, 3 signed, 6 valid posted and 61 invalid examples, 34 of 34 fake-ingest matrix checks; pnpm audit: no known vulnerabilities (see `docs/assets/l-03-instance-events/`) | [2026-10-08-tannmayygupta-instance-event-schema-if-4](dev-log/2026-10-08-tannmayygupta-instance-event-schema-if-4.md) |
| LB-5 | Orchestrator API v0 (IF-5): OpenAPI 3.1 contract, state machine, signing, errors, `InstanceHost` protocol, `FakeInstanceHost`, HTTP client, fake orchestrator service (touches FR-INS-07, NFR-SEC-04, NFR-ISO-03) | Built and tested, not closed: awaiting the developer's confirmation; Akshay's review of the 33 open points is optional (D-37); mTLS tested in L-04 limits (2026-10-09); CI run on GitHub still to be recorded | `contracts/orchestrator/`, `contracts/mocks/fake-orchestrator/server.mjs`, `apps/api/src/vulnmart/ports/`, `scripts/check_orchestrator_contract.py` | `apps/api/tests/` (`test_protocol.py`, `test_http_service.py`, `test_contract.py`, `test_mtls.py`), `scripts/e2e/contracts.e2e.test.mjs`, `scripts/e2e/orchestrator.e2e.test.mjs` | 255 of 255 Python tests pass, 11 of them the mTLS tests (protocol suite on the fake host and on the client plus fake service); `pnpm run contracts:check` PASS (8 operations, 15 valid and 44 invalid examples); 82 of 82 script tests and 13 of 13 orchestrator end-to-end tests pass (L-04 limits run, 2026-10-09); `uv lock --check`, `pnpm audit` and `uv audit` clean | [2026-10-09-tannmayygupta-orchestrator-api-v0](dev-log/2026-10-09-tannmayygupta-orchestrator-api-v0.md), [2026-10-09-tannmayygupta-l-04-limits](dev-log/2026-10-09-tannmayygupta-l-04-limits.md) |
