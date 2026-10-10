# Runbook: Oracle account, two VMs, private link and firewall

Story 2.1 (task L-08). Owner of the account: Tanmay (D-40). Claude helps read outputs but never applies Terraform and never sees secrets.

**Rules for every step:** no OCID, key, password, card detail or public address goes into the repository, a document, a log or a chat message. They stay in your password manager and in git-ignored local files (`infra/terraform/oci/terraform.tfvars`, `hosts.local.json`, local state). Tick each box only when the check next to it is true.

Oracle facts used here were read on 2026-10-10 from Oracle's "Always Free Resources" page (docs.oracle.com, FreeTier): Arm A1 allowance is 1,500 OCPU hours and 9,000 GB hours a month (2 OCPUs and 12 GB for an Always Free tenancy, one or two A1 instances); 200 GB block storage for boot and block volumes together; an instance is idle if over 7 days CPU p95, network and (A1 only) memory are all under 20 percent; Always Free compute and block volumes must be in the home region. **Unverified:** whether Pay As You Go prevents idle reclaim, home region permanence, public IP counts on A1, default security list contents (this setup replaces it anyway), console menu wording below.

## Known gap: the host firewall does not filter Docker-published ports

The cloud network groups are the real filter for what reaches a VM. The host firewall written by `vulnmart-firewall.sh` is a second layer on the **INPUT** chain only. Docker publishes container ports through its own NAT and **FORWARD** rules, so a container port published with `-p` or `ports:` is **not** blocked by the INPUT rules on the host. Until the NSG rules say otherwise, the network groups alone protect published container ports, and nothing stops a container from reaching the VCN private address range or `169.254.169.254` (the instance metadata address). This setup does **not** fix that. It is handed to L-15 and L-29 (handoff H-103): a `DOCKER-USER` policy, blocking containers from the VCN range and the metadata address, egress control for VM-I, one subnet for both VMs and NFR-ISO-06. Do not publish any container port on either host before that is done, except what Caddy needs on 80 and 443.

## Part A. Account (by hand, in the browser)

