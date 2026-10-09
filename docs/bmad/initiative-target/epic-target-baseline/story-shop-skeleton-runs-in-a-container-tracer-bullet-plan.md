---
title: 'Shop skeleton runs in a container (tracer bullet)'
type: 'feature'
ticket: '1'
created: '2026-10-09'
status: built
baseline_revision: 'cc25d1374bdb010a585c2151843b3dadfb109bde'
route: 'full'
route_source: 'pinned'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/contracts/instance/instance-contract.md'
  - '{project-root}/docs/architecture/07-repo-and-workstreams.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Target stream (T-01, TB-3/TB-5) has no runnable shop yet. The epic's tracer bullet needs the thinnest real shop that starts in a hardened container on Sahil's PC and answers the three health endpoints the instance contract defines, so every later shop story has a running baseline.

**Approach:** Add an Express app on Node 24 under `apps/shop/` that serves `GET /healthz`, `GET /readyz` and `GET /version`, and a hardened container image for it (non-root, read-only rootfs, dropped caps, no-new-privileges, memory/pids limits). Prove it with `docker run` hitting the three endpoints. Readiness is a plain 200 here; marker-gating and real contract conformance are T-04, not this story.

## Boundaries & Constraints

**Always:** Shop listens on `PORT` (default 3000). Endpoint shapes follow the instance contract section 6/3.2: `/healthz` = process up, `/readyz` = 200 when ready, `/version` = build id + catalogue version, no secrets. Container runs as uid:gid 65532:65532, `read_only` rootfs, `cap_drop ALL`, `no-new-privileges`, writable only on tmpfs `/tmp`, limits 512 MB / 256 pids (contract row 10/11). Base image pinned by digest. Stay inside `apps/shop/`. No secrets or flag values anywhere.

**Never:** Do not implement marker-gated readiness, planted flag, app events, the injector `inject` entrypoint, mock services, the DB, or compose/harness wiring — those are T-04 and later. Do not use the reserved `/_vm/` path prefix. Do not edit another stream's folders, `scripts/`, `contracts/`, or `infra/`. Do not add egress or open non-loopback host ports.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Liveness | `GET /healthz` | 200 JSON `{status:"ok"}` | n/a |
| Readiness | `GET /readyz` | 200 JSON `{status:"ready"}` | n/a for skeleton (marker gate is T-04) |
| Version | `GET /version` | 200 JSON `{build, catalogue_version}` from env/package, never a secret | missing env → safe default `"dev"` |
| Unknown route | `GET /nope` | 404 JSON, no stack trace | handled by a terminal handler |

</frozen-after-approval>

## Code Map

- `apps/shop/.gitkeep` -- placeholder from L-01; replaced by the package files.
- `apps/shop/package.json` -- new pnpm workspace package `@vulnmart/shop`; pins Express; `start` and `test` scripts.
- `apps/shop/src/app.mjs` -- new; `createApp()` builds the Express app and routes. Exported so tests use it without binding a port.
- `apps/shop/src/server.mjs` -- new; reads `PORT`, calls `createApp()`, listens. Container entrypoint.
- `apps/shop/Dockerfile` -- new; multi-stage: builder installs prod deps, final stage is a pinned non-root distroless Node 24 image, read-only friendly, with a `HEALTHCHECK` hitting `/readyz` via `node -e fetch`.
- `apps/shop/.dockerignore` -- new; keep node_modules/tests/docs out of the build context.
- `apps/shop/test/app.test.mjs` -- new; node:test unit tests for the four I/O rows against an ephemeral listen.
- `infra/compose/compose.yaml` -- READ ONLY reference for the hardening pattern (hello service); do not edit.
- `contracts/instance/instance-contract.md` -- READ ONLY; endpoint shapes, ports, limits, user, reserved paths.

## Tasks & Acceptance

