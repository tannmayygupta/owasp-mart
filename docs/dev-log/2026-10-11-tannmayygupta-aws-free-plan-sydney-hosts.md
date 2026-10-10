# Host the two VMs on the AWS Free Plan (Sydney), offline phase

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | tannmayygupta |
| Branch / commit | sprint-1-tanmay / not committed yet (baseline a4ef73a) |
| Status | Partly done: everything that can be built and tested without an AWS account is done; the live apply, live checks and credit record are the developer's steps |
| Report tag | environments and deployment, hosting |

## Requirements covered
LE-1, LE-6, LE-8 (story 2.6, task L-08); NFR-ISO-06 (metadata part), NFR-CST-01, NFR-AVL-01, R-2, OI-8; decisions D-34, D-40, D-41; ADR 0021 (superseded in part), ADR 0022; handoffs H-100, H-102, H-103.

## Summary (plain language)
The Oracle plan could not go live (no credit card). The same hosting recipe now targets the developer's AWS Free Plan account in Sydney. Terraform builds a network, firewall groups from the one rules file and two Free Plan eligible servers with the same host baseline; budgets warn by e-mail when credit is used. All the offline checks pass. Nothing was applied: Claude has no AWS access, by design.

## Why
Oracle sign-up needs a credit card no developer has and Azure for Students rejected the college domain. The AWS account works but only in Sydney (D-41).

## What was built
- `infra/terraform/aws/`: VPC, internet gateway, one public subnet, route table, emptied default security group, one security group per host with rules from `infra/network-rules.json` (private rules reference the other group), two EC2 hosts (Ubuntu 24.04 from the Canonical SSM parameter, type per host from a validated Free Plan list, 30 GB encrypted gp3, IMDSv2 required, hop limit 1, no instance profile), one Elastic IP each, a key pair, a zero-spend budget and a monthly-use budget (50, 80, 100 percent of a configurable limit), sensitive outputs plus the (non-secret) instance IDs. Provider `hashicorp/aws` `~> 6.68`, lock file with hashes for five platforms.
- `iam-policy.json`: least-privilege policy for the Terraform IAM user, EC2 and VPC actions limited to Sydney, Budgets for `vulnmart-*`, one SSM path.
- Host baseline made cloud neutral: baseline script takes a keep-alive flag (off by default), the cloud-init template gets the time server and the developer keys as variables, comments no longer say Oracle only. Oracle Terraform kept as an unused option and still passes its tests.
- Rule file moved to `infra/network-rules.json` (shared by both folders).
- Scripts: `oracle-hosts.mjs` renamed `cloud-hosts.mjs` (test renamed too, default address file now in the aws folder); `verify-hosts.mjs` accepts x86_64 and aarch64, checks keep-alive as configured, and adds the metadata check (control on the host, a container must be blocked); `scan-secrets.mjs` also catches AWS access key ids, secret keys, account IDs and AWS credential files.
- CI job `terraform` runs fmt, init (locked), validate and test for both folders.
- Runbook `docs/runbooks/aws-account-and-vms.md` (Parts A to H, including stop and start, credit check and the acceptable-use note), study notes S-11 (new `s-11-aws-hosts.md`; the Oracle one marked superseded) and S-17 retargeted, D-41, ADR 0022, handoffs H-100, H-102, H-103 reworded.

## How it works
`terraform apply` (run by the developer) reads `infra/network-rules.json` and builds one security group per host. Public ports 22 (only listed addresses), 80, 443; the two private ports are allowed only from the other host's group. The same cloud-init file configures both hosts at first boot (key-only SSH, Docker, firewall, secrets folder). Elastic IPs keep the address when the labs host is stopped to save credits.

## Files changed
- `infra/terraform/aws/*` (new), `infra/network-rules.json` (moved from `infra/terraform/oci/`), `infra/terraform/oci/network.tf` and `compute.tf` (path and new template variables)
- `infra/hosts/cloud-init.yaml.tftpl`, `vulnmart-baseline.sh`, `vulnmart-firewall.sh`, `vulnmart-keepalive.py` and `.service` (neutral wording, keep-alive flag, NTP and key variables)
- `scripts/cloud-hosts.mjs` and `cloud-hosts.test.mjs` (renamed), `verify-hosts.mjs`, `private-link-check.mjs`, `check-network-rules.mjs` and test, `scan-secrets.mjs` and test
- `.github/workflows/ci.yml` (job `terraform`)
- `docs/runbooks/aws-account-and-vms.md` (new), `docs/runbooks/oracle-account-and-vms.md` (not-in-use banner), `docs/research/s-11-aws-hosts.md` (new), `s-11-oracle-shape.md`, `s-17-private-link.md`, `docs/adr/0022-*.md` (new), `0021` and README, `initial.md` (D-41), `docs/dev/HANDOFFS.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/assets/l-08-aws-hosts/offline-checks.txt`

