# DuckDNS names and certificates (lego on the host, DNS-01)

| Field | Value |
|---|---|
| Date | 2026-10-11 |
| Developer | tannmayygupta |
| Branch / commit | sprint-2-tanmay / not committed yet (baseline b74cd57) |
| Status | Partly done: scripts, tests, docs done; live issuance, S-16 result and real renewal are the developer's steps and not done |
| Report tag | Environments and deployment, certificates |

## Requirements covered
LE-2, LE-8 (spike S-16, template and check script only), D-28 (mechanism line amended), D-49 (new), ADR 0003, ADR 0030, story L-10, handoff H-115 (new, for L-12).

## Summary (plain language, 3-5 lines)
Each host now has a small script that gets a Let's Encrypt certificate with `lego` using the DuckDNS TXT record (DNS-01), and a timer that checks twice a day whether it needs renewing. Staging is always tried first; production is refused until staging succeeded. Caddy (L-12) only loads the finished files. Everything is tested with stand-in programs; no real name, token or certificate exists yet.

## Why
D-28 wants a normal certificate for the platform name and a wildcard for the labs name. Its mechanism (a Caddy plugin) needs a custom Caddy image that belongs to L-12 and puts the DuckDNS token in the public edge container. A host-side client works now and keeps the token in a root-only file.

## What was built
- `infra/hosts/vulnmart-certs.sh` (issue, renew, status, name and token checks, markers, staging gate), `vulnmart-certs.service`, `vulnmart-certs.timer`, `vulnmart-install-lego.sh`, `lego.pin.json`.
- Baseline steps `certs-dir`, `lego`, `certs-timer`; cloud-init `write_files` for the five files; both `compute.tf`; drift list and certificate check in `scripts/verify-hosts.mjs`.
- `scripts/check-duckdns.mjs` (S-16 wildcard check, prints match or no match, never an address).
- Runbook `docs/runbooks/certificates.md` (developer steps with a check each), `docs/research/s-16-duckdns-wildcard.md` (template).

## How it works
`issue` (staging) -> files in `/opt/vulnmart/certs/staging`, marker `certs-staging-ok`. `issue --production` (needs that marker) -> `/opt/vulnmart/certs/live`, marker `certs-ok`. `renew` (timer) does nothing without a production certificate or when more than 30 days are left; otherwise `lego renew`. A lego failure writes `certs-failed` and exits 1, so the unit shows failed. The token is passed to lego only as `DUCKDNS_TOKEN_FILE`.

## Files changed
- New: `infra/hosts/vulnmart-certs.sh`, `vulnmart-certs.service`, `vulnmart-certs.timer`, `vulnmart-install-lego.sh`, `lego.pin.json`; `scripts/certs-host.test.mjs`, `scripts/check-duckdns.mjs`, `scripts/check-duckdns.test.mjs`; `docs/runbooks/certificates.md`; `docs/research/s-16-duckdns-wildcard.md`; `docs/adr/0030-certificates-by-lego-on-the-host-dns-01.md`; `docs/assets/duckdns-names-and-certificates/test-output.txt`.
- Changed: `infra/hosts/vulnmart-baseline.sh`, `infra/hosts/cloud-init.yaml.tftpl`, `infra/terraform/aws/compute.tf`, `infra/terraform/oci/compute.tf`, `scripts/verify-hosts.mjs`, `scripts/cloud-hosts.test.mjs`, `scripts/check-network-rules.test.mjs` (step list), `initial.md` (D-49), `docs/architecture/02-deployment-and-network.md` (S-16 row amended), `docs/adr/README.md`, `docs/dev/HANDOFFS.md` (H-115), `docs/traceability.md` (LE-2 new, LE-8), `CHANGELOG.md`.

