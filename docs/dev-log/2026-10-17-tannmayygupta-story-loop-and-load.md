# Local end-to-end loop on Docker Desktop and a small load check

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay / not committed yet |
| Status | Done locally (10 of 10 loop steps and the load check green on Docker Desktop, re-run by the coordinator; stub image, laptop numbers; nothing on the deployed system) |
| Report tag | integration and demo readiness, local loop (LX-1), load check (LX-2) |

## Requirements covered
LX-1, LX-2 (local), FR-INS-10, FR-SES-11, FR-DET-01, FR-SCR-01, D-97 (part, as proposed in the story).

## Summary (plain language, 3-5 lines)
One candidate now goes through the real pieces on Docker Desktop in ten steps: lab runtime, real orchestrator, stub instance, edge gate behind Caddy, a signed event back into the ingest handler, a flag, the score, the deadline freeze and the destroy. All ten steps passed and nothing was left behind. A second script starts six stub instances at once and records laptop numbers.

## Why
Pieces were proven separately (orchestrator demo, edge test, in-process loop). The demo on 19 Oct needs the whole chain once, and LX-2 needs one load number.

## What was built
- `scripts/e2e/loop.e2e.test.mjs`: ten `test()` steps, skips with a message without Docker, uv or openssl.
- `scripts/e2e/loop-support.mjs` (+ pure tests): labels, leftover finder, bounded poll, redaction, request signing, manifest and template for the loop, small parsers, and the process helpers.
- `scripts/load-check.mjs` (+ pure tests): N stub instances at once (default 6), time to ready (p50, max), container memory, destroy, PASS or FAIL against a 60 s placeholder target.
- Runbook section "Full loop" in `docs/runbooks/local-demo.md`.

## How it works
The test starts uvicorn with the lab runtime (random demo token, orchestrator URL and key file), the real orchestrator (Docker backend, the shop template cut to injector, shop and sidecar, the stub image in every role) with `--edge-container` and `--gate-url`, then the edge gate and Caddy with the compose run flags read from `compose.yaml`. The gate relays events to the runtime at `host.docker.internal`. The sidecar command in the images manifest points at the gate container name. The gate hostname rule needs `<id>.<zone>`, and the runtime builds `<id>.instances.example.invalid`, so the zone of the test is that suffix. The owner hash for the ticket is read from the `vm.owner` label of the shop container (the runtime keys are random per process, so it cannot be derived). The planted flag is read with `docker exec` from `/run/vm/flags.json` inside the shop container and is never printed or written. Time moves with `POST /advance` and `POST /tick`.

Admin listener (H-143): the gate admin listener answers only on the core network, and the orchestrator runs on the host. The test starts a labelled forwarder container (a node one-liner from the stub image) on the core network with port 9090 published on `127.0.0.1` only, and gives the orchestrator that loopback URL. Compose, the gate and the orchestrator are unchanged. The core network is an ordinary one here (compose has the same), because a forwarder with a published port cannot sit on an internal network.

## Files changed
- `scripts/e2e/loop.e2e.test.mjs`, `scripts/e2e/loop-support.mjs`, `scripts/e2e/loop-support.test.mjs` (new)
- `scripts/load-check.mjs`, `scripts/load-check.test.mjs` (new)
- `docs/runbooks/local-demo.md` (section "Full loop")
- `docs/assets/story-8-3-loop-and-load/loop-output.txt`, `load-check.txt` (generated, redacted)

## Decisions made
No new ADR. D-97 (part) stays as proposed in the story: Docker layer reuses the existing harnesses and the real orchestrator, Docker Desktop only, never a CI gate. The 60 s load target is a placeholder, not a decision. Alternative considered for the admin listener: publishing it in compose (changes a shipped rule) or running the orchestrator in a container (needs an image and the Docker socket); the test-only forwarder was the smallest.

## Tests
- `node --test scripts/e2e/loop-support.test.mjs scripts/load-check.test.mjs`: 13 tests, 13 pass (after a fix of my own argument range for `--target-s`).
- `node --test --test-concurrency=1 scripts/e2e/loop.e2e.test.mjs`: first run 9 of 10 steps pass; second run all 10 pass (about 26 s). Cleanup check printed: containers 0, networks 0, volumes 0, temp folder removed. Afterwards `docker ps -a --filter label=vm.kind=loop-test` and `docker ps -a --filter label=vm.instance` printed nothing.
- `node scripts/load-check.mjs --n 6`: 6 of 6 ready, p50 8.1 s, max 15.7 s, memory of the 12 instance containers 243.2 MiB in total (average 20.3, largest 33.3), PASS against 60 s, nothing left. Machine: 12 logical CPUs (AMD Ryzen 5 5600H), 15.3 GiB RAM, Docker engine sees 12 CPUs and 7.8 GiB.
- `node scripts/check-text-files.mjs`: PASS. `node scripts/scan-secrets.mjs`: PASS. `node scripts/scan-flags.mjs`: nothing to scan without arguments (it needs `--instance`, `--image`, `--file` or `--tar`); not run against the evidence files with that tool, the evidence files were checked with a text search for `VM{` and long hex (none).
- Numbers in step 7 and 8: stub event credits C03 M1 (18 points, score 19); after the flag, C03 is M3, 90 points, score 94, equal to the hand number (1000 x 90 / 960 = 93.75, half up 94).

## Evidence
`docs/assets/story-8-3-loop-and-load/loop-output.txt` and `load-check.txt`.

## Problems met and how they were fixed
- Step 9 first failed: after the destroy tick the orchestrator answered `stopping`, because the destroy runs after the call returns. Fixed in the test with a bounded wait for `destroyed` or 404, and a bounded wait for the gate's ended page.
- The load check's argument parser used the range 1 to 50 for `--target-s` as well; the pure test caught it; fixed to 1 to 3600.
- Dead end avoided: the orchestrator is started in step 3 before the gate exists (as in the plan); it started and waited without failing, so no reordering was needed.

## Security notes (vulnerable parts only)
No vulnerable part is added. The test reads one flag inside the test and never prints it; logs and evidence pass through `redactAll` (flags, long hex, addresses, tokens, tickets, cookies, given secrets).

## Limitations and follow-ups
- Laptop numbers only; the VM-I concurrency target (NFR-PRF) is a runbook step (story 6, `measure-instances.md`).
- The loop uses the stub image, not the real shop; the stub's one exploit path gives C03 M1 only.
- The instance objects made by the orchestrator carry template labels, not `vm.kind=loop-test`; the test removes exactly the instance ids it created (the preflight refuses to start when other `vm.instance` containers exist).
- The load check memory counts the shop and the volume keeper per instance (the injector has exited).
