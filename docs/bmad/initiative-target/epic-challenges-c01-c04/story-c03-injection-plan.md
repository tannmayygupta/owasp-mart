---
title: 'C03 Injection (SQL injection and stored XSS)'
type: 'feature'
ticket: '3'
created: '2026-10-18'
status: 'done'
baseline_revision: '9fa7dfe'
route: 'full'
risk: 'high'
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/docs/design/challenge-specs.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** C03 (OWASP A03, CWE-89/79) needs two injection weaknesses: part A, a UNION SQL injection in product search; part B, a stored XSS in support ticket messages that the support bot would open. Both must be realistic, isolated, and build-gated.

**Approach:**
- **Part A:** product search runs against a SEPARATE read-only catalog store (its own SQLite db: products + `ops_notes`, no users/orders/tokens). Fixed (default) parameterises the query; vulnerable concatenates the term, so `… UNION SELECT … FROM ops_notes` reads the notes (one marker, one flag). A SQL error emits `shop.catalog_query_error`.
- **Part B:** a customer's ticket message is stored as data (both builds); the support-console ticket detail renders it via one helper — fixed escapes it, vulnerable returns raw HTML (the stored XSS). Storing a message with an HTML tag emits `shop.ticket_markup_stored`.

The live part-B exfiltration loop — the headless support bot opening the ticket, the script reading the bot's agent-profile token, and the in-instance collector receiving it — is the bot headless-visitor's job (S-5 / H-44) and is tracked as a follow-up in deferred-work; this story delivers the shop-side stored-and-rendered weakness and its detection signals.

## Boundaries & Constraints

**Always:** Default to fixed. Part A only ever touches the separate catalog store (never the shop db). Keep each weakness in its own challenge module. Part B stores the raw text as data in both builds; only the render differs.

**Never:** No injection path from search into users/orders (separate store). No real flag committed (neutral markers in tests). No stacked-statement or ATTACH reach (node:sqlite runs one statement; load_extension off).

## I/O & Edge-Case Matrix

| Part | Build | Input | Result |
|------|-------|-------|--------|
| A | vulnerable | `' UNION SELECT id,body,1,'x' FROM ops_notes-- ` | ops_notes rows (marker/flag) in results |
| A | vulnerable | `'` (malformed) | [] + `shop.catalog_query_error` |
| A | fixed | same UNION text | 0 rows, no event |
| B | either | store a message with a tag | stored as data + `shop.ticket_markup_stored` |
| B | vulnerable | support opens the ticket | raw `<script>` in the console HTML |
| B | fixed | support opens the ticket | escaped (`&lt;script&gt;`) |

</frozen-after-approval>

## Code Map

- `apps/shop/src/challenges/c03a-catalog-search.mjs` — separate catalog store + concatenated/parameterised search.
- `apps/shop/src/challenges/c03b-ticket-xss.mjs` — the render decision + markup event.
- `apps/shop/src/web/routes.mjs` — `GET /api/products/search` (anon) + markup event on ticket create.
- `apps/shop/src/web/routes-staff.mjs` + `views/staff/ticket-detail.njk` — the support console render surface.
- `apps/shop/src/domain/staff-service.mjs` — `getTicketWithMessages`.
- `challenges/tests/c03-injection/{exploit-a-sqli.mjs,exploit-b-stored-xss.mjs,c03.test.mjs}`.

## Tasks & Acceptance

- [x] Part A catalog store + search + exploit.
- [x] Part B render helper + console detail + markup event + exploit.
- [ ] Live bot token-exfil loop — deferred (bot headless visitor, S-5 / H-44).

**Acceptance:** both exploits pass on the vulnerable build and fail on the fixed build; the SQL error and markup-stored events fire on the vulnerable build; part A cannot reach users/orders (separate store).

## Verification

- `node --test "challenges/tests/**/*.test.mjs"` — C03 3/3.
- `node --test "apps/shop/test/**/*.test.mjs"` — shop suite 134 pass.
