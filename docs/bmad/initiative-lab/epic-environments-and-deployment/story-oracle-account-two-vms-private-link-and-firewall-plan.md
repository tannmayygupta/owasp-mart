---
title: 'Oracle account, two VMs, private link and firewall'
type: 'feature'
ticket: '1'
created: '2026-10-10'
status: 'in-progress'
baseline_revision: 'dc5c8bdbd50448d97eed5f97cdea9ebd6599f61a'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every later lab task (certificates, deployment, orchestrator, isolation) needs two reachable hosts, VM-P (platform) and VM-I (labs), but no Oracle account, network, firewall, access rule, budget alert or keep-alive routine exists, and the decision who owns the account (Q-32, OI-8) was open.

**Approach:** The developer creates the Oracle account and applies the infrastructure by hand; Claude builds everything repeatable and checkable around that: Terraform for the VCN, firewall rules and both VMs, a host baseline that makes SSH key-only, a keep-alive service, verification scripts that prove the done-when from outside and over the private link, a runbook for the manual steps, the Oracle terms-of-service email draft and the handoff rows. The story is closed only after the live results are recorded.

## Boundaries & Constraints

**Always:** Decisions confirmed by the developer on 2026-10-10: Tanmay owns the Oracle account (settles Q-32 and OI-8; recorded as a decision in `initial.md` after approval); the account is created by hand (card only for identity verification, never Pay As You Go, NFR-CST-01); provisioning is Terraform in the repository; both VMs run Ubuntu 24.04 aarch64 on Always Free Arm shapes with 1 OCPU and 6 GB each (D-34); home region India South (Mumbai); keep-alive is an alarm plus a small, bounded load service. Only ports 22 (limited to listed source addresses), 80 and 443 are open from the internet; all other traffic between the VMs uses private addresses and named ports; SSH is key-only (no password, no root login) with the public keys of all three developers; deploy credentials never live in CI. Network rules live in one data file read by both Terraform and the policy test, so a new open port fails a test. The two hosts have exactly the same baseline. Every manual step is a numbered, checkable item in the runbook; every claim about Oracle is read from an Oracle page in this session or marked unverified (NAT gateway cost, whether Pay As You Go prevents idle reclaim, home region permanence, default security list contents and public IP counts are unverified today). Real commands and results only. The ports for the orchestrator (9443, mTLS, architecture 02) and the event relay are proposals until S-17 and IF-4 confirm them (handoff H-68 stays open for production certificates and rotation).

**Never:** No secret, password, API private key, SSH private key, OCID, tenancy detail, public IP or card detail in the repository, a document, a log or a chat message: they stay in the developer's password manager and in git-ignored local files (`terraform.tfvars`, local state, an outputs file). Claude never asks for, reads or stores them. No `terraform apply` or any change to the Oracle account by Claude: the developer runs it. No Pay As You Go upgrade. No DuckDNS, certificates, Vercel, images or deployment (stories 2.2 to 2.4). No change to the application contracts. No push, no pull request. The terms-of-service email is drafted by Claude and sent by the developer only.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Rule data | `network-rules.json` lists public ingress 22, 80, 443 only (22 from listed sources) | policy test passes | — |
| Open port added | rule data gets any other public ingress (or 22 from 0.0.0.0/0) | policy test fails naming the rule | exit 1 |
| Terraform check | `terraform fmt -check` and `terraform validate` on the module | pass without credentials | CI job fails otherwise |
| Public ports | both public addresses probed from outside | 22, 80, 443 reachable per rule, every other probed port closed | script fails naming the port |
| SSH | key login; password login attempt | key works; password and root login refused | script fails |
| Private link | VM-P to VM-I over private addresses on the proposed ports | TCP and a mutual-TLS handshake with throwaway certificates succeed; latency recorded (S-17) | named failure; no certificate left on the hosts |
| Link blocked | same test from the internet side | refused | — |
| Idle host | a VM idle for days | keep-alive load keeps it above the idle thresholds; the OCI alarm fires if it does not | alarm email to the owner |
| Arm capacity refused | shape not available in any availability domain | runbook fallback: retry, other availability domain; record in S-11; laptop fallback stays valid | recorded, story stays open |
| Reclaimed or lost VM | host deleted | one `terraform apply` and the baseline rebuild it | runbook section |
| Secret in the tree | any OCID, key or IP committed | the secret scan test fails | exit 1 |

</frozen-after-approval>

## Code Map

