# C03 part B: the support bot runs the player's script (stored XSS end to end)

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | l-c03b-bot-xss |
| Status | Done on the live lab; not looked at in a real browser |
| Report tag | Lab stream, C03 part B, support bot, ADR 0061 |

## Requirements covered
C03 (part B), FR-SHP-11, FR-CHL-04, challenge-specs 3.2 to 3.7, IF-4 events `bot.visit` and `collector.hit`, IF-6 1.0.1, spike S-5.

## Summary (plain language)
Part B of the injection challenge could not be played: nothing ever opened the stored ticket in something that runs scripts. Now a customer sends a ticket with a script in it, the support agent's browser (the bot of the instance) opens it a few seconds later under its own session, the script reads the agent profile (which holds the flag for that session only), sends it to the collector, and the customer reads it on a new Listener page and pastes it.

## Why
The task brief asked for every challenge to be solvable end to end. C03B was the one that was not (57 of 58 live checks before this).

## What was built
- Bot (`services/bot`): a visitor that runs page scripts in jsdom, one child process per visit (empty environment, heap limit, Node permission model, hard time limit); a network layer that allows only the shop and the collector and tags every request; shims for fetch, XMLHttpRequest, images, beacons; emulation of the agent's browser (image errors, load, focus, mouse events). The controller takes a session and a ticket id, runs one visit at a time and reports `bot.visit` start and end.
- Shop: the bot queue (3 s delay, one visit per ticket, 10 visits in 10 minutes, 2 KB body limit), a signed bot session, a scope rule (one ticket page and the agent profile only), `GET /staff/api/agent-profile` (flag as `console_key` for the bot session in the vulnerable build only), a customer Support page (`/tickets`), "Agent has viewed this ticket at hh:mm", and the Listener page `/lab/listener`.
- Mock-services collector: `/c/<id>` with id check, visit tag check, 1x1 GIF and open CORS, `collector.hit` to the sidecar (ids and counts only), `/inbox` with the last 20 hits.
- Contracts: IF-6 1.0.1 (example templates give mock-services and the bot the event and mock addresses); catalogue text for C03 (start and hints).
- ADR 0061 (why jsdom and not Chromium, and what is built around its limits).

## How it works
Player ticket, shop queue (3 s), bot controller `/visit` with a fresh signed session, jsdom child process loads `/staff/tickets/<id>` as `bot.support`, the script runs, its requests go through the network layer, the collector records the hit and tells the sidecar, the Listener page shows the content to the player.

## Files changed
- `services/bot/src/{browser,visit-worker,controller,main}.mjs`, `services/bot/Dockerfile`, `services/bot/{package.json,pnpm-lock.yaml}`, root `pnpm-lock.yaml`, tests `services/bot/test/{browser,bot}.test.mjs`
- `services/mock-services/src/server.mjs` and its test
- `apps/shop/src/challenges/c03b-bot.mjs`, `apps/shop/src/{app.mjs,web/routes.mjs,web/routes-staff.mjs,domain/shop-service.mjs}`, views `ticket.njk`, `tickets.njk`, `lab/listener.njk`, `layout.njk`, test `apps/shop/test/web/c03b-bot.test.mjs`
- `challenges/tests/c03-injection/{live-loop.test.mjs,exploit.live.mjs}`, `challenges/catalog/c03.yaml`
- `contracts/instance/examples/valid/instance-template/*.json`, `contracts/instance/instance-contract.md`, `contracts/CHANGELOG.md`, `contracts/COMPAT.md`
- `docs/adr/0061-support-bot-runs-page-scripts-in-jsdom.md`

## Decisions made
ADR 0061 (status Proposed until the developer confirms it for `initial.md` Section 15). Alternatives: headless Chromium (too heavy for seven instances per host), regex check (no loop). The placeholders of challenge-specs 3.2 were set to 3 s delay and 5 s open time instead of 10 s and 15 s to keep the player's loop short.

