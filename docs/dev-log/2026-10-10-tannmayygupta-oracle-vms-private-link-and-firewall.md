# Oracle account, two VMs, private link and firewall (task L-08, story 2.1)

| Field | Value |
|---|---|
| Date | 2026-10-10 |
| Developer | tannmayygupta |
| Branch / commit | sprint-1-tanmay; nothing committed yet (working tree on top of e4492b7, the HEAD when the work started) |
| Status | Partly done: Phase 1 (offline build) done and tested; Phase 2 (account, apply, live checks, terms e-mail) not started. L-08 is not ticked and the story is not marked done |
| Report tag | infrastructure; deployment; network isolation; cost and availability |

## Requirements covered
LE-1, LE-6, LE-8 (spikes S-11 and S-17, live part pending), NFR-AVL-01, NFR-CST-01, NFR-ISO-06, R-1, R-2, R-4, OI-8 and Q-32 (closed by D-40), D-34, D-40, ADR 0007, 0021, handoff H-68 (answered at host and link level).

## Summary (plain language, 3-5 lines)
The labs need two servers, and nothing existed to create or check them. Everything repeatable is now code: Terraform for the network, firewall and two Oracle Arm VMs, one startup file that makes both VMs identical (key-only SSH, firewall, Docker, a small keep-alive service), and two scripts that prove the result from outside and over the private link. The account, the apply and the terms e-mail are manual steps in a runbook; they have not been done yet, so there are no live results.

## Why
Every later lab task needs reachable hosts; Oracle reclaims idle VMs; the account owner was undecided (Q-32, OI-8). Decisions were confirmed by the developer on 2026-10-10 and recorded as D-40.

## What was built
- `infra/terraform/oci/`: VCN, internet gateway, closed default security list, one network security group per VM, two `VM.Standard.A1.Flex` instances (1 OCPU, 6 GB, 50 GB boot, Ubuntu 24.04 aarch64), notification topic and idle alarm. Rules come from `network-rules.json`.
- `infra/hosts/`: cloud-init template and the files it carries (sshd drop-in, firewall script, Docker install with fingerprint check, keep-alive script and unit).
- `scripts/check-network-rules.mjs`, `scripts/scan-secrets.mjs`, `scripts/oracle-hosts.mjs`, `scripts/verify-hosts.mjs`, `scripts/private-link-check.mjs` and their tests.
- CI job `terraform`; runbook, terms e-mail draft, S-11 and S-17 notes, ADR 0021, D-40, handoffs.

## How it works
One JSON file lists the allowed ports. Terraform builds the network rules from it and a unit test checks it, so adding a public port fails a test. Both VMs use one cloud-init, so their baseline is the same. After apply, `verify-hosts` probes ports from outside, logs in by key, tries password and root login, and compares file hashes between hosts. `private-link-check` makes a throwaway CA on VM-P, copies a node certificate to a memory-backed folder on VM-I, runs a TLS server and clients (with and without a certificate), measures connect latency, and deletes everything.

## Files changed
- `infra/terraform/oci/*` (versions, variables, network, compute, alarms, outputs, network-rules.json, tfvars example, .gitignore, lock file); `infra/hosts/*`
- `scripts/check-network-rules(.test).mjs`, `scripts/scan-secrets(.test).mjs`, `scripts/oracle-hosts(.test).mjs` (tests cover verify-hosts and private-link-check), `scripts/verify-hosts.mjs`, `scripts/private-link-check.mjs`
- `.github/workflows/ci.yml` (job `terraform`), `.gitattributes` (LF for infra files)
- `docs/runbooks/oracle-account-and-vms.md`, `docs/runbooks/oracle-tos-email.md`, `docs/research/s-11-oracle-shape.md`, `docs/research/s-17-private-link.md`, `docs/adr/0021-*.md`, `docs/adr/README.md`
- `initial.md` (D-40, Q-32 closed), `docs/prd/PRD.md` (OI-8 closed), `docs/dev/HANDOFFS.md` (H-68 answered, H-100 to H-102), `CHANGELOG.md`, `docs/traceability.md`

