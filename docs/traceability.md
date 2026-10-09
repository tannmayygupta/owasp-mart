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
| LB-1 | Repository skeleton, pinned tools, CI, CODEOWNERS, Compose, dev.mjs | Done (CI on a pull request not yet seen) | `scripts/dev.mjs`, `infra/compose/compose.yaml`, `.github/` | `scripts/dev.test.mjs`, `scripts/e2e/dev.e2e.test.mjs` | 19 unit and 10 end-to-end tests pass on real Docker; lockfile and compose checks pass | [2026-10-08-tannmayygupta-repository-skeleton](dev-log/2026-10-08-tannmayygupta-repository-skeleton.md) |
| LB-2 | Docker works on Tanmay's PC (WSL and data on D:, memory cap) | Done | `docs/assets/l-01-repository-skeleton/` | `node scripts/dev.mjs doctor` and `hello` | WSL repaired, doctor 6 of 6 PASS, hello exit 0, 8 GB cap set, Docker data moved to D: (junction) | [2026-10-08-tannmayygupta-repository-skeleton](dev-log/2026-10-08-tannmayygupta-repository-skeleton.md) |
| LB-3 | Instance contract v0 (IF-6): contract text, 3 JSON Schemas, examples, validator (touches F1, F3, FR-INS-02, FR-INS-05, FR-FLG-03, FR-SHP-15, NFR-ISO-03, D-02) | Done, awaiting Sahil's approval (consumer) | `contracts/instance/`, `contracts/CHANGELOG.md`, `scripts/validate-contracts.mjs` | `scripts/validate-contracts.test.mjs`, `node scripts/validate-contracts.mjs` | 40 of 40 script tests and 7 of 7 end-to-end tests pass (fresh-checkout run of the CI command included); validator PASS on 3 schemas, 5 valid and 129 invalid examples (see dev-log) | [2026-10-08-tannmayygupta-instance-contract-v0](dev-log/2026-10-08-tannmayygupta-instance-contract-v0.md) |

## Target baseline (T stream)

| ID | Requirement (short) | Status | Code | Tests | Result | Dev-log |
|---|---|---|---|---|---|---|
| TB-2 | Target stream reviewed IF-6 (instance contract) and IF-4 (instance events) as consumer and signed the versions | Done (signed v0.1.0; CR-1 open with Tanmay) | review of `contracts/instance/`, `contracts/events/` (on `shared-L-03`) | consumer review (manual) | all IF-6 open points owned by Sahil confirmed; IF-4 covers every shop event for C01–C11; IF-6 v0.1.0 and IF-4 v0.1.0 signed | [2026-10-09-sahillroy-t03-if6-if4-consumer-review](dev-log/2026-10-09-sahillroy-t03-if6-if4-consumer-review.md) |
| TB-4 | Exploit test runner runs a test against any instance URL (pass on vulnerable, fail on fixed) | Done (skeleton; 11 real exploits T-19..T-29, release gate T-31) | `challenges/tests/runner/run-exploit.mjs`, `challenges/tests/_example/` | `challenges/tests/_example/example.test.mjs` (CI `exploit runner` job) | 6 of 6 self-tests pass; CLI PASS/exit 0 on vulnerable stub, FAIL/exit 1 on fixed stub | [2026-10-09-sahillroy-t05-exploit-test-runner](dev-log/2026-10-09-sahillroy-t05-exploit-test-runner.md) |
| TB-3 | Shop skeleton answers the instance contract health surface (`/healthz`, `/readyz`, `/version`) in a hardened container | In progress (health surface done; harness conformance is T-04) | `apps/shop/src/app.mjs`, `apps/shop/src/server.mjs`, `apps/shop/Dockerfile` | `apps/shop/test/app.test.mjs`, `docker run` + `docker inspect` | 5 of 5 unit tests pass; container runs non-root (uid 65532), read-only rootfs, cap-drop ALL, 512 MB/256 pids; all three endpoints 200; Docker health `healthy` | [2026-10-09-sahillroy-t01-shop-skeleton](dev-log/2026-10-09-sahillroy-t01-shop-skeleton.md) |
| TB-5 | Developer environment verified on Sahil's PC (Docker, Node 24, uv, skills verifier) | Done | `docs/assets/t01-shop-skeleton/run-output.txt` | `node --version`, `uv --version`, `docker --version`, `node scripts/verify-skills.mjs` | Node 24.8.0, uv 0.12.24, Docker 28.5.1, verify-skills OK (217 files); uv updated and Python 3.14.8 installed to satisfy the repo pin | [2026-10-09-sahillroy-t01-shop-skeleton](dev-log/2026-10-09-sahillroy-t01-shop-skeleton.md) |
