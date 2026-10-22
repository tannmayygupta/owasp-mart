# Audit: playing each of the 11 challenges by hand, on the deployed lab, in a real browser (2026-10-22)

Question from the leader: does the shop actually let a learner follow the brief/start-state/hints to find the flag and have it validated, for every challenge — not proven by calling routes directly, but by using the console and the shop the way a person does.

## Method
One Playwright test per challenge (`tests/web-e2e/live/human-path.spec.mjs`), run in order against the real deployed site (`https://tanmay-platform-prod.duckdns.org`) with a confirmed learner account. Each test: opens the lab console, begins the challenge (reads the brief and the first hint), opens the shop in a second tab, follows only what the start state and hints say (menu links, forms, one request from the shop page's own console standing in for Burp/curl where the hint calls for a raw request), and then checks the platform side: the lab must have counted the challenge by itself, and pasting the found flag into the console must answer "correct".

## Defects found and fixed in this branch
1. **Dropped refresh in the console.** Pressing *Start* (or any button) while a read was already in flight silently dropped the click's own refresh. A finished run has no further poll, so the page was stuck showing a destroyed shop under "Building your shop..." until a manual reload. Root cause: `refresh()` returned early on `state.busy` with no record that a retry was owed. Fix: a `state.again` flag re-runs `refresh()` once the in-flight read finishes; a console with no live run is now also polled every 20s so another tab's change is picked up. Regression test added and proven to fail without the fix.
2. **A flag found just as the console moved on was rejected.** The lab credits a challenge the moment the flag appears in a shop response (the sidecar sees it), which can happen before the learner pastes it. The console was already showing the next challenge by then, so the paste failed with "not the flag for this challenge" and gave no indication the first one was already captured. Fix: `refresh()` now notices when the challenge on screen just became solved and stays on it, with a banner explaining the lab already counted it. Regression test added and proven to fail without the fix.
3. **C05's start state did not match the shop.** The brief says "no account needed", but the product page only showed *Add to cart* to a signed-in visitor, so the anonymous `/api/cart` request the weakness depends on was unreachable as described. Fixed: the button and form show for every visitor.
4. **C08's pay page under-documented the webhook.** The hint says to "replay the provider message yourself" and "look for a header that changes how strictly it is checked", but the page only named the route and the signature header, not the sandbox header or an example body for the order in front of the learner. Fixed: the page now shows the literal JSON body for the current order and the `X-Gateway-Mode: sandbox` header.
5. **The wrong-flag message named no challenge.** "That is not the flag for this challenge" did not say which challenge, which matters once two challenges are open in the same session. Fixed: it now names the challenge key and reminds that a reset changes every flag.

## Result, challenge by challenge (live, in order)
| # | Brief followed | Flag found as described | Lab credited it (M3) | Paste answers correct |
|---|---|---|---|---|
| C01 | yes | yes (buyer note of a neighbouring order number) | yes | yes |
| C02 | yes | yes (MD5 of the serial, forged for card 1) | yes | yes |
| C03 | yes | yes (both parts: UNION in search, stored XSS via the bot) | yes | yes |
| C04 | yes | yes (goodwill-adjustment line after two quick refunds) | yes | yes |
| C05 | yes, after fixing defect 3 | yes (`/_ops/diagnostics`) | yes | yes |
| C06 | yes | yes (`__proto__` in the import options) | yes | yes |
| C07 | yes | **not reproduced in the browser run** (see below) | — | — |
| C08 | not run in this session | — | — | — |
| C09 | not run in this session | — | — | — |
| C10 | not run in this session | — | — | — |
| C11 | not run in this session | — | — | — |

C01–C06: 6 of 6 pass, in a real browser, following only what the challenge tells a learner.

## C07: open issue, not fixed
In the browser run, the *Forgot your password?* page's own script did not send the `/auth/forgot` request on first load (`/assets/shop.js` was observed answering 404 then 200 across the two tab loads in one run). The separate, API-level live exploit suite (`scripts/e2e-live-exploits.mjs`, all HTTP calls, no browser) passed C07 on this same deployment the day before (58 of 58 across all 11 challenges). So the weakness and the route both work; something about the **page's own script timing** in a fresh tab is the suspect, not the challenge. This needs its own investigation and is left open, not silently fixed.

## Not yet run through the browser in this audit
C08, C09, C10, C11: each has a passing route-level exploit test (`challenges/tests/`) and passed in the API-level live suite. They were not re-walked through the console+shop browser path in this session; that is the remaining gap of this audit.

## Tests
- `scripts/lab-console.test.mjs`: 21 of 21 (2 new regression tests; both proven to fail on the pre-fix code).
- `apps/shop/test/challenge-entry-points.test.mjs`: 13 of 13 (unaffected by the view changes).
- `challenges/tests/*`: unaffected (no challenge-module code changed).
- Live browser run, `tests/web-e2e/live/human-path.spec.mjs` against the deployed site: C01–C06 pass; C07 fails on the reason above; C08–C11 not run.
