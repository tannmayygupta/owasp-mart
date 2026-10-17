# L-10 live: DuckDNS names and real certificates on vm-p and vm-i

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay |
| Status | Done (live) |
| Report tag | live, certificates |

## Requirements covered
LE-2; spike S-16; D-49, ADR 0030; H-115 (open for Caddy).

## Summary
The developer created two DuckDNS names (platform and labs, two accounts) and typed the two tokens into local files with a hidden prompt; Claude copied them to the hosts (mode 600 root), deleted the local copies, and ran the runbook `certificates.md` over SSH on the developer's authorisation. Real Let's Encrypt certificates are on both hosts and renewal works. Evidence: `docs/assets/l-10-certificates/live-run.txt`.

## Tests (real results)
- S-16: `node scripts/check-duckdns.mjs` printed `match: a random label resolves to the same A record as the name`.
- Staging then production, once per name: vm-p `state=ok days_left=89`, issuer Let's Encrypt (not STAGING), subject and SAN the single name; vm-i the wildcard.
- Renewal: the not-due run says `nothing to do`; a forced renewal on vm-p ended `renewed` with a later expiry.
- `node --test scripts/certs-host.test.mjs`: 28 passed, 0 failed after the syntax fix; `scripts/cloud-hosts.test.mjs` 38 passed.

## Problems met and how they were fixed
- Staging failed: `flag provided but not defined: -accept-tos`. lego v5 has one command, `run`, with all flags after it; the script (written against lego v4 and never run against the real binary) was fixed with the help output of v5.5.2, and the tests that asserted the wrong form were updated.
- Staging failed again on the propagation check (the hosts reach only the VPC resolver on port 53); fixed with `LEGO_EXTRA_ARGS=--dns.propagation.disable-ans` in `certs.env`, not with a firewall change.
- The Chrome extension was not connected, so Claude could not read the tokens from the DuckDNS pages; the developer saved them locally with a hidden prompt.

## Security notes
No token was printed or stored in the repo; the local token files were overwritten and removed. Private keys are mode 600 root. The forced renewal cost one extra certificate on the platform name (Let's Encrypt limit 5 per week per name set).

## Limitations and follow-ups
Caddy does not mount the files yet and its reload hook finds no container (L-11, L-17); file ownership for a non-root Caddy is H-115. Renewal on vm-i (the wildcard) was not forced; it uses the same code path and was proven on vm-p. vm-i is still running.
