# 0021. Oracle account, two Arm VMs, Terraform and keep-alive

- **Status:** Superseded in part by [ADR 0022](0022-aws-free-plan-sydney-hosts.md) on 2026-10-11 (provider, region, shape, keep-alive and alarm; Oracle is an unused option). Original status: Proposed (the owner, region, image and tooling were confirmed by the developer on 2026-10-10 as decision D-40; the private ports 9443 and 9444, the keep-alive memory share, the alarm queries and the host isolation are not settled, and nothing has been applied yet)
- **Date:** 2026-10-10
- **Deciders:** Tanmay
- **Requirements:** LE-1, LE-6, LE-8, NFR-AVL-01, NFR-CST-01, NFR-ISO-06, R-1, R-2, R-4, OI-8, Q-32, S-11, S-17, D-34, D-40, ADR 0007

## Context
Later lab work needs two reachable hosts (VM-P platform, VM-I labs). There was no account, network, firewall, budget alert or protection against Oracle's idle reclaim, and nobody owned the account.

## Options considered
1. **Console clicks only** - fast, but not repeatable and cannot be tested.
2. **Terraform plus cloud-init baseline (chosen)** - repeatable, the firewall rules sit in one data file that a test reads, a lost host is rebuilt by one apply; needs the developer to run it (Claude never holds credentials).
3. **Ansible or manual hardening** - more tools for two hosts; not chosen.
4. Keep-alive: a real-use-only policy (no load) - cheapest but leaves the 7-day reclaim to luck; **a bounded memory-holding service plus an OCI alarm (chosen)**. This differs from the wording of PRD R-2 ("a fake cron load would not be honest use"); the developer chose it knowingly, R-2 is not rewritten.

## Decision
- Owner Tanmay; Mumbai; Always Free only, never Pay As You Go.
- Two `VM.Standard.A1.Flex` instances, 1 OCPU, 6 GB, 50 GB boot, Ubuntu 24.04 aarch64, one VCN, one subnet, one network security group per VM. The VCN default security list (which normally lets port 22 in from anywhere) is replaced with a closed one.
- Public ingress 22 (listed sources only), 80, 443. Private ingress only from the other VM's group on named ports (proposed 9443 and 9444). Rules live in `infra/terraform/oci/network-rules.json`; `scripts/check-network-rules.mjs` fails on any other public port.
- Terraform 1.16.5 image pinned by digest, provider `oracle/oci` pinned at 9.9.0 with a lock file for five platforms; CI job `terraform` runs fmt, validate and `terraform test` (mocked provider, no credentials) on the network rules. A running VM is never replaced for a changed startup file or key list (`ignore_changes` on `user_data` and `ssh_authorized_keys`); changes are pushed over SSH and `verify-hosts` detects drift by file hashes (runbook Part G).
- One cloud-init for both hosts, running one baseline script that stops at the first failure and writes a marker file: key-only SSH, no root login, host firewall rules persisted, time sync, unattended upgrades, Docker from the official repository after a fingerprint check, `/opt/vulnmart/secrets` mode 0700, keep-alive service.
- Secrets and addresses stay out of the repository: Terraform outputs are sensitive and saved to a git-ignored file; `scripts/scan-secrets.mjs` fails on an OCID, key block, API fingerprint, local file or public address.

## Consequences
- Easier: rebuilds, review of firewall changes, same baseline on both hosts, checks anyone can rerun.
- Known gap (not fixed here, handoff H-103 to L-15 and L-29): the host firewall covers the INPUT chain only, so Docker-published container ports bypass it, and containers can reach the VCN range and the metadata address `169.254.169.254`; the network groups are the only filter until a `DOCKER-USER` policy and egress control exist.
- Alarms: one for low memory and one for a missing metric per VM, both to the owner topic; the queries are unverified until the live test.
- Harder: the developer must run apply and keep local files safe; the Docker key fingerprint is a pinned constant to re-check when Docker rotates its key.
- Watch: Arm capacity errors; whether memory use counts in Oracle's idle measure; the alarm query is unverified until the live test (runbook D4); the shared API key and state file are single points of failure.

## Evidence
Read 2026-10-10:
- Oracle, Always Free Resources (docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm): A1 allowance, 200 GB block storage, minimum boot volume (47 GB and 50 GB both stated), idle rule, home-region rule, capacity error text.
- Terraform provider `oracle/oci` releases (github.com/oracle/terraform-provider-oci/releases): v9.9.0 latest.
- Docker install page for Ubuntu (docs.docker.com/engine/install/ubuntu): apt repository steps; the page states no key fingerprint. The fingerprint in the script was read from the key itself with gpg and equals the long-published Docker value (still UNVERIFIED against a current Docker page).
- hashicorp/setup-terraform latest release v4.0.1 (not used; the Docker image digest is pinned instead).
- Unverified: Pay As You Go effect on reclaim, home region permanence, public IP counts, console menu names, alarm query.

## Sources
Links recorded from the pages named under Evidence (not re-read when added, 2026-10-11).
- Oracle Always Free Resources: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Terraform provider `oracle/oci`: https://registry.terraform.io/providers/oracle/oci/latest and https://github.com/oracle/terraform-provider-oci/releases
- Docker Engine install on Ubuntu: https://docs.docker.com/engine/install/ubuntu/
- setup-terraform action: https://github.com/hashicorp/setup-terraform/releases
- Superseded for the provider by ADR 0022 (AWS sources are listed there).
