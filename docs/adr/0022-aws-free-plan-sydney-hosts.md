# 0022. Hosts on the AWS Free Plan in Sydney (supersedes the provider part of ADR 0021)

- **Status:** Accepted for the provider, region, tooling and sizing (confirmed by the developer on 2026-10-11 as decision D-41); Proposed for the private ports 9443 and 9444, the instance sizes (a variable, to be revisited when the credit balance is known) and the host isolation. Nothing has been applied yet.
- **Date:** 2026-10-11
- **Deciders:** Tanmay
- **Requirements:** LE-1, LE-6, LE-8, NFR-AVL-01, NFR-CST-01, NFR-ISO-06, R-1, R-2, R-4, OI-8, S-11, S-17, D-34, D-40, D-41, ADR 0007, ADR 0021

## Context
ADR 0021 chose Oracle Always Free in Mumbai. The live phase cannot start: the Oracle sign-up needs a credit card that no developer has, and Azure for Students rejected the college domain. The developer's new AWS Free Plan account works (USD 100 credit, 182 days left, UPI AutoPay) but only the Sydney region (`ap-southeast-2`) is usable; Mumbai is denied for the account.

## Options considered
1. **Oracle Always Free** - blocked by the card requirement (no change possible by us).
2. **Azure for Students** - the college domain was rejected.
3. **AWS Free Plan in Sydney (chosen)** - works now; costs credits, not free forever; higher latency from India.
4. **Laptop only (D-35)** - stays as the fallback and the zero-latency demo; not a public host.
- Sizing: Arm t4g (cheap, needs an arm64 build matrix) versus x86 (t3, m7i-flex; amd64 images only). **x86 chosen**; the labs host gets the memory (m7i-flex.large, 8 GB, about six lab instances), the platform host t3.small (2 GB). Sizes are one variable and can drop to t3.small or t4g.small if credits run low.
- Keep-alive: the load service of ADR 0021 stays in the repository but is **off by default** (variable); AWS is assumed not to reclaim idle instances (unverified), and the PRD R-2 conflict disappears while it is off.

## Decision
- Account owner Tanmay; Terraform from the developer's PC with a limited IAM user (`infra/terraform/aws/iam-policy.json`, EC2 and VPC actions limited to Sydney, Budgets for `vulnmart-*`, one SSM path); the root login has MFA and is never used for daily work; never the Paid plan, never Organizations or Control Tower.
- `infra/terraform/aws/`: VPC, internet gateway, one public subnet, route table, an emptied default security group, one security group per host, two instances (Ubuntu 24.04 from the Canonical SSM parameter, per architecture; Free Plan eligible type per host, validated; 30 GB encrypted gp3; IMDSv2 required with hop limit 1; no instance profile; public address from an Elastic IP), one key pair, a zero-spend budget and a monthly-use budget (alerts at 50, 80 and 100 percent of a configurable limit, default USD 60) by e-mail, and `aws_ec2_instance_state` so that stopping the labs host is the one-line variable `vm_i_running`. Every resource carries the tag `Project=vulnmart`. **No NAT gateway.**
- Ports 80 and 443 use the rule-file token `$public_web_cidrs` (variable `public_web_cidrs`, default the same list as `ssh_source_cidrs`): nothing is open to the internet until the team opens it on purpose (nothing listens before stories 2.2 to 2.4; PRD R-4). `0.0.0.0/0` is never written into the rule file.
- The IAM policy limits `ec2:RunInstances` to the Free Plan eligible instance types (condition `ec2:InstanceType`) and to Sydney, so a leaked key cannot start a large instance.
- One rule file `infra/network-rules.json` read by both Terraform folders and by `scripts/check-network-rules.mjs` (moved from `infra/terraform/oci/`). Private rules are security-group references on the receiving side; public 22 only from `ssh_source_cidrs`.
- Hosts stay up from the same cloud-init baseline; the baseline script takes a keep-alive flag; the time server is the Amazon Time Sync address. The labs host is stopped, not deleted, when idle (credit saving); Elastic IPs keep the address.
- Checks: `terraform test` with a mocked provider (19 runs), policy and static tests, `verify-hosts` (now also: x86_64 or aarch64, keep-alive as configured, a container cannot read instance metadata while the host can) and `private-link-check`. CI job `terraform` runs fmt, init (locked), validate and test for `aws` and `oci`.
- `infra/terraform/oci/`, its runbook and ADR 0021 stay as an unused option; ADR 0021 is superseded for provider, region, shape, keep-alive and alarm.

## Consequences
- Easier: the hosts exist without a card the team lacks; a rebuild is one apply; the same baseline and checks; the instance metadata gap for containers is closed on AWS.
- Harder: money. About USD 108 to 113 per month with both hosts running all day (20 + 75 to 80 + 13; estimate, unverified) against USD 100 credit plus up to USD 100 earned; the labs host must be stopped when idle; the plan ends about 2027-04-11; latency from India to Sydney is about 150 to 250 ms (estimate).
- **Budgets are a warning, not a control:** AWS Budgets lags by up to a day, only e-mails, and its treatment of the credit is unverified. The real protection is the weekly credit check in the Billing console and stopping the labs host.
- Known gaps: handoff H-103 (Docker-published ports bypass the host firewall; containers can reach the VPC range; egress control, one subnet) stays open for L-15 and L-29. **On AWS the security groups are the only perimeter:** the host firewall rules are ACCEPT rules on an INPUT chain whose policy is ACCEPT, so they filter nothing and are a placeholder for a later default-drop policy; the IAM policy is written from the configuration and may miss an action the first apply shows.
- Images must be amd64 (handoffs H-100 and H-102 updated for Akshay and Sahil).
- Acceptable use of a deliberately vulnerable lab on AWS is not settled by the pages read (neither allowed nor forbidden); the runbook Part H says what to tell AWS if asked and how to answer an abuse report.

## Evidence
Read on 2026-10-11 while planning story 2.6 (AWS pages; not re-read in the build, so they stay marked for re-check in the runbook): Free Plan duration and credit, eligible EC2 types, no Organizations or Control Tower, EC2 security testing policy, abuse-report forwarding, public IPv4 and NAT gateway prices, free outbound data.
Real in the build (2026-10-11): `terraform init` in the pinned Terraform 1.16.5 image resolved `hashicorp/aws` 6.68.0 under the constraint `~> 6.68` and `terraform providers lock` wrote hashes for five platforms; `terraform validate` accepted the configuration including the `insecure_value` attribute of the SSM parameter data source; `terraform test` 19 of 19 and a deliberate swap of a rule direction made it fail.
Unverified: Sydney prices, the 16 KB user data limit, idle reclaim by AWS, Budgets treatment of credits, Free Plan limits on instance count and disk size, console menu names, completeness of the IAM policy.
