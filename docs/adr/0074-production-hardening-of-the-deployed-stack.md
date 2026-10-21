# 0072. Production hardening of the deployed stack: dashboards, scheduler, real mail, fail-closed starts

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** the leader (instruction of 2026-10-21, work package C), Claude
- **Requirements:** wiring audit 2026-10-21 F-02, F-03, F-04 and section 3 (stubs reachable in production); tracker audit 3.5 items 1, 2, 8; handoffs H-358, H-111, H-123, H-125; D-102, D-104, D-105

## Context
The audit found a deployed stack that looked finished and was not: no dashboards (every page path served the learner console), the retention scheduler off (no invite expiry, no erasure after the undo window), mail going to a catcher nobody reads, Valkey with no password that could evict queued mail ids, and several places where a missing setting silently turned into an in-memory fake.

## Options considered
1. **Dashboards on Vercel, the rest on vm-p.** Cheaper in RAM, but a second origin: cookies, CSRF and the origin secret then cross sites, and the deployed verification script would need two bases. Rejected for the demo.
2. **Dashboards as a container on vm-p behind the same Caddy (chosen).** One origin, `apps/web` built with `output: 'standalone'`, a distroless runtime image, 192 MB limit (measured 57 MiB idle, 107 MiB after the verification run). Caddy routes only the page folders of `apps/web/app` and `/_next/*` to it; Next sets its own per-request nonce CSP, so Caddy sets none there (two CSP headers would intersect and break the pages). `/api/*` stays Caddy to the API with the origin secret.
3. **Scheduler as a separate service.** The jobs already run under a lease in `job_runs` (ADR 0054) and several processes may run them; a separate service costs 256 MB of the 1.9 GB host for no gain. The scheduler runs in the `api` process (`VULNMART_SCHEDULER_ENABLED=true`).
4. **Mail.** Brevo by default; Mailpit only behind the compose profile `mail-catcher`, switched on by `live-deploy.mjs platform --allow-mail-catcher`. Production refuses to start when the effective mail goes to a catcher (provider `smtp` with host mailpit, MailHog, loopback or no host) unless `VULNMART_ALLOW_MAIL_CATCHER=true`, and refuses provider `brevo` with an empty key. The key is a file (`secrets/brevo_api_key`) that the leader places; the repository never holds it.
5. **Fail closed.** `Settings.check_stores_for_environment` (called by `get_settings`, so by every service start) refuses staging and production without `VULNMART_POSTGRES_DSN`, and without `VULNMART_KEYSTORE_DSN` for the api, ingest and live services. The API's `LiveOutbox` has no email stand-in in production (it carries domain events only; mail is written by `DbOutboxPort` in the caller's transaction). The check lives in the settings, not in `build_ports`, so the existing tests of the other start checks (Valkey, field secret) keep their order. The lab runtime guard (FakeInstanceHost, in-memory stores) belongs to the attempt-lifecycle package.
6. **Valkey.** Password, append-only file on the named volume `valkey-data` (`everysec`), `maxmemory 64mb`, policy `volatile-lru` (not `noeviction`: the rate-limit counters all have a TTL and must be evictable, otherwise a full memory would make every login fail; queued mail ids and live streams have no TTL and are never evicted; if they alone filled 64 MB a write fails loudly). The same settings in the development compose so development finds the same problems.
7. **A lint of the deployed files.** `scripts/check-deployed-compose.mjs` reads `platform.compose.yaml` and `Caddyfile.platform` and fails on: scheduler off, the catcher by default, no Brevo key mount, a fake or missing orchestrator address, a non-Postgres lab store, Valkey without persistence or password or with `allkeys-*`, a dashboards page folder without a Caddy route, a CSP set on the dashboards, a missing hardening flag, or memory limits that do not fit the host. It runs in CI.

## Decision
Options 2, 3, 4, 5, 6 and 7. CI also runs `scripts/check_spec_routes.py` (every contract operation has a route and the reverse), `scripts/check-pytest-skips.mjs` (the `api` job now has Valkey and allows zero service skips; the `scripts` job has a budget of 250 against the 241 measured) and builds the production web image.

## Consequences
- The leader must place `keys/brevo_api_key` (and verify the sender domain in Brevo) before a normal deploy; without it `live-deploy.mjs platform` stops. This is the one external blocker.
- Memory: the resident limits add up to under 1700 MB (checked by the lint).
- The dashboards image is built on the PC and shipped like the API image (`docker save`), not pulled.
- A key-less staging demo is still possible, knowingly, with `--allow-mail-catcher`; it logs a warning at every start.

## Evidence
- Next.js standalone output and the distroless Node image: Next.js documentation, "output: standalone"; GoogleContainerTools/distroless (nonroot tag, digest pinned in the Dockerfile).
- Valkey eviction policies and append-only persistence: valkey.io documentation, "Key eviction" and "Persistence" (`volatile-lru` evicts only keys with an expire set; `appendfsync everysec` loses at most one second).
- Local proof (2026-10-21): the dashboards container behind the real `Caddyfile.platform` and the real API answered `node scripts/verify-deployed.mjs` with every page check passing; recorded in `docs/dev-log/2026-10-21-tannmayygupta-wp-c-deployment-hardening.md`. The deployed host itself was not touched.
