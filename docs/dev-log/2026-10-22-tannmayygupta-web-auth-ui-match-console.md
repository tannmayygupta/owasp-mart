# Sign-up and sign-in pages match the console design

| Field | Value |
|---|---|
| Date | 2026-10-22 |
| Developer | tannmayygupta |
| Branch / commit | web-auth-ui-match-console |
| Status | Built and checked locally; deployment follows after the database work (leader's order) |
| Report tag | UI consistency, onboarding |

## Requirements covered
FR-ACC-01, FR-ACC-03, FR-ORG-01 (the screens), L-25 groundwork (consistent focus styles).

## Summary
The leader saw two designs: the lab console at the site root (polished) and the dashboards app at `/signup` and `/login` (plain, with stretched radio buttons). The dashboards app now uses the console's tokens, fonts and split layout, so a new visitor sees one product everywhere.

## Why
Two front-ends are served from one host: Caddy sends `/login`, `/signup` and the other dashboard pages to the Next.js app and everything else to the static console. They had separate stylesheets. The misaligned radio buttons came from the rule `.row input { flex: 1 1 10rem }`, which stretched every input in a row, radio buttons included.

## What was built
- `apps/web/app/globals.css`: rewritten with the console's tokens (light and dark), the self-hosted fonts from `/fonts` (served by the same host), buttons, fields, cards, pills and banners in the same shapes; the old variable names (`--card`, `--accent`) are aliases, so the company, admin and learner pages inherit the new look.
- `apps/web/app/auth-shell.tsx` (new): the split layout (pitch on the left, form card on the right) for `/login` and `/signup`.
- `signup/page.tsx`: the account type is a segmented control of real radio buttons; the age declaration now carries the console's wording.
- `nav.tsx`: logo, name and Sandbox tag as in the console.
- `apps/lab-console/index.html`: two lines under the sign-in card (how to get an account, where challenge logins appear, a link to the company sign-up).
- `apps/shop/src/views/login.njk`: one line on the practice shop's login (no sign-up; credentials are under "How to begin").

## How it works
Pure CSS and markup; no new dependency, no inline style (the production CSP forbids it).

## Files changed
The six files above plus `docs/assets/web-auth-ui-match-console/` (screenshots).

## Decisions made
No ADR. Alternative considered: one front-end for all pages; too large for this fix and it would move every dashboard.

## Tests
- `pnpm run typecheck` in `apps/web`: exit 0.
- `pnpm test` in `apps/web`: 35 of 35 passed.
- `node --test` in `apps/shop`: 203 tests, 200 passed, 0 failed (the rest are skipped by the suite).
- Headless Chrome screenshots of `/signup` and `/login` from `next dev` at 1440 by 900 (dark scheme): `docs/assets/web-auth-ui-match-console/`.

## Evidence
`signup-dark.png`, `login-dark.png` in `docs/assets/web-auth-ui-match-console/`.

## Problems met and how they were fixed
- First phone-width screenshot looked cut off. Headless Chrome has a minimum window width, so it was not reliable; I removed it and added `min-width: 0` for the grid children as the correct CSS rule. Phone width is not proven.
- Playwright is not installed here, so the browser suite `tests/web-e2e` was not run. The labels used by its helpers (`Email`, `Password`, buttons `Sign in` and `Create account`) were kept.

## Security notes (vulnerable parts only)
The shop's login line is general text and gives no credential.

## Limitations and follow-ups
- Light-scheme screenshots and a real phone check are still open.
- The browser suite should run after the next deploy, against the live stack.
