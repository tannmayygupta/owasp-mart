---
title: 'Host the two VMs on the AWS Free Plan (Sydney)'
type: 'feature'
ticket: '6'
created: '2026-10-11'
status: 'in-progress'
baseline_revision: 'a4ef73af94b9b94342c41c91e61afb59414f7977'
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

**Problem:** The Oracle plan (story 1) cannot go live: Oracle's sign-up needs a credit card that no developer has, and Azure for Students rejected the college domain. The developer's new AWS Free Plan account works (USD 100 credits, 182 days left, UPI AutoPay) but only the Sydney region (ap-southeast-2) is usable; nothing yet builds the two hosts there.

**Approach:** Retarget the repeatable infrastructure to AWS: Terraform for a VPC, security groups built from `network-rules.json` and two Free Plan eligible EC2 hosts with the existing host baseline, plus a budget and credit alert, a least-privilege IAM policy for the developer's Terraform user, a runbook, decision D-41 and an updated ADR. The developer applies it by hand; the story closes only after the live results are recorded.

## Boundaries & Constraints

**Always:** Decisions confirmed by the developer on 2026-10-11: AWS Free Plan account owned by Tanmay; region Sydney (Mumbai is denied for the account); provisioning is Terraform (aws provider) run from the developer's PC with a limited IAM user (never the root login) and root MFA; Oracle is dropped for now and its Terraform stays in the repository as an unused option; the keep-alive service is dropped on AWS unless the build finds that AWS reclaims idle instances. Instance types are limited to the Free Plan eligible list (t3.micro, t3.small, t4g.micro, t4g.small, c7i-flex.large, m7i-flex.large) and are a Terraform variable; the default is performance first for the labs host (the developer asked for lab behaviour without lag): platform host t3.small (2 vCPU, 2 GB) and labs host m7i-flex.large (2 vCPU, 8 GB), both x86 so only amd64 images are needed; the labs host is stopped (not deleted) whenever it is not being tested, to save credits, and started again for the evaluation; each host has an Elastic IP so its address survives stop and start; all host services and Docker start by themselves at boot; sizes are variables and the developer confirms them at plan approval (see Design Notes). The same baseline runs on both hosts: SSH key-only with no root login, only 22 (limited to listed source addresses), 80 and 443 reachable from the internet, other traffic between the hosts only through named ports and security-group references, IMDSv2 required with hop limit 1, no NAT gateway, Docker, secrets directory mode 0700. Network rules stay in one data file read by Terraform and by the policy test. Scripts and docs that are Oracle-specific are renamed to cloud-neutral names. Every AWS fact is read from an AWS page in the build or kept marked unverified (Sydney prices, user_data size limit, whether idle instances are reclaimed, Budgets behaviour with credits, Free Plan limits on instance count and EBS size are unverified today). Real commands and results only.

**Never:** No secret in the repository, a document, a log or chat: no access key, secret key, password, one-time code, UPI detail or AWS account ID (account IDs appear in console addresses; redact them). Claude never runs `terraform apply`, never calls AWS and never asks for credentials. No upgrade to the Paid plan and no AWS Organizations or Control Tower (they upgrade the account). No NAT gateway. No change to application contracts. No DuckDNS, certificates, Vercel or deployment (stories 2.2 to 2.4). No push, no pull request.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Rule data | `network-rules.json` lists public ingress 22, 80, 443 only (22 from listed sources) | policy test passes | — |
| Open port added | any other public ingress, or 22 from everywhere | policy test fails naming the rule | exit 1 |
| Terraform checks | `fmt -check`, `init -lockfile=readonly`, `validate`, `terraform test` with a mocked aws provider | pass without credentials | CI job fails otherwise |
| Wiring | rule direction, SSH source expansion, security-group references, IMDSv2 options, instance type in the eligible list | native tests assert each; a swapped direction or a non-eligible type fails | exit 1 |
| Input checks | SSH source `0.0.0.0/0`, `::/0`, broad prefix, placeholder key, ineligible instance type, user_data above the size limit | refused with a clear message | validation error |
| Public ports | both public addresses probed from outside | 22, 80, 443 as per the rules, every other probed port closed | script fails naming the port |
| SSH | key login; password login attempt | key works; password and root refused | script fails |
| Private link | host to host over private addresses on the proposed ports | TCP and mutual-TLS handshake with throwaway certificates; latency recorded; wrong direction and other ports blocked | named failure; no certificate left |
| Metadata | a container on the labs host asks for the instance metadata | refused (IMDSv2 required, hop limit 1) | recorded in the live check |
| Credits | credits used or low | the budget alert email arrives; the credit balance and days remaining are read from the Billing console | runbook says what to stop |
| Region refused | resource not allowed in the account's region or by the Free Plan | clear runbook step: stay in ap-southeast-2; record the error | story stays open |
| Stop and start | the labs host is stopped, then started a week later | same public address, services and Docker up without manual steps, `verify-hosts` passes again; the rehearsal is a runbook step | a service that needs a manual start is a defect |
| Rebuild | host deleted or plan ended | `terraform apply` rebuilds; the plan end (about 2027-04-11) is written down | runbook section |
| Secret in the tree | access key, account ID or key block committed | the secret scan test fails | exit 1 |

