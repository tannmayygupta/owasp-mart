# A modern shop interface that keeps every challenge working

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | `l-tester-login-hint-bugs` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | shop UI, FR-SHP-01 |

## Requirements covered
FR-SHP-01 (a believable everyday marketplace look), C01 to C11 (must keep working). Story: `docs/bmad/initiative-lab/backlog/story-modern-shop-ui.md`.

## Summary (plain language, 3-5 lines)
The shop pages had browser-default styling. I added one shared theme (navy, sand, coral; light and dark), a role-aware top bar, a hero search, lettered product tiles, status badges and a cart with a checkout summary. Forms, field names, routes and escaping are unchanged, so every challenge still works and still returns its own flag.

## Why
The developer asked for a modern interface and a unique experience for learners, with every challenge still working end to end.

## What was built
- `apps/shop/src/views/partials/theme.css` (inline theme, system fonts only, no outside resources) and a new `layout.njk` (top bar, role links, current-page mark, footer).
- Restyled `index`, `product`, `cart`, `orders`, `order`, `login`, `message`, `tickets`, `ticket`; status badges added to the staff and seller tables.
- `middleware.mjs`: the request path is put in the view context so the top bar can mark the current page.

## How it works
Pages extend `layout.njk`, which includes the theme as inline CSS. The top bar shows only links a role can open. It does not link `/_ops/` (C05), the settlement page (C07 flag) or the case notes (C09 flag). Product art is a coloured tile with the product's first letter.

## Files changed
- `apps/shop/src/views/**`, `apps/shop/src/web/middleware.mjs`, `docs/assets/modern-shop-ui/*.png`, the story files, `CHANGELOG.md`, this file.

## Decisions made
No ADR. Palette and tile style are an assumption in the story (the developer can change them).

## Tests
- `node --test` in `apps/shop` — 180 tests, 177 pass, 3 skipped, 0 fail (after the change).
- `node --test "challenges/tests/**/*.test.mjs"` — 42 of 42 pass.
- `node scripts/e2e-local-flags.mjs --docker` — 35 PASS, 0 FAIL (every challenge returns its own flag, with the new templates).
- `node --test "scripts/*.test.mjs"` — 928 tests, 925 pass, 1 fail, 2 skipped. The failure was `check-text-files` (BOM and mojibake in `CHANGELOG.md` and `docs/traceability.md`), caused by my own PowerShell merge edit. Both files were rebuilt from `origin/main` with explicit UTF-8 and the check now passes (`node scripts/check-text-files.mjs`: PASS; its test: 5 pass).
- Real Chrome screenshots (light and dark) of the shop, product, cart, orders, support, login and seller pages: `docs/assets/modern-shop-ui/`.
- Not run: a phone-width visual check (the CSS has a narrow layout; not looked at); the live lab.

## Evidence
`docs/assets/modern-shop-ui/shop-light.png`, `shop-dark.png`, `cart-light.png`, `seller-light.png`.

## Problems met and how they were fixed
- The logout button text was navy on navy (a CSS specificity clash): fixed.
- The hero search box was dark on dark in dark mode: fixed (white box).
- Windows PowerShell 5.1 re-encoded two docs files when I resolved the merge. Lesson: use explicit UTF-8 or the Edit tool.

## Security notes (vulnerable parts only)
No vulnerable path was changed. The only new user-text echo is the search term on the shop page, and it is auto-escaped.

## Limitations and follow-ups
Product photos are not used (lettered tiles). Staff pages get the shared theme and badges but no bespoke layouts.