## Decisions made
ADR 0030 and D-49 (Proposed, on the developer's delegation). Alternatives: Caddy plugin (needs custom image, token in edge container), certbot (pip or snap), paid services (rejected).

## Tests
Real commands and results are in `docs/assets/duckdns-names-and-certificates/test-output.txt`: the new and affected test files (certs-host, cloud-hosts, infra-isolation, check-duckdns) all pass; the whole `scripts/*.test.mjs` suite, `check-text-files.mjs` and `scan-secrets.mjs` pass; `terraform fmt -check`, `validate` and `test` on a clean copy of `infra/` pass (aws 37, oci 10). Rendered cloud-init: 15261 bytes gzipped (limit 16384), plain-text blocks checked byte for byte against the repository files with a YAML parser. Rows updated: LE-2, LE-8 in `docs/traceability.md`.
NOT run: lego itself, DuckDNS, Let's Encrypt, any host.

## Evidence
`docs/assets/duckdns-names-and-certificates/test-output.txt`.

## Problems met and how they were fixed
- Review fixes (coordinator review, same day): (1) one `certs-failed` marker for both modes let a staging success hide a production renewal failure: now `certs-failed` is production only and `certs-staging-failed` staging only, each cleared only by its own success, `status` ignores staging; (2) `issue --production` had no guard: the staging marker now stores CERT_NAME and production is refused for another name, and refused when a production certificate with more than RENEW_DAYS days left exists unless `--force`; (3) `renew` checked the token before its no-op branches, so the timer failed on an unconfigured host: it now exits 0 first when there is no production certificate or it is not due; (4) lock (flock, "already running") and `TimeoutStartSec=30min`; (5) a missing lego state file for renew is a clear failure with the marker; (6) `certs.env` is read as KEY=value lines only (never executed, environment wins, six allowed keys); (7) the lego install and timer steps moved after the existing baseline steps and made non-fatal (`certs-tooling-failed`, WARN in verify-hosts); (8) verify-hosts treats an empty or unknown `certs=` answer as a WARN; (9) `check-duckdns.mjs` reads `--label` by flag, validates label and name, checks A and AAAA, has a resolver time limit and prints a usage line; (10) installer curl has timeouts and `grep -qF`; (11) runbook heredocs at column 0, pin procedure, RENEW_DAYS rule, Elastic IP and key-readability notes, Part G renamed to avoid the AWS runbook clash; (12) D-28, ADR 0003 and architecture 03 carry the "superseded in part" note; traceability has D-28 and D-49 rows and LE-2 before LE-8.
- The review asked for a size test with three distinct random keys and a YAML parse (js-yaml): with that, the rendered user data was 16414 bytes gzipped, OVER the limit of 16384 (the earlier 14802 used three identical keys). Fix: trimmed the header comments of `vulnmart-certs.sh` (15997) and shipped `vulnmart-egress.sh` as a plain text block too (15261). Real margin now 1123 bytes. Both `compute.tf` files and the template changed for the egress script.
- The new "already running" lock test needs `flock`, which Git bash on Windows lacks: it is skipped here and runs on Linux CI. The lock path itself was therefore not exercised on this PC.
- First size estimate with base64 for all files gave 15661 bytes gzipped (too close to 16384). Fix: ship the five new files as plain text blocks (`indent(6, file(...))`), which compress better: 15261.
- Git bash puts its own tools first on PATH, so stub `openssl` and `curl` were ignored in tests; fix: the scripts take `OPENSSL_BIN` and `CURL_BIN`.
- `tar` on a `C:/` path was read as a remote host; fix: relative paths in the test fixture.
- The existing test of the baseline step list had to be updated for the three new steps.

## Security notes (vulnerable parts only)
Not a vulnerable part. The token is a root-only file (0600 in a 0700 folder), passed to lego as a file name only, never in an argument, log or file of the repository; tests assert the stub never sees a token variable.

## Limitations and follow-ups
- The developer must create the names and accounts, place tokens, run staging then production, record the S-16 result and a real renewal (runbook `certificates.md`); L-10 stays open until real redacted results are pasted.
- lego v5.5.2 command flags (`--server`, `--dns`, `--domains`, `--path`, `renew --days`, `--version`, `--accept-tos`) are unverified against the real binary; the sha256 values come from the GitHub release data, not from a downloaded file.
- User data margin is about 1.5 KB; a new host file may need the plain-text treatment or a trim.
- H-115: L-12 must mount the files and reload Caddy after renewal.