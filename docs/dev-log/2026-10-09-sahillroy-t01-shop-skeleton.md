# Shop skeleton runs in a container (T-01 tracer bullet)

| Field | Value |
|---|---|
| Date | 2026-10-09 |
| Developer | Sahil Roy |
| Branch / commit | sprint-1-sahil |
| Status | Done |
| Report tag | Target stream, Sprint 1, baseline tracer bullet |

## Requirements covered
TB-3 (shop skeleton meets the instance contract's health surface: `/healthz`, `/readyz`, `/version`), TB-5 (developer environment verified on Sahil's PC). BMAD story 1.1 of `epic-target-baseline`. Related: FR-SHP-15, NFR-POR-03, Q-24.

## Summary (plain language, 3-5 lines)
Built the thinnest runnable VulnMart shop: an Express app on Node 24 that answers the three health endpoints the instance contract defines, packaged as a hardened container (non-root, read-only root filesystem, dropped capabilities, no-new-privileges, memory and pids limits). Proved it with `docker run` on Sahil's Windows PC: all three endpoints return 200 and Docker reports the container healthy. This is the running baseline every later Target-stream story builds on.

## Why
The Target baseline epic needs a tracer bullet so the lab and platform have a real shop to render and score against before the challenges exist (architecture 07 section 3.2, decisions D-33/D-35). T-01 was blocked on L-01 (repository skeleton); L-01 merged to `main`, so the shop folder `apps/shop/` now has a home and the story was unblocked.

## What was built
- `apps/shop/` package `@vulnmart/shop` (ESM, Express pinned 5.2.1).
- `GET /healthz` → `{status:"ok"}` (process up), `GET /readyz` → `{status:"ready"}` (200; marker gating is T-04), `GET /version` → `{build, catalogue_version}` from the environment, never a secret. Unknown routes return `404 {code:"SHOP-NOT-FOUND"}`; a 4-arg error handler returns the same JSON shape instead of Express's default.
- A hardened two-stage Dockerfile: a `node:24.21.0-bookworm-slim` builder (frozen pnpm install) and a `gcr.io/distroless/nodejs24-debian12:nonroot` runtime (uid 65532, no shell), both pinned by digest, with a Docker `HEALTHCHECK` on `/readyz`.
- Unit tests for the endpoint behaviour, and a CI `app tests` job so `apps/*/test` run on every pull request.

## How it works
`src/app.mjs` exports `createApp()` so tests can drive the routes without binding a port; `src/server.mjs` resolves and validates `PORT` (default 3000), binds it inside the container, handles `listen` errors, and shuts down cleanly on SIGTERM/SIGINT with a forced-exit fallback. The host publishes the port on 127.0.0.1 only. The container writes nothing to its root filesystem (read-only); `/tmp` is a tmpfs.

## Files changed
- `apps/shop/package.json` — new workspace package, Express pinned.
- `apps/shop/src/app.mjs` — app factory and the three endpoints, 404 and error handlers.
- `apps/shop/src/server.mjs` — entrypoint: PORT validation, listen-error handling, graceful shutdown.
- `apps/shop/Dockerfile`, `apps/shop/.dockerignore` — hardened image, digest-pinned bases, frozen install.
- `apps/shop/pnpm-lock.yaml` — shop-local lockfile for the reproducible image install.
- `apps/shop/test/app.test.mjs` — unit tests for the I/O matrix.
- `.github/workflows/ci.yml` — new `app tests` job (shared CI; co-owned, flagged to the team).
- `pnpm-lock.yaml` (root) — adds the shop's Express to the workspace lockfile.
- `docs/bmad/initiative-target/epic-target-baseline/` — story plan, settled unknown, dated decision.

## Decisions made
No ADR raised for a tracer bullet. Two decisions recorded in the story plan: (1) the in-instance images use a distroless non-root base (uid 65532, no shell), which fits read-only rootfs and cap-drop ALL and matches the instance contract's 65532:65532 proposal; this pattern is a candidate for a formal ADR once more Target images adopt it. (2) The committed, re-runnable proof of the hardened container run is left to T-04's compose/harness wiring; for T-01 the proof is the captured `docker run`/`docker inspect` output in Evidence.

## Tests
Real commands and results:
- `corepack pnpm --filter @vulnmart/shop test` → `node --test`: 5 passed, 0 failed.
- `node --test "apps/*/test/*.test.mjs"` (the CI command): 5 passed, 0 failed.
- `corepack pnpm install --frozen-lockfile` (root): lockfile up to date, passes.
- `docker build -t vulnmart-shop:t01 apps/shop`: image builds.
- `docker run` with the hardening flags, then curl: `/healthz` 200 `{"status":"ok"}`, `/readyz` 200 `{"status":"ready"}`, `/version` 200 `{"build":"dev","catalogue_version":"dev"}`, `/nope` 404.
- `docker inspect`: ReadonlyRootfs=true, CapDrop=[ALL], SecurityOpt=[no-new-privileges=true], Memory=536870912, PidsLimit=256; `docker exec` uid=gid=65532; Docker health status `healthy`; port bound 127.0.0.1:3000.
Traceability rows TB-3 and TB-5 updated in `docs/traceability.md`.

## Evidence
`docs/assets/t01-shop-skeleton/run-output.txt` — full captured output of the environment check, unit tests, build, container run, endpoints and `docker inspect`.

## Problems met and how they were fixed
- The repo pins Python 3.14.8, but the installed uv (0.11.24) could not fetch it. Updated uv to 0.12.24 and installed Python 3.14.8 so the BMAD scripts run.
- `corepack`'s pnpm 12.10.1 shim was broken (looked for `pnpm.cjs`; the package ships `pnpm.mjs`). Cleared the corepack cache and re-prepared with corepack 0.36.0; the same fix is baked into the Dockerfile builder.
- Windows Git Bash rewrites container paths like `/tmp` and `/nodejs/bin/node` into Windows paths; `docker run`/`exec` need `MSYS_NO_PATHCONV=1`. Recorded for the other developers.

## Security notes (vulnerable parts only)
None. This is the neutral shop skeleton with no challenge, no flag and no secret. `/version` returns only a build id and catalogue version; a test asserts it exposes no other keys. `x-powered-by` is disabled and error bodies carry no stack traces.

## Limitations and follow-ups
- `/readyz` returns ready unconditionally; T-04 adds the injector-marker gate (`/run/vm/injected`) and the test for the not-ready branch.
- `/version` build id and catalogue version are `dev`; stamping a real build id and confirming the env var names against the instance contract allowlist is raised for T-03. See `docs/bmad/initiative-target/deferred-work.md`.
- The distroless runtime ships Node 24.14.0 (from its digest); the repo pin 24.21.0 governs local and CI Node. Both satisfy `>=24 <25`.
