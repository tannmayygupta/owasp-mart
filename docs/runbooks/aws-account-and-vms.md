# Runbook: AWS Free Plan account, two hosts in Sydney, private link and firewall

Story 2.6 (task L-08, replaces the live phase of story 2.1). Owner of the account: Tanmay (D-41). Claude helps read outputs but never applies Terraform, never calls AWS and never sees secrets.

**Rules for every step:** no access key, secret key, password, one-time code, UPI detail, AWS account ID or public address goes into the repository, a document, a log or a chat message. Account IDs appear in console addresses, in ARNs and in screenshots: redact them. Secrets stay in your password manager and in git-ignored local files (`infra/terraform/aws/terraform.tfvars`, `hosts.local.json`, local state) and in `C:\Users\you\.aws\` (outside the repository). Tick each box only when the check next to it is true. Commands are for **Windows PowerShell** from the repository root unless said otherwise.

**Facts used here.** Read from AWS pages on 2026-10-11 (while planning story 2.6; not re-read in the build, so re-check before relying on them): the Free Plan lasts 6 months or until the credits run out (USD 100, plus up to USD 100 earned through activities); eligible EC2 types are t3.micro, t3.small, t4g.micro, t4g.small, c7i-flex.large and m7i-flex.large (source: the AWS Free Tier EC2 page); AWS Organizations and Control Tower are not available (they upgrade the account); EC2 security testing needs no approval, but hosting an intentionally vulnerable application is neither allowed nor forbidden in the pages read; abuse reports are forwarded to the customer; the Terraform AWS provider `hashicorp/aws` 6.68.0 was current on 2026-10-07 (pinned `~> 6.68`, locked at 6.68.0); public IPv4 costs USD 0.005 per hour; a NAT gateway costs USD 0.045 per hour (not used); 100 GB per month of outbound data is free. **Unverified:** Sydney prices, the 16384-byte user data limit (the configuration refuses larger data), whether AWS reclaims idle instances (assumed not; the keep-alive service is off), how Budgets treats the credits, Free Plan limits on the number of instances and on disk size, console menu names, whether the policy in `iam-policy.json` is complete (the first plan or apply may show a missing action).

## Known gap: on AWS the security groups are the only perimeter

**Network layers (D-43, ADR 0027; written in the repository, NOT applied until you run the plan below).** Two subnets (`subnet-p` for `vm-p`, `subnet-i` for `vm-i`), security groups with an outbound allowlist (no all-outbound rule), network ACLs that deny the VPC range from the labs subnet before any allow to the internet, and host rules on `vm-i` (`vulnmart-egress.sh`, `DOCKER-USER`, a metadata block for non-root). The security groups and ACLs are the **real boundary**. A root or privileged container, or one with host networking, can bypass the host rules; `node scripts/check-lab-compose-rules.mjs` refuses compose files that ask for those rights. Docker publishes container ports through its own NAT and FORWARD rules, which INPUT rules never see, so the host INPUT policy (now DROP, with an allowlist) protects only the host's own ports. Do not publish any container port on either host except what Caddy needs on 80 and 443. **The earlier live results (`verify-hosts` 94 checks, `private-link-check` 22 checks) were measured on the OLD network and must be re-measured after the apply (Part C).**

## Public web ports are closed to the internet by default

`infra/network-rules.json` does not contain `0.0.0.0/0`. Ports 80 and 443 use the token `$public_web_cidrs`; the Terraform variable `public_web_cidrs` defaults to the same list as `ssh_source_cidrs`, so **nothing is open to the internet**. That is intended: nothing listens on 80 and 443 until stories 2.2 to 2.4, and the lab stays closed to outside users until the team decides (PRD R-4). To open the web ports on purpose, set `public_web_cidrs = ["0.0.0.0/0"]` in `terraform.tfvars`, record the decision (ADR) and apply. Port 22 never follows this variable. `verify-hosts` expects 80 and 443 to be reachable **from your address**; from another network they time out until the variable is changed.

## Sizing and cost (to confirm; Sydney prices unverified)

Default sizes (Terraform variable `instance_types`): platform host `vm-p` t3.small (2 vCPU, 2 GB), labs host `vm-i` m7i-flex.large (2 vCPU, 8 GB), both x86, so only amd64 images are needed. Estimate from the plan: about USD 20 (`vm-p`) plus USD 75 to 80 (`vm-i`) plus about USD 13 for two disks and two public addresses, so **about USD 108 to 113 per month** with both running all day. The USD 100 credit alone covers about one month; the extra credit of up to USD 100 roughly doubles that. Therefore the labs host is **stopped** (not deleted) whenever it is not being tested (Part D), and the plan is: run it while building and testing the orchestrator and for the evaluation week. If credits run low, change `instance_types` (for example `vm-i = "t3.small"`) and apply. Latency from India to Sydney is about 150 to 250 ms (plan estimate, to be measured); the laptop fallback (D-35) is the zero-latency demo.

**Budgets are a warning, not a control.** Two budgets e-mail the owner (`vulnmart-zero-spend` and `vulnmart-monthly-use`, alerts at 50, 80 and 100 percent of `monthly_budget_usd`, default USD 60). AWS Budgets lags by up to a day, only sends e-mail and stops nothing, and how it treats the Free Plan credit is unverified. The real protection is the **weekly credit check in the Billing console** (Part D) and stopping `vm-i`.

## Part A. Account (by hand, in the browser; the developer already has the account). Pre-apply gate: do not run Part B until every box below is ticked

- [ ] A1. **Root e-mail is monitored.** The root user's e-mail address is a mailbox you read (AWS sends billing, security and abuse messages there). Check: you received a test message there this week and a second person knows the mailbox exists (not its password).
- [ ] A2. **Alternate contacts.** In the account settings set alternate billing, operations and security contacts (a second person, for example Akshay) so an abuse or billing message is not missed. Check: the three contacts are listed (menu names unverified). Record only names, not addresses, in Part F.
- [ ] A3. **Root multi-factor authentication: strongly recommended.** The developer chose to skip it for now; this is recorded as a risk, not a decision to leave it off. What it protects: the root login can change the plan, close the account, change billing and contacts and create unlimited resources; without a second factor, a leaked or phished root password is the whole account. The Terraform **IAM access key is separate**: it is limited by `iam-policy.json` and does not depend on root MFA, and root is never used by Terraform. Check (when done): the next root sign-in asks for the second factor. Until then use a long unique root password in the password manager and never sign in as root for daily work.
- [ ] A4. Region: switch the console to **Asia Pacific (Sydney), `ap-southeast-2`**. Mumbai is denied for this account. Stay in Sydney for everything. Check: the console shows Sydney.
- [ ] A5. **Never upgrade by accident.** The Free Plan turns into a paid account if you click an upgrade prompt, switch on AWS Organizations or Control Tower, or (unverified) use a service or limit the Free Plan does not cover. Do not click "Upgrade", do not create an organization, read every console banner before accepting it. Check: the account page still shows the Free Plan.
- [ ] A6. Create a limited **IAM user** for Terraform (for example `vulnmart-terraform`), not an administrator. Attach a customer-managed policy with the content of `infra/terraform/aws/iam-policy.json` (EC2 and VPC actions limited to ap-southeast-2, RunInstances limited to the Free Plan eligible instance types, Budgets for `vulnmart-*`, one SSM parameter path). Turn on MFA for this user too if the console offers it. If AWS refuses an action for this user, record the exact error in Part F and add **only** the one missing action (tell the team: the policy is part of the repository).

  **Policy changed on 2026-10-11 (story 1.13): paste the new version into the IAM user policy.** Start, stop, terminate and the two modify actions (`ModifyInstanceAttribute`, `ModifyInstanceMetadataOptions`) are now allowed only on instances tagged `Project=vulnmart` (condition `aws:ResourceTag/Project`), so a leaked key cannot stop or delete an unrelated instance. The policy in the AWS console is a copy: until you paste the new `iam-policy.json` over it (IAM, Policies, the customer-managed policy, Edit, JSON), the old, wider rule stays in force. The tag condition was written from the AWS documentation and has not been run against the account: apply once after pasting and record any `UnauthorizedOperation` in Part F. **Changed again in story 1.15 (D-44, ADR 0027): paste the policy once more.** `ec2:ModifyInstanceAttribute` is removed from every Allow (it cannot be limited by instance type, so a leaked key could resize a stopped instance), an explicit Deny of `ec2:RunInstances` applies to any instance type that is not on the eligible list, network ACL actions are added, and the Terraform state bucket permissions are added (replace `vulnmart-tfstate-REPLACE-WITH-YOUR-BUCKET` in the three S3 statements with your bucket name before pasting; remove the `BootstrapStateBucketOnce_RemoveAfterwards` statement after the bucket exists). **Before the real apply run one `terraform plan` with the new policy.** If a real change needs `ModifyInstanceAttribute` (for example changing `instance_types` of an existing host), add a temporary Allow statement for it on tagged instances, apply, and remove the statement again; tell the team. The weekly credit check (Part D) stays the control for spending.
- [ ] A7. Create an **access key** for that user (use case: command line). Download it once, put it in the password manager, never in the repository, never in chat.
- [ ] A8. Install the AWS CLI (`winget install Amazon.AWSCLI`). Run `aws configure --profile vulnmart` (key, secret, region `ap-southeast-2`, output `json`). They are stored in `C:\Users\you\.aws\`, outside the repository. Check: `aws sts get-caller-identity --profile vulnmart` answers; **do not paste the answer anywhere** (it contains the account ID). Check: `git status` shows nothing new.
- [ ] A9. Billing console: turn on free tier usage alerts and billing alert e-mails to the owner address, and find the **credit balance** page (menu names unverified). Check: you can read the balance and the days left.
- [ ] A10. Collect the **public** SSH keys of Tanmay, Akshay and Sahil (each runs `ssh-keygen -t ed25519` and sends the `.pub` file; private keys are never sent). They go into `ssh_public_keys`.
- [ ] A11. Find your current public address and put it as `x.x.x.x/32` in `ssh_source_cidrs` (add the others' addresses when they need SSH; never `0.0.0.0/0`, Terraform refuses it; at least one IPv4 address is required and each CIDR must be written in canonical form).
- [ ] A12. **If the Free Plan ends** (about 2027-04-11 or when the credits run out): decide before that date, with the team, between (a) moving to the Paid plan deliberately with a budget and a stop routine, (b) running `terraform destroy` (Part G) and using the laptop fallback (D-35), (c) a new account (Part E). Do nothing by default: an account that is left alone may be closed or start billing (unverified which; read the plan page again in the last month).

## Part B. Apply (the developer runs it; PowerShell)

**Terraform state.** Local state is the file `infra\terraform\aws\terraform.tfstate` (and `terraform.tfstate.backup`), git-ignored, never committed. It holds addresses and resource IDs: treat it like a secret. It is a single point of failure: **after every apply copy `terraform.tfstate` and `terraform.tfvars` to a safe private place** (the password manager's secure attachment or an encrypted drive) and test once that the copy restores. A remote backend with locking (an S3 bucket) is prepared (D-45): see "Move the state to S3" below; until you migrate, the local state rules here apply. If the state is lost, use "Find leftovers by tag" in Part G.

Install once (native, preferred): `winget install Hashicorp.Terraform`, then open a new PowerShell and check `terraform version` (the configuration needs 1.9 or newer, below 2.0; CI uses 1.16.5).

- [ ] B1. `cd infra\terraform\aws`, `Copy-Item terraform.tfvars.example terraform.tfvars`, fill it in (`ssh_source_cidrs`, `ssh_public_keys`, `budget_email`; sizes if you change them). Set the profile for this PowerShell window: `$env:AWS_PROFILE = "vulnmart"`.
- [ ] B2. Offline checks first (no AWS calls): `terraform fmt -check -recursive ..`, `terraform init -backend=false -lockfile=readonly`, `terraform validate`, `terraform test`. Check: all pass.
- [ ] B3. `terraform init -lockfile=readonly`, then `terraform plan -out tfplan`. Read it: one VPC, one subnet, one internet gateway, two security groups, two instances (types from `instance_types`, 30 GB gp3, IMDSv2 required), one instance state resource for `vm-i`, two Elastic IPs, two budgets, one key pair, **no NAT gateway**. Do not paste the plan anywhere.
- [ ] B4. **Gate:** every Part A box is ticked. Then `terraform apply tfplan`. Check: no errors. If AWS refuses something (region, Free Plan limits, an instance type not available in the zone, disk size, instance count), **stay in ap-southeast-2**, copy the exact error into `docs/research/s-11-aws-hosts.md` (redact account IDs), then: for a zone problem set `availability_zone` (for example `ap-southeast-2b`), for a size problem lower `instance_types` or `root_volume_gb`. The story stays open until both hosts exist.
- [ ] B5. **Copy the state now:** `terraform.tfstate` and `terraform.tfvars` to the safe private place (see above). Check: the copy opens.
- [ ] B6. Confirm the budget e-mail subscriptions: AWS sends a confirmation or the first alert to `budget_email` (unverified which); check the inbox.
- [ ] B7. Save the addresses (PowerShell 5.1 `>` writes UTF-16, so use this): `terraform output -json | Set-Content -Encoding ascii hosts.local.json` (git-ignored). Check: `git status` does not list it.
- [ ] B8. Wait about 10 minutes for cloud-init (it installs packages and Docker), then go to Part C.

**Alternative: Terraform in Docker** (if you cannot install it). From the repository root, set the image from `ci.yml`, then use `docker run` with the working directory and your AWS profile mounted read-only:

```powershell
$env:TF_IMAGE = (Select-String -Path .github\workflows\ci.yml -Pattern 'TF_IMAGE: (\S+)').Matches[0].Groups[1].Value
docker run --rm -v "${PWD}/infra:/infra" -v "$env:USERPROFILE\.aws:/root/.aws:ro" -e AWS_PROFILE=vulnmart -w /infra/terraform/aws $env:TF_IMAGE plan -out tfplan
```

The mount `${PWD}/infra:/infra` is where `terraform.tfvars`, the lock file and the **state file** live on your PC (`infra\terraform\aws`); the state is written there and must be copied after every apply exactly as above. For `output -json` pipe the docker output to `Set-Content -Encoding ascii infra\terraform\aws\hosts.local.json`.

### Plan and apply the network isolation change (story 1.15, D-43 to D-45)

Nothing below has been run. You run it; read every line of the plan.
1. Paste the new `iam-policy.json` (bucket name filled in; see A6).
2. `cd infra\terraform\aws`, then `terraform init -input=false`, then `terraform plan -out=tfplan`. Expect: `aws_subnet.main`, the route table and its association are **moved** (no change); a new subnet `i`, route table `i`, two network ACLs and their rules are **created**; both groups lose the `all outbound` rule and gain the allowlist rules; **`aws_instance.vm["vm-i"]` is replaced** (new subnet), and with it its Elastic IP association and the `aws_ec2_instance_state`; `vm-p` shows no change (its user data is ignored). The user data is now sent gzip-compressed (`user_data_base64`): no change for the running `vm-p` because both are in `ignore_changes`. Stop and ask the team if the plan wants to replace `vm-p`, delete an Elastic IP, or change anything not listed here.
3. If the plan wants `ModifyInstanceAttribute`, follow the temporary-statement note in A6.
4. `terraform apply tfplan`, wait about 10 minutes for the new `vm-i` to run cloud-init, then run `terraform output -json` into `hosts.local.json` as in Part B (the labs host has a new private address) and **Part C again** (`node scripts/verify-hosts.mjs --identity <key> --provider aws`, it now also runs the isolation probes on the labs host; `node scripts/private-link-check.mjs ...`). Record the new check counts in Part F; the old 94 and 22 no longer apply.
5. Expected live outcomes (to be proven by the run, not yet proven): a bridge container and a non-root host-network container cannot reach 169.254.169.254 (timeout), cannot reach `vm-p:443` (timeout), can reach `vm-p:9444` (open, or refused while nothing listens), and the HOST can still reach `vm-p:9444`. The check prints an information line for a ROOT host-network container reaching metadata: that is the known gap (ADR 0027).
6. Roll back: `git revert` the change and plan again (this recreates the single subnet and moves `vm-i` back), or set `apt_http_egress` as needed; a failed cloud-init on the new `vm-i` shows `/var/lib/vulnmart/baseline-failed` with the step name.

### Move the state to S3 (D-45; run by you, not by the agent)

Prerequisites: Terraform 1.11 or newer (`terraform version`; the repository requires it now), the AWS CLI with a profile that may create the bucket (the policy has a bootstrap statement for it), and a bucket name that is unique in the world.
1. Make the bucket: `sh infra/terraform/aws/bootstrap-state-bucket.sh vulnmart-tfstate-<something-unique>` from Git Bash (or run its four `aws s3api` lines in PowerShell). It creates the bucket in ap-southeast-2 with versioning, SSE-S3 encryption and all public access blocked, and fails if the name is taken. Remove the bootstrap statement from the IAM policy afterwards.
2. Back up the local state first: copy `terraform.tfstate` and `terraform.tfvars` to the safe private place.
3. `cd infra\terraform\aws`, `Copy-Item backend.hcl.example backend.hcl`, put your bucket name in `backend.hcl` (git-ignored), `Copy-Item backend.tf.example backend.tf`.
4. `terraform init -migrate-state -backend-config=backend.hcl` and answer `yes` to copy the existing state. Check: `terraform plan` shows the same plan as before (no changes caused by the move) and the object `vulnmart/aws/terraform.tfstate` exists in the bucket (`aws s3 ls s3://<bucket>/vulnmart/aws/`).
5. Keep the local `terraform.tfstate` as the dated backup until two applies have worked; locking uses a `terraform.tfstate.tflock` object next to the state (native S3 locking, no DynamoDB). Never commit `backend.hcl`.
6. Roll back: delete `backend.tf`, run `terraform init -migrate-state` (Terraform offers to copy the state back to the local file), check `terraform plan`, and restore the local backup copy if anything looks wrong. A stuck lock after a crash: `terraform force-unlock <id>` (the error message shows the id).
The tests and CI use `terraform init -backend=false`, so they do not depend on the bucket.
## Part C. Verify (live)

