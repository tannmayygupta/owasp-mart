# Changelog

All notable changes to VulnMart. Format follows [Keep a Changelog](https://keepachangelog.com/).
Categories: Added, Changed, Deprecated, Removed, Fixed.

## [Unreleased]

### Changed (PR 3 review remediation, story 1.15, 2026-10-11, Tanmay)
- Merged `origin/main` into the sprint 1 branch: 7 conflicts resolved as unions, IF-7 registered, this branch's ADRs 0017 and 0018 renumbered 0023 and 0024, the IF-4 consumer sign-off flagged stale.
- IF-4 0.2.0: `epoch` on every event, identity `(instance_id, epoch, seq)`, seq lanes per source, signed epoch, per-epoch HKDF event key with a test vector, `first_seq` removed from IF-5 and the sidecar start input, sidecar counter saved before each event (ADR 0025). Breaking inside 0.x.
- IF-6 0.2.0: template schema rejects 40 more invalid shapes (fixed network and image per role, limits, env patterns, injector rules, reason quality, dates, user).
- IF-5 0.3.0: required `transition` on StateReport, strict integers on the wire, RFC 9457 problem details with an open schema, `ssl_context` must verify (ADR 0028).
- IF-2 0.2.0: stable `(epoch, seq)` cursor, `has_more` and `limit`, RFC 9457 problems, flag answer only `correct` or `incorrect`, role table, 410 for withdrawn and cancelled reads.
- Contract rules engine: trusted base checker, whole-contract deletion is breaking, exact `BREAKING:` marker, `oneOf` branch removal and unlisted artefacts are compared, `.github/CODEOWNERS` for the checker paths (ADR 0026). The workflow has not run on GitHub yet.
- Fixed after the first paste into the AWS console: an IAM statement ID with an underscore is refused; the ID is renamed and a test checks all IDs.
- Infrastructure as code (nothing applied): two subnets, labs egress allowlist, network ACL, DOCKER-USER and metadata rules, compose lint, IAM policy without `ModifyInstanceAttribute` and with an instance-type deny, S3 backend example and bootstrap script, Terraform 1.11 minimum (ADR 0027).

### Added (progress page for the guide meeting, story 1.14, 2026-10-11, Tanmay)
- `scripts/progress-page.mjs` (with `scripts/progress-page.test.mjs`) builds one offline HTML page from the three task files (working tree or a git ref per stream) and can serve it on 127.0.0.1; snapshot in `docs/progress/index.html`, how-to in `docs/progress/README.md`, `pnpm run progress`. Traceability row LX-3 (partial).

### Fixed (sprint 1 audit remediation, story 1.13, 2026-10-11, Tanmay)
- False or stale statements corrected (traceability LB-5, LB-6, LB-7, LB-9, LE-1, LE-6, LE-8; dev-log headers with real commit hashes; ADR 0021 and 0022 status and sources; HANDOFFS H-101 and statuses; D-15, D-34, D-38; dated Closed-with notes under L-02, L-04 to L-08), damaged text repaired and a unit test (scripts/check-text-files.mjs) that fails on a control character, BOM or mojibake in a tracked text file; image files outside `docs/assets` and the console URL form refused by scan-secrets (`/image.png` ignored); CI first-run hardening (`scripts` timeout 20 minutes, cancel only pull request runs, dev.e2e in the `compose` job); IAM policy tag conditions on start, stop, terminate and modify; verify-hosts firewall check names say placeholder rule; runbook warnings. Audit record: `docs/bmad/initiative-lab/audit-2026-10-11-sprint-1.md`.

### Fixed (live verification of the AWS hosts, L-08 / story 2.6, 2026-10-11, Tanmay)
- The two AWS hosts are built and verified live (verify-hosts 94 checks and private-link-check 22 checks pass). Three defects found only on a real host are fixed with regression tests: the baseline sshd -t step creates /run/sshd first; the time-sync step restarts chrony when systemd-timesyncd does not exist; the private-link check keeps its certificates under /run (made and removed with sudo) because /dev/shm is wiped by systemd-logind between ssh sessions. verify-hosts also starts a short bare TCP listener on the web ports (AWS drops closed-port connections silently) and reports a repaired cloud-init error as a warning.
### Added (story 2.6, L-08 hosts on the AWS Free Plan in Sydney, offline phase, 2026-10-11, Tanmay)
- `infra/terraform/aws/` (provider `hashicorp/aws` `~> 6.68`, lock file for five platforms): VPC, one public subnet, security groups built from the shared rule file, two Free Plan eligible EC2 hosts (default platform t3.small and labs m7i-flex.large, x86, 30 GB encrypted gp3, IMDSv2 required with hop limit 1, no instance profile, Elastic IP each, no NAT gateway), zero-spend and monthly-use budgets by e-mail, `vm_i_running` to stop the labs host, web ports closed by default (`public_web_cidrs`), `iam-policy.json` for a limited Terraform IAM user, 30 native `terraform test` runs with a mocked provider.
- Runbook `docs/runbooks/aws-account-and-vms.md` (account, apply, verify, credits, stop and start, rebuild, acceptable-use note), decision D-41, ADR 0022, study note S-11 for AWS.
- `verify-hosts` checks that a container cannot read instance metadata (host control included); `scan-secrets` catches AWS access key ids, secret keys, account IDs and credential files; 3 new host-check tests, 11 new static policy tests and 3 new scan tests.
### Changed (story 2.6)
- Hosting moved from Oracle to AWS Sydney (D-41; ADR 0021 superseded in part); Oracle Terraform and runbook stay as an unused option. Rule file moved to `infra/network-rules.json`; `scripts/oracle-hosts.mjs` renamed `scripts/cloud-hosts.mjs`; host baseline keep-alive is now a flag (off by default) and the cloud-init template takes the time server and developer keys as variables; CI job `terraform` covers both folders; handoffs H-100, H-102 and H-103 reworded (images are amd64 by default).
- The live apply, live checks and credit record were done by the developer on 2026-10-11 (see the Fixed entry above). Still open for L-08: budget alert e-mail unconfirmed, one developer key installed, stop and start path and idle observation not rehearsed (docs/dev/sprint-1-pr-checklist.md).

### Added (story 2.1, L-08 Oracle account, two VMs, private link and firewall, 2026-10-10, Tanmay)
- `infra/terraform/oci/` (Terraform 1.16.5 image and provider `oracle/oci` 9.9.0 pinned, lock file): VCN, closed default security list, one network group per VM, two Always Free Arm VMs (Ubuntu 24.04, 1 OCPU, 6 GB), idle alarm with e-mail topic; firewall rules come from one data file, `network-rules.json` (public 22, 80, 443; private 9443 and 9444 are proposals). `infra/hosts/`: one cloud-init baseline (key-only SSH, no root, persisted iptables rules, Docker with a key fingerprint check, `/opt/vulnmart/secrets` 0700, bounded keep-alive service).
- `scripts/check-network-rules.mjs` (policy: an added public port fails), `scripts/scan-secrets.mjs` (OCID, key block, API fingerprint, local files, public addresses), `scripts/verify-hosts.mjs` and `scripts/private-link-check.mjs` (live checks with injected runners in tests, throwaway certificates, redacted evidence); 37 new tests. CI job `terraform` (fmt and validate, no credentials).
- Runbook `docs/runbooks/oracle-account-and-vms.md`, terms e-mail draft, study notes S-11 and S-17 (templates), ADR 0021, decision D-40 (Tanmay owns the account; Q-32 and OI-8 closed); handoff H-68 answered at host level, new rows H-100 to H-102. The live run and the tick of L-08 are pending.
- Review fixes of L-08: validated Terraform inputs (CIDR and key checks), `user_data` and key changes no longer replace a running VM, a missing-metric alarm, a lock file for five platforms, Terraform native tests of the network rules (mocked provider), a baseline script with a result marker, per-port firewall and file-hash drift checks in `verify-hosts`, safer clean-up and negative probes in `private-link-check`, address redaction with boundaries and IPv6, a bounded keep-alive that tolerates bad settings, wider secret-scan file names, CI job `terraform` hardened (runner user, read-only lock file, `terraform test`). Handoffs: H-100 now covers Akshay and Sahil (H-101 removed), H-103 added for the Docker-published-port gap.
### Added (story 1.6, L-07 contract checks live in CI, 2026-10-10, Tanmay)
- CI job `contract-rules` (pull requests, full history) runs `node scripts/check-contract-rules.mjs` (also `pnpm run contracts:rules`, and a step in `pnpm run ci:linux`): changelog entry and mock updated or waived, breaking-change check, unregistered contract folders, table owners, one Alembic head, COMPAT.md, bundle. Each check prints PASS, FAIL or NOT-APPLICABLE with the reason; inputs that do not exist yet (table-owners file, Alembic folder, COMPAT.md, bundle command) are NOT-APPLICABLE and counted.
- `contracts/registry.json` (one entry per contract), `scripts/schema-diff.mjs` (JSON Schema breaking diff), `tools/oasdiff.json` and `scripts/oasdiff.mjs` (oasdiff 1.33.0 pinned, sha256 verified, fetched into git-ignored `tools/.bin/`), `scripts/check_table_owners.py`, `scripts/check_alembic_head.py`, proposed `contracts/db/table-owners.schema.json`; 86 new and extended tests. ADR 0012 updated; handoffs H-73 answered, H-95 to H-99 added.
- Review fixes of L-07: the rule engine fails closed (no base guess, full history needed), compares the base registry too, reads changelog markers from the new entry only, and the oasdiff severity file raises removal checks to err; job `contract-rules` installs the pnpm packages.
- CI job `scripts` now sets up uv before the unit tests; `ci-linux.mjs` copies `.git` into the container and leaves out `tools/.bin`.
### Added (story 1.5, L-06 stub shop, fake ingest and lab harness, 2026-10-10, Tanmay)
- `contracts/mocks/stub-instance/`: one pinned Node stub image with the commands `shop`, `inject`, `sidecar`, `edge`, `gate` (and a harness-only `ingest` wrapper) and 32 unit tests. The stub meets IF-6 (health, ready only after marker and open database, version, injector exit codes 0, 10, 11, 12, 13) and IF-4 (posted schema, `seq` from `first_seq`, HMAC signing, retry and drop rules, bounded buffer).
- `infra/compose/harness.yaml` and `node scripts/dev.mjs harness [--keep]` / `harness down`: one full stub instance with the fake ingest, the IF-6 runtime profile, fresh fake flags, seed and key per run (standard input only), `scripts/check-instance-conformance.mjs` (17 static rules on the resolved config, live probes and `docker inspect` rules); CI job `compose` runs the harness and its end-to-end tests; the stub unit tests run in the job `scripts` and in `ci:linux`.
- IF-6 0.1.3 (additive): `sidecar-start.schema.json` (OI-35, H-59) with 2 valid and 24 invalid examples; new OP 36 (a tmpfs volume is lost when its last container stops; the harness uses a volume keeper). ADR 0020; handoffs H-92 to H-94 and answers to H-74, H-56, H-59, H-26 to H-28, H-60, H-62, H-75, H-76. Task L-06 is not ticked until the developer confirms.
### Added and Fixed (story 1.11, review gaps of L-04, L-05 and 1.10, 2026-10-09, Tanmay)
- CI job `e2e` runs the lab, orchestrator and events end-to-end files (the nested pytest is switched off there by `VULNMART_E2E_SKIP_NESTED_PYTEST`). `pnpm run ci:linux` (`scripts/ci-linux.mjs`) repeats the CI commands in a Linux container with Docker; all passed on Linux before the job was added.
- Fake lab: a repeated correct flag adds nothing; a challenge stays held until no held flag is open; hint levels unlock in order (409, `field` `/level`); strict cursor; unknown or repeated query parameters on every GET are 422 (declared on every GET in the OpenAPI file); listen errors and port range exit 2; an oversize body gets its 413 before the connection closes.
- Tests: certificate refusals (expired, not yet valid, wrong use, TLS 1.1), `CI` parsing (`true` or `1` only), missing-openssl branch, exact example counts, all declared headers, order independent lab end-to-end tests, narrowed retries, parsed leak test, negative test of the orchestrator checker. Handoff pointer P-04 lists H-84 to H-89.
- ADR 0019 cites the sources read (RFC 9457, OpenAPI 3.1.0, OWASP CSRF, Prism) and records the developer's decisions: RFC 9457 error body in a later story (1.12, not made), signed session-bound CSRF token (text updated, mock unchanged); handoffs H-90 and H-91. Review follow-ups: 413 closes the connection, strict `--port`, stronger missing-openssl and `ci:linux` tests.

### Added (L-05 lab fragment of the platform API, IF-2, 2026-10-09, Tanmay)
- `contracts/api/lab/`: `lab.openapi.yaml` (OpenAPI 3.1, 18 operations under `/api/v1/`), `lab-api.md` (scope, auth and cross-cutting rules, placeholder error codes, 30 open points) and 38 valid and 82 invalid examples. States, access and health are identical to IF-5.
- `contracts/mocks/fake-lab/server.mjs`: Node mock, no dependency, answers every operation with cookie, CSRF and Origin checks, ownership 404, flag results by input, a flag rate limit and instance state rules.
- `scripts/check_lab_contract.py` (added to `pnpm run contracts:check`), `apps/api/tests/test_lab_contract.py` (62 tests) and `scripts/e2e/lab.e2e.test.mjs` (12 tests). No new dependency.
- Decision D-39 and ADR 0019 (route prefix, Node mock instead of Prism, scope); handoffs H-84 to H-89 for Akshay, H-78 answered.

### Added (L-04 limits: mTLS test, Akshay handoff, 2026-10-09, Tanmay)
- Fake orchestrator: optional --tls-cert, --tls-key, --tls-ca (all three or none, else exit 2); with them it serves HTTPS and requires a client certificate. Plain HTTP stays the default. 11 new Python tests (apps/api/tests/test_mtls.py, certificates made at test time with openssl in a temporary folder) and one Node end-to-end test; no certificate or key is committed; no contract or client change.
- Handoff H-83 and a ready chat message for Akshay (docs/dev/messages/), note on H-68.

### Added (handoff register, 2026-10-09, Tanmay)
- `docs/dev/HANDOFFS.md`: 82 hand-offs (Akshay 23, Sahil 33, Tanmay 26) from the three contracts, linked from the task files, with a rule in `CLAUDE.md` and a step in `docs/dev/START-HERE.md` so each developer's Claude reads them when planning a task. LF line endings pinned for contracts, apps, JSON, YAML, TOML, Python and lockfiles.

### Added (orchestrator API v0, L-04, 2026-10-09, Tanmay)
- Orchestrator API contract v0 (IF-5) in `contracts/orchestrator/`: OpenAPI 3.1 file for the seven calls and the signed state report, contract text with state machine, signing, idempotence, errors and 30 open points (proposals for Akshay), 15 valid and 33 invalid examples, a signing vector. Checked by `scripts/check_orchestrator_contract.py`, now the second half of `pnpm run contracts:check`.
- Python package `vulnmart-api` (`apps/api`, only the ports): `InstanceHost` protocol, `FakeInstanceHost`, `HttpInstanceHost` (standard library only). Fake orchestrator service in `contracts/mocks/fake-orchestrator/server.mjs` (Node, no dependencies). 204 Python tests; the protocol suite runs against the fake host and against the client plus the fake service. After review: the fake host mirrors the service validation, the client refuses unsafe setups and treats any odd answer as `OrchestratorUnavailable`, the fake service hardens body, query and method handling (405), the contract check no longer fails with a traceback.
- Pinned Python dev dependencies (pytest 9.1.1, openapi-spec-validator 0.9.0, jsonschema 4.26.0, pyyaml 6.0.3, uv_build 0.12.23); `apps/api` added to the uv workspace; CI `scripts` job now also runs the Python tests and `contracts:check`.
### Changed (orchestrator API follow-up, L-04, 2026-10-09, Tanmay)
- IF-5 create body now requires `owner_hash` (the `vm.owner` label) and `first_seq`; reset requires `first_seq` (handoffs H-20, H-59); IF-4 text says the shop posts import events (H-50). Fake host and fake service validate both fields; 244 Python tests. Fix from review: the Python patterns end with `\Z`, so a trailing newline is no longer accepted. Remaining review points are in `docs/bmad/initiative-lab/deferred-work.md`.

### Added (instance event contract IF-4, L-03, 2026-10-08, Tanmay)
- Instance event contract v0 (IF-4) in `contracts/events/`: contract text with the 29-type event catalogue, JSON Schema, a derived posted-body schema, 29 valid events, 3 signed requests, 6 valid posted bodies and 61 invalid examples. Fake ingest in `contracts/mocks/fake-ingest/` (answers 202, 200, 401, 413, 422). Checked by `scripts/validate-events.mjs` (`pnpm run events:check`; `pnpm run contracts:check` now runs both checks) with unit and end-to-end tests. No new dependency.
### Added (T-08 snapshot seeding mechanism, 2026-10-09, Sahil)
- `apps/shop/seed/`: a per-epic seed registry that discovers `contributions/NNN-*.mjs` in numeric order and runs them in one transaction, a deterministic baseline world (users, stores, categories, products with fixed timestamps), and a `build-snapshot` CLI (`pnpm run snapshot`) that migrates a fresh SQLite db, seeds it, and reports dynamic row counts and build time (~320 ms). Later epics add seed data by dropping a file, no shared-file edits. Snapshot is a gitignored CI artifact. 7 tests. Covers FR-SHP-12.

### Added (T-07 shop identity, roles, permissions and hashing, 2026-10-09, Sahil)
- `apps/shop/` identity and authorization: scrypt password hashing (`src/identity/password.mjs`, salted, timing-safe, param floor, PHC-style, no MD5/unsalted — ADR 0018), an accounts service (`src/identity/accounts.mjs`, create/authenticate over `users`, normalized email, no hash leak), the six roles and the RS-G 1.2 permission matrix with a scoped `can(role, action, ctx)` guard (`src/domain/roles.mjs`, `permissions.mjs`), and neutral branding (`src/identity/branding.mjs`). 48 tests. Covers FR-SHP-01, FR-SHP-03, FR-SHP-09.

### Added (T-06 shop data model and seven state machines, 2026-10-09, Sahil)
- `apps/shop/` data layer: 23-table SQLite schema (`migrations/0001_init.sql`, the RS-G 1.1 marketplace model plus the thin audit log and the C09 security-events/alerts tables, integer `*_cents` money, status CHECKs mirroring the state machines), an idempotent migration runner + CLI (`src/db/migrate.mjs`, `migrate` script), and the seven state machines (`src/domain/state-machines.mjs`: seller approval, product, checkout, fulfilment, refund, dispute, payout) as pure guarded transition logic. On Node 24's built-in `node:sqlite` (ADR 0017). 21 tests. Covers FR-SHP-02, FR-SHP-04.

### Added (T-05 exploit test runner skeleton, 2026-10-09, Sahil)
- `challenges/tests/runner/` exploit test runner: runs an exploit test against any instance URL and reports passed (vulnerable) / failed (fixed) / errored (could not run), as a library and a CLI (exit 0/1/3, 2 on usage). Ships a tiny vulnerable/fixed stub and a demo exploit under `challenges/tests/_example/`, a self-test (6 cases) proving pass-on-vulnerable and fail-on-fixed, and a CI `exploit runner` job that fails if no exploit tests are found. Node built-ins only. Covers TB-4.

### Added (T-03 IF-6/IF-4 consumer review, 2026-10-09, Sahil)
- Target-stream consumer review and sign-off of the instance contract (IF-6 v0.1.0) and the instance event contract (IF-4 v0.1.0): `docs/reviews/2026-10-09-target-if6-if4-consumer-review.md`. Confirms every IF-6 open point owned by Sahil, checks IF-4 carries every shop-produced event the 11 challenges need, and raises one change request (CR-1: the `/version` env names vs the env allowlist). Covers TB-2.

### Added (T-01 shop skeleton, 2026-10-09, Sahil)
- `apps/shop/` shop skeleton (tracer bullet): Express 5.2.1 on Node 24 answering `/healthz`, `/readyz` and `/version`, packaged as a hardened, digest-pinned container (non-root uid 65532, read-only rootfs, cap-drop ALL, no-new-privileges, 512 MB / 256 pids) with a `/readyz` healthcheck. Unit tests (5) cover the endpoint behaviour; a new CI `app tests` job runs `apps/*/test` on every pull request. Proven on Sahil's PC with `docker run` (all three endpoints 200, container healthy). Covers TB-3, TB-5.
### Added (T-02 challenge catalogue IF-7, 2026-10-09, Sahil)
- Challenge catalogue contract IF-7: `contracts/catalog/challenge.schema.json` (JSON Schema 2020-12) and 11 stub entries `challenges/catalog/c01..c11.yaml` with OWASP 2021/2025 tags, CWE and ATT&CK ids, difficulty and tier (derived per D-32), placeholder milestones and three hint slots, and provisional flag placement/delivery. Validator `scripts/validate-catalog.mjs` (`pnpm run catalog:check`) and tests enforce the schema plus semantic rules (tier↔difficulty, key↔filename, key-matched test/fixed paths, env-delivery reason, exactly 11 entries, no real flag). `js-yaml` 4.1.0 added as a pinned dev dependency. Covers TB-1. EARLY PR; P-04 (Akshay) consumes it.

### Added (instance contract v0, L-02, 2026-10-08, Tanmay)
- Instance contract v0 (IF-6) in `contracts/instance/`: contract text, three JSON Schemas (injection document, flags file, instance template), 5 valid and 129 invalid examples, `contracts/CHANGELOG.md`. Checked by `scripts/validate-contracts.mjs` (`pnpm run contracts:check`) with tests. Ajv 8.20.0 and ajv-formats 3.0.1 added as pinned dev dependencies; CI `scripts` job now installs dependencies first. End-to-end tests in `scripts/e2e/contracts.e2e.test.mjs`. Merged in pull request #2 (CI green); Sahil's "to confirm" rows are still open. Decisions D-36 (placement volumes, injector without network) and D-37 (pull request review optional during initial development).

### Added
- `initial.md` v0.2 as the source of truth (decisions D-01 to D-13). (2026-10-08, Tanmay)
- Documentation system: `CLAUDE.md` rule, dev-log, ADRs, traceability table, commit gate (`scripts/check-docs.mjs`, Claude Code hook and git `commit-msg` backstop). (2026-10-08, Tanmay)

### Added (2026-10-08, Tanmay)
- Product Requirements Document `docs/prd/PRD.md` (170 FR, 49 NFR, 38 open items) and research note RS-I on the four design traps and the lifecycle.
- BMAD 6.13.0-next installed from a reviewed, pinned copy: 23 skills in `.claude/skills/`, runtime in `_bmad/`, install record and hash manifest in `docs/bmad/`, verifier `scripts/verify-skills.mjs`, BMAD section in `CLAUDE.md`. `uv` is a new prerequisite for developers.
- Decisions D-28 (design traps) and D-29 to D-31 (lifecycle, trackers, tooling) in `initial.md`.

### Added (BMAD trackers, 2026-10-08, Tanmay)
- Draft BMAD ticket trees for the three streams under `docs/bmad/initiative-*` (all 170 FR owned once), a manually maintained Excel workbook `docs/bmad/VulnMart-Tracker.xlsx`, and a tracker-update rule in the commit gate and `CLAUDE.md`.

### Added (developer task lists, 2026-10-08, Tanmay)
- `docs/dev/dev1-tanmay.md`, `dev2-akshay.md`, `dev3-sahil.md`: all tasks by weekly sprint (4 sprints, 7 to 8 tasks each); the Excel tracker is now one simple sheet per developer (Done Yes/No). `docs/README.md` index refreshed.

### Added (developer start guide, 2026-10-08, Tanmay)
- `docs/dev/START-HERE.md` (how to use BMAD and Claude Code for one task at a time), task-cycle and branch rules in `CLAUDE.md`, BMAD story references and EARLY PR marks in the task files.

### Added (challenge design, 2026-10-08, Tanmay)
- `docs/design/challenge-specs.md`: detailed design of the 11 challenges with milestones, tests and event catalogue; decisions D-32 (DC-1 to DC-15) accepted; PRD open items OI-16 to OI-20 resolved.

### Added (L-01 repository skeleton, 2026-10-08, Tanmay)
- Monorepo skeleton (architecture 07 section 1), pinned tools (Node 24.21.0, pnpm 12.10.1, Python 3.14.8, uv 0.12.23) with empty pnpm and uv workspaces and lockfiles, Compose project `vulnmart` with a hardened `hello` service, `scripts/dev.mjs` (`hello`, `up`, `down`, `doctor`) with tests, `.github/CODEOWNERS`, and CI `.github/workflows/ci.yml`. Docker on Tanmay's PC was repaired (WSL updated to 2.7.13, 8 GB cap in `.wslconfig`, Docker data moved to D:); `hello`, `doctor` and the container hardening pass on real Docker (19 unit and 10 end-to-end tests). CI was green (4 of 4 jobs) on pull request #1, merged into `main`.

### Added (architecture, 2026-10-08, Tanmay)
- Architecture documents `docs/architecture/` (index, evidence register, 7 design documents) and decision records `docs/adr/0002` to `0015`. Decisions D-33 (three work-streams P, L, T; Tanmay L, Akshay P, Sahil T), D-34 (two Oracle VMs, amends D-15) and D-35 (per-attempt keys, ASVS level 3 for key and audit, loopback HTTP for development, catalogue as a read-only SQLite file).

### Changed
- `.gitattributes` pins LF line endings for skills and `_bmad` so hashes match on every machine.
- Research phase complete: eight research notes (`docs/research/`) and decisions D-15 to D-27 locked in `initial.md` (hosting, web address, live updates, roles, stack, scoring, isolation, shop, privacy, challenge catalogue). (2026-10-08, Tanmay)

### Fixed
- `.githooks/commit-msg` is now marked executable (mode 100755) so the git backstop also runs on macOS and Linux. (2026-10-08, Tanmay)
- Claude Code commit hook now matches the `PowerShell` tool as well as `Bash` (`.claude/settings.json`, `scripts/check-docs.mjs`). On Windows the hook had never fired; only the git backstop was working. Found by a live check. (2026-10-08, Tanmay)
- Added `.gitattributes` so hook and script files keep LF line endings on every machine; otherwise a Windows clone could turn `.githooks/commit-msg` into CRLF and silently disable the commit backstop. (2026-10-08, Tanmay)