## Decisions made
ADR 0021 and D-40. Alternatives: console only, Ansible. The keep-alive load differs from PRD R-2 wording ("a fake cron load would not be honest use"); the developer chose it, R-2 is unchanged and this is flagged for the report.

## Tests
Real commands run on 2026-10-10:
- `node --test scripts/check-network-rules.test.mjs scripts/scan-secrets.test.mjs scripts/oracle-hosts.test.mjs`: 37 tests, 37 pass.
- `node --test "scripts/*.test.mjs"`: 323 tests, 323 pass.
- `node scripts/check-network-rules.mjs`: PASS. `node scripts/scan-secrets.mjs`: PASS on the working tree.
- Terraform through the Docker image `hashicorp/terraform@sha256:c7926feace...` (1.16.5): `init -backend=false`, `validate` ("The configuration is valid"), `fmt -check -recursive` exit 0.
- Mutual-TLS helper programs run on loopback in an alpine container with a throwaway CA: client with certificate OK (TLSv1.3), client without certificate refused (`docs/assets/l-08-oracle-hosts/local-mtls-helper-check.txt`). This is not a result for the Oracle hosts.
- `pnpm run ci:linux` (Linux Docker): all 9 steps PASS (skills, pnpm-install, unit-tests, stub-instance-tests, pytest, contracts-check, uv-lock-check, contract-rules, e2e). The new job `terraform` is not in ci:linux.
- Not run: `terraform plan` and `apply` (no credentials by design), the live scripts, `contracts:check` (no contract file touched).
Traceability rows: LE-1, LE-6, LE-8.

## Review fixes (2026-10-10, after the first build)
A review of the first build found problems; each fix has a test where a test is possible.
- Terraform: `ssh_source_cidrs` must be valid CIDRs, not `0.0.0.0/0` or `::/0`, no prefix shorter than /16 (IPv6 /48), no duplicates or placeholders; `ssh_public_keys` must be `ssh-ed25519` or `ssh-rsa` public keys, no private key text, no `AAAA...` placeholder. `user_data` and `ssh_authorized_keys` are in `ignore_changes` (a running VM is never replaced for them), with preconditions for the availability domain index and an empty image list. A second alarm per VM for a missing metric. Lock file regenerated for five platforms.
- Terraform native tests (`infra/terraform/oci/tests/network.tftest.hcl`, mocked provider, no credentials): public ingress only 22 (sources from `ssh_source_cidrs`), 80, 443; each private rule on the NSG of the `to` side with the `from` NSG as source; the `$ssh_source_cidrs` token is expanded; bad inputs are refused. Proved once on temporary copies: swapping `from` and `to` in the rule file, and collapsing the token expansion, each made tests fail.
- Policy and scan: null or non-object rule entries are named failures, `::/0` on port 22 is rejected, the subnet must lie inside the VCN; the scan also catches `*.tfvars`, `*.tfvars.json`, `tfplan*`, and ssh private key file names; `.gitignore` extended.
- Host files: keep-alive ignores non-numeric values with a warning, maximum 1900 MB under `MemoryMax=2200M`; one baseline script stops at the first failure and writes `baseline-ok` or `baseline-failed`; Docker install waits for the apt lock and retries downloads; Docker log rotation and live-restore; sshd `MaxAuthTries 6`.
- `verify-hosts`: per-port `iptables -C` checks (a refused connection on 80 or 443 passes only when the rule exists), marker check, and sha256 of seven baseline files against the repository (drift and missing files fail), `set -o pipefail`.
- `private-link-check`: clean-up kills only saved server process ids (no pattern kill) and removes the folder; "client without certificate" passes only on a TLS-level error plus a rejection in the server log; server lifetime derived from the step budget; probes of the wrong direction and a port in no rule must time out.
- `oracle-hosts`: address redaction with boundaries, longest first, IPv6; options that need a value give a usage error; `--opt=a=b` splits at the first `=`.
- CI job `terraform`: runs as the runner user, `init -backend=false -lockfile=readonly`, adds `terraform test` and a check that nothing tracked changes.
- Docs: Docker-published-port gap stated in the runbook, H-102 and ADR 0021 and handed to L-15 and L-29 (H-103, deferred-work); one handoff row (H-100) for both developers; ADR 0021 status Proposed; the terms e-mail describes the lab truthfully and has an "if Oracle does not reply" section; runbook Part G (change a host file, add a key, updates and reboots, key rotation, cost check, lockout recovery, teardown) and state backup advice.
- Real results after the fixes: `node --test` on `oracle-hosts`, `check-network-rules`, `scan-secrets` and `ci-linux` tests: 67 of 67 pass (one test runs the keep-alive script with Python 3); `terraform test` in the pinned image: 10 of 10 pass; `terraform fmt -check -recursive` exit 0; `terraform validate` valid; `scan-secrets` and `check-network-rules` PASS; `sh -n` on the three host scripts passes; the loopback run of the Python helpers (probe, mTLS) gave the expected answers. The full `ci:linux` was not rerun for these fixes.