- [ ] A1. Prepare: a password manager entry for the Oracle account, an authenticator app for MFA, the owner's e-mail, a card for identity verification.
- [ ] A2. Sign up for an **Always Free** account. Choose home region **India South (Mumbai)**. The home region cannot be changed later (unverified: check Oracle's page before you confirm). Check: the console shows the region name.
- [ ] A3. **Do not upgrade to Pay As You Go.** Check: the account page shows Always Free, no paid plan.
- [ ] A4. Turn on multi-factor authentication for your user. Check: the next sign-in asks for the second factor.
- [ ] A5. Create a **budget** (Billing and cost management, Budgets) with a small monthly amount (for example 1 in your currency) and an **alert rule** at 1 percent of actual spend that e-mails you. Check: the budget and its alert are listed. Menu names unverified.
- [ ] A6. Create an **API key** for Terraform: your user, API keys, add API key, generate. Download the private key to a folder **outside the repository** (for example `C:\Users\you\.oci\`). Copy the configuration preview values (tenancy, user, fingerprint, region) into `terraform.tfvars`. Check: `git status` shows nothing new under the repository.
- [ ] A7. Note the compartment: the tenancy root is acceptable for a first run; copy its OCID into `terraform.tfvars` as `compartment_ocid`.
- [ ] A8. Collect the **public** SSH keys of Tanmay, Akshay and Sahil (they each run `ssh-keygen -t ed25519`, send the `.pub` file). Put them in `ssh_public_keys`. Private keys are never sent.
- [ ] A9. Find your own current public address and put it as `x.x.x.x/32` in `ssh_source_cidrs` (add the others' addresses when they need SSH; never `0.0.0.0/0`, Terraform refuses it).
- [ ] A10. Send the terms-of-service e-mail (`docs/runbooks/oracle-tos-email.md`) and keep the reply in the shared mailbox or password manager. Check: record the date sent and the date of the reply in Part F.

## Part B. Apply (developer runs it)

Terraform is run by you; use the pinned Docker image if it is not installed (see the repository CI job `terraform` for the exact image).

**Terraform state.** Local state is the file `terraform.tfstate` in `infra/terraform/oci/` (git-ignored, never committed). It holds addresses and resource ids, so treat it like a secret. It is a single point of failure: after every apply copy it (and `terraform.tfvars`) into the password manager's secure attachments or an encrypted backup, and test once that the copy restores. A remote backend with locking (for example an Oracle Object Storage bucket) is the better long-term option; it is not set up here (deferred).

- [ ] B1. `cd infra/terraform/oci`, copy `terraform.tfvars.example` to `terraform.tfvars`, fill it in (Part A values, `alarm_email`).
- [ ] B2. Check offline first (no credentials): `terraform fmt -check -recursive`, `terraform init -backend=false -lockfile=readonly`, `terraform validate` and `terraform test` (the native tests of the network rules use a mocked provider). With Docker, use the image pinned in `.github/workflows/ci.yml` (`TF_IMAGE`), for example `docker run --rm -v "$PWD/infra:/infra" -w /infra/terraform/oci <image> test`. Check: all pass.
- [ ] B3. `terraform plan -out tfplan`. Read it: two instances (`VM.Standard.A1.Flex`, 1 OCPU, 6 GB, 50 GB boot), one VCN, no ingress other than the NSG rules from `network-rules.json`. Plan output may show sensitive values hidden; do not paste it anywhere.
- [ ] B4. `terraform apply tfplan`. Check: apply finishes without errors.
- [ ] B5. If you get **"out of host capacity"** (Oracle's page says this is a temporary lack of Always Free shapes in the home region): retry later, then set `availability_domain_index` to the next domain and apply again. Record every attempt (date, domain, result) in `docs/research/s-11-oracle-shape.md`. If no domain works for days, the laptop fallback stays valid; the story stays open.
- [ ] B6. `terraform output -json > hosts.local.json` (git-ignored). Check: `git status` does not list it.
- [ ] B7. Wait about 10 minutes for cloud-init (it installs packages and Docker), then go to Part C.

## Part C. Verify (live)

Both scripts run on your PC; they need `ssh` and Node. The identity is the path to your SSH private key.

- [ ] C1. `node scripts/verify-hosts.mjs --identity <path-to-your-private-key> --evidence docs/assets/l-08-oracle-hosts/verify-hosts.txt`. Expected: `RESULT PASS`. Ports 80 and 443 show "refused by the host: no listener yet" until Caddy exists (story 2.2); that is accepted (use `--require-listener` later).
- [ ] C2. `node scripts/private-link-check.mjs --identity <path-to-your-private-key> --evidence docs/assets/l-08-oracle-hosts/private-link-check.txt`. Expected: `RESULT PASS`, a latency line per direction, and "no certificate or key left on the host" for both hosts.
- [ ] C2b. Drift check. `verify-hosts` compares the sha256 of the seven baseline files on each host (`BASELINE_FILES` in `scripts/verify-hosts.mjs`) with the files in this repository, because Terraform ignores later changes to the startup file and the key list (a running VM is never replaced for them). A line "differs (drift)" means the host runs older or edited files: use "Change a host file" in Part G. The check also needs `baseline marker says ok` (the baseline script writes `/var/lib/vulnmart/baseline-ok`, or `baseline-failed` naming the failing step) and `cloud-init finished`.
- [ ] C3. Open the two evidence files and confirm that no address is visible (they show labels such as `<vm-p-public>`). Then `node scripts/scan-secrets.mjs` must print PASS.
- [ ] C4. Copy the latency and the capacity result into `docs/research/s-17-private-link.md` and `s-11-oracle-shape.md`, and paste the results into the dev-log section "Live verification".
- [ ] C5. If a check fails, send Claude the redacted output (never the raw output) and fix the cause; do not edit the checks to pass.

## Part D. Keep-alive and alarm

Why: Oracle may reclaim a VM idle for 7 days. The service `vulnmart-keepalive` holds about 1.5 GB of memory (25 percent of 6 GB) so that one of the three idle measures stays above 20 percent. Limits are set in the systemd unit (memory max 2 GB, CPU quota 50 percent, lowest priority, first to be killed).

- [ ] D1. On each host: `systemctl is-active vulnmart-keepalive` prints `active` (also checked by `verify-hosts`).
- [ ] D2. In the console, Monitoring: check that the metric `MemoryUtilization` (namespace `oci_computeagent`) appears for each VM and shows about 25 percent or more. If it does not, the monitoring plugin is not running yet; wait or enable "Compute Instance Monitoring" in the instance's Oracle Cloud Agent tab.
- [ ] D3. Confirm the e-mail subscription: the alarm topic sent a confirmation mail to `alarm_email`; click the link. Until you do, no alarm mail arrives.
- [ ] D4. Alarm test: stop the service on one host (`sudo systemctl stop vulnmart-keepalive`), wait for the alarm to fire (about an hour), check the mail arrives, then start the service again. There are two alarms per VM: `<vm>-memory-low` and `<vm>-metric-missing` (no metric for 10 minutes: VM down or monitoring stopped; test it by stopping the monitoring plugin or the VM briefly). Both queries are unverified until these tests pass.
- [ ] D5. Fallback if memory does not count as expected: edit `KEEPALIVE_CPU_PERCENT` in the unit (maximum 40, a share of one core) and restart. Confirm against OCI metrics after one week (record in Part F).

## Part E. Rebuild a lost or reclaimed host

- [ ] E1. `cd infra/terraform/oci`, `terraform apply`. Terraform recreates a missing instance with the same cloud-init baseline; the public address may change.
- [ ] E2. `terraform output -json > hosts.local.json`, wait 10 minutes, run Part C again, then tell Akshay and Sahil the host changed (addresses only through the team's private channel).
- [ ] E3. If Terraform state is lost, import is not documented here; recreate the VMs and update this runbook with what you did.

## Part F. Records (fill in; no secrets)

| Item | Value |
|---|---|
| Account owner | Tanmay (D-40) |
| Contact route for the other two | (fill in: private channel and shared mailbox, no addresses here) |
| Budget alert | (fill in: amount, threshold, date created) |
| Idle alarm | (fill in: date confirmed in D4) |
| Keep-alive routine | `vulnmart-keepalive` on both hosts; checked weekly against OCI metrics (fill in dates) |
| Terms-of-service e-mail | sent: (date) reply: (date, where kept) |
| API key location | password manager entry name (not the key) |
| Public keys installed | Tanmay, Akshay, Sahil (date) |
| Next review of idle metrics | (date, one week after apply) |
| State backup | where the encrypted copy of `terraform.tfstate` and `terraform.tfvars` lives (location only) |
| Last API key rotation | (date) |
| Last monthly cost check | (date, result) |

## Part G. Maintenance

### Change a host file or add a developer key (two safe ways)
Terraform ignores changes to `user_data` and `ssh_authorized_keys` on a running VM, so editing `infra/hosts/*` or `ssh_public_keys` and applying changes nothing on a live host (and never replaces it). Choose one:

1. **Push over SSH (normal case).** Edit the repository file, then on each host copy it into place and run the step again, for example for the firewall script: `scp infra/hosts/vulnmart-firewall.sh ubuntu@<host>:/tmp/`, then `sudo install -m 0755 /tmp/vulnmart-firewall.sh /usr/local/sbin/` and `sudo /usr/local/sbin/vulnmart-firewall.sh <subnet cidr>`. The target paths are listed in `BASELINE_FILES` (`scripts/verify-hosts.mjs`). Run `node scripts/verify-hosts.mjs` afterwards: the drift check must show no "differs". To add a developer key later: append the **public** key line to `/home/ubuntu/.ssh/authorized_keys` on both hosts (`sudo -u ubuntu tee -a`), add the same line to `ssh_public_keys` in your local `terraform.tfvars` so a rebuild includes it, and test a login from the new developer's machine. To remove a key, delete the line on both hosts and from `terraform.tfvars`.
2. **Deliberate replacement.** For a change that must be in the first boot, run `terraform apply -replace='oci_core_instance.vm["vm-i"]'` (or `vm-p`). The VM is rebuilt from the new startup file; its data is lost and its public address may change. Do this one VM at a time and only when the data can be restored.

### Kernel and package updates
Unattended upgrades install security updates, but **no automatic reboot is configured**. A new kernel is used only after a reboot. About once a month, per host: `sudo apt-get update && sudo apt-get -y upgrade`, then `[ -f /var/run/reboot-required ] && sudo reboot` in a quiet moment (never both hosts at once; instances on VM-I are lost on reboot), then rerun `verify-hosts`.

### API key rotation and revocation
Rotate the Terraform API key every 90 days, and at once if the private key file may have been copied. In the console: your user, API keys, add a new key, put the new fingerprint and key path in `terraform.tfvars`, run `terraform plan` to prove it works, then delete the old key in the console. Keep the private key outside the repository; revoke by deleting the key in the console. Record the date in Part F.

### Monthly cost check
Once a month: Billing and cost management, cost analysis, expect zero; check the budget alert still exists and the alarm e-mail subscription is confirmed. Record the result in Part F. Console menu names are unverified.

### Lockout recovery and a changed home address
- Your home address changed (SSH times out): add the new address to `ssh_source_cidrs` in `terraform.tfvars` and run `terraform apply` from a machine that can still reach the Oracle API (the API does not depend on SSH). In an emergency edit the `nsg-vm-p` and `nsg-vm-i` SSH rule source in the console, then make the Terraform value match so the next apply does not undo it.
- A key is lost or sshd is broken: use the console's instance console connection (serial console; menu name unverified) with a temporary password-less recovery as described in Oracle's documentation, or recreate the VM (Part E).
- Never open port 22 to `0.0.0.0/0` to recover; Terraform refuses it.

### Teardown
`terraform destroy` (in `infra/terraform/oci`) removes both VMs, the network and the alarms. Check in the console that nothing is left (compute, boot volumes, VCN, topics). The budget and the API key are not managed by Terraform: delete them by hand if the account is being closed.
