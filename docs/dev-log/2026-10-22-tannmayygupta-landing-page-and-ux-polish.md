# Landing page at / and a natural-feeling UI (clickable things look clickable, locked things say why)

| Field | Value |
|---|---|
| Date | 2026-10-22 |
| Developer | tannmayygupta |
| Branch / commit | ux-landing-and-polish |
| Status | Built and tested locally; deployment is the next step |
| Report tag | UX, onboarding, learner console |

## Requirements covered
FR-ACC-01, FR-ACC-03 (the entry points), FR-DSH-01 (where each kind of account lands), the learner console of story 11 (countdown, rail), L-25 groundwork (pointer, focus and disabled states).

## Summary
`/` had its own sign-in and create-account form while `/signup` and `/login` had theirs: two ways in, two designs. Now `/` is a landing page for visitors (what the platform offers, two buttons, a footer with a contact), and `/login` and `/signup` are the only forms. The console is also easier to read as a product: the pointer shows what can be clicked, locked challenges explain themselves, and a stale message no longer contradicts the page.

## Why
The leader's review of the live site (screenshot of the console with the shop destroyed and the rail unresponsive):
- clicking challenge 3 did nothing and the pointer stayed an arrow, so the page felt broken;
- clicking an earlier challenge while the shop was down changed nothing;
- "Building your shop. This takes a few seconds." stayed on screen over a page that said the shop was not running;
- disabled buttons gave no reason;
- `/` and `/signup` showed the same kind of form in two designs.
Cause of the first: `.dot` buttons had no `cursor` rule (browsers use the arrow on buttons), and a locked challenge was a plain `disabled` button, which swallows the click and shows nothing.

## What was built
Lab console (`apps/lab-console`):
- `index.html`: the landing page (hero with a decorative preview of the challenge card, six short service cards, a closing call to action) and a footer with a contact; Sign in and Create account in the top bar; the old inline forms and the e-mail confirmation block are gone (`/login`, `/signup` and `/verify-email` are served by the dashboards app).
- `app.js`: signed out shows the landing page; a recruiter or administrator who opens `/` is sent to `/dashboard`; locked rail dots answer a click with the reason (and keep keyboard focus); every open dot has a tooltip with the challenge name; with the shop down, the picked challenge and its brief are shown; "ok" and "info" messages fade after 7 seconds, errors stay; "Building your shop" is removed when the shop is up; disabled buttons carry a title that says why; a Dashboard link in the top bar.
- `style.css`: pointer on every button, summary, select and checkbox label; `not-allowed` on disabled and locked things; hover states on rail dots; landing and footer styles; sticky footer.
- `favicon.svg`.
Dashboards (`apps/web`): a learner who signs in goes to the lab at `/` (a recruiter and an administrator to `/dashboard`; a valid `?next=` still wins, `afterSignIn` in `lib/paths.ts`); the same footer and favicon; "Practice lab" in the navigation for learners; `/signup?as=recruiter` preselects the company form (the landing page links to it); the same locked-challenge treatment on the dashboards' own rail; pointer rules.
Browser test helper: the age checkbox is found by a pattern, because its wording is now the console's ("I am 18 or over, and I will only attack the lab").

## How it works
`/` is served by the console in production (Caddy sends only the dashboard routes to the Next.js app). The console decides by the session: no session shows the landing page, a learner sees the lab, anyone else leaves for `/dashboard`. In development and in the browser tests `/` is the dashboards' own home page, which sends a signed-in visitor to `/dashboard`.

## Files changed
`apps/lab-console/{index.html,app.js,style.css,favicon.svg}`, `apps/web/{lib/paths.ts,app/login/page.tsx,app/signup/page.tsx,app/page.tsx,app/nav.tsx,app/layout.tsx,app/site-footer.tsx,app/sequenced-stage.tsx,app/globals.css}`, `scripts/lab-console.test.mjs`, `apps/web/test/dashboard-lib.test.mjs`, `tests/web-e2e/tests/helpers.mjs`, screenshots in `docs/assets/ux-landing-and-polish/`.

## Decisions made
No ADR. Alternatives: moving the console to `/lab` and keeping a static landing at `/` (clearer URLs, but it changes Caddy, every link and the live checks; not now); a locked dot as a disabled button (rejected: it gives no feedback).

## Tests
Real results (2026-10-22, on the leader's PC):
- 
ode --test scripts/lab-console.test.mjs: 19 of 19 (13 before; 6 new: landing when signed out, role redirect, locked dot says why, picked challenge with the shop down, disabled-button reasons and the vanishing build message, pointer and locked styles).
- pnpm test in pps/web: 36 of 36 (one new: where each kind of account lands after sign-in). pnpm run typecheck: exit 0.
- Browser suite 	ests/web-e2e (Playwright with the installed Chrome, production build of the dashboards, real API app): first run 16 of 20; the 4 failures were axe colour-contrast on the success green (4.4 to 1 on its soft background, under 4.5 to 1 required), fixed by darkening --ok in both apps; second run of the whole suite 20 of 20. (Running the accessibility file alone fails two tests that need data from the earlier specs; that is how the suite is built, not a defect.)
- Before my fix to the helper, the learner sign-up specs failed on the changed checkbox wording (see Problems).
- 
ode scripts/check-text-files.mjs: PASS.

## Evidence
`landing-dark.png`, `landing-light.png`, `landing-narrow-dark.png` in `docs/assets/ux-landing-and-polish/` (the console served as static files; headless Chrome).

## Problems met and how they were fixed
- My restyle of `/signup` in the previous change (PR 89) changed the age checkbox wording, which the browser suite looks up by its exact text; the suite is not run by CI, so it went unnoticed until I ran it here. The helper now matches by pattern.
- A first attempt to replace a block of the console stylesheet duplicated the file because the marker lookup failed; restored from git and redone with exact line numbers.

## Security notes (vulnerable parts only)
None. The contact address in the footer is the leader's own, stated by the leader.

## Limitations and follow-ups
- Real phone width is checked only at 500 px in headless Chrome.
- The contact line is one place per app (`apps/lab-console/index.html`, `apps/web/app/site-footer.tsx`).
