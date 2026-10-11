# PR 3 review remediation (story 1.15)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | tannmayygupta |
| Branch / commit | sprint-1-tanmay (merge of origin/main, then the story changes; see git log) |
| Status | Built and tested; the infrastructure was applied by the developer and verified live on 2026-10-11; the trusted checker has not run on GitHub; waiting for the reviewer |
| Report tag | Lab stream, Sprint 1, review remediation |

## Requirements covered
LB-3, LB-4, LB-5, LB-7, LB-9, LE-1, LE-6, LE-8; handoffs H-09, H-10, H-103 (code only), new H-104 to H-110; decisions D-42 to D-46 (proposed, decided on delegation).

## Summary (plain language)
The reviewer of pull request 3 (the Target developer) blocked the merge on four items and listed five dependent items and seven majors. The developer asked for everything at once. The main branch was merged in (7 conflicts), and the findings were fixed in four parts: the contracts (IF-4, IF-5, IF-6, IF-2), the rules engine, the infrastructure code and the documents. The decisions were taken by Claude on the developer's explicit delegation and are recorded as Proposed.

## Why
The review found collisions (IF-7 registry, ADR numbers), an IF-4 design that could not be built (sequence and epoch rules, event keys), a rules engine the pull request could weaken, and an isolation gap on the labs host. Source: the pull request review of 2026-10-11 and `docs/bmad/initiative-lab/audit-2026-10-11-sprint-1.md`.

## What was built
- Part A: merge of origin/main with 7 conflicts resolved as unions; IF-7 added to `contracts/registry.json` and the contracts CHANGELOG; this branch's ADR 0017 and 0018 renumbered 0023 and 0024 with every reference; the IF-4 consumer sign-off flagged stale in `docs/reviews/2026-10-09-target-if6-if4-consumer-review.md`.
- Part B1, IF-4 (ADR 0025): `epoch` on every event, identity `(instance_id, epoch, seq)`, seq lanes per source, signed epoch, HKDF event key per instance and epoch with a test vector, `first_seq` removed from IF-5 and the sidecar start input, sidecar counter saved before each event.
- Part B2, IF-6: 40 new invalid template examples; the schema now fixes network and image per role, limits, env patterns, injector rules, reason quality, dates and user.
- Part B3, IF-5 (ADR 0028): required `transition` on StateReport, strict integers on the wire, RFC 9457 problem details with an open schema, verified `ssl_context`, 415 before 404.
- Part B4, IF-2: stable `(epoch, seq)` cursor, `has_more` and `limit`, RFC 9457, flag answer only `correct` or `incorrect`, role table, 410 for withdrawn and cancelled reads.
- Part C (ADR 0026): the contract rules run from the base commit, whole-contract deletion is breaking, exact `BREAKING:` marker, `oneOf` branch removal and unlisted artefacts are compared, CODEOWNERS for the checker paths, a separate job for the checks that run head code.
- Part D (ADR 0027): two subnets, labs egress allowlist, network ACL, DOCKER-USER and metadata rules, compose lint, IAM policy without `ModifyInstanceAttribute` and with an instance-type deny, S3 backend example and bootstrap script, Terraform 1.11 minimum, runbook sections. Nothing applied.

## How it works
See the ADRs 0025 to 0028 and the contract texts. Key idea of D-42: carry the epoch on the wire so a reset can never collide with buffered old events, and derive the event key from a master secret with the instance id and the epoch as context.

## Files changed
Too many to list here (about 380 paths): see `git diff --stat` of the story commits. Main areas: `contracts/`, `apps/api/`, `scripts/`, `infra/`, `.github/`, `docs/`.

