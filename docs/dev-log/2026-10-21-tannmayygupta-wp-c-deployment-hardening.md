# Deployment hardening (work package C)

| Field | Value |
|---|---|
| Date | 2026-10-21 |
| Developer | tannmayygupta |
| Branch / commit | `wp-c-deploy-hardening` (commit hash after the commit) |
| Status | Done (in review); the deploy itself is a separate step |
| Report tag | F-02, F-03, F-04, F-12, F-13, IF-5 1.2.0, ADR 0074, ADR 0075 |

## Requirements covered
Wiring audit F-02 (scheduler), F-03 (mail), F-04 (dashboards), F-12, F-13 (durable state) and section 3; tracker audit 3.5 items 1, 2, 8; handoffs H-111, H-123, H-125, H-358. Story: `docs/bmad/initiative-lab/backlog/story-wp-c-deployment-hardening.md`.

## Summary (plain language, 3-5 lines)
The deployed stack is made honest: the dashboards are a container behind the same Caddy, the retention scheduler is on, real mail is the default and the catcher needs an explicit flag, production refuses to start on missing stores, the gate and the sidecar keep their state across a restart, the platform tells the orchestrator which instances should exist, and a lint plus a route check keep it that way in CI.

## Why
The audit found a deployed stack that looked finished and was not (see ADR 0074).

## What was built
ADR 0074 (stack) and ADR 0075 (durable state, desired instances): `apps/web/Dockerfile.prod` and the compose service, Caddy routes for the dashboards, scheduler on, Brevo by default with the key as a file, fail-closed settings (`Settings.check_stores_for_environment`), Valkey with password, append-only file and `volatile-lru`, `apps/edge/src/persist.mjs`, a durable sidecar outbox, desired state for the orchestrator (IF-5 1.2.0) and the platform side, `scripts/check-deployed-compose.mjs`, `scripts/check_spec_routes.py`, `scripts/check-pytest-skips.mjs`, `scripts/check-docker-proxy.mjs`, resumable first boot in the cloud-init template, runbook `docs/runbooks/live-deploy.md`.

## How it works
See the two ADRs. The deployed files are linted on every pull request; `live-deploy.mjs platform` builds and ships the dashboards image with the API image.

## Files changed
`infra/deploy/*`, `infra/compose/compose.yaml`, `infra/hosts/cloud-init.yaml.tftpl`, `apps/edge/*`, `services/sidecar/*`, `apps/orchestrator/*`, `apps/api/src/vulnmart/{kernel,lab,live}/*`, `contracts/orchestrator/*`, `scripts/*`, `.github/workflows/ci.yml`, docs.

## Decisions made
ADR 0074, ADR 0075 (renumbered from 0072 and 0073, which other packages took).

## Tests
- `node --test` on `apps/edge/test`, `services/sidecar/test` and the deploy scripts: 240 passed, 0 failed.
- `pytest` (API): `test_lab_desired_state`, `test_production_guards`, `test_spec_routes_check`, `test_kernel_settings`, `test_audit_log`, `test_contract`: 160 passed. Orchestrator suite: 489 passed.
- `node scripts/check-deployed-compose.mjs`: PASS. `python scripts/check_spec_routes.py`: 87 routes, 89 operations, 2 exempt as pending, PASS.
- Not run: the deployed host (the lead deploys after the merge); a real Brevo delivery (needs the key).

## Evidence
Command output above; the pull request checks.

## Problems met and how they were fixed
Two decision records (0072, 0073) collided with numbers taken by other packages and were renumbered 0074 and 0075. The agent that wrote the package hit its session limit; the lead finished the documents and integrated it.

## Security notes (vulnerable parts only)
None. Valkey now needs a password; the key files are placed by the leader.

## Limitations and follow-ups
The leader places `keys/brevo_api_key` and verifies the sender domain in Brevo before a normal deploy; `live-deploy.mjs platform` stops without it (or with `--allow-mail-catcher` for a knowingly key-less demo).