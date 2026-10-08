# 0003. Instance addressing and TLS

- **Status:** Accepted by the user (D-28); refinements marked Proposed
- **Date:** 2026-10-08
- **Deciders:** the user (D-28)
- **Requirements:** D-16, C03/D-18, NFR-SEC-06, FR-INS-10; OI-9

## Context
The shop is deliberately XSS-vulnerable and must never share an origin or cookie scope with the platform.

## Options considered
1. Per-instance subdomains under a labs name, one wildcard certificate (DNS-01).
2. Per-host ports on one hostname: cookies ignore ports, odd ports often blocked.
3. Path-based routing: one origin for everything, unsafe.
4. sslip.io or nip.io names: no wildcard, per-host certificates, shared limits.

## Decision
Option 1 (D-28): two separate DuckDNS names, one for the platform and one for labs, with a wildcard certificate for `*.<labs>.duckdns.org` through DNS-01. duckdns.org is on the Public Suffix List, so the two names are different sites. Upgrade to real domains if the Student Pack provides one. Proposed refinements: hostname `i-<16 random chars>`; the DNS token for the labs name on a separate DuckDNS account; port 80 closed; edge adds no CSP or HSTS to shop responses; "never plain HTTP" read as public addresses only, with plain HTTP on loopback and on private internal hops (user to confirm).

## Consequences
No per-start certificate issuance. Email cannot use DuckDNS (no separate SPF or DKIM): Brevo single-sender or a real domain (OI-32). Wildcard A resolution is unconfirmed (spike S-16).

## Evidence
https://publicsuffix.org/list/public_suffix_list.dat (VERIFIED, duckdns.org and vercel.app listed); https://www.duckdns.org/spec.jsp (VERIFIED, partial); https://letsencrypt.org/docs/faq/ (VERIFIED, wildcard needs DNS-01); https://letsencrypt.org/docs/rate-limits/ (VERIFIED); https://nip.io/ (VERIFIED, no wildcard). See docs/architecture/03-origins-and-access.md.