**Execution:**
- [ ] `apps/shop/package.json` -- create the workspace package, pin `express` to an exact version, add `start` (node src/server.mjs) and `test` (node --test) -- gives the shop a home and a reproducible dep.
- [ ] `apps/shop/src/app.mjs` -- implement `createApp()` with the three endpoints, a JSON 404 terminal handler, and no `/_vm/` route -- the shop's behavior, testable without a port.
- [ ] `apps/shop/src/server.mjs` -- bind `PORT` (default 3000) on all interfaces inside the container, log listen line -- container entrypoint.
- [ ] `apps/shop/Dockerfile` + `apps/shop/.dockerignore` -- hardened multi-stage image, non-root 65532, read-only rootfs, HEALTHCHECK on /readyz -- satisfies the container hardening invariants.
- [ ] `apps/shop/test/app.test.mjs` -- unit-test the I/O matrix rows -- proves endpoint behavior in CI without Docker.

**Acceptance Criteria:**
- Given the image is built, when `docker run` starts it with the hardening flags and `-p 127.0.0.1:3000:3000`, then `/healthz`, `/readyz` and `/version` each answer 200 with the shapes above, captured as real output.
- Given the container, when inspected, then it runs as uid 65532, root filesystem is read-only, and it has no added capabilities.
- Given Sahil's PC, when the environment is checked, then Docker, Node 24, uv and `node scripts/verify-skills.mjs` all succeed (TB-5).
- Given the unit test command, when run, then all four I/O rows pass.

## Implementation Notes

- 2026-10-09: Created `apps/shop/` package `@vulnmart/shop` (ESM, Express pinned 5.2.1). `src/app.mjs` exports `createApp()` with `/healthz`, `/readyz`, `/version` and a JSON 404 terminal handler; `x-powered-by` disabled. `src/server.mjs` binds `PORT` (default 3000) on 0.0.0.0 with SIGTERM/SIGINT clean shutdown.
- Unit tests `test/app.test.mjs` (node:test, ephemeral listen, global fetch) cover the four I/O rows. Result: 4 passed, 0 failed (`corepack pnpm --filter @vulnmart/shop test`).
- `pnpm install` updated the root `pnpm-lock.yaml` to add the shop's `express` dependency (expected workspace behaviour; shared lockfile).
- Dockerfile is a two-stage build: `node:24.8.0-bookworm-slim` builder (pnpm `install --prod --ignore-workspace`) and a `gcr.io/distroless/nodejs24-debian12:nonroot` runtime (uid 65532, no shell). HEALTHCHECK hits `/readyz` via `node -e fetch`.
- 2026-10-09 (step 3): Pinned base digests — builder `node@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85`, runtime `gcr.io/distroless/nodejs24-debian12@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a`.
- Builder fix: the slim image's bundled corepack had the same pnpm-shim bug, so the Dockerfile upgrades corepack to 0.36.0 and pins pnpm 12.10.1 before install.
- Built `vulnmart-shop:t01` and ran it with the hardening flags. Results (real output): `/healthz`=200 `{"status":"ok"}`, `/readyz`=200 `{"status":"ready"}`, `/version`=200 `{"build":"dev","catalogue_version":"dev"}`, `/nope`=404 `{"code":"SHOP-NOT-FOUND",...}`.
- `docker inspect`: ReadonlyRootfs=true, CapDrop=[ALL], SecurityOpt=[no-new-privileges=true], Memory=536870912 (512 MB), PidsLimit=256; `docker exec` uid=gid=65532; Docker health status reached `healthy` (healthcheck on /readyz); port bound 127.0.0.1:3000.
- Host note (Windows/Git Bash): `docker run`/`exec` need `MSYS_NO_PATHCONV=1` so `/tmp` and `/nodejs/bin/node` are not rewritten to Windows paths. Recorded for the dev-log and the other developers.
- TB-5 environment on Sahil's PC: Node v24.8.0, uv 0.12.24, Docker 28.5.1, `verify-skills` OK (217). uv needed updating from 0.11.24 and Python 3.14.8 installing to satisfy the repo pin.

## Plan Change Log

- 2026-10-09 (review loop): applied 6 patches from the code review and resolved 2 decisions. Node base aligned to the repo pin, shop install frozen with a lockfile, server startup/shutdown hardened, JSON error handler added, PORT resolution unified and validated, tests and comments corrected, and a CI `app tests` job added so `apps/*/test` run on every PR. Decision: container-run hardening proof stays in the dev-log for T-01; the compose-level proof is T-04. Rebuilt image, re-ran the container (all endpoints 200, uid 65532, healthy), unit tests 5/5 pass, root frozen install passes.