</frozen-after-approval>

## Code Map

- Story 2.1 results (committed `7c54650` and later): `infra/terraform/oci/` (network-rules.json, tests, variables checks), `infra/hosts/` (cloud-init template, baseline, firewall, sshd, docker install and daemon settings, keep-alive), `scripts/oracle-hosts.mjs`, `verify-hosts.mjs`, `private-link-check.mjs`, `check-network-rules.mjs`, `scan-secrets.mjs` and their tests, `docs/runbooks/oracle-*.md`, ADR 0021, `initial.md` D-40, handoffs H-100 to H-103.
- `docs/architecture/02-deployment-and-network.md` (ports, SSH, secrets path, private link on the VPC private address, mTLS port 9443, event relay port proposal 9444), ADR 0007 (two VMs or one), NFR-ISO-06, NFR-CST-01, R-1, R-2, OI-8.
- AWS facts read 2026-10-11 (to re-verify in the build): Free Plan lasts 6 months or until credits run out (USD 100 plus up to USD 100 earned), eligible EC2 types as above, no Organizations or Control Tower, EC2 security testing allowed without approval but hosting an intentionally vulnerable app is neither allowed nor forbidden, abuse reports are forwarded to the customer, Terraform `hashicorp/aws` v6.68.0 on 2026-10-07 (pin `~> 6.68`), public IPv4 USD 0.005 per hour, NAT gateway USD 0.045 per hour, 100 GB per month free outbound data.
- New or changed: `infra/terraform/aws/` (versions, variables, network, compute, budget, outputs, `network-rules.json` moved or shared, tests, `iam-policy.json` for the Terraform user, `terraform.tfvars.example`), cloud-neutral scripts (`cloud-hosts.mjs`, runbook `docs/runbooks/aws-account-and-vms.md`, tos email note adapted to the AWS acceptable use policy), ADR 0022 (supersedes the provider part of ADR 0021), `initial.md` D-41, handoffs updated (H-100 to H-103 wording), CI job `terraform` covering both Terraform folders, `scripts/ci-linux` untouched except where a step name changes.
- Do not touch: other developers' tracker folders, contracts, the instance harness, PRD (the R-2 conflict disappears if no keep-alive is used; leave the PRD for the developer).

## Tasks & Acceptance

