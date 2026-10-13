# Orchestrator engine: state machine and Docker instance builder (L-13 part 1)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | tannmayygupta |
| Branch / commit | shared-L-13 / not committed yet |
| Status | Partly done (engine done; HTTP service story 3.2, stories 3.3 and S-4 measurement open) |
| Report tag | orchestrator, instance lifecycle |

## Requirements covered
FR-INS-01, FR-INS-02, FR-INS-11 (and FR-INS-07 state names); NFR-SEC-04; D-52; handoffs H-60, H-61, H-69, H-70, H-71.

## Summary (plain language, 3-5 lines)
The orchestrator did not exist. There is now a package `apps/orchestrator` that can create an instance on Docker from an IF-6 template and destroy it. It starts a helper that keeps the memory volumes alive, runs the injector first, starts the other containers only after the injector exited 0, and calls the instance ready only when everything is healthy. Any failure removes everything and records a failure code. It has no web API yet.

## Why
The danger is in this part: ready too early, leftovers on the host, or a request that controls a container. So it is tested alone, on a fake and on real Docker, before the HTTP service wraps it.

## What was built
`states.py` (states, transition table, error codes), `images.py` (allowlist from a release-manifest JSON), `builder.py` (request parsing, template to specs, documents), `backend.py` (interface, fake, Docker SDK), `engine.py` (create, destroy), `templates.py` (schema-checked loader). Tests in `apps/orchestrator/tests/`.

## How it works
Create: refuse unknown template or image before anything exists; record requested; create network, volumes, containers; start the keeper; start the injector with its document on stdin once (StdinOnce); wait for exit 0 and remove it; start the others (the sidecar also gets its document on stdin); wait for healthy; ready. Failure: remove all labelled objects, then record failed with the code. Destroy: remove everything with the instance label, any state, repeatable. Transitions are numbered from 1 per instance and epoch.

## Files changed
- `apps/orchestrator/` (new package, source and 4 test files plus `support.py` and `conftest.py`)
- `pyproject.toml`, `uv.lock` (workspace member, docker 7.1.0, requests, urllib3, pywin32)
- `.github/workflows/ci.yml`, `scripts/ci-linux.mjs`, `scripts/ci-linux.test.mjs` (tests wired in both places; ci:linux skips Docker tests)
- `docs/adr/0033-orchestrator-engine-docker-builder.md`, `docs/adr/README.md`, `initial.md` (D-52), `docs/dev/HANDOFFS.md`, `docs/dev/dev1-tanmay.md`, `CHANGELOG.md`, `docs/traceability.md`, `docs/assets/orchestrator-engine/test-output.txt`

## Decisions made
ADR 0033 (D-52): Docker SDK behind an interface, state in memory plus labels, volume keeper. Alternatives rejected: Docker CLI subprocess, Compose files, a database.

## Tests
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests`: 92 passed (including 3 on real Docker with the stub image).
- `uv lock --check`, `node --test scripts/ci-linux.test.mjs scripts/ci-workflow-shape.test.mjs` (16 passed), `node scripts/check-text-files.mjs` (PASS), `node scripts/scan-secrets.mjs` (PASS). Output in `docs/assets/orchestrator-engine/test-output.txt`. No container was left (`docker ps -a` empty).
- Traceability rows FR-INS-01, FR-INS-02, FR-INS-11, D-52 updated.

## Evidence
`docs/assets/orchestrator-engine/test-output.txt`.

## Problems met and how they were fixed
- A first test run wrote files with a byte order mark and `uv` refused the project file; the marks were removed.
- A combined verification command exceeded its time limit and was moved to the background; the commands were run again one by one with limits.
- Test expectation errors (7 started containers, OpenAPI schema is named `State`) were fixed in the tests, not the code.

## Security notes (vulnerable parts only)
None of the challenge code. Engine rules: no flag, seed or key in a label, a log line or an environment variable (the only exception is the contract's flag-in-env for the shop); a real-Docker test checks `docker inspect` of every container for them.

## Limitations and follow-ups
No HTTP service, mTLS, signing or socket proxy (story 3.2). No reset or reconciler (3.3, 3.5, L-14). Request `limits` are not applied (template numbers are). Product images need `wget`, `nc` and `test` for the healthchecks. Volume options checked on Docker Desktop only. Cold-start time (S-4) not measured. The Excel tracker is updated by hand by the developer.