Both scripts run on your PC; they need `ssh` and Node. `<key>` is the path to your SSH **private** key. `--provider aws` picks the address file in `infra\terraform\aws` (it is never guessed when two address files exist).

- [ ] C1. `node scripts/verify-hosts.mjs --provider aws --identity <key> --evidence docs/assets/l-08-aws-hosts/verify-hosts.txt`. Expected: `RESULT PASS`. It checks key-only login, password and root refused, only 22, 80 and 443 answering from outside (AWS drops a connection to a closed port without answering, so the check starts a bare TCP listener on 80 and 443 for a short time, probes them and stops it; add `--no-temp-listener` once Caddy really listens, and `--require-listener` to insist on it; from a network not in the web list they time out, see "Public web ports" above), the baseline marker, the file hashes (drift), that keep-alive is off, and that **a container cannot read instance metadata**: the probe image (pinned by digest) is pulled in its own step, then the host must read metadata, the container must reach a public site (control) and must be blocked from metadata. A `WARN a reboot is pending` line means installed updates need a reboot (no automatic reboot is configured): reboot that host once in a quiet moment (C6 covers it) and run C1 again. `--skip-metadata` only reruns the rest; `--keepalive` expects the keep-alive service to be active.
- [ ] C2. `node scripts/private-link-check.mjs --provider aws --identity <key> --evidence docs/assets/l-08-aws-hosts/private-link-check.txt`. Expected: `RESULT PASS`, a latency line per direction, "no certificate or key left on the host".
- [ ] C3. Open both evidence files and confirm that no address is visible (labels such as `<vm-p-public>`). Then `node scripts/scan-secrets.mjs` must print PASS.
- [ ] C4. Copy the latency and the limits you met into `docs/research/s-17-private-link.md` and `s-11-aws-hosts.md`, and paste the results into the dev-log section "Live verification".
- [ ] C5. If a check fails, send Claude the redacted output (never the raw output) and fix the cause; do not edit the checks to pass.
- [ ] C6. **Stop and start rehearsal** (short). Cost: a stopped instance bills no compute and the rehearsal runs the host for a few minutes more than normal, so it costs cents (unverified); the disk and the Elastic IP keep billing while stopped as in Part D. Steps: set `vm_i_running = false` in `terraform.tfvars` and `terraform apply`, wait a few minutes, set it back to `true` and `terraform apply`, wait for boot, run C1 again. Check: same public address, no manual step, `RESULT PASS`. A service that needs a manual start is a defect. If C1 showed a pending reboot, reboot `vm-p` once too (`ssh ... sudo reboot`), then C1 again.

