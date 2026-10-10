# Stub shop, fake ingest and lab harness (task L-06, story 1.5)

| Field | Value |
|---|---|
| Date | 2026-10-10 |
| Developer | tannmayygupta |
| Branch / commit | sprint-1-tanmay, uncommitted at the time of writing (base 2f98d34) |
| Status | Built and tested; not closed. L-06 is not ticked and the story is not marked done until the developer confirms. The CI job `compose` has not run yet |
| Report tag | testing and quality; instance contract; lab harness |

## Requirements covered
IF-6 (instance contract), IF-4 (event contract), OI-35 and H-59 (sidecar start input), handoffs H-56, H-74, H-26 to H-28, H-60, H-62, H-75, H-76 (answered), D-37, ADR 0005, 0016, 0017. Report row LB-6.

## Summary (plain language, 3-5 lines)
Sahil and the lab needed a reference instance, and nothing proved that the instance contract and the event contract work together. A small Node program (one pinned image) now plays the shop, injector, sidecar, edge and gate; a Compose harness starts it with the fake ingest; one command, `node scripts/dev.mjs harness`, runs it, checks it against both contracts and removes it. The run passed on real Docker, and a deliberately broken copy of the config fails with the rule's name.

## Why
Task L-06 (EARLY PR: Sahil's T-04 waits on it). The instance and event contracts were only text and schemas; this makes them executable, so a mismatch shows up before the real shop, sidecar and orchestrator are built.

## What was built
- `contracts/mocks/stub-instance/` (test only, never a product image): `shop` (`/healthz`, `/readyz` only after the marker and an open database, `/version`, test routes under `/_stub/` for the planted flag and for sending events), `inject` (one document on standard input, snapshot, placement files, `flags.json` 0400, marker 0444 last, exits 10/11/12/13, prints one fixed line), `sidecar` (reads the start document once, answers 202/400/405/413/415/422, adds `instance_id` and the next `seq` from `first_seq`, signs, forwards, keeps until 202 or 200, drops on 401/409/413/422 with an alarm line, bounded buffer, passes player traffic to the shop), `edge` (pass-through; the relay forwards only `POST /internal/v1/events`), `gate` (always allows), plus a harness-only `ingest` wrapper for the fake ingest. Dockerfile on a Node 24.21.0 Alpine base pinned by digest.
- `infra/compose/harness.yaml`: one Compose project `vulnmart-harness` with the IF-6 runtime profile (user 65532, read-only root, no-new-privileges, cap_drop ALL, tmpfs only at `/tmp` and `/data`, four named memory-backed volumes, no bind mounts, only the edge published and only on 127.0.0.1, injector with `network_mode: none`, `depends_on` the injector).
- `scripts/harness.mjs` and `scripts/dev.mjs`: `harness`, `harness --keep`, `harness down`. Fresh fake flags, seed and event key for each run; they reach the containers on standard input only.
- `scripts/check-instance-conformance.mjs`: 17 static rules on the resolved config (`docker compose config --format json`) plus live probes and `docker inspect` rules run by the harness (20 in the recorded run).
- `contracts/instance/sidecar-start.schema.json` with 2 valid and 24 invalid examples, a semantic rule in `scripts/validate-contracts.mjs`, IF-6 section 6, section 7, OP 35 and new OP 36, `contracts/CHANGELOG.md` 0.1.3.
- CI: job `compose` runs the harness and its end-to-end tests; job `scripts` and `ci:linux` run the stub unit tests.
- Handoffs: answers to H-74, H-56, H-59, H-26 to H-28, H-60, H-62, H-75, H-76; new rows H-92 (Sahil), H-93 (L-13), H-94 (L-20).

## How it works
Chain: player to edge (127.0.0.1) to gate to sidecar 8080 to shop 3000. Events: shop to sidecar 9000 `/v1/events`, sidecar signs and posts to the edge relay `:8081/internal/v1/events`, which forwards to the fake ingest. The harness creates all containers, starts a helper that keeps the four memory volumes mounted, starts the ingest, runs the injector with its document on standard input and waits for exit 0, then starts shop, gate, sidecar (document on standard input) and edge, waits for them to be healthy and runs the live checks (health, readiness, version, planted flag equals the flags file, one event stored and verified at the ingest with `seq` equal to `first_seq`, the five error answers, no flag, seed or key in any log, answer, file or container setting, `docker inspect` of every container). It always tears everything down unless `--keep`.

## Files changed
- `contracts/mocks/stub-instance/` (new: `common.mjs`, `inject.mjs`, `shop.mjs`, `sidecar.mjs`, `edge.mjs`, `gate.mjs`, `ingest.mjs`, `main.mjs`, `fixtures.mjs`, `Dockerfile`, `Dockerfile.dockerignore`, six `*.test.mjs`)
- `infra/compose/harness.yaml` (new)
- `scripts/harness.mjs`, `scripts/check-instance-conformance.mjs`, `scripts/conformance-fixtures.mjs` (new), `scripts/dev.mjs` (`harness` commands)
- `scripts/harness.test.mjs`, `scripts/check-instance-conformance.test.mjs` (new), `scripts/dev.test.mjs`, `scripts/e2e/harness.e2e.test.mjs` (new), `scripts/validate-contracts.test.mjs`, `scripts/e2e/contracts.e2e.test.mjs` (schema count 3 to 4)
- `contracts/instance/sidecar-start.schema.json`, `contracts/instance/examples/*/sidecar-start/`, `contracts/instance/examples/invalid/manifest.json`, `contracts/instance/instance-contract.md`, `contracts/CHANGELOG.md`, `scripts/validate-contracts.mjs`
- `.github/workflows/ci.yml`, `scripts/ci-linux.mjs`, `package.json` (test script)
- `docs/adr/0020-...`, `docs/adr/README.md`, `docs/dev/HANDOFFS.md`, `docs/traceability.md`, `CHANGELOG.md`, `docs/assets/l-06-stub-harness/`

## Decisions made
ADR 0020. Confirmed by the developer on 2026-10-10 (from the plan): small Node stubs with real behaviour where a contract needs it; entry `node scripts/dev.mjs harness`; stub is test only; sidecar start input as one JSON document on standard input with the new schema (a proposal for Akshay and L-13); one local Dockerfile with a digest-pinned Node 24 base.
Made during the build and **not yet confirmed** (proposals): (a) a `volume-keeper` helper container, because Docker destroys a tmpfs volume when its last container stops (IF-6 OP 36); (b) the stub reads its input until the first complete JSON object, because a Compose container has no `StdinOnce`; (c) the fake ingest in the harness takes its key from standard input through a wrapper (a sixth command, a deviation from the plan text), so the key is not in a command line or in `docker inspect`.

## Tests
Real commands and results, 2026-10-10, Docker 29.6.2 (Docker Desktop, Linux engine) on a Windows host:
- `node scripts/dev.mjs harness` : exit 0; 17 static rules PASS, 20 live and inspect rules PASS, `harness: PASS`; afterwards no container, network or volume of the project remains (`docs/assets/l-06-stub-harness/harness-run.txt`).
- `node --test "scripts/*.test.mjs" "contracts/mocks/stub-instance/**/*.test.mjs"` : 197 tests, 197 pass (32 of them are the stub tests).
- `node --test scripts/e2e/harness.e2e.test.mjs` : 8 of 8 pass (clean run and nothing left, `--keep` then `down`, bad injection document exit 10 with the shop never started, 5 broken configs fail with their rule names plus a missing start order and a key in the environment, shop 503 before the marker and without an open database, injector exits 0/10/11/12/13 in real containers with nothing from the document printed, no connection possible with network none).
- `node --test scripts/e2e/dev.e2e.test.mjs scripts/e2e/contracts.e2e.test.mjs` : 19 of 19 pass.
- `pnpm run contracts:check` : PASS (4 instance schemas, 7 valid and 153 invalid examples; events, orchestrator and lab checks PASS).
- `pnpm run ci:linux` : all 8 steps PASS in a Linux container (skills, install, unit tests, stub tests, pytest, contracts check, uv lock check, e2e).
- Not run: the harness on a Linux host (that is the CI job `compose`, to run on the pull request); the new job steps are untested in GitHub Actions.
Traceability row: LB-6 in `docs/traceability.md`.

## Evidence
`docs/assets/l-06-stub-harness/harness-run.txt` (full run output and the empty leftover lists), `static-conformance.txt` (static rules on the resolved config), `test-results.txt`. No flag, seed or key value is in any of them.

## Problems met and how they were fixed
- First harness run: the fake ingest never became healthy. Cause: a container created by Compose has `StdinOnce=false` (checked with `docker inspect`; `docker create -i` sets it true), so Docker never closed its standard input and the read-to-end waited forever. Fix: the document reader ends at the end of input or at the first complete JSON object; unit test `readDocument: a complete document ends the read even when the input is never closed` fails without it.
- A tmpfs-backed Docker volume loses its content when the last container using it stops (tried with two `docker run` calls: the file was gone for the second). The injector exits before the shop starts, so flags and marker would vanish. Fix: the `volume-keeper` helper container (not an instance role, labelled `vm.kind=harness`); recorded as IF-6 OP 36 and H-93 because L-13 has the same problem.
- The first version of `runHarness` used the name `live` for both an option and a local variable, so every run died at the live step with "Cannot access 'live' before initialization". The unit test of the run order caught it before any real run; fixed by renaming the local.
- A mistaken edit of two test files through PowerShell turned a Unicode bullet into mojibake; the files were restored with `git checkout` and edited again with Node. A first Dockerfile written through a PowerShell here-string was blocked by the tool; written with the file tool instead.
- A test of mine matched the env allowlist with a regular expression that also matched `VM_FLAGS_PATH`; the expression was fixed (the allowlist itself was right).

## Security notes (vulnerable parts only)
The stub shop is not vulnerable and holds no challenge. The planted-flag test route (`/_stub/planted-flag`) returns a flag of the run's fresh fake flags only; it exists so the conformance check can see the flag, is not part of IF-6 and must never exist in a real image. Flags, seed and key are generated per run, travel on standard input, and are never written to a tracked file, a log or a doc (checked live in logs, answers, files and `docker inspect`).

## Review follow-up (same day)
Fixed after review: corrupted open point 35 row (form-feed escapes) and a BOM in an evidence file; schema description now matches section 6; semantic rules shared by the validator and the stub in contracts/mocks/stub-instance/semantic.mjs with parity tests; readDocument rejects trailing data, non-objects and has a 10 s deadline; exit 2 and exit 10 tested through main; shop 400 on a bad request target and DB retry after a read-only partial copy; passThrough mid-body error; conformance rules now cover every service (helper allowlist, vm.kind, implicit and host networks, docker not found); harness fails fast on exited containers and feeder exit codes, reports teardown failure and refuses to run over an existing instance; 7 more invalid sidecar-start examples (24 in total); ADR 0020 re-read against the Docker docs (summarising fetch; they neither confirm nor contradict the two findings, so those stay Proposed). Tests re-run: only the touched files (see the reply to the coordinator); the full verification is run separately.

## Deferred (reasons in docs/bmad/initiative-lab/deferred-work.md)
- /_stub/* routes reachable on the player port; image build not reproducible (L-12); sidecar buffer-overflow statistics edge case; injector leaves partial files after exit 12 or 13; TCP-only healthchecks and no ordering by depends_on; CI runs the harness twice without a layer cache; Dockerfile pins not compared with package.json; mtime-based ordering assertion in the injector test; first CI run of job compose still to be recorded.

## Limitations and follow-ups
- Task L-06 not ticked; story 1.5 not marked done; the Excel workbook is updated by the developer. The CI job `compose` has not run on GitHub yet.
- Proposals (a) to (c) above need the developer's decision; ADR 0020 status for them is Proposed. Docker documentation for tmpfs volumes and Compose `stdin_open` was not read in this task (experiment only).
- Not covered by design: the stub has no import service, mock-services or bot controller, so the two placement volumes and `/run/import` have no consumers; the instance id, labels (nine) and per-instance limits are the template's example values or are not applied.
- Handoffs H-92 to H-94 are for Sahil, L-13 and L-20; H-59 is only partly closed (the reserved `seq` range is still a proposal).


## Close-out note (2026-10-10)
The story was marked done by the developer with the GitHub CI result pending: the pull request is raised after all sprint 1 tasks. The first real CI result is to be recorded in docs/dev/sprint-1-pr-checklist.md and here; a failure becomes a bug story.
