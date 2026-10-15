# 0030. Certificates issued by lego on each host (DNS-01, DuckDNS), Caddy only loads the files

- **Status:** Proposed (decided on the developer's delegation 2026-10-11, "research and go with the recommended answer"; recorded as D-49). Becomes Accepted when the developer confirms it after the live staging and production runs.
- **Date:** 2026-10-11
- **Deciders:** Tanmay (stream L), on delegation (D-49)
- **Requirements:** LE-2, LE-8, S-16, D-28, ADR 0003, L-10, L-12

## Context
D-28 and ADR 0003 want a normal certificate for the platform name and a wildcard certificate for the labs name, by DNS-01, with two separate DuckDNS names. D-28 named the mechanism: Caddy with the DuckDNS DNS plugin. The stock Caddy image does not contain that plugin; a custom image (xcaddy) belongs to L-12 and would also put the DuckDNS token inside the internet-facing edge container. Ports 80 and 443 are still closed and no names or certificates exist.

## Options considered
1. **Caddy with the `caddy-dns/duckdns` plugin (the D-28 wording).** Pros: one component; renewal built in. Cons: needs a custom image first (L-12), the token sits in the edge container, nothing can be issued before L-12 exists.
2. **lego on each host, files mounted into stock Caddy (chosen).** Pros: works now; the token is a root-only file on the host, never in a container; stock Caddy; the same script for both hosts; testable with stubs. Cons: one more small component to keep current (pinned release); Caddy must reload the files after a renewal (L-12 handoff).
3. **certbot with a DuckDNS plugin (pip or snap).** Cons: pip or snap on the host, third-party plugin, no gain over lego.
4. **A paid DNS or certificate service.** Rejected: free things only (D2).

## Decision
- D1: only the **mechanism line** of D-28 changes (lego on the host instead of the Caddy plugin). The names, the wildcard, DNS-01 and the separate platform and labs names stay.
- D2: free only (DuckDNS, Let's Encrypt, lego MIT); no paid service, no new AWS resource.
- D3: the labs certificate is the wildcard `*.<labs>.duckdns.org` only (DuckDNS keeps one TXT value per name); the platform certificate is one name.
- D4: Let's Encrypt staging first; `--production` is refused until the staging success marker exists.
- D5: the token is a root-only file on the host read by lego as `DUCKDNS_TOKEN_FILE`; the labs token comes from a separate DuckDNS account (ADR 0003); no token in the repository, chat or logs.
- D6: renewal by a systemd timer twice a day with `Persistent=true`; the script decides (renew when 30 days or fewer are left, a setting), because Let's Encrypt is shortening lifetimes; failure leaves a failed unit and a marker file.
- D7: lego is installed from a pinned release (`infra/hosts/lego.pin.json`, v5.5.2) with a verified sha256; no pip, no snap.
- D8: certificates live in `/opt/vulnmart/certs/live/` (root only) for Caddy to mount read-only; staging output is kept apart in `staging/`.
- D9: running hosts get the files by the maintenance procedure (runbook Part G, `docs/runbooks/certificates.md` Part B); new hosts by cloud-init. The five new files go into cloud-init as plain text blocks (not base64), because plain text compresses much better and the user data must stay under 16384 bytes after gzip (measured 15261 bytes for three distinct keys, margin 1123 bytes; the egress script is plain text too).
- Files: `infra/hosts/vulnmart-certs.sh`, `.service`, `.timer`, `vulnmart-install-lego.sh`, `lego.pin.json`; check script `scripts/check-duckdns.mjs`; runbook `docs/runbooks/certificates.md`.

## Consequences
Easier: issuance and renewal work before any Caddy image exists; the token is out of the edge container. Harder: L-12 must mount `/opt/vulnmart/certs/live` read-only and reload Caddy after a renewal (handoff H-115). Not proven live: lego v5.5.2 command flags (`renew --days`, `--server`, `--dns`) are from the lego documentation and general knowledge and were exercised only against a stub; DuckDNS TXT propagation time, wildcard resolution (S-16) and DuckDNS limits are unverified until the developer's runs. The pinned sha256 values were read from the GitHub release data, not computed from a downloaded file.

## Evidence
- Pinned checksums (verification): the sha256 of `lego_v5.5.2_linux_amd64.tar.gz` and `lego_v5.5.2_linux_arm64.tar.gz` in `infra/hosts/lego.pin.json` were read on 2026-10-11 from the `digest` fields of the GitHub release API (`https://api.github.com/repos/go-acme/lego/releases/tags/v5.5.2`). They were NOT computed from a downloaded file and were not compared with the release checksums file (its direct download name was not found). The installer verifies them at install time; the procedure to raise the pin is Part G of `docs/runbooks/certificates.md`.
- Public Suffix List contains `duckdns.org`; Let's Encrypt limits 50 certificates per registered domain and 5 duplicates per week (https://letsencrypt.org/docs/rate-limits/); DuckDNS API `update?domains=&token=&txt=` (https://www.duckdns.org/spec.jsp); lego provider `duckdns` reads `DUCKDNS_TOKEN_FILE` (https://go-acme.github.io/lego/dns/duckdns/); lego release v5.5.2 (https://github.com/go-acme/lego/releases/tag/v5.5.2).
- Test runs: `docs/assets/duckdns-names-and-certificates/test-output.txt`.