## Review Triage Log

## Code Review

### 2026-10-09 — 2 decision-needed, 6 patch, 2 defer, 1 rejected

- [x] [Review][Decision] CI never runs the shop tests — RESOLVED: added an `app tests` job to `.github/workflows/ci.yml` running `node --test "apps/*/test/*.test.mjs"` after a frozen install. I co-own `/.github/`; flagged to the team as a shared-CI change.
- [x] [Review][Decision] No committed, re-runnable proof of the hardened `docker run` — RESOLVED (decision): leave container-run proof to T-04's compose/harness wiring, staying faithful to the "don't edit infra yet" boundary. The docker run + inspect proof stays captured in the dev-log for T-01.
- [x] [Review][Patch] Dockerfile Node base bumped to 24.21.0 to match `.node-version` (digest d6aa754f…). Note: the distroless runtime ships Node 24.14.0 from its own digest; both satisfy `>=24 <25` [apps/shop/Dockerfile]
- [x] [Review][Patch] server.mjs now has a `server.on('error')` (log + exit 1) and an unref'd 5s shutdown fallback [apps/shop/src/server.mjs]
- [x] [Review][Patch] Added a 4-arg JSON error-handler middleware returning `{code,message}` [apps/shop/src/app.mjs]
- [x] [Review][Patch] PORT resolved and validated once in server.mjs; Dockerfile healthcheck mirrors the `?? 3000` default [apps/shop/src/server.mjs, apps/shop/Dockerfile]
- [x] [Review][Patch] Dockerfile copies a shop `pnpm-lock.yaml` and installs with `--frozen-lockfile --ignore-workspace` [apps/shop/Dockerfile, apps/shop/pnpm-lock.yaml]
- [x] [Review][Patch] Tests assert `x-powered-by` absent and JSON content-type; teardown awaited; ENTRYPOINT comment corrected to `/nodejs/bin/node` [apps/shop/test/app.test.mjs, apps/shop/Dockerfile]
- [x] [Review][Defer] `/version` reads `VM_BUILD_ID`/`VM_CATALOG_VERSION`, not on the instance-contract env allowlist, and nothing stamps a build id [apps/shop/src/app.mjs:15-16] — deferred: the env allowlist is an open contract point; raise it in T-03 (instance-contract consumer review).
- [x] [Review][Defer] `/readyz` not-ready (503) branch has no test seam because `isReady()` is hardcoded true [apps/shop/src/app.mjs:40-47] — deferred: T-04 adds the injector-marker gate and the test that exercises both branches.

Rejected:
- PORT non-numeric throws NaN (edge-case-hunter): low and the standalone guard adds complexity; folded into the PORT-alignment patch instead of a separate guard.

## Design Notes

Base image choice: a distroless non-root Node 24 image gives uid 65532 and no shell, which fits `read_only` + `cap_drop ALL` cleanly and matches the contract's 65532:65532 proposal. The `HEALTHCHECK` uses `node -e` with global `fetch` (Node 24) because distroless has no wget/curl. The exact base digest is captured at build time and written here and in the dev-log (no invented digests).

Readiness honesty: `/readyz` returns ready in this skeleton. A short code comment and the dev-log both record that T-04 will gate it on the injector marker `/run/vm/injected`; we do not pretend that gate exists yet.

## Verification

**Commands:**
- `corepack pnpm --filter @vulnmart/shop install` -- expected: deps resolve, lockfile updates.
- `corepack pnpm --filter @vulnmart/shop test` -- expected: all node:test cases pass.
- `docker build -t vulnmart-shop:t01 apps/shop` -- expected: image builds; record the base digest.
- `docker run -d --name vulnmart-shop --read-only --tmpfs /tmp --user 65532:65532 --cap-drop ALL --security-opt no-new-privileges --memory 512m --pids-limit 256 -p 127.0.0.1:3000:3000 vulnmart-shop:t01` then `curl` the three endpoints -- expected: three 200s with the documented JSON.
- `docker inspect` / `docker exec id -u` -- expected: user 65532, read-only rootfs true.
- `node scripts/verify-skills.mjs` -- expected: `OK: all 217 installed skill files match the manifest.`
