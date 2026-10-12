---
title: 'DuckDNS names and certificates (lego on the host, DNS-01)'
type: 'feature'
ticket: '2'
created: '2026-10-11'
status: 'built'
baseline_revision: 'b74cd57c8bff7d78117fd9901a511d0a8c669c9c'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The platform host and the labs instances need real HTTPS certificates (a normal one for the platform name, a wildcard for the labs name), but ports 80 and 443 are closed, no DuckDNS names or certificates exist, and D-28's mechanism (Caddy with a DuckDNS plugin) needs a custom image that belongs to L-12.

**Approach:** A pinned `lego` binary issues and renews both certificates by DNS-01 on each host, driven by a systemd timer that also catches up after a stop; stock Caddy (L-12) only loads the files. Everything is scripted and tested with stubs; the live issuance (staging first) is the developer's numbered steps.

## Boundaries & Constraints

**Always:** Decisions (developer, 2026-10-11: "research and go with the recommended answer", free things only): D1 mechanism amends only the mechanism line of D-28 (record D-49 and ADR 0030); names, wildcard, DNS-01, separate platform and labs names stay. D2 Free only: DuckDNS, Let's Encrypt, lego (MIT); no paid service, no new AWS resource. D3 Labs certificate is the wildcard `*.<labs>.duckdns.org` only (DuckDNS keeps one TXT value per name); the platform certificate is one name; both by DNS-01. D4 Let's Encrypt staging first; production only with `--production` after a staging success marker exists. D5 The token is a root-only file on the host (read by lego as a file), the labs token from a separate DuckDNS account (ADR 0003); never in the repository, chat or logs. D6 Renewal: a systemd timer twice a day, `Persistent=true`, the client decides when to renew (no hardcoded 60 days; Let's Encrypt moves to 64 then 45 days); failure leaves a failed unit and a marker file. D7 lego is installed from a pinned release with a verified sha256; no pip, no snap. D8 Certificates live under a root-only folder on the host for Caddy to mount read-only. D9 Hosts that already run get the files by the maintenance procedure (runbook Part G); new hosts by cloud-init within the 16 KB user-data limit.

**Never:** Claude runs no ssh, terraform or AWS call and never sees a token; no public address, token, email or account name in any file; no production issuance before staging; no change to the Caddy or L-12 scope; no push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Staging issue | token file, valid name, `certs.env` | lego runs against staging, files written, success marker | no error |
| Token missing | no token file | exit 2, message, no network call | exit 2 |
| Bad name | not `*.<x>.duckdns.org` or `<x>.duckdns.org` | refused | exit 2 |
| Not due | certificate valid | no-op, exit 0 | none |
| Renewal fails | lego exits non-zero | failure marker written, unit fails | exit 1 |
| Production early | no staging marker | refused with the reason | exit 1 |
| Checksum mismatch | wrong sha256 | install refused | exit 1 |
| Host was stopped | timer missed | timer is `Persistent=true`: runs at next boot | n/a |
| Wildcard check | developer PC, random label under the labs name | prints match or no match, no address | exit 1 on no match |

</frozen-after-approval>

## Code Map

- `infra/hosts/` (new): `vulnmart-certs.sh` (issue, renew, status), `vulnmart-certs.service`, `vulnmart-certs.timer`, `lego.pin.json` and an installer step; pattern of `vulnmart-egress.sh` and `vulnmart-egress.service`; `infra/hosts/cloud-init.yaml.tftpl` (`write_files`), `infra/terraform/aws/compute.tf` and `oci/compute.tf` (`base64encode(file())`, 16 KB precondition, currently about 10 KB gzipped).
- `scripts/verify-hosts.mjs` `BASELINE_FILES` (drift list) and a certificate check (days left, marker); `scripts/infra-isolation.test.mjs` (stub binaries on PATH, Git bash) as the test pattern; `infra/hosts/vulnmart-baseline.sh:26` creates `/opt/vulnmart/secrets` (0700 root).
- New: `scripts/check-duckdns.mjs` (+ test with an injected resolver) for the S-16 wildcard check; `docs/research/s-16-duckdns-wildcard.md`; ADR 0030; `docs/runbooks/certificates.md`; `initial.md` D-49; `docs/architecture/02-deployment-and-network.md` amendment note; handoff row for L-12 (Caddy loads the files, no plugin build); traceability LE-2 and LE-8.
- Facts verified by research (2026-10-11): `duckdns.org` is on the Public Suffix List; Let's Encrypt limits 50 certificates per registered domain and 5 duplicates per week; DuckDNS API `update?domains=&token=&txt=`; lego provider `duckdns` reads `DUCKDNS_TOKEN_FILE`; lego latest v5.5.2 (asset and checksum names to be read from the release page in the build). Unverified: wildcard resolution, DuckDNS limits, TXT propagation time, lego `renew` flags.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/certs-host.test.mjs`, `infra/hosts/vulnmart-certs.sh` -- issue, renew, status, name and token checks, markers, staging gate (tests first, stub lego) -- the matrix
- [x] `infra/hosts/vulnmart-certs.service`, `.timer`, `lego.pin.json`, installer -- timer twice a day with `Persistent=true`, pinned checksum -- renewal after a stop
- [x] `infra/hosts/cloud-init.yaml.tftpl`, both `compute.tf`, `scripts/verify-hosts.mjs` and tests -- ship the files, drift list, certificate check, size under 16 KB -- host pattern
- [x] `scripts/check-duckdns.mjs` and test -- S-16 check for the developer's PC -- spike S-16
- [x] ADR 0030, `initial.md` D-49, architecture 02 note, `docs/runbooks/certificates.md` (developer steps: accounts, names, token, staging, production, checks), S-16 note template, L-12 handoff, dev-log, CHANGELOG, traceability -- documentation rule

**Acceptance Criteria:**
- Given stubs for lego and the clock, when the scripts run, then every matrix row behaves as written.
- Given the rendered cloud-init, when measured, then the gzip size stays under 16384 bytes and verify-hosts lists the new files.
- Given the runbook, when followed, then each developer step has a check and no step needs a secret in a file of the repository.
- Given the repository, when scanned, then no token, address, email or account name appears.

## Implementation Notes

- 2026-10-11: all five execution tasks built and tested with stubs. Live steps (names, tokens, staging, production, S-16, real renewal) are the developer's and are NOT done: the story stays in-progress and L-10 is not ticked.
- Deviation from the Code Map: the five new cloud-init files are plain text blocks, not base64 (gzip 14802 vs 15661 bytes). Added OPENSSL_BIN and CURL_BIN overrides for tests. Added handoff H-115 and baseline steps certs-dir, lego, certs-timer.
- Review fixes (2026-10-11): markers per mode, production guards (name, duplicate, --force), renew no-ops before the token check, flock and start timeout, settings file read as KEY=value lines, optional non-fatal lego steps, egress script also shipped as plain text (margin now 1123 bytes), runbook and docs notes.
- Unverified: lego v5.5.2 flags against the real binary; pinned sha256 values came from GitHub release data.

## Plan Change Log

## Review Triage Log

Pass 1 (thorough; lenses: blind-hunter, edge-case-hunter, verification-gap, intent-alignment). Intent Alignment: reading A (tooling and runbook, live issuance is the developer's) is implemented; the live surfaces (real lego, DuckDNS, Let's Encrypt, systemd, Caddy reload) are untouched by the changes and the tests, as the plan states. No intent_gap, no bad_plan: no loopback.

| # | Finding (lens) | Verdict | Route | Evidence |
|---|---|---|---|---|
| 1 | initial.md: D-49 inserted above line 1, the title glued to its last line, outside Section 15 (all four) | high | patch (done by the coordinator) | repaired 2026-10-11: title on line 1, D-49 after D-48, diff vs baseline is the three intended lines |
| 2 | One failure marker for staging and production: a staging success hides a production renewal failure, a staging failure marks a good certificate failed (blind, edge) | medium | patch | `do_issue` runs `rm -f certs-failed` after any success; `fail_marker` is mode-blind |
| 3 | `issue --production` has no guard against a valid live certificate or a changed name since staging (edge) | medium | patch | duplicate limit is 5 per week; the staging marker holds no name |
| 4 | `renew` checks name and token before the no-op: a host with no token yet fails twice a day, contradicting the matrix (verification-gap, edge, blind) | medium | patch | `do_renew` calls `check_name; check_token` first |
| 5 | publish moves two files separately, no lock, no start timeout (blind, edge) | medium | patch | flock around issue and renew, `TimeoutStartSec`; the reload belongs to the hook in L-12 |
| 6 | renew without a lego production certificate gives an opaque error (edge) | low | patch | direct check and clear message |
| 7 | `certs.env` is sourced as shell and only CERT_NAME keeps the environment value; an unquoted value runs as a command (blind, edge, verification-gap) | medium | patch | parse `KEY=value` lines like systemd's EnvironmentFile, preserve pre-set variables, quote in the runbook; test the file path |
| 8 | lego download has no timeouts and a failed install stops the whole baseline (blind, edge) | medium | patch | the step sits before time-sync, keepalive and unattended-upgrades; make the lego steps non-fatal and last, with timeouts |
| 9 | Pinned sha256 values were never checked against a download (blind) | low | patch (docs) | the coordinator checked them against the digests of the GitHub release API for v5.5.2: both match; the runbook gets the bump procedure |
| 10 | Cloud-init size test uses three identical keys and its own join, so the 14802 bytes and the 1.5 KB margin are optimistic; no YAML parse test of the plain blocks (blind, edge, verification-gap) | medium | patch | gzip compresses repeats; js-yaml is a devDependency; recompute with distinct keys and compare each block to its source file |
| 11 | Test gaps: certs.env path, LEGO_EXTRA_ARGS, an expired or unreadable certificate, arm64 installer branch (blind, verification-gap) | medium | patch | all tests pass the settings through the environment; installer tests use x86_64 only |
| 12 | verify-hosts: an empty `certs=` answer is reported as "more than 14 days" (verification-gap, edge) | low | patch | an empty value is not undefined |
| 13 | Runbook heredoc is indented and breaks on copy; "Part G" names clash with the AWS runbook (blind) | low | patch (docs) | terminator indented inside a list fence |
| 14 | Stale documents: D-28, ADR 0003, architecture 03; traceability rows for D-28 and D-49; LE-2 row placed after LE-8 (blind) | low | patch (docs) | only a strike-through in architecture 02 changed |
| 15 | Evidence file holds counts only; terraform line has no raw output (blind) | low | patch | CLAUDE.md rule 5 asks for real output |
| 16 | check-duckdns: arguments parsed by position, label not validated, no AAAA, no timeout (blind, edge) | low | patch | direct fixes |
| 17 | installer greps the version as a regex (edge) | low | patch | `grep -qF` |
| 18 | Stale A record after a host replacement; Caddy needs read access to the root-only key; RENEW_DAYS must stay below half the lifetime (blind) | low | patch (docs) | Elastic IPs survive stop and start and replacement keeps the association; notes for the runbook and H-115 |
| 19 | lego v5 flags `renew --days`, `--path`, `--server` unproven (own, implementer) | maybe-false (medium if wrong) | defer | needs the staging run; `--accept-tos`, the flag order and the wildcard file names were confirmed from the lego documentation |
| 20 | Tests find Git bash by a fixed path and skip silently (blind) | low | reject | existing pattern of the host tests; CI runs on Linux where bash exists |
| 21 | D-49 recorded as Proposed (blind) | low | reject | kept Proposed on purpose until the live runs confirm it; the developer's instruction is quoted in the entry |
| 22 | Story record inconsistent (status, unticked documentation box) (blind, edge) | low | patch | box ticked by the coordinator; status is set by the workflow |
## Design Notes

Why lego and not Caddy's plugin: the token stays out of the internet-facing edge container, no custom Caddy image is needed, and issuance works now. The developer-run boxes (like L-08): DuckDNS accounts and names, token on the hosts, staging run, production run, the S-16 result; the story closes only after the real redacted results are pasted.

## Verification

**Commands:**
- `node --test scripts/certs-host.test.mjs scripts/cloud-hosts.test.mjs scripts/infra-isolation.test.mjs` -- expected: all pass
- `node --test "scripts/*.test.mjs"`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass
- Terraform fmt, validate and test on a clean copy (as in story 1.15) -- expected: pass