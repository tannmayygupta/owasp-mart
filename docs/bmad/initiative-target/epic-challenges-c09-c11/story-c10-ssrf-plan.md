---
title: 'C10 Server-Side Request Forgery (seller image import)'
type: 'feature'
ticket: '2'
created: '2026-10-18'
status: 'built'
baseline_revision: '790f803'
route: 'full'
risk: 'high'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** C10 (OWASP A10/A01, CWE-918) needs an SSRF: the shop fetches a seller-supplied URL and a weak check lets it reach the internal metadata service.

**Approach:** "Import image from URL" (`POST /seller/import-image`). The fixed (default) build resolves the host to an IP and refuses private/loopback/link-local addresses. The vulnerable build uses a STRING blocklist of a few literal names/addresses, which a variant representation (the decimal form of a loopback IP) evades, so the importer reaches the internal metadata service; the non-image response shows the first 200 characters, leaking the flag in the metadata's startup data. http/https only. Event `importer.fetch_attempt` (url_class, blocked).

## Boundaries & Constraints

**Always:** Default to fixed (resolve-and-check). http/https only (no `file://`/`gopher://`). Timeout + body cap. The importer error must not name the internal service (C05 conflict — the flag is the leaked body, not a named host).

**Never:** No real flag committed (neutral marker). No other flag reachable from the metadata service.

## I/O & Edge-Case Matrix

| Build | URL | Result |
|-------|-----|--------|
| vulnerable | decimal-IP form of loopback metadata | fetched; "Not an image: <flag>" |
| vulnerable | literal `127.0.0.1`/`localhost`/… | blocked (string match) |
| fixed | any form resolving to private/loopback | blocked (resolved IP) |
| either | `file://` / `gopher://` | rejected (scheme) |
| either | a real public host | resolved public -> fetched (no egress in-instance) |

</frozen-after-approval>

## Code Map

- `apps/shop/src/challenges/c10-ssrf-import.mjs` — URL screening (both branches), fetch, classification, `importer.fetch_attempt`.
- `apps/shop/src/web/routes-seller.mjs` — `POST /seller/import-image`.
- `challenges/tests/c10-ssrf/{exploit.mjs,c10.test.mjs}`.

## Tasks & Acceptance

- [x] Importer (both branches), seller route, exploit + self-test (with a fake metadata server).

**Acceptance:** the decimal-IP bypass reaches the metadata service and leaks the flag on the vulnerable build; the resolved loopback IP is refused on the fixed build; a non-http scheme is rejected on both.

## Verification

- `node --test "challenges/tests/**/*.test.mjs"` -- C10 3/3.
- `node --test "apps/shop/test/**/*.test.mjs"` -- shop suite 134 pass.