## Live verification
Not done yet. To be filled by the developer after runbook Parts A to D: outputs of `verify-hosts` and `private-link-check` (redacted evidence in `docs/assets/l-08-oracle-hosts/`), the capacity result (S-11), latency (S-17), the alarm test, date the terms e-mail was sent and replied.

## Evidence
`docs/assets/l-08-oracle-hosts/`.

## Problems met and how they were fixed
- The first draft of the policy test counted `user_data` twice (the Terraform local and the instance); the check now matches the use in the instance.
- The tree scan flagged an existing test fixture (a fake key header in `scripts/validate-contracts.test.mjs`); that file is on a named allow-list.
- A first batch of file writes through PowerShell here-strings failed and wrote a byte-order mark in some files; the files were rewritten without it.
- The `terraform validate` run needed network to fetch the provider (`init`), so it is not "offline" in the strict sense; it needs no credentials.

## Security notes (vulnerable parts only)
Not a vulnerable component. Security controls: closed default security list, key-only SSH, secrets and addresses kept out of the tree (scan test), sensitive Terraform outputs. No flag is involved.

## Limitations and follow-ups
- Private ports 9443 and 9444 are proposals; production certificates and rotation open (H-68).
- Unverified Oracle facts: Pay As You Go and reclaim, home region permanence, public IP counts, console menu names; the alarm query is checked live.
- Docker key fingerprint is read from the key and a pinned constant, not from a current Docker page.
- The CI job `terraform` has not run on GitHub; it uses a pinned Docker image instead of an action pinned by SHA.
- The developer must do Parts A to D, then confirm before L-08 is ticked and the story marked done; remind to set Done = Yes in the Excel sheet.


## Verification note (2026-10-10)
After the review patches: unit tests 393 of 393, 	erraform fmt, init -lockfile=readonly, alidate and 	erraform test (10 of 10) pass in the pinned image, network-rule and secret-scan checks pass, contract rules unchanged (17 PASS, 4 NOT-APPLICABLE). The Linux proof (pnpm run ci:linux) passed before the review patches; the re-run after them was stopped by the system for low memory and is still to be repeated.


## Oracle sign-up blocked (2026-10-10)
The developer tried the Oracle Cloud sign-up in the Mumbai region: the payment step offers only 'Credit Card' and none of the three developers has one. Research the same day (summaries of Microsoft, AWS, GitHub, Oracle and other pages, mostly secondary sources): Oracle accepts credit cards and debit cards that work like credit cards, not prepaid, virtual or RuPay-only cards, and no UPI; AWS needs a payment method too; Azure for Students needs no card (USD 100 credit for 12 months, free hours of small VMs) but the college domain may not be accepted. The developer chose to try Azure for Students first (college email, GitHub Student Developer Pack as the backup route). The Terraform for Oracle stays in the repository until the provider decision is recorded (planned D-41); only the provider-specific parts (Terraform, console steps in the runbook) would change. The live phase of this story is blocked until a provider account exists.
