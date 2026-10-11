# Runbook: DuckDNS names and certificates (lego on each host, DNS-01)

Story: L-10 (D-49, ADR 0030). The scripts are in `infra/hosts/` (`vulnmart-certs.sh`, `vulnmart-certs.service`, `vulnmart-certs.timer`, `vulnmart-install-lego.sh`, `lego.pin.json`). Claude never runs these steps and never sees a token. Nothing below puts a token, email, public address or account name into a file of the repository: they live only on the host and in your DuckDNS and Let's Encrypt accounts. Where this runbook shows `<...>`, you fill the value at your keyboard.

Everything here is free: DuckDNS, Let's Encrypt, lego (MIT). No port 80 or 443 is needed for the issue (DNS-01 talks only outbound to DuckDNS and Let's Encrypt).

References to the AWS runbook mean `docs/runbooks/aws-account-and-vms.md`, written as "AWS runbook, Part G (change a host file)".

## How it works (short)
- One host, one name, one certificate. The platform host (vm-p) gets `<platform>.duckdns.org`; the labs host (vm-i) gets the wildcard `*.<labs>.duckdns.org` only (DuckDNS keeps one TXT value per name, so the labs name itself is not in the certificate).
- `lego` writes the proof (a TXT record) through the DuckDNS API using a token file read by root only. Let's Encrypt checks it and issues the certificate.
- Files end up in `/opt/vulnmart/certs/live/` (`fullchain.pem` 0644, `privkey.pem` 0600 root). Staging results go in `/opt/vulnmart/certs/staging/` and are never used by Caddy. Stock Caddy (L-12) mounts `live/` read-only.
- A systemd timer runs `vulnmart-certs.sh renew` twice a day (03:00 and 15:00, plus up to one hour random delay, `Persistent=true`: a run missed while the host was stopped happens at the next boot). The script renews when `RENEW_DAYS` (default 30) or fewer days are left, and exits 0 first, without needing a token, when no production certificate exists or it is not due. A failed run leaves a failed unit and the marker `/var/lib/vulnmart/certs-failed` (production problems only; staging problems use `certs-staging-failed`). One run at a time (a lock); the service stops after 30 minutes.
- Settings file `/etc/vulnmart/certs.env` is read as `KEY=value` lines only and never executed. Allowed keys: `CERT_NAME`, `CERT_EMAIL`, `RENEW_DAYS`, `TOKEN_FILE`, `CERT_DIR`, `LEGO_EXTRA_ARGS`. A variable already set in the environment wins.
- `RENEW_DAYS` must stay below half of the certificate lifetime (Let's Encrypt is moving from 90 to 64 and then 45 days: at 45 days a value above 22 would renew every run). Today 30 is right for 90 days; lower it when the lifetime shortens.
- Size note: the cloud-init user data is 15261 bytes gzipped for three developer keys (limit 16384, margin 1123 bytes; measured by `scripts/cloud-hosts.test.mjs`). A host file that grows needs a trim or the plain-text treatment of the other files.

## Part A. Accounts and names (browser, once)
1. Platform name: sign in at duckdns.org with your account, add a subdomain `<platform>`, set its current ip to the **public address of vm-p**. This must be the Elastic IP (it survives stop and start; a replaced host keeps the association when the Elastic IP resource is kept), never an address that changes. Check: `nslookup <platform>.duckdns.org` answers that address.
2. Labs name: sign in with a **different** DuckDNS account (ADR 0003: separate tokens), add a subdomain `<labs>`, current ip = public address (Elastic IP) of vm-i. Check: `nslookup <labs>.duckdns.org`.
3. Copy each account's token from the top of its page. Keep it in your password manager. It goes nowhere else except the token file in Part C.
4. Run the S-16 wildcard check from your own PC (no login, a few DNS lookups): `node scripts/check-duckdns.mjs <labs>.duckdns.org`. Expected: `match: a random label resolves to the same A record as the name`. Run it also for the platform name to confirm the A record points where you set it. If it prints `no match` for the labs name, do not go on with Route 2 for the labs name: tell Tanmay (ADR 0003: fall back to Route 3). Paste the printed line (it contains no address) into `docs/research/s-16-duckdns-wildcard.md`.

## Part B. Put the files on the host
**New host** (built after this change): cloud-init already wrote the five files. The baseline script runs the lego install and enables the timer as its last, optional steps. If one of them failed, the baseline still finishes, `/var/lib/vulnmart/certs-tooling-failed` exists and `verify-hosts` shows a WARN: repeat the commands below. Check on the host: `lego --version` prints v5.5.2; `systemctl is-enabled vulnmart-certs.timer` prints `enabled`.

**Host that already runs** (the current two hosts): use the maintenance procedure (AWS runbook, Part G (change a host file), "push over SSH"). For each host, from your PC:

```
scp infra/hosts/vulnmart-certs.sh infra/hosts/vulnmart-install-lego.sh infra/hosts/vulnmart-certs.service infra/hosts/vulnmart-certs.timer infra/hosts/lego.pin.json ubuntu@<host>:/tmp/
```

then on the host:

```
sudo install -m 0755 /tmp/vulnmart-certs.sh /tmp/vulnmart-install-lego.sh /usr/local/sbin/
sudo install -m 0644 /tmp/vulnmart-certs.service /tmp/vulnmart-certs.timer /etc/systemd/system/
sudo install -d -m 0755 /etc/vulnmart && sudo install -m 0644 /tmp/lego.pin.json /etc/vulnmart/
sudo install -d -m 0700 /opt/vulnmart/certs
sudo /usr/local/sbin/vulnmart-install-lego.sh
sudo systemctl daemon-reload && sudo systemctl enable --now vulnmart-certs.timer
```

Check: `lego --version` prints v5.5.2. The installer refuses (exit 1, "checksum mismatch") if the download differs from the pinned sha256, and installs nothing. Then run `node scripts/verify-hosts.mjs --provider aws`: the drift check lists the five new files (and `vulnmart-egress.sh`, now shipped as plain text) and must show no "differs".

## Part C. Token and settings on each host (by hand, on the host)
Token (typed or pasted at the prompt, not shown, not stored in the shell history). Use the token of the account that owns that host's name (platform account on vm-p, labs account on vm-i):

```
( umask 077; read -rs T; printf %s "$T" | sudo tee /opt/vulnmart/secrets/duckdns.token > /dev/null; unset T )
```

Check: `sudo stat -c '%a %U' /opt/vulnmart/secrets/duckdns.token` prints `600 root`.

Settings file (a name and an email, never the token). On vm-p:

```
sudo install -m 0640 /dev/null /etc/vulnmart/certs.env
sudo tee /etc/vulnmart/certs.env > /dev/null <<'EOF'
CERT_NAME="<platform>.duckdns.org"
CERT_EMAIL="you@example.org"
EOF
```

On vm-i use `CERT_NAME="*.<labs>.duckdns.org"` and your own address instead of the example one. Check: `sudo /usr/local/sbin/vulnmart-certs.sh status` prints `state=none` (no certificate yet). A wrong name is refused with exit 2 and no network call.

## Part D. Staging first (always)
On the host: `sudo /usr/local/sbin/vulnmart-certs.sh issue` (it uses the Let's Encrypt **staging** server; its certificates are not trusted by browsers and do not count against the production limits).
- Check: exit 0, the line `staging certificate for ... written`, the marker `sudo cat /var/lib/vulnmart/certs-staging-ok` (first line is the name), and `sudo ls /opt/vulnmart/certs/staging/` shows `fullchain.pem` and `privkey.pem`.
- If it fails: read the terminal output or `sudo journalctl -u vulnmart-certs.service --no-pager | tail` (the token is never printed). Typical causes: wrong token for that name, name not created in that account, DNS propagation of the TXT record too slow (set `LEGO_EXTRA_ARGS` in `certs.env` after checking `lego --help` for the propagation options of your version; the option names for v5.5.2 were not verified in the build), outbound access blocked. A staging failure leaves `/var/lib/vulnmart/certs-staging-failed` and does not touch a production certificate.
- The production run is refused (exit 1) until staging has succeeded **for the same name**.

## Part E. Production
On the host: `sudo /usr/local/sbin/vulnmart-certs.sh issue --production`.
- It is refused when a production certificate with more than `RENEW_DAYS` days left already exists (a duplicate costs a Let's Encrypt limit); `--force` overrides on purpose.
- Limits to respect (Let's Encrypt): 5 duplicate certificates per week per name set, 50 per registered domain per week (`duckdns.org` is on the Public Suffix List, so each name counts separately). Do not loop this command.
- Check: `sudo /usr/local/sbin/vulnmart-certs.sh status` prints `state=ok`, `days_left=` about 89 or 90 (it may become shorter as Let's Encrypt shortens lifetimes), `production_marker=yes`.
- Look at the issuer: `sudo openssl x509 -in /opt/vulnmart/certs/live/fullchain.pem -noout -issuer -subject -enddate`. Expected: a Let's Encrypt issuer (not "(STAGING)") and a subject or SAN for your name (`*.<labs>.duckdns.org` on vm-i).
- The private key `privkey.pem` is 0600 root. The Caddy container (L-12) mounts the folder read-only and must run as the file owner (root), or L-12 adapts the file mode or ownership there. This is recorded in handoff H-115; nothing here changes the mode.

## Part F. Renewal checks
1. Timer: `systemctl list-timers vulnmart-certs.timer` shows a next run. `systemctl cat vulnmart-certs.timer` shows `Persistent=true`.
2. A manual run when not due must be a no-op: `sudo systemctl start vulnmart-certs.service; systemctl status vulnmart-certs.service --no-pager` ends with `certificate valid for N more days ... nothing to do`.
3. A real renewal, once: temporarily add the line `RENEW_DAYS=100` to `certs.env` and run `sudo systemctl start vulnmart-certs.service`. It renews (this counts as one more certificate: do it once only), the new `enddate` is later, then remove the `RENEW_DAYS` line.
4. Stop-and-start catch-up (the story 1.15 rehearsal): after `vm_i_running = false` and back to `true` (AWS runbook, Part D), `systemctl list-timers` shows the timer ran or is due.
5. `node scripts/verify-hosts.mjs --provider aws` shows `certificate renewal timer enabled` and `certificate has more than 14 days left` for both hosts (no certificate yet is only a warning).

## Part G. Raising the lego version (the pin)
The version and the checksums live in `infra/hosts/lego.pin.json`. To move to a newer release:
1. Read the release page `https://github.com/go-acme/lego/releases` for the new version (note changes to the command line flags used by `vulnmart-certs.sh`).
2. For each of the two Linux files (`lego_<version>_linux_amd64.tar.gz`, `..._linux_arm64.tar.gz`) take the sha256 from the digest field of the GitHub release API (`https://api.github.com/repos/go-acme/lego/releases/tags/<version>`) or from the release's `lego_<version>_checksums.txt`. If you download a file, compute `sha256sum` yourself and compare it with both sources.
3. Edit `lego.pin.json` (one key per line, the installer reads it with `sed`): `version`, `url_prefix`, both file names and both sha256 values.
4. Run `node --test scripts/certs-host.test.mjs scripts/cloud-hosts.test.mjs` (the pin test and the size test).
5. Push the new pin to the hosts as in Part B (the installer replaces lego only when the installed version differs), then run `lego --version`.

The v5.5.2 values in the repository were checked against the GitHub release API digests on 2026-10-11 (the asset names and `digest` fields); they were not computed from a downloaded file.

## Part H. Real results to paste (the story closes only after these)
Paste redacted real output (no addresses, no token) into `docs/assets/duckdns-names-and-certificates/` and the dev-log: the S-16 line, the staging run, the production `status` and issuer lines for both hosts, the renewal check, the verify-hosts lines. Fill `docs/research/s-16-duckdns-wildcard.md`. Then tell Claude so it can close L-10 and update the traceability rows.

## Troubleshooting
- Exit 2 with "refused name": the name must be `<x>.duckdns.org` or `*.<x>.duckdns.org` (one label, lowercase).
- `certs-failed` marker present: fix the cause, then `sudo /usr/local/sbin/vulnmart-certs.sh renew` (or `issue --production --force` if the lego state is missing); a success removes the marker.
- "already running": another run holds the lock; wait for it (the service stops after 30 minutes).
- Token rotated: rewrite the token file as in Part C; nothing else changes.
- Rollback: `sudo systemctl disable --now vulnmart-certs.timer`; remove `/opt/vulnmart/certs`. Names and tokens stay in your DuckDNS accounts.