**Execution:**
- [ ] `infra/terraform/aws/` -- VPC, internet gateway, public subnet, route table, security groups (rules from `network-rules.json`, `from` and `to` as security-group references), two EC2 instances (Ubuntu 24.04 from the Canonical SSM parameter for the architecture, Free Plan eligible type variable with a validation, 30 GB gp3, IMDSv2 required, hop limit 1, public IPv4), the cloud-init baseline as user_data (size within the limit), zero-spend and credit budget with email, outputs only to a git-ignored file; provider pinned `~> 6.68` and lock file for all platforms
- [ ] `infra/terraform/aws/iam-policy.json` -- least-privilege policy for the Terraform IAM user (EC2, VPC, Budgets, SSM parameter read), written from what the configuration needs
- [ ] host baseline -- keep-alive off by default on AWS (variable), cloud-neutral names, no Oracle wording; rename `oracle-hosts` to `cloud-hosts` with tests and imports updated
- [ ] tests -- `terraform test` with a mocked aws provider (public ingress only 22 from the source list, 80, 443; references and directions; IMDSv2; instance type validation; bad inputs), policy and secret scan tests updated for AWS (access key ids and account IDs), unit tests of scripts unchanged in behaviour
- [ ] `docs/runbooks/aws-account-and-vms.md` -- Part A (developer): root MFA, region Sydney, IAM user and access keys kept locally, AWS CLI, Budgets and Free Plan alerts, never upgrade; Part B apply; Part C verify; Part D credits and cost check (read the credit balance, days left, plan end date); Part E rebuild; Part F owner and routine record; Part G changes, key rotation, teardown, lockout recovery; the acceptable use note for hosting a vulnerable lab (what to tell AWS if asked, the abuse report process)
- [ ] CI job `terraform` -- run for both folders; no credentials
- [ ] records -- `initial.md` D-41 (provider AWS Free Plan Sydney, Terraform, Oracle dropped, keep-alive off, sizing), ADR 0022 with sources read in the build, handoffs rows and S-11 and S-17 notes retargeted, dev-log, CHANGELOG, traceability LE-1, LE-6, LE-8; tick L-08 and mark stories 2.1 and 2.6 done only after the live results are recorded and the developer confirms

**Acceptance Criteria:**
- Given the repository, when the tests and the Terraform checks run, then they pass without credentials, and any rule or instance type outside the allowed set fails a test.
- Given the runbook, when the developer follows Part A and B, then the budget alert, the two hosts and the network exist without any secret entering the repository.
- Given the hosts, when `verify-hosts` and `private-link-check` run, then both are reachable by key-only SSH, only 22, 80 and 443 respond from outside, the private link works with mutual TLS, a container cannot read the instance metadata, and the output is saved as evidence with addresses redacted.
- Given the Billing console, when the credit check is done, then the balance, days left and plan end date are written in the owner record with the alert route.
- Given S-11 and S-17, when the notes are read, then the account limits actually met and the link latency and rules are recorded.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Sizing (to confirm by the developer): the developer wants the labs to run smoothly without lag, so the labs host gets the memory: m7i-flex.large (2 vCPU, 8 GB) holds about six lab instances (the shop container is limited to 512 MB), the platform host t3.small (2 vCPU, 2 GB) runs the API and database. Both are x86, which avoids the Arm build matrix (amd64 images only). Estimated cost in Sydney, to verify against AWS pages: platform host about USD 20, labs host about USD 75 to 80 per month while running, plus about USD 13 for disks and public addresses, so about USD 105 per month with both running 24 hours: the USD 100 credit alone covers about one month, and the extra credit of up to USD 100 earned through AWS activities roughly doubles it. The runbook therefore has a stop and start routine for the labs host (a stopped instance costs only its disk and address) and a plan: run the labs host while building and testing the orchestrator and for the evaluation week, stop it otherwise. If the credits run low the sizes change by one variable (for example t4g.small and t3.small). Online latency stays at Sydney levels (about 150 to 250 ms from India); the laptop fallback (D-35) is the zero-latency demo. Region reasons: Sydney is the only region this account can use; latency from India is higher (about 150 to 250 ms) than Mumbai. IMDSv2 with hop limit 1 keeps containers from reading instance metadata; the hosts carry no instance profile.

## Verification

**Commands:**
- `node --test "scripts/*.test.mjs"` -- expected: all pass
- `terraform fmt -check -recursive infra/terraform`, `terraform init -backend=false -lockfile=readonly`, `terraform validate` and `terraform test` in `infra/terraform/aws` (pinned Docker image) -- expected: pass
- `node scripts/check-network-rules.mjs` and `node scripts/scan-secrets.mjs` -- expected: PASS
- `node scripts/check-contract-rules.mjs --base origin/main` -- expected: unchanged
- Live (developer, after apply): `node scripts/verify-hosts.mjs` and `node scripts/private-link-check.mjs` -- expected: PASS with evidence saved