- `docs/dev/dev1-tanmay.md` L-08 (lines 102-109), epic `docs/bmad/initiative-lab/epic-environments-and-deployment/epic-environments-and-deployment.md` (LE-1, LE-6, LE-8; Done-when 1, 3, 5), PRD NFR-AVL-01, NFR-CST-01, NFR-ISO-06, R-1, R-2, R-4, OI-8, S-11, S-17.
- `docs/architecture/02-deployment-and-network.md` (lines 18, 86-88, 144-148, 167, 250-272, 299, 336-339), `06-security.md` (TB-5, TB-9), ADR `0007-vm-topology-one-vm-or-two.md`, `0009`, `0010`, `0015`, `initial.md` D-15, D-28, D-34, D-35 -- topology, ports, SSH, secrets path `/opt/vulnmart/secrets`.
- `docs/dev/HANDOFFS.md` H-68 (mTLS on the private link): answered here for the host and link level; production certificates and rotation stay open.
- Existing: `infra/` holds only caddy and scripts placeholders, compose files for the stub; `.gitignore` already ignores `.env*`. New: `infra/terraform/oci/` (versions, variables, network, compute, outputs, `network-rules.json`), `infra/hosts/` (cloud-init baseline, keep-alive service), `scripts/verify-hosts.mjs` and `scripts/private-link-check.mjs` (+ tests), `docs/runbooks/oracle-account-and-vms.md`, `docs/runbooks/oracle-tos-email.md`, `docs/research/s-11-oracle-shape.md`, `docs/research/s-17-private-link.md`, ADR 0021.
- Oracle facts read 2026-10-10 (to re-read primary pages in the build): Always Free A1 2 OCPU and 12 GB total (two instances of 1 OCPU allowed), 200 GB block storage shared, minimum boot volume 47 GB, idle means CPU p95, network and memory (A1) all under 20 percent over 7 days, NSGs preferred, Ubuntu images need an iptables ACCEPT rule persisted, Bastion free, Terraform OCI provider v9.9.0, API key steps. Unverified list above.
- CI: `.github/workflows/ci.yml` gets a job `terraform` (fmt and validate, no credentials, action pinned by SHA); `scripts/ci-linux.test.mjs` guards only listed jobs.
- Do not touch: other developers' tracker folders, contracts, the instance harness.

## Tasks & Acceptance

**Execution:**
- [ ] `infra/terraform/oci/` -- VCN, internet gateway, subnet, NSGs from `network-rules.json`, two instances (Ubuntu 24.04 aarch64, 1 OCPU, 6 GB, 50 GB boot), instance metadata with the three developers' public keys and the cloud-init baseline; variables for region, compartment, source CIDRs; pinned Terraform and provider (re-verify versions); outputs for addresses written only to a git-ignored file
- [ ] `infra/hosts/` -- cloud-init baseline (SSH key-only, no root, iptables ACCEPT for 22, 80, 443 and the private ports persisted, time sync, automatic security updates, Docker from the official repository with a verified key, `/opt/vulnmart/secrets` mode 0700), keep-alive systemd service holding a bounded share of memory with an alarm design
- [ ] tests -- policy test for `network-rules.json`, a secret and address scan test over the tree, unit tests of the verification scripts with injected network and ssh runners; `terraform fmt -check` and `terraform validate` locally (Docker image if Terraform is not installed)
- [ ] `scripts/verify-hosts.mjs`, `scripts/private-link-check.mjs` -- outside probes, SSH checks, private-link TCP and mutual-TLS handshake with throwaway certificates, latency, clean-up
- [ ] `docs/runbooks/oracle-account-and-vms.md`, `docs/runbooks/oracle-tos-email.md` -- Part A manual (sign-up with MFA, Mumbai, budget and alert, API key for Terraform, owner record, send the email), Part B apply, Part C verify, Part D keep-alive and alarm, Part E rebuild, Part F owner, alert and routine record
- [ ] CI job `terraform`; handoffs: answer H-68 (host and link level), rows for Akshay and Sahil (their public keys, the host names, ports, how access works), for L-10, L-12 and L-13 (addresses, Docker, arm64), and the S-11 and S-17 record
- [ ] `initial.md` decision (owner, region, image, Terraform, keep-alive; Q-32 and OI-8 closed), ADR 0021 with research sources, dev-log, CHANGELOG, traceability LE-1, LE-6, LE-8; tick L-08 only after the live results are recorded and the developer confirms

**Acceptance Criteria:**
- Given the repository, when the tests and the Terraform checks run, then they pass, and a changed rule file that opens another public port fails the policy test.
- Given the runbook, when the developer follows Part A and B, then the account, budget alert, both VMs and the network exist without any secret entering the repository.
- Given the two hosts, when `verify-hosts` and `private-link-check` run, then both reachable by key-only SSH, only 22, 80 and 443 respond from outside, the private link works with mutual TLS, and the output is saved as evidence with addresses redacted.
- Given the account, when the owner record is read, then it names the owner, the budget alert, the keep-alive routine and the contact route for all three developers, and the terms-of-service email is sent and its reply kept.
- Given S-11 and S-17, when the study notes are read, then the shape and capacity result and the link latency and rules are recorded.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Phase 1 (offline, Claude): everything above except the live runs; the plan status becomes built. Phase 2 (live, developer): Part A to D with Claude helping read outputs; the live results go into the dev-log section "Live verification" and the story is marked done only then. Keep-alive logic: the idle rule needs all three measures under 20 percent, so one measure above is enough; holding a modest share of memory (about 25 percent of 6 GB) is cheap and harmless, CPU load is the fallback; confirm against the OCI metrics after a week.

## Verification

**Commands:**
- `node --test "scripts/*.test.mjs"` -- expected: all pass including policy, scan and script tests
- `terraform fmt -check -recursive infra/terraform` and `terraform validate` (or the same through the pinned Docker image) -- expected: pass
- `pnpm run contracts:check` and `node scripts/check-contract-rules.mjs --base origin/main` -- expected: unchanged results
- `pnpm run ci:linux` -- expected: all steps PASS
- Live (developer, after apply): `node scripts/verify-hosts.mjs` and `node scripts/private-link-check.mjs` -- expected: PASS with evidence saved