## Decisions made
ADR 0022 and D-41. Alternatives: Oracle (blocked), Azure for Students (domain rejected), laptop only (stays as fallback). Arm t4g versus x86: x86 chosen so only amd64 images are needed.

## Tests
Real runs on 2026-10-11 (output saved in `docs/assets/l-08-aws-hosts/offline-checks.txt`):
- `terraform fmt -check -recursive /infra/terraform` exit 0; in `infra/terraform/aws` and `infra/terraform/oci`: `init -backend=false -input=false -lockfile=readonly` exit 0, `validate` exit 0, `terraform test` aws 30 of 30 passed (after the review fixes; 19 of 19 before), oci 10 of 10 passed (Terraform 1.16.5 image from the CI digest, run through Docker on the developer's PC).
- Before the review fixes: `node --test "scripts/*.test.mjs"` 361 of 361 pass. After the review fixes only the files touched were run: `node --test scripts/cloud-hosts.test.mjs scripts/check-network-rules.test.mjs scripts/scan-secrets.test.mjs scripts/ci-linux.test.mjs` 96 of 96 pass (output in `docs/assets/l-08-aws-hosts/offline-checks.txt`).
- `node scripts/check-network-rules.mjs` PASS; `node scripts/scan-secrets.mjs` PASS; `node scripts/check-contract-rules.mjs --base origin/main` printed only NOT-APPLICABLE lines for the parts that do not exist yet, no failure.
- Negative check: swapping `from` and `to` of a private rule in the rules file made `terraform test` fail (1 failed run); the file was restored.
Traceability rows: LE-1, LE-6, LE-8.

## Review fixes (2026-10-11, three batches)
- **Batch 1 (Terraform, IAM, rules):** IAM policy completed (budget tag actions, SSM, instance state, describe) and `RunInstances` limited to the eligible instance types and to Sydney, with a test that derives the needed actions from the resource types; web ports 80 and 443 now use the token `$public_web_cidrs` (variable defaults to the SSH list, `0.0.0.0/0` only when set on purpose, tested both ways); at least one IPv4 SSH source and canonical CIDRs required; credit limit default 120; instance type error names its source; key pair by name prefix, first of the sorted list, public key ignored after creation; user data size counted in bytes; public rule keys include the port; the rule checker limits literal `0.0.0.0/0` and `::/0` to egress, ICMP and default-route blocks and checks unique names; budgets are monthly (50, 80, 100 percent, default USD 60) plus zero-spend; `vm_i_running` through `aws_ec2_instance_state`; tests for keys and the Amazon time server in user data, the Oracle option, IPv6 sources; the secret scan also catches `SecretAccessKey` and more id prefixes; root volumes and all resources carry `Project=vulnmart`.
- **Batch 2 (hosts and scripts):** baseline script refuses a keep-alive argument other than yes or no (exit 2) and records a pending reboot; `verify-hosts` warns about a pending reboot, pulls the probe image (pinned by digest) in its own step, requires a working container control before it accepts "blocked", prints the exception class, treats keep-alive off as inactive, failed or unknown only, and exports its option mapping for a test; the firewall script header and docs now say the security groups are the only perimeter on AWS; the address file is chosen by `--hosts`, `--provider aws|oci` or the only file that exists, never guessed.
- **Batch 3 (docs):** cost arithmetic corrected (about USD 108 to 113), runbook rewritten for PowerShell (native Terraform first, Docker as an alternative, state location and copy, find leftovers by tag, what a stop does, shorter rehearsal, Part A gate, monitored root e-mail, alternate contacts, root MFA risk, accidental upgrade, plan end), budgets described as a lagging warning, deferred items recorded in `docs/bmad/initiative-lab/deferred-work.md`.

## Evidence
`docs/assets/l-08-aws-hosts/offline-checks.txt`. Live evidence (`verify-hosts.txt`, `private-link-check.txt`) is still to be produced by the developer.

## Problems met and how they were fixed
- `terraform test` crashed (Terraform panic "value has marks") while printing a failed assertion on an instance whose `user_data` is sensitive; the failing assertion was an instance-profile check that cannot hold with a mocked provider (computed strings); removed it and covered "no instance profile" with a static test on `compute.tf`.
- The policy check for network files rejected the default route (`0.0.0.0/0` in a route) and port numbers in ICMP rules; the check now knows `cidr_block` default routes and `from_port`/`to_port` literals.
- A first batch of edits through PowerShell double-quoted strings executed `$(...)` text and ate backticks (in `initial.md`); the affected files were restored from git and redone with exact edits.
- My CI edit glued the next job name onto the last step line; found by the `ci-linux` test and fixed.
- No `terraform` binary on the PC: everything runs in the pinned Docker image.

## Security notes
Not a vulnerable-app task. Notes on the hosts: IMDSv2 required with hop limit 1 so a container cannot read instance metadata; no instance profile; no secrets in the repository; the secret scan now looks for AWS keys and account IDs. No flag values involved.

## Limitations and follow-ups
- **Not done (developer steps):** Part A and B of the runbook (account hardening, IAM user, apply), Part C (live `verify-hosts` and `private-link-check`, evidence), Part D (credit balance, days left, plan end date in the owner record), the stop and start rehearsal, S-11 and S-17 live fields. L-08 is **not** ticked and stories 2.1 and 2.6 are **not** marked done until those results are recorded and the developer confirms.
- Unverified (marked in runbook and ADR): Sydney prices, 16 KB user data limit, whether AWS reclaims idle instances, how Budgets treats credits, Free Plan limits on instance count and disk size, completeness of the IAM policy (the first plan may show a missing action), the `python:3.12-alpine` image pull needed by the metadata check, AWS pages were not re-read in this build.
- H-103 (Docker-published ports, container egress, VPC range) stays open for L-15 and L-29; the host firewall is only a second layer on AWS images.
- PRD R-2 left for the developer (no conflict while keep-alive is off).
- Akshay and Sahil: images must be amd64 (H-100 and H-102 updated); tell them in the team chat.
- Live verification: (empty until the developer runs Part C)


## Live verification (2026-10-11)
Done by the developer on the AWS Free Plan account in Sydney (ap-southeast-2); Claude read only redacted outputs.
- **Apply:** `terraform apply` created 28 resources on the first run (the plan was checked against the design first: one VPC, one subnet, one internet gateway, two security groups, two EC2 hosts, two Elastic IPs, two budgets, one key pair, no NAT gateway). The limited IAM user with `iam-policy.json` was enough for plan and apply; no action had to be added.
- **Sizes:** platform host t3.small, labs host m7i-flex.large (x86, Ubuntu 24.04), both accepted by the Free Plan in Sydney. Mumbai (ap-south-1) was denied for the account.
- **First boot failed in the baseline** and was repaired live (three defects that only a real host shows; each fixed in the repository with a regression test): (1) `sshd -t` needs `/run/sshd`, which does not exist before the first ssh start on Ubuntu 24.04; (2) the AWS image has chrony and no systemd-timesyncd, so the time-sync step now restarts whichever exists; (3) the private-link check kept its certificates in `/dev/shm`, which systemd-logind wipes when an ssh session ends, so it now uses a folder under `/run` made and removed with sudo. The fixed baseline script was pushed to both hosts over ssh and rerun (runbook Part G way 1); cloud-init keeps an error status from the first run, which `verify-hosts` now reports as a warning when the baseline marker is ok.
- **Closed web ports give no "refused" answer on AWS** (a closed port is dropped silently), so `verify-hosts` now starts a bare TCP listener on 80 and 443 for a short time (serves nothing), probes, and stops it. A manual test used Python's file server for 25 seconds from the developer's own address (it would have listed the root folder; nothing was requested); it is not used any more.
- **`verify-hosts`:** `RESULT PASS (94 checks)` with two warnings (the cloud-init note on each host). Key-only login works; password and root login refused; only 22, 80 and 443 answer from the developer's address and every other probed port is closed; the baseline marker and the seven baseline files match the repository; Docker 29.9.0 is installed; a container cannot read the instance metadata while the host can (IMDSv2, hop limit 1, with controls).
- **`private-link-check`:** `RESULT PASS (22 checks)`. Mutual TLS 1.3 works both ways (9443 and 9444); median connect about 0.44 ms; a client without a certificate is refused; wrong direction and an unlisted port are dropped; no certificate left on either host.
- **Evidence:** `docs/assets/l-08-aws-hosts/verify-hosts.txt` and `private-link-check.txt` (addresses redacted; the secret scan passes).
- **Still open before the story closes:** credit balance, days left and plan end date read from the Billing console (Part D); the budget alert e-mail confirmed; the stop and start rehearsal of the labs host (Part C6); Akshay's and Sahil's public keys added (only Tanmay's key is installed); idle reclaim by AWS to be observed for a week; root MFA skipped by choice (recorded risk).