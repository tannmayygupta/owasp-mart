# Learner console redesign (one challenge at a time)

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | `l-tester-login-hint-bugs` (commit hash after the commit) |
| Status | Done (in review) |
| Report tag | LB-13, D-80, ADR 0063 |

## Requirements covered
Story: `docs/bmad/initiative-lab/backlog/story-the-learner-console-one-challenge-at-a-time.md`.

## Summary (plain language, 3-5 lines)
The learner console is rebuilt. A learner sees one challenge at a time with a countdown ring (Easy 20, Medium 40, Hard 60 minutes, started by Begin), a rail of progress, the hints and the flag box, and the account points in the top bar. After a capture the page shows the result and the write-up and offers the next challenge; after a finished run it offers a new run.

## Why
The live page showed a finished attempt with no way to start and no challenges; the developer asked for a simple sandbox-style UI with one challenge at a time.

## What was built
- `index.html`, `style.css` (tokens inspired by the Radix colour scale, light and dark), `app.js` (state-driven views), self-hosted fonts `fonts/` (Atkinson Hyperlegible Next for text, Martian Mono for numbers and labels, both SIL Open Font Licence, see `fonts/NOTICE.txt`).
- Works with a server that is not sequenced (every challenge open, no countdown, no account points).
- A refused call re-checks the session before signing the learner out; the loads run one after the other.

## Files changed
`apps/lab-console/*`, `scripts/lab-console.test.mjs`, records, screenshots in `docs/assets/lab-console-redesign/`.

## Decisions made
None new. Fonts and theme choice follow the research done with the ui-ux-pro-max guidance (Atkinson for legibility, a monospace for the countdown); the developer can change them.

## Tests
- `node --test scripts/lab-console.test.mjs` — 10 passed (fake DOM and scripted API: one challenge, Begin, hints, flags, next challenge, expiry, new run, not-sequenced fallback, no markup injection, Burp link).
- Real Chrome (headless, CDP) against the real lab API on the fake instance host with `sequenced = True`: sign in, start, the intro with 20:00, Begin, the ring counting down (18:29 to 18:27), hint 1 revealed, a wrong flag answered with the rate-limit text, phone width without sideways scroll, light and dark. Screenshots in `docs/assets/lab-console-redesign/`.
- Not run: a capture of a real flag in the browser (the fake instance host has no shop); the live site.

## Problems met and how they were fixed
- The local harness (one shared SQLite connection) answered parallel requests with 401 and 500 (38 of 40 bursts); sequential requests were clean. Production uses a Postgres pool, so this is a harness limit; the console now loads in order and re-checks the session before signing out.
- A re-render while an expired challenge was shown caused an extra refresh; the refresh now only follows an active countdown.

## Security notes (vulnerable parts only)
None. Server text is set with textContent only (checked by a test); the shop tab is opened with `opener = null`.

## Limitations and follow-ups
Live check after the deploy (story 12).