## Part D. Credits, cost and the stop and start routine

- [ ] D1. Read the credit balance, the days left and the plan end date in the Billing console. Write them in Part F (numbers only, no account ID). The plan ends about 2027-04-11 (6 months after sign-up, per the plan; check the console).
- [ ] D2. Check that both budgets exist (`vulnmart-zero-spend`, `vulnmart-monthly-use`) and that their alert e-mail arrives. They lag by up to a day and only send e-mail; how the credit counts in Budgets is unverified. The Billing console balance is the number to trust.
- [ ] D3. **Once a week while the hosts run:** read the balance and divide by days left. If it will not last until the end of the evaluation, stop the labs host or lower `instance_types`.
- **What a stop of `vm-i` does.** Set `vm_i_running = false` in `terraform.tfvars` and run `terraform apply` (one line; Terraform keeps its state in step; do not stop it by hand with the AWS CLI, or the next plan will show a difference). The instance stops. Its disk and its Elastic IP stay (and keep costing a little), so the public address does not change. When you set it back to `true` and apply, the host boots and its services and Docker start by themselves. **Lab instances that the orchestrator started on `vm-i` are stopped with the host and are NOT restarted automatically**, because the instance contract sets no restart policy: the orchestrator must recreate them. So stop only when nobody is testing, and plan for the orchestrator to recreate the instances after the start.
- **If credits run out:** stop `vm-i` first (above), then also `vm-p` if needed (it has no variable: use `aws ec2 stop-instances` with the ID from `terraform output -json instance_ids` and expect a plan difference), then decide with the team (new sizes, laptop fallback D-35, teardown in Part G). Never upgrade to the Paid plan to keep running.

