---
title: 'Support-agent bot'
type: 'feature'
ticket: '6'
created: '2026-10-12'
status: 'done'
baseline_revision: '656f101'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: ['security']
review_loop_iteration: 1
context:
  - '{project-root}/contracts/instance/instance-contract.md'
  - '{project-root}/docs/research/RS-E-challenges-01-06.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FR-SHP-11 requires a support-agent bot that opens only pages of its own instance for a fixed time — the victim that renders a future C03 stored-XSS payload under the support-agent role. None exists (`services/bot/` is a placeholder). Its memory per instance must be measured (spike S-5).

**Approach:** Build the bot CONTROLLER in `services/bot/` (port 9200): a `/visit` trigger that opens only pages whose origin is the bot's own instance target and whose path is allow-listed, refuses everything else, bounds each visit by a timeout, and reports its memory (`/stats`). A pluggable visitor (default an HTTP GET, Node built-ins); the headless-browser visitor that executes page JS for C03 and its full memory profile are the S-5 spike / C03 work.

## Boundaries & Constraints

**Always:** Opens ONLY same-origin (its instance target) + allow-listed path prefixes; refuses other origins, protocol-relative/absolute cross-origin URLs, and non-allow-listed paths; each visit is time-bounded; memory is measurable; Node built-ins only; hardened (non-root 65532, read-only). Stay in `services/bot/`.

**Never:** No visiting arbitrary/external URLs (SSRF/pivot); no unbounded visit; no deliberate weakness.

## I/O & Edge-Case Matrix

| Trigger | Expected |
|---------|----------|
| `POST /visit {path}` same-origin + allow-listed | visited (status, duration recorded) |
| path not allow-listed (e.g. `/admin`) | 403 refused |
| other origin (`http://evil/...`, `//evil/...`) | 403 refused |
| bad/missing path | 400 |
| a hung target | visit returns promptly via the timeout (status 0) |
| `GET /stats` | visit count + `process.memoryUsage()` |

## Code Map

- `services/bot/src/controller.mjs` -- new; `isAllowed`, `visitHttp` (time-bounded GET), `createBotController` (/visit, /healthz, /stats).
- `services/bot/src/main.mjs` -- new; entrypoint on 9200, target + allow-prefixes + max-visit from env.
- `services/bot/Dockerfile` -- new; hardened distroless, no deps, healthcheck.
- `services/bot/test/bot.test.mjs` -- new; allow-list, refusals, time-bound, memory.
- `services/bot/instance-harness/bot-check.mjs` -- new; the Docker proof + S-5 memory measurement. `pnpm --filter @vulnmart/bot run bot:check`.

## Tasks & Acceptance

**Execution:**
- [x] Controller (allow-list, time-bounded visit, /stats memory), entrypoint, hardened Dockerfile.
- [x] Unit tests (allowed + several refusals, time-bound, memory).
- [x] Docker harness (visits allowed, refuses disallowed + other-origin, memory measured).

**Acceptance Criteria:**
- The bot visits an allow-listed page of its own instance, refuses a non-allow-listed page and a page of another origin, and each visit is time-bounded.
- Its memory per instance is measured (S-5 baseline for the controller; the browser memory is the remaining S-5 work).

## Implementation Notes

Same-origin is enforced with `new URL(path, target)` + an `origin` equality check (WHATWG URL normalizes `..` and rejects cross-origin tricks), plus a path-prefix allow-list. `redirect:'manual'` so the visitor does not follow a redirect off the allowed page. The headless-browser visitor (for C03 page JS) and its memory profile are S-5; the controller's measured baseline here is ~17 MiB.

## Plan Change Log

## Review Triage Log

### 2026-10-12 — security/correctness review (Opus)

The review confirmed the critical allow-list/SSRF axis is well-engineered: same-origin + WHATWG URL normalization closes the whole bypass battery (`http://evil/..`, `//evil`, `\\evil`, userinfo/port tricks, `..` traversal normalized before the check, `data:`/`file:`/`javascript:` → null origin, trailing-dot host). Redirects are `manual` (not followed off the allowed page); the visit is time-bounded; the request body is capped. Two real bugs were fixed:

**Fixed:**
- **Prefix boundary over-match** — `startsWith('/staff/tickets')` also matched `/staff/ticketsX`. `isAllowed` now requires the exact path or a path separator after a non-slash prefix (`p` or `p + '/'`), so a sibling path is refused. New tests cover `/staff/ticketsX` → refused and `/staff/tickets/5` → allowed.
- **Uncapped response body read (undercut S-5 memory)** — `visitHttp` did `await r.text()`, so a fast large page could OOM the bot despite the time bound. It now streams the body and cancels past a 1 MiB cap.
- Nits: added a test that a redirect off the allowed page is NOT followed (guards against a future `redirect:'follow'` regression reopening the pivot); the harness memory parser now also handles a bare-byte `MemUsage`.

**Acknowledged (notes, not fixed):** `/visit` has no authN and binds 0.0.0.0 — acceptable here because the bot is on the `--internal` instance network and the allow-list bounds the worst case to allowed prefixes; worth revisiting when the bot is wired to a trigger source (L-13). The dead `=== p` clause is kept for readability alongside the under-prefix match.

## Design Notes

A pluggable visitor keeps the SSRF-sensitive allow-list and the time bound in the controller, independent of whether the visitor is HTTP (now) or a headless browser (S-5). The harness measures the container's memory via `docker stats`.

## Verification

**Commands:**
- `node --test "services/bot/test/**/*.test.mjs"` -- expected: 8 pass.
- `pnpm --filter @vulnmart/bot run bot:check` (needs Docker) -- expected: `bot: PASS (5 checks)`.
