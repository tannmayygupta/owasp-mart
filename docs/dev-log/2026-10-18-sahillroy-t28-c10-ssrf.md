# T-28 C10 Server-Side Request Forgery (seller image import)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-4-sahil |
| Status | Done |
| Report tag | Sprint 4, epic-challenges-c09-c11 story 7.2 |

## Requirements covered
FR-CHL-11 (C10). Challenge spec C10.

## Summary (plain language, 3-5 lines)
Built the "Import image from URL" feature with the C10 weakness build-gated. The fixed (default) build resolves the host to an IP and refuses private/loopback/link-local addresses; the vulnerable build uses a string blocklist of a few literal addresses, which a variant form (the decimal representation of a loopback IP) evades, so the importer reaches the internal metadata service and the non-image response leaks the flag in its first 200 characters. An exploit test proves both.

## What was built
- `c10-ssrf-import.mjs`: `importImageFromUrl` (string-blocklist vs resolve-and-check), classification, `importer.fetch_attempt` event; http/https only, timeout.
- `POST /seller/import-image` (seller).

## How it works
Vulnerable: the URL string is checked against a literal blocklist; a decimal-IP (or similar variant) is not listed and passes, and the host resolves to loopback where the metadata service lives. Fixed: the host is resolved to an IP and any private range is refused, whatever the textual form.

## Files changed
- `apps/shop/src/challenges/c10-ssrf-import.mjs` — new.
- `apps/shop/src/web/routes-seller.mjs`.
- `challenges/tests/c10-ssrf/{exploit.mjs,c10.test.mjs}` — new.

## Tests
`node --test "challenges/tests/**/*.test.mjs"` -- 33 pass (C10 3/3, with a fake metadata server). `node --test "apps/shop/test/**/*.test.mjs"` -- 134 pass. No new migration.

## Security notes (vulnerable parts only)
The vulnerable branch is a string blocklist (CWE-918), bypassable by a variant address form, isolated in `c10-ssrf-import.mjs`, off by default. The fix resolves the host and blocks private ranges (and would re-check after redirects + use an allow-list). http/https only, so `file://` cannot read local files; the error leaks only the fetched body, not the internal host name (C05 containment).