## Part E. Rebuild a lost host or a new plan

- [ ] E1. `cd infra\terraform\aws`, `terraform apply`. Terraform recreates a missing instance with the same cloud-init baseline; the Elastic IP is re-associated, so the address normally stays.
- [ ] E2. Save the addresses again (B7), wait 10 minutes, run Part C again, tell Akshay and Sahil if anything changed (addresses only through the team's private channel).
- [ ] E3. When the Free Plan ends, follow A12. To move to a new account, repeat Part A and B in it (the repository is the recipe).
- [ ] E4. If Terraform state is lost, do not guess: use "Find leftovers by tag" in Part G, delete the leftovers or import them, then apply again.

## Part F. Records (fill in; no secrets, no account ID)

| Item | Value |
|---|---|
| Account owner | Tanmay (D-41) |
| Contact route for the other two | (fill in: private channel and shared mailbox, no addresses here) |
| Root e-mail monitored / alternate contacts set | (date; names only) |
| Root MFA | skipped for now (risk accepted); date turned on: |
| IAM user and policy | user name only, policy = `iam-policy.json`, date; errors met and actions added |
| Budget alert e-mail | (fill in: both budgets, date created, first alert received yes/no) |
| Credit balance (USD) / days left / plan end date | (fill in: date read, three numbers) |
| Region and zone | ap-southeast-2, zone used |
| Sizes in use | (fill in: `instance_types` and date) |
| Free Plan limits met | (fill in: instance count, disk size, types, zone; exact messages without account IDs) |
| Idle reclaim by AWS observed | (fill in: yes/no after one week) |
| Public keys installed | Tanmay, Akshay, Sahil (date) |
| State backup | where the copy of `terraform.tfstate` and `terraform.tfvars` lives (location only), date of the last copy |
| Last access key rotation | (date) |
| Last weekly credit check | (date, result) |
| Stop and start rehearsal | (date stopped, date started, `verify-hosts` result) |

## Part G. Maintenance

### Change a host file or add a developer key (two safe ways)
Terraform ignores changes to `user_data`, the AMI and the key pair on a running host, so editing `infra/hosts/*` or `ssh_public_keys` and applying changes nothing on a live host (and never replaces it). Choose one:

1. **Push over SSH (normal case).** Edit the repository file, then on each host copy it into place and run the step again, for example the firewall script: `scp infra/hosts/vulnmart-firewall.sh ubuntu@<host>:/tmp/`, then `sudo install -m 0755 /tmp/vulnmart-firewall.sh /usr/local/sbin/` and `sudo /usr/local/sbin/vulnmart-firewall.sh <subnet cidr>`. **Rerunning `vulnmart-firewall.sh` on a host that already runs Docker is safe for the live rules but does not save them:** the script never flushes a chain and never touches FORWARD or the Docker chains, it adds missing INPUT rules (checked with `-C`) and sets the INPUT policy to DROP last. It skips `netfilter-persistent save` when a `DOCKER` chain exists (saving would write Docker's own rules to disk, and on the next boot they would come back before Docker starts), and prints "NOT saved". So a changed rule survives a reboot only if it was made on first boot or the saved file is repaired by hand; for a new port on a Docker host, rebuild the host or save from a clean state after checking `sudo iptables-save` for `DOCKER` chains. `vulnmart-egress.service` re-applies its own rules at every boot and whenever Docker restarts. Target paths are in `BASELINE_FILES` (`scripts/verify-hosts.mjs`); run `node scripts/verify-hosts.mjs --provider aws` afterwards: the drift check must show no "differs". To add a developer key later: append the **public** key line to `/home/ubuntu/.ssh/authorized_keys` on both hosts, add it to `ssh_public_keys` in `terraform.tfvars` so a rebuild includes it, and test a login. To remove a key, delete the line on both hosts and from `terraform.tfvars`.
2. **Deliberate replacement.** `terraform apply -replace='aws_instance.vm["vm-i"]'` (or `vm-p`). The host is rebuilt from the new startup file; its data is lost. One host at a time, only when the data can be restored.

### The EC2 key pair
The key pair `aws_key_pair.main` is a fallback only (cloud-init installs every developer key). Its name is `vulnmart-` plus a random suffix, it uses the first key of the **sorted** list (so reordering the list changes nothing) and its public key is ignored after creation (adding a developer never recreates it). After a lost state, import it: find its name in the EC2 console (Key Pairs) and run `terraform import aws_key_pair.main <key name>`.

### Kernel and package updates
Unattended upgrades install security updates, but **no automatic reboot is configured**. When updates need a reboot, `verify-hosts` prints a `WARN a reboot is pending` line and the marker file `/var/lib/vulnmart/baseline-ok` records it at first boot. About once a month per host: `sudo apt-get update && sudo apt-get -y upgrade`, then `[ -f /var/run/reboot-required ] && sudo reboot` in a quiet moment (never both hosts at once; lab instances on `vm-i` are lost on reboot), then rerun `verify-hosts`.

### Access key rotation and revocation
Rotate the Terraform user's access key every 90 days and at once if the key file may have been copied: create a second key, update `aws configure --profile vulnmart`, run `terraform plan` to prove it works, deactivate and delete the old key in the console. Record the date in Part F.

### Lockout recovery and a changed home address
- Your home address changed (SSH times out): add the new address to `ssh_source_cidrs` and run `terraform apply` (the AWS API does not depend on SSH). In an emergency edit the SSH rule of the two security groups in the console, then make the Terraform value match so the next apply does not undo it.
- A key is lost or sshd is broken: use EC2 Instance Connect or the serial console from the console (availability for this account is unverified), or replace the host (deliberate replacement above).
- Never open port 22 to `0.0.0.0/0` to recover; Terraform refuses it.

### Find leftovers by tag (lost state, failed apply, or before closing the account)
Every resource Terraform creates carries the tag `Project=vulnmart` (provider default tags; the root disks carry it through `volume_tags`). List what exists, in Sydney only; empty lists mean nothing is left:

```powershell
$r = "ap-southeast-2"
aws ec2 describe-instances --region $r --profile vulnmart --filters "Name=tag:Project,Values=vulnmart" --query "Reservations[].Instances[].[InstanceId,State.Name,InstanceType]" --output table
aws ec2 describe-volumes --region $r --profile vulnmart --filters "Name=tag:Project,Values=vulnmart" --query "Volumes[].[VolumeId,Size,State]" --output table
aws ec2 describe-addresses --region $r --profile vulnmart --filters "Name=tag:Project,Values=vulnmart" --query "Addresses[].[AllocationId,AssociationId]" --output table
aws ec2 describe-vpcs --region $r --profile vulnmart --filters "Name=tag:Project,Values=vulnmart" --query "Vpcs[].VpcId" --output table
aws ec2 describe-key-pairs --region $r --profile vulnmart --query "KeyPairs[?starts_with(KeyName, 'vulnmart-')].KeyName" --output table
```

Elastic IPs that are not associated cost money: release them (`aws ec2 release-address --allocation-id <id>`). Delete in this order: instances (terminate, then their volumes disappear), Elastic IPs, security group rules and groups, subnet, route table, internet gateway, VPC. The budgets are listed in the Billing console (the CLI needs the account ID: do not paste it). Do not paste the IDs into chat; they are not secret but they belong to the account.

### Teardown
`terraform destroy` (in `infra\terraform\aws`) removes both hosts, Elastic IPs (released, so they stop costing), the network and both budgets. Then run "Find leftovers by tag" and check that every list is empty. The IAM user and its keys are not managed by Terraform: delete them by hand when the account is closed.

## Part H. Acceptable use: hosting a deliberately vulnerable lab

What the pages read on 2026-10-11 say (unverified in detail): EC2 security testing of your own resources needs no approval; hosting an intentionally vulnerable application is neither expressly allowed nor forbidden; AWS forwards abuse reports to the account owner.

- **What to tell AWS if they ask:** VulnMart is a college project, an intentionally vulnerable, flag-based shop for security training and skills assessment (OWASP Top 10). Each user attacks only their own isolated instance on one host (`vm-i`); the platform (accounts, scoring, database) runs on a separate host; all shop data is fake; no real payment data; attacks against other systems are against the rules. Some planted weaknesses (for example server-side request forgery) make the shop send requests, so the activity can look like an attack from that host. No instance profile or AWS credential exists on the hosts, and instance metadata is closed to containers.
- **Optional prevention:** the terms-of-service note for Oracle (`docs/runbooks/oracle-tos-email.md`) can be adapted and sent through AWS Support; nothing has been asked of AWS yet, so record "not asked" or the reply date in Part F. Silence is not permission (PRD R-4): keep the lab closed to outside users until the team decides (the web ports are closed by default, see above).
- **If an abuse report arrives** (e-mail to the root and alternate contacts): answer within the time stated in the message, say what the host is (above), say what you did (stop `vm-i` first with `vm_i_running = false`, then investigate), keep the messages, tell the team the same day, and record the date in Part F. Do not delete evidence. If AWS suspends the account, use the laptop fallback (D-35) and decide next steps with the team.
