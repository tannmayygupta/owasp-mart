# Local end-to-end demo of sprints 1 and 2

| Field | Value |
|---|---|
| Date | 2026-10-13 |
| Developer | tannmayygupta |
| Branch / commit | sprint-2-tanmay, not committed yet (base 0a2a43b) |
| Status | Done (built and run for real; the developer commits and closes story 17) |
| Report tag | demo, integration, stream L, P and T |

## Requirements covered
FR-INS-01, FR-INS-07, PB-6 (ticket 17 of initiative-lab); D-28 (same-origin proxy), IF-5, IF-8. Row DEMO-1 in `docs/traceability.md`.

## Summary (plain language, 3-5 lines)
One command, `node scripts/dev.mjs demo`, starts the platform stack, builds the lab images, starts the real Python orchestrator and drives it with the platform's own client. It prints a PASS/FAIL table, saves redacted evidence, and removes everything it started. The real shop image is tried in the shop role; today it fails there, so the stub is used and the table says so.

## Why
The guide meeting needs proof that the three streams run together on one machine. Ticket 17 asks for one command, a step table, evidence and a runbook.

## What was built
`node scripts/dev.mjs demo [--keep] [--stub-only] [--no-web]` and `demo down`; the runbook with a 5-minute talk track.

## How it works
1. Preflight with the existing `doctor` logic (Node, uv, Docker, Compose, engine) and a clean-machine check (no `vulnmart-*` containers, no `vm.instance` objects, ports free).
2. `docker compose -p vulnmart-demo` with profiles platform (+ web): API health, 403 without the origin secret, health through the web port, and the secret header in no response.
3. Builds `vulnmart-stub-instance:local` and `vulnmart-shop:local`. Starts the orchestrator (`uv run --locked --package vulnmart-orchestrator python -m vulnmart_orchestrator`, Docker backend) on a free 127.0.0.1 port with a random key in a temporary file (passed to the service by environment variable), a temporary image manifest (images pinned by id) and a reduced two-component template with a relaxed temporary copy of the template schema (the real schema demands six components; the contract file is not changed). First it probes the real shop in the shop role; on failure it restarts the service with the stub in that role.
4. `scripts/demo_client.py` (run with `uv run --locked --package vulnmart-api`) uses `HttpInstanceHost`: host status, create, wait ready, get without secrets, `docker exec` of `/readyz`, open access, list, repeated create, an IF-8 error, destroy twice, leftover check.
5. A finally block always stops the orchestrator, runs `compose down -v` for the demo project only, removes any `vm.instance` leftovers and the temporary folder (unless `--keep`), then writes `docs/assets/local-demo/demo-output.txt` (redacted: flags, long hex, addresses and home paths are replaced).

## Files changed
- `scripts/demo.mjs` (new), `scripts/demo_client.py` (new), `scripts/demo.test.mjs` (new, 17+ tests of the pure parts)
- `scripts/dev.mjs`: `demo` command and help text
- `docs/runbooks/local-demo.md`, `docs/assets/local-demo/demo-output.txt`
- plan file of story 17, this dev-log, `CHANGELOG.md`, `docs/traceability.md` (DEMO-1, FR-INS-01, PB-6)

## Decisions made
None needing an ADR. Choices: a unique Compose project name (`vulnmart-demo`), but the compose file fixes `container_name` (`vulnmart-api` and so on) and host ports, so the clean-machine check refuses to run when those exist instead of removing them. The real shop falls back to the stub automatically.

## Tests
- `node --test scripts/demo.test.mjs scripts/dev.test.mjs`: 43 tests pass, 0 fail.
- Real runs of `node scripts/dev.mjs demo`: run 1 FAIL (orchestrator did not start: schema needs six components, fixed), run 2 PASS in 145 s, `--stub-only --no-web` PASS in 42 s (web steps SKIP), final full run PASS in 141 s (24 rows, 0 FAIL). After each run `docker ps -a` showed no vulnmart container, no vm.instance network or volume; only the unrelated `n8n_data` volume remained.
- See `docs/assets/local-demo/demo-output.txt`.

## Evidence
`docs/assets/local-demo/demo-output.txt`.

## Problems met and how they were fixed
- The orchestrator refused the reduced template: the schema requires six components. Fix: a temporary relaxed copy of the schema in the temp folder.
- The real shop image does not reach `ready` in the shop role (`INST-HEALTH-TIMEOUT`). The orchestrator's http health check runs `wget` and the distroless shop image has none (checked: `wget` not found in the image). Not changed: that is a decision between stream L and T. The demo falls back to the stub and prints why.
- No existing code needed changing.

## Security notes (vulnerable parts only)
None. The demo uses random fake flags, seed and event key, a random signing key in a temporary file, loopback only. No real secret is printed or saved.

## Limitations and follow-ups
- Real shop not yet usable in the shop role (health check tool and a real snapshot from the real injector are needed). Follow-up for L and T.
- Sahil's import service, mock services and bot controller are on `origin/sprint-2-sahil`, not in `main`; the demo runs a reduced template.
- First run needs internet and about 4 to 5 minutes for image builds.
- Review step (`bmad-code-review`) and `bmad-qa-generate-e2e-tests` were not run by this build.
## Fix after the first runs (same day)
The real `apps/shop` image ended `failed` with `INST-HEALTH-TIMEOUT` in the shop role: the engine checked health with `wget` and the distroless shop image has none. Fixed with an optional per-role `healthchecks` entry in the image manifest (`ImageAllowlist.healthchecks`, used by `build_plan`); the demo manifest gives the shop the same node check as its own HEALTHCHECK. Test: `test_manifest_healthchecks_override_the_template_check_for_an_image_without_wget` (orchestrator, 9 passed in that file). Re-run: `node scripts/dev.mjs demo` all PASS in 145 s with `shop-role: the real apps/shop image works in the shop role`, nothing left over.