## Tests
Real commands and results:
- `node --test test/browser.test.mjs` (services/bot): 9 pass (script reads the profile under the bot session and reaches the collector tagged; img onerror, svg onload, autofocus, mouseover, click payloads run; XHR and sendBeacon; HttpOnly cookie not readable; no request to any other origin; the page cannot replace the tag; the escape probe; `while(true){}` is stopped at the time limit; error page ends the visit).
- `node --test test/bot.test.mjs`: 11 pass (3 new: session and events, one visit at a time, bad session refused).
- `node --test` in `services/mock-services`: 8 pass (2 new for the collector).
- `node --test test/web/c03b-bot.test.mjs` (apps/shop): 8 pass, run three times in a row after one flaky run was fixed (the first test looked at the page after the agent had already been; the queue now waits 400 ms in that test). Whole shop suite: see below.
- `node --test` on all `challenges/tests/**/*.test.mjs`: 42 pass, including `live-loop.test.mjs`: the real shop, the real bot controller with its browser and the real collector: the flag reaches the Listener page in the vulnerable build; in the fixed build the bot visits and nothing reaches the collector.
- Hardened container run (`--read-only --cap-drop=ALL --security-opt=no-new-privileges --memory=128m --cpus=0.5 --pids-limit=64`, distroless image): the script ran and the collector got a tagged hit; sampled peak 81 to 92 MiB; a visit took 12.7 s at 0.5 CPU with the older 8 s dwell (about 6 s start-up).
- `node scripts/validate-contracts.mjs`: PASS; `node scripts/check-contract-rules.mjs`: 18 PASS 0 FAIL; `node scripts/validate-catalog.mjs`: 11 validate; `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests`: 473 passed.

- Live (lab redeployed with `live-deploy build`, `ship-i`, `lab`; the platform was not redeployed for this task): `node scripts/e2e-live-exploits.mjs --only C03` 7 PASS, 0 FAIL: the exploit works against a deployed instance (part A, then part B: ticket with an image onerror payload, the flag read on the Listener page, "Agent has viewed this ticket"), the sidecar credited the capture by itself (M3), pasting gives "correct", the flag of another learner's instance is refused. A first run failed on the "viewed" line only (the shop notes a visit when the agent closes the ticket, after the script ran); the exploit now waits for it.
- Live: `node scripts/e2e-live.mjs` after adding a sweep of all 11 challenges x 3 hints (ordered unlock, text only after the unlock, a repeat is free, no hint holds a flag, unknown key or level refused): 38 PASS, 0 FAIL. The first attempt got HTTP 429 (the exploit runs had filled the lab); with the developer's yes, `live-free-test-instances.mjs --apply` freed 7 attempts and the rerun passed.

## Evidence
`docs/assets/c03b-bot/exploits-live-c03b.json`, `docs/assets/production-readiness/e2e-run-hints-all.json`.

## Problems met and how they were fixed
- jsdom 28 has no `ResourceLoader`; resources go through `requestInterceptor` (found by running the worker, fixed).
- The test probe showed that `setTimeout.constructor('return process')()` returned the worker's `process`: jsdom's own functions belong to the worker's realm. Closed in the worker (see ADR 0061) and covered by the probe test.
- A first test run hung: one test leaked a server (never closed); fixed.
- PowerShell mangled the escaping in two edits (a lost path separator, a stray tab); found by the failing run and fixed by hand.
- My ADR number 0057 collided with Akshay's admin-operations ADR; renumbered to 0058. It collided again with Akshay's candidate-invite record 0058 on main and moved to 0061 (handoff H-357, 2026-10-20).

## Security notes (vulnerable parts only)
Weakness: stored XSS (CWE-79) in the support console. The flag lives in the agent profile of the bot account (`console_key` returned by `/staff/api/agent-profile` to the bot session only). Outline: send a ticket whose message runs a script that fetches the profile and sends it to the collector address on the Listener page. jsdom is not a security sandbox; the boundary is the container (ADR 0061).

## Limitations and follow-ups
Navigation-based payloads (`location = ...`) are not emulated. The demo memory stays 128 MB for the bot. The Windows run of `live-loop.test.mjs` works (no unix sockets involved).