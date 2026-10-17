# Support-agent bot (T-13)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | Sahil Roy |
| Branch / commit | sprint-2-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 2, support-agent bot (FR-SHP-11, spike S-5) |

## Requirements covered
FR-SHP-11 (a support-agent bot that opens only pages of its own instance for a fixed time) and spike S-5 (its memory per instance). BMAD story 2.6 of `epic-shop-instance-integration`. Completes the Sprint 2 instance-integration tasks.

## Summary (plain language, 3-5 lines)
Built the support-agent bot controller: a service on port 9200 that, on a `/visit` trigger, opens only pages whose origin is its own instance target and whose path is allow-listed, refuses everything else (other origins, protocol-relative/absolute cross-origin URLs, non-allow-listed paths), bounds each visit by a timeout, and reports its memory. It is the controller with a pluggable visitor (default an HTTP GET); the headless-browser visitor that executes page JS for C03 and its full memory profile are the S-5 spike / C03 work. Proven with unit tests and a Docker harness that also measures the bot's memory per instance (the controller baseline is ~17 MiB).

## Why
C03 is stored XSS that fires when the support-agent bot renders a ticket/dispute. The bot must be tightly scoped — opening only its own instance's pages — or it becomes an SSRF/pivot; and it must run for a fixed time and have a known memory footprint (S-5) so many instances can run at once.

## What was built
- `services/bot/src/controller.mjs` — `isAllowed` (same-origin + allow-listed prefix), `visitHttp` (time-bounded GET), `createBotController` (`/visit`, `/healthz`, `/stats`).
- `services/bot/src/main.mjs` — entrypoint on 9200; target, allow-prefixes and max-visit from env.
- `services/bot/Dockerfile` — hardened distroless, no deps, healthcheck.
- `services/bot/test/bot.test.mjs` — allow-list, refusals, time-bound, memory.
- `services/bot/instance-harness/bot-check.mjs` — the Docker proof + S-5 memory measurement.

## How it works
`/visit {path}` resolves `new URL(path, target)` and allows it only if its origin equals the bot's instance target and its path starts with an allow-listed prefix (WHATWG URL normalizes `..` and rejects cross-origin tricks); otherwise 403. The visit is a time-bounded HTTP GET (`redirect:'manual'`, so it does not follow a redirect off the allowed page), recorded with its status and duration. `/stats` reports `process.memoryUsage()`; the harness reads the container's memory via `docker stats`.

## Files changed
- `services/bot/{src/*, Dockerfile, package.json, test/*, instance-harness/*}` — new.

## Decisions made
A pluggable visitor keeps the SSRF-sensitive allow-list and the time bound in the controller, independent of the visitor (HTTP now, headless browser at S-5). Same-origin + path-prefix allow-list is the gate. Node built-ins only. The real headless-browser bot (for C03 page JS) and its memory profile are the S-5 spike; the controller's measured baseline is ~17 MiB.

## Tests
Real commands and results:
- `node --test "services/bot/test/**/*.test.mjs"` → **8 passed**: `isAllowed` (same-origin + prefix only); visits an allowed page time-bounded; refuses `/admin`, `http://evil…`, `//evil…`, `/staff/users`; bad input → 400; `/stats` reports memory; the HTTP visitor bounds a hung target by the timeout.
- `pnpm --filter @vulnmart/bot run bot:check` (Docker 28.5.1) → **`bot: PASS (5 checks)`**: the bot answers, visits an allow-listed page of its instance, refuses a non-allow-listed path and a page of another origin, and its memory per instance is measured (S-5 baseline, controller only: **~17 MiB**).
- Traceability row FR-SHP-11 added in `docs/traceability.md`.

## Evidence
Test + harness output above; the harness runs the real bot image with a target on the instance network and reads the bot container's memory.

## Problems met and how they were fixed
(Review findings and fixes recorded in the story's Review Triage Log.)

## Security notes (vulnerable parts only)
No deliberate weakness — this is the scoping. The bot opens ONLY its own instance's allow-listed pages; other origins and non-allow-listed paths are refused (preventing the bot becoming an SSRF/pivot). Each visit is time-bounded and does not follow redirects off the allowed page. Hardened container, instance-network only.

## Limitations and follow-ups
- The headless-browser visitor that actually executes page JS (needed for C03's stored XSS to fire) and its full memory profile are the spike S-5 / the C03 challenge; this story delivers the controller with an HTTP visitor and a memory baseline (~17 MiB).
- The live docker-compose wiring of the bot into a full instance (triggered by a customer opening a ticket) is L-13; T-13 proves the controller, its allow-list and its memory via its own harness.
