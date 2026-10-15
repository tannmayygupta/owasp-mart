# S-16: DuckDNS wildcard resolution and DNS-01 certificate (template)

Status: TEMPLATE. The live fields are empty until the developer runs `docs/runbooks/certificates.md` (story L-10). Fill only real, redacted results. No addresses, tokens, emails or account names.

## Question
Does a random label under a DuckDNS name resolve like the name itself (`anything.<labs>.duckdns.org`), and can a wildcard certificate `*.<labs>.duckdns.org` be issued by DNS-01 with lego and the DuckDNS TXT API? (ADR 0003, D-28, D-49; architecture 03 section 3 marks wildcard A resolution UNVERIFIED.)

## Facts verified by research on 2026-10-11 (not by a live run)
| Fact | Source |
|---|---|
| `duckdns.org` is on the Public Suffix List | https://publicsuffix.org/list/public_suffix_list.dat |
| Let's Encrypt: 50 certificates per registered domain per week, 5 duplicates per week | https://letsencrypt.org/docs/rate-limits/ |
| DuckDNS update API with `txt=` | https://www.duckdns.org/spec.jsp |
| lego provider `duckdns` reads `DUCKDNS_TOKEN_FILE` | https://go-acme.github.io/lego/dns/duckdns/ |
| lego v5.5.2 Linux release files and their sha256 are pinned in `infra/hosts/lego.pin.json` (digests read from the GitHub release data on 2026-10-11) | https://github.com/go-acme/lego/releases/tag/v5.5.2 |

## Live results (developer fills)
| Check | Command | Result (redacted) |
|---|---|---|
| Wildcard A resolution | `node scripts/check-duckdns.mjs <labs>.duckdns.org` | |
| Staging issue (labs wildcard) | `vulnmart-certs.sh issue` | |
| TXT propagation time seen | journal of the run | |
| Production issue, issuer line | `openssl x509 -noout -issuer` | |
| Platform certificate (single name) | same | |
| DuckDNS limits met (rate, record count) | | |
| lego `renew` flags that worked on v5.5.2 | | |

## Decision this feeds
If wildcard resolution works: Route 2 stays for the labs zone. If not: Route 3 (sslip.io) with the slot pool (architecture 03 section 3). Tell Tanmay; do not decide alone.