## Decisions made
ADRs 0025, 0026, 0027, 0028 (all Proposed, decided on the developer's delegation on 2026-10-11). Not recorded in `initial.md` Section 15 until the developer confirms. Alternatives and sources are in each ADR.

## Tests (real results, 2026-10-11)
- `node --test "scripts/*.test.mjs" "contracts/mocks/stub-instance/**/*.test.mjs"`: 515 of 515 pass (after updating the `ci:linux` mirror tests for the new `contract-rules` job).
- `uv run --locked --package vulnmart-api pytest -q apps/api/tests`: 640 passed in 247 s.
- `node --test "scripts/e2e/*.test.mjs"`: 71 of 72 pass; the one failure was the fresh-checkout parity test, which failed first because it copied the old `ci:linux` test and then because its own 5-minute step timeout was too short for 640 Python tests. Fixed (see Problems); rerun of `node --test scripts/e2e/contracts.e2e.test.mjs`: 9 of 9 pass (716 s).
- `node scripts/check-contract-rules.mjs`: 18 PASS, 0 FAIL, 4 NOT-APPLICABLE. `node scripts/validate-contracts.mjs` and `node scripts/validate-events.mjs`: PASS. `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs`: PASS.
- Terraform on a clean copy (run by the infra helper): `fmt -check`, `validate` pass; `terraform test` aws 37 of 37, oci 10 of 10.
- `node scripts/dev.mjs harness` (Docker engine 29.6.2): exit 0, `conformance: PASS (20 rules)`, `harness: PASS`, all `live-*` checks PASS.
- Live (applied by the developer, 2026-10-11, Sydney): the plan showed only `vm-i` replaced; the first `verify-hosts` failed on `vm-i` (baseline marker `failed: step=firewall exit=127`, Docker missing) because the host had been created stopped and its first boot was cut off; after replacing `vm-i` with the host kept running and replacing `vm-p` (so it has the new scripts), the final run gave `verify-hosts` RESULT PASS (107 checks; one WARN: a root host-network container can reach instance metadata, the known residual risk of ADR 0027) and `private-link-check` RESULT PASS (22 checks, TLS 1.3 both ways). These numbers are from the developer's terminal output; the evidence files were not saved on that run. The labs host is stopped again (`vm_i_running = false`).
- Not run: `ci:linux` (killed for low memory earlier, not repeated), the workflow on GitHub, `terraform plan` or `apply`, anything on AWS.

## Evidence
Command output as above; no screenshots.

## Problems met and how they were fixed
- Several tests were written together with the code, so they were not all shown failing first: B1, B2, B3 (transition and problem details), B4 said so in their reports. B3's wire-rule tests were shown failing on the old code (66 failed, 47 passed).
- Live finding: a host created while `vm_i_running = false` is stopped during its first boot and never finishes setup (runbook rule added; follow-up H-111).
- Live finding: the new metadata rule blocks non-root host processes, so the `verify-hosts` metadata control ran as `ubuntu` and failed; it now runs under `sudo` (test in `scripts/cloud-hosts.test.mjs`).
- A helper deleted some valid IF-5 examples through a PowerShell alias and restored them from git; the intended deletions are the old `first_seq` examples and the old oracle examples.
- The `ci:linux` mirror tests assumed the old `contract-rules` job; updated.
- The fresh-checkout parity test timed out after 5 minutes on the Python step; the step timeouts are now 15 minutes.
- The first draft of the labs egress script had a public IPv4 address on one line while it was being written; the secret scan caught it and the final tree passes the scan.

- The AWS console refused the new IAM policy: the statement ID `BootstrapStateBucketOnce_RemoveAfterwards` had an underscore (IDs allow letters and digits only). Found when the developer pasted the policy; renamed `BootstrapStateBucketOnceRemoveAfterwards`; a test now checks every ID and the size limit (`node --test scripts/infra-isolation.test.mjs`: 13 of 13 pass).

## Security notes (vulnerable parts only)
No flag values or secrets were written. The event key vector uses a fake master marked as a test value.

## Limitations and follow-ups
H-104 to H-110: the instance-conformance check cannot validate against the template schema; IF-2 evidence and integrity lists have no cursor; the sidecar counter file lives on the container tmpfs; the JSON reader of the fake orchestrator does not reject duplicate keys; the first run of the trusted checker on GitHub is in bootstrap mode; a root or privileged container can bypass host filters, so the VPC security groups and the network ACL are the real boundary; the live checks (94 and 22) must be repeated after the developer applies the infrastructure.