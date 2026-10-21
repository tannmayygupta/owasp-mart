# Deferred work (initiative-target)

## Deferred from: code review of story-shop-skeleton-runs-in-a-container-tracer-bullet-plan (2026-10-09)

- `/version` reads `VM_BUILD_ID` and `VM_CATALOG_VERSION`, which are not on the instance-contract section 2 env allowlist, and nothing stamps a real build id (so `/version` is permanently `dev`). Raise in T-03 (instance-contract consumer review): either add these names to the contract or wire a Docker build-arg to stamp the build id.
- `/readyz` not-ready (503) branch is unreachable because `isReady()` is hardcoded `true`, so it has no test seam. T-04 adds the injector-marker gate (`/run/vm/injected`) and the test that exercises both the ready and not-ready branches.

## Deferred from: code review of story-challenge-catalogue-schema-and-11-stub-entries-if-7-plan (2026-10-09)

- No consistency rule between `flag.placement` and `flag.delivery` in the IF-7 schema/validator. Deferred: the stub placements are provisional and `delivery: env` has no matching placement, so a strict coupling could be wrong now. Confirm the real placement/delivery pairs per challenge in T-19..T-29 and add the rule then.

## Deferred from: code review of story-shop-identity-six-roles-permissions-and-strong-hashing-plan (2026-10-09)

- No brute-force throttling, lockout, or attempt accounting in `authenticate`. Deferred: lockout and security-event emission belong to the login flow (T-14) and interact with C07 (weak password reset) and C09 (unlogged legacy login). The `needsRehash` seam and `security_events`/`alerts` tables are in place for that work.
- Rehash-on-successful-login (using `needsRehash`) is wired by the login flow (T-14), not the identity primitives.

## Deferred from: code review of story-customer-flows-plan (2026-10-11)

- No login throttling/lockout or security-event emission on `/login` (T-14). Deferred: the attempt-logging and lockout model is entangled with C09 (what gets logged) and C07 (password reset); design it alongside the C09 logging story. The `security_events`/`alerts` tables and the `needsRehash` seam are ready.

## Deferred from: code review of story-support-finance-and-admin-flows-plan (2026-10-11)

