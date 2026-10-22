# The shop's pages lead to every challenge

| Field | Value |
|---|---|
| Date | 2026-10-22 |
| Developer | tannmayygupta |
| Branch / commit | shop-ui-for-every-challenge |
| Status | Built and tested locally; deployment of the lab images follows |
| Report tag | challenges, learner experience, shop |

## Requirements covered
T-14 (customer pages), the challenge stories C01 to C11 (entry points, start states, hints), FR-SHP-05, FR-SHP-12.

## Summary
The leader noticed that Cryptographic Failures (C02) talks about gift cards and the shop has none, and asked for every challenge to be checked end to end: statement, hints, and whether the target site has what a learner needs to find the weakness. The audit (`docs/audit/2026-10-22-challenge-entry-points.md`) found that the weaknesses worked through their API routes but that 9 of 11 challenges could not be reached from the pages. The shop now has the pages, menus and page requests each challenge needs.

## Why
The exploit tests call the routes directly, so 40 of 40 passing said nothing about whether a person sitting at the shop could find the route. The start states and hints also named pages that did not exist (sign-up, Contact, Gift cards, Import image from URL, the Pay step, a seller's order page).

## What was built
See the audit file for the table. In short: `/register`, `/wallet`, `/seller/orders` and `/seller/orders/{no}`, `/forgot`, `/contact`, `/app`, `/pay/start` and `/pay/{id}`; the search box on `/shop` goes through the catalogue search; the order page has Quick refund and Refund statement; the product page sends the cart preview to `/api/cart`; the seller dashboard has the image import form and an Orders link; the store form sends the tax id to the KYC route; menu entries for Gift cards, Sell with us, Orders, Case notes and Settlement; footer links Contact us and Mobile app; one page script `src/web/assets/shop.js`. The C01 placement now adds the neighbouring orders so the numbers run in sequence.

## How it works
New pages are thin views in `src/web/routes-pages.mjs`. The page script sends form-encoded requests with the session's CSRF token (in a meta tag) to the existing API routes, so the requests show in the browser's Network panel, and puts every answer on the page as text. The challenge modules and the fixed builds are unchanged except two small things: the vulnerable search now returns its SQL error message for the page to show, and the fixed search escapes LIKE wildcards (the shop's own listing did, and an existing test requires it).

## Files changed
`apps/shop/src/web/routes-pages.mjs`, `apps/shop/src/web/assets/shop.js`, `apps/shop/src/app.mjs`, `apps/shop/src/web/routes.mjs`, `apps/shop/src/domain/seller-service.mjs`, `apps/shop/src/challenges/c03a-catalog-search.mjs`, `apps/shop/src/instance/placements.mjs`, views (`layout`, `login`, `index`, `cart`, `order`, `product`, new `register`, `wallet`, `forgot`, `contact`, `app`, `pay`, `seller/orders`, `seller/order`, `seller/register`, `seller/dashboard`), `partials/theme.css`, `apps/shop/dev/serve-local.mjs`, `apps/shop/test/challenge-entry-points.test.mjs`, `tests/web-e2e/playwright.shop.config.mjs`, `tests/web-e2e/shop/shop-walkthrough.spec.mjs`, `docs/audit/2026-10-22-challenge-entry-points.md`.

Also: scripts/e2e-live-exploits.mjs accepts two already confirmed accounts through VM_XP_EMAIL_1/2 and VM_XP_PASSWORD_1/2, because production mail goes through Brevo and a throw-away account cannot be confirmed from the script.

## Decisions made
No ADR. Alternative considered: a separate single-page app for the shop (rejected: more code and a second front-end to keep in step); leaving the API-only routes and documenting them in the briefs (rejected: a learner would be told the answer instead of finding it).

## Tests
- `node --test` in `apps/shop`: 216 tests, 213 passed, 0 failed, 3 skipped (skipped before this change too). New: `test/challenge-entry-points.test.mjs`, 13 of 13.
- `node --test "challenges/tests/*/*.test.mjs"`: 40 of 40.
- Browser walkthrough (Playwright with the installed Chrome, `pnpm exec playwright test -c playwright.shop.config.mjs` in `tests/web-e2e`): 12 of 12, one test per challenge, run after fixing four mistakes of my own in the first draft of the tests (a wrong menu step in two tests, an ambiguous label, a JSON body that Playwright re-encoded).

## Evidence
`docs/audit/2026-10-22-challenge-entry-points.md`.

## Problems met and how they were fixed
- The first run of the new tests failed for C01 (the instance placement had no neighbouring orders, so a seller's list was empty) and C02 (no flag card without the placement). The test now uses the real placement function, and the placement adds the neighbours.
- An existing test (search with SQL metacharacters is literal) failed when the shop's search moved to the catalogue search; the fixed branch now escapes wildcards.
- The local server helper first lived in `test/`, and `node --test` ran it as a test and hung; it moved to `apps/shop/dev/`.
- PowerShell double-quoted strings swallowed `${...}` in one edit of the page script; fixed by editing the file directly.

## Security notes (vulnerable parts only)
No new weakness: the pages call the existing vulnerable routes. The Contact page lists the support agent's address and the finance mailbox on purpose (C07 and C09 start from them). The Mobile app page documents the legacy login route on purpose (C09).

## Limitations and follow-ups
- C03 B, C06 and C10 end in other containers of the instance; the walkthrough checks their entry points. The live suite covers their ends and needs two confirmed accounts.
- The browser walkthrough is not in CI; the HTML-level test is.
- Human solve times against the countdowns are not measured.
