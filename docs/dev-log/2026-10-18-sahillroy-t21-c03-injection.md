# T-21 C03 Injection (SQL injection and stored XSS)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | Sahil Roy |
| Branch / commit | sprint-3-sahil |
| Status | Done (shop-side; live bot-exfil loop deferred) |
| Report tag | Sprint 3, epic-challenges-c01-c04 story 5.3 |

## Requirements covered
FR-CHL-04 (C03), both parts. Challenge spec C03 A and B.

## Summary (plain language, 3-5 lines)
Built C03's two injection weaknesses, both build-gated and off by default. Part A: product search runs against a separate read-only catalog store; the vulnerable build concatenates the search text into the SQL, so a UNION reads a notes table (marker + flag), while the fixed build parameterises it. Part B: a customer's ticket message is rendered on the support console; the vulnerable build shows it as raw HTML (stored XSS), the fixed build escapes it. Exploit tests prove both pass on vulnerable and fail on fixed.

## Why
FR-CHL-04 / C03. Injection is OWASP A03. Part A is kept to a separate catalog store so an injection cannot reach users or orders; part B is the classic stored XSS the support bot would open.

## What was built
- Part A: `buildCatalogStore` (a separate SQLite db: catalog_products + ops_notes) and `searchCatalog` (concatenated vs parameterised); `GET /api/products/search` (anonymous). A SQL error emits `shop.catalog_query_error`.
- Part B: `renderTicketMessageHtml` (escape vs raw) and `noteTicketMarkup` (`shop.ticket_markup_stored`); a support ticket-detail route + view render each message through the helper; `getTicketWithMessages` in staff-service.

## How it works
Part A: the search endpoint queries only the catalog store (built lazily on first use, so instance mode never touches the db before the snapshot is ready). The vulnerable query is `… name LIKE '%<q>%'` by concatenation; a UNION matching the four columns returns ops_notes rows. Part B: the message is stored as data in both builds; only the console render differs, via one `| safe` spot fed by the challenge helper.

## Files changed
- `apps/shop/src/challenges/c03a-catalog-search.mjs`, `c03b-ticket-xss.mjs` — new.
- `apps/shop/src/web/routes.mjs`, `routes-staff.mjs`, `app.mjs` — routes + threading.
- `apps/shop/src/domain/staff-service.mjs` — `getTicketWithMessages`.
- `apps/shop/src/views/staff/ticket-detail.njk` — new.
- `challenges/tests/c03-injection/{exploit-a-sqli.mjs,exploit-b-stored-xss.mjs,c03.test.mjs}` — new.

## Decisions made
- Part A uses a separate catalog store (FR-INS-02), so even a successful injection cannot read users/orders.
- The live part-B loop (bot opens the ticket, script reads the bot's agent-profile token, collector receives it) is deferred to the bot headless visitor (S-5 / H-44); this story delivers the stored-and-rendered weakness and the detection events. Recorded in deferred-work.

## Tests
`node --test "challenges/tests/**/*.test.mjs"` — 14 pass (C03 3/3). `node --test "apps/shop/test/**/*.test.mjs"` — 134 pass.

## Security notes (vulnerable parts only)
Part A: a concatenated SQL query (CWE-89) against a store with no users/orders; fix is parameterisation. Part B: an unescaped render of stored user markup (CWE-79); fix is HTML-escaping. Both are isolated in their challenge modules and off by default. The full XSS payload-execution path requires the headless bot (deferred); the stored markup and the console render are proven here.