- ~~`setUserStatus` (admin manage-users) has no self-suspend / last-admin guard...~~ **RESOLVED 2026-10-16 (PR #14 review B):** `setUserStatus` now refuses suspending your own account or the last active admin (`apps/shop/src/domain/staff-service.mjs`), with tests in `apps/shop/test/staff-service.test.mjs`.
- The service layer calls `can(role, action, {})` with an empty ctx. Safe today because every staff-reachable matrix cell is unscoped (`true`/`amounts_only`); if a staff action ever gains a scoped rule (`own`/`own_store`), pass real ctx so the matrix check is not a no-op behind `requireRole`.
- `assignTicket` and `holdPayout` endpoints exist and are gated but have no UI control yet (reachable only by direct POST). Add the buttons with the fuller staff screens.

## Deferred from: T-09 (health, readiness and runtime profile)

- ~~In instance mode the shop serves only the health surface... needs lazy-db wiring...~~ **RESOLVED 2026-10-16 (A2a, PR #14):** `server.mjs` mounts the marketplace on `lazyDb(readiness.getDb)` and `app.mjs` gates marketplace routes behind `isReady()` (503 until the marker), and the login/checkout routes emit real events. Proven by the T-10 harness (12/12) and `apps/shop/test/instance/instance-events-wiring.test.mjs`.
- The runtime profile in T-09 is applied by the shop-owned harness's `docker run` flags, mirroring IF-6 section 7. Binding it to the real orchestrator's instance template (and running the real shop through Tanmay's lab harness with shop-agnostic live-checks) is L-13.
- Running `apps/shop/instance-harness/shop-instance-check.mjs` in CI (Docker) is a possible regression guard; it runs locally today.

## Deferred from: T-11 (mock-services)

- **H-120 (C11 KYC error shape):** the correct KYC mock returns 400 on malformed input (fails closed). RS-F C11 has the provider reply 500 so the shop's `try/catch` fails open and auto-approves. The C11 challenge story decides whether the mock should 500 on the specific malformed shapes it abuses, or the shop's fail-open treats a 400 as an error. Keep the mock correct until then.
- **H-121 (C10 metadata detection event):** the metadata mock records requests internally but does not yet emit the `meta.request_served` event (source `mock`) that is C10's primary detection signal. Emit it with the events/monitor work (the mocks' event emission — `gateway.ledger_entry`, `collector.hit`, `meta.request_served` — is deferred alongside the shop's event wiring).
- Live docker-compose wiring of mock-services into a full instance (with the `/run/placement/mock` volume mounted and `VM_MOCK_URL` reachable by the shop) is L-13; T-11 proves the container + its network boundary via its own reachability harness.

## Deferred from: PR #14 second review (2026-10-16, Tanmay)

Accepted as deferred by the reviewer; each is a baseline robustness gap, not planted challenge surface, to be done in a later target story.

- **Stock check at payment with `BEGIN IMMEDIATE`.** `checkout` reads stock then writes in the same transaction but does not take an immediate write lock, so two concurrent checkouts of the last unit could both pass the `stock >= qty` check (node:sqlite serializes within one process, so this is latent until a multi-connection path exists). Wrap the stock-check-and-decrement in `BEGIN IMMEDIATE` when the money/seller story (T-18) touches this path.
- **List paging.** The staff/customer list queries (`listProducts`, `listOrders`, `listTickets`, `listDisputes`, `listPayouts`, `listUsers`) have no `LIMIT`/paging; the audit log and alerts already cap at 200. Add paging with the fuller staff screens; bounded today by the seeded data size.
- **Field length limits.** Shipping address, ticket subject/body and review body are not length-capped at the service layer (the DB columns are TEXT). Add validation caps with the seller/content stories.
- **Seeded-password per-instance overwrite (D-02).** The seed uses one demo password across accounts; whether each instance overwrites seeded passwords with per-instance values is the injector owner's call (D-02). Track with the challenge-account story (T-16 follow-up) and the injector design.

## Deferred from: T-21 (C03 Injection)

- **C03 part B live exfiltration loop.** The shop-side stored XSS is done (the ticket message is stored, and the support-console ticket detail renders it raw on the vulnerable build / escaped on the fixed build, with `shop.ticket_markup_stored`). The remaining part — the headless support bot opening the ticket, the injected script reading the bot's `/support/api/agent-profile` token, and the in-instance collector receiving it with `collector.hit` (`bot_tagged`) — needs the bot's headless browser (deferred to the bot headless-visitor work, S-5 / H-44) and `/support/api/agent-profile` (challenge-specs Section 3.5). Do it with the bot-browser story; the detection signal and the fix (escaping) are already in place.
  - **Status 2026-10-21 (records reconciliation): the "live loop deferred" wording above is stale.** The C03 exploit passes on the deployed instance (`docs/assets/production-readiness/exploits-live-c03b.json`) and the release gate is 11/11 including C03 (tracker audit 5.1, T-21). Remaining for C03: the bot is a jsdom visitor (ADR 0061), not a real headless browser; that choice is open (tracker audit 5.4 item 5).

## Deferred from: T-27 (C09 Logging Failures)

- **IF-4 `shop.security_event_written` platform event.** The shop-side C09 pipeline is done (the `security_events` table + `alerts`, read by the C09 proof). The matching IF-4 platform event `shop.security_event_written` (the M2 negative-observation signal) is NOT emitted yet, because the posted event schema (`contracts/events/instance-events.posted.schema.json`, IF-4, stream L) does not list it, and emitting an unknown type fails the posted-schema validation the T-10 harness enforces. Emit it once IF-4 adds the per-challenge event names (a contract change / handoff to stream L); `recordAuth` keeps the `emit` parameter ready. Same situation applies to the other per-challenge event names used by the exploit tests (`shop.cross_store_order_read`, `shop.giftcard_attempt`, `shop.catalog_query_error`, `shop.ticket_markup_stored`, `shop.refund_decision`, `shop.refund_invariant_broken`, `ops.page_served`, `shop.verbose_error`, `auth.reset_requested`, `webhook.received`): they are emitted only during challenge flows (not the baseline login/checkout the T-10 harness exercises), so they do not break it today, but they also need adding to IF-4 before the sidecar will accept them in a live instance.
  - **Status 2026-10-21 (records reconciliation):** `contracts/events/app-events.md` now lists these names and the shop emits all of them except `shop.security_event_written`, which `c09-logging-failures.mjs` still drops (`void emit`). Fixing it is work package d (shop and challenges); tracker audit 5.1 T-27, 5.4 item 2.

## Blocked: T-32 (Deployed verification on the instance VM)

- T-32 runs all 11 exploit tests against a DEPLOYED instance on vm-i (each passes on the vulnerable build, fails on the fixed build). It needs Tanmay's deployment (L-12 image builds/release manifest, L-15 socket proxy, L-17 edge/Caddy) and live AWS/vm-i access, so it is a developer runbook step, not runnable from the shop repo or CI. The equivalent local proof is in place: `node scripts/release-gate.mjs` runs all 11 exploit self-tests against the real shop in both builds (11/11), and the exploit-runner CI job enforces the same. Do T-32 once Tanmay's instance is deployed; the story (epic-catalogue-hints-and-verification entry 3) carries the unknown.
