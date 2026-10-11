# S-11: AWS Free Plan hosts in Sydney (spike record)

Status: **template; the live fields are empty until the developer applies Terraform** (runbook `docs/runbooks/aws-account-and-vms.md` Part B). It replaces `s-11-oracle-shape.md` (Oracle sign-up needs a credit card nobody has; D-41). Do not write addresses, account IDs, keys or e-mail addresses here.

## Question
Can two Free Plan eligible EC2 hosts (platform t3.small, labs m7i-flex.large, both x86, 30 GB gp3) be created in Sydney (`ap-southeast-2`), and what limits does the account meet?

## Read from AWS (2026-10-11, while planning; to re-verify in the build or the live run)
- Free Plan: 6 months or until credits run out; USD 100 credit plus up to USD 100 earned; eligible EC2 types t3.micro, t3.small, t4g.micro, t4g.small, c7i-flex.large, m7i-flex.large; no AWS Organizations or Control Tower.
- Public IPv4 USD 0.005 per hour; NAT gateway USD 0.045 per hour (not used); 100 GB per month free outbound data.
- Unverified: Sydney prices, user data size limit (16 KB assumed), instance count and EBS size limits of the Free Plan, whether AWS reclaims idle instances (keep-alive is off), how Budgets treats credits.

## Fields to fill from the live run
| Field | Value |
|---|---|
| Date of first apply | |
| Errors from AWS (exact text, account IDs removed) | |
| Zone used, and any zone that refused a type | |
| AMI name used (Ubuntu 24.04 amd64, from the Canonical parameter) | |
| Instance types and disk size actually accepted | |
| Credit balance, days left, plan end date (Billing console, numbers only) | |
| Credit used after the first week | |
| Did either budget alert fire, and when | |
| Did AWS stop or reclaim an idle instance (after 1 week) | |
| Stop and start rehearsal: same address, services up, `verify-hosts` result | |
| Reply to any acceptable-use question (date, where kept) | |
| Laptop fallback still valid (yes/no) | |