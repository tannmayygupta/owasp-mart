# Live human-path audit of the 11 challenges, and two console bugs it found

| Field | Value |
|---|---|
| Date | 2026-10-22 |
| Developer | tannmayygupta |
| Branch / commit | audit-challenges-live-human-path |
| Status | Partly done: C01–C06 proven live, one by one, in a real browser; C07 has an open issue; C08–C11 not yet re-walked in the browser (their route-level and API-level live tests already pass) |
| Report tag | audit, learner console, shop |

## Requirements covered
FR-FLG-01..09 (flags: find, validate, credit), FR-CHL-01..17 (challenge delivery), the challenge catalogue briefs/hints/start-states for C01–C11.

## Summary
The leader reported solving a challenge by hand but being unable to get the flag validated, and asked for every challenge to be played the way a learner actually plays it — console, then shop, by the brief and hints — one at a time, in a single audit with one PR. Doing this by hand surfaced two real console bugs (a dropped refresh after Start, and a flag that is auto-credited while the learner is still reading getting rejected on paste) and two shop defects (C05's anonymous entry point, C08's under-documented webhook). All four are fixed in this branch. C01 through C06 then passed end to end, live, in a real browser. C07 surfaced a script-timing issue on the forgot-password page that is not understood yet and is left open rather than papered over.

## Why
Calling routes directly (the earlier `scripts/e2e-live-exploits.mjs` run, 58/58) proves the weakness and the credit path work, but not that a learner following only the in-product text can find them — the two console bugs here were invisible to that style of test because they are about the page staying in sync with what the learner just did, not about whether a call succeeds.

## What was built
- `apps/lab-console/app.js`: `refresh()` queues one more read when called while already busy (`state.again`); a console with no live run is also polled, not just a running one; a challenge the lab already credited while on screen stays shown as captured, with a banner; the wrong-flag message names the challenge.
- `apps/shop/src/views/product.njk`: Add to cart shown to every visitor, signed in or not.
- `apps/shop/src/views/pay.njk`: the pay page states the literal webhook body for the order in front of the learner and the sandbox header.
- `tests/web-e2e/live/human-path.spec.mjs` + `playwright.live.config.mjs`: the one-test-per-challenge live human-path harness, run against the real deployment with a confirmed account.
- `scripts/lab-console.test.mjs`: two new regression tests (both proven to fail on the pre-fix code, pass after).
- `docs/audit/2026-10-22-live-human-path-11-challenges.md`: the full findings.

## How it works
See the audit file for the mechanism of each bug. In short: the console's `refresh()` is reentrant now instead of dropping a call; and a captured-while-reading challenge is distinguished from "the learner moved to another challenge" by comparing the item's `solved` flag across one read to the next, keyed on the still-current attempt id.

## Files changed
`apps/lab-console/app.js`, `apps/shop/src/views/{product,pay}.njk`, `scripts/lab-console.test.mjs`, `tests/web-e2e/live/human-path.spec.mjs` (new), `tests/web-e2e/playwright.live.config.mjs` (new), `docs/audit/2026-10-21-challenge-entry-points.md` is unaffected (different audit, kept as is), this dev-log, this audit file.

## Decisions made
No ADR: both console fixes are bug fixes to existing behaviour (the "credited automatically" and "poll while idle" behaviour were already the intended design, see `docs/audit/2026-10-22-challenge-entry-points.md` and earlier dev-logs), not new product decisions.

## Tests
Real commands and real output, 2026-10-22:
- `node --test scripts/lab-console.test.mjs`: 21 of 21 pass. The 2 new tests were run again against the pre-fix file (`git stash` of `apps/lab-console/app.js` only) and both failed there, confirming they test the real behaviour.
- `node --test apps/shop/test/challenge-entry-points.test.mjs`: 13 of 13 pass (unaffected by the view-only shop changes).
- Live browser run (`pnpm exec playwright test -c playwright.live.config.mjs` in `tests/web-e2e`, installed Chrome, against `https://tanmay-platform-prod.duckdns.org` with a confirmed audit account): C01, C02, C03, C04, C05, C06 each pass individually, run one at a time in the order the leader asked for (not in parallel), each carrying its own account into the next via `VM_KEEP=1`. C07 fails: see the audit file. C08–C11 not run in the browser this session.

## Problems met and how they were fixed
- The audit account's password had been changed by an earlier password-reset test mail; switched the audit to the second confirmed account.
- Several Playwright locator and popup-timing mistakes in the first drafts of the human-path test itself (ambiguous button text, a bare `/login` navigated to `about:blank`, waiting on the wrong event) — all in the test file, not the product; fixed by reading the actual page markup instead of guessing selectors.
- C07: the forgot-password page's script did not fire the reset request in the browser run; not root-caused yet. Recorded as an open item rather than silently worked around.

## Security notes (vulnerable parts only)
None of the fixes touch a challenge's vulnerable/fixed logic; all four are learner-experience fixes around the weaknesses, not to them.

## Limitations and follow-ups
- C07's browser-only symptom needs its own investigation (likely a script-load race on that specific page, given `/assets/shop.js` was observed answering 404 then 200 across the two tab loads of one run).
- C08–C11 have not been re-walked through the console+shop browser path; their route-level (`challenges/tests`) and API-level live (`scripts/e2e-live-exploits.mjs`, 2026-10-21, 58/58) checks already pass.
- Not yet deployed: this branch is local until the leader loads the SSH key for the deploy step.
