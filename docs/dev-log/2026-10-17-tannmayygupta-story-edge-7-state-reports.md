# Edge story 7: the platform receiver for the orchestrator's state reports (H-147 point 1)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay, on top of 6b01ab9; not committed yet |
| Status | Done locally (Docker Desktop, host receiver); nothing run on vm-p or vm-i |
| Report tag | Orchestrator to platform state path: receiver, TLS trust, report key |

## Requirements covered
FR-INS-07 (state of an instance is known to the platform), FR-INS-11 (reports are ordered, at least once, repeats are harmless), NFR-SEC-03 (signed internal calls, no secret in logs or answers), handoffs H-16 and H-147 point 1, decision F-3 (`docs/reviews/2026-10-12-p08-contract-sign-off.md`), IF-5 section 8 (`contracts/orchestrator/orchestrator-api.md`).

## Summary (plain language)
The orchestrator container already pushed state reports, but nothing on the platform side received them. This adds the receiver `POST /internal/v1/orch/state` to the lab runtime of the ingest app. It checks the signature, parses the body strictly, answers 204 for a new report, 200 for an identical repeat and 409 for the same identity with another body, and keeps an impossible transition as history without moving the recorded state. It exists only when the lab runtime is on and a report key file is given. The orchestrator can now take its report URL and key file from the environment, and an override compose file turns reports on with a CA file for the private certificate. A local run with the real container, TLS and a receiver restart passed.

## Why
H-147 point 1: the container had no report URL or key and the platform had no receiver. H-16 and IF-5 section 8 define the endpoint; F-3 defines what an impossible transition does.

## What was built
- `apps/api/src/vulnmart/lab/state_reports.py` (stream L folder): `StateReportStore` (history per `(instance_id, epoch, transition)` through the existing `ReportIngest`, recorded state per instance, memory only), `read_report_key` (mode 0600 or stricter on POSIX, at least 32 characters), the route, and `install_state_reports` (mounts only with `VULNMART_ORCH_REPORT_KEY_FILE` set; a key file that cannot be used stops the start).
- Order of checks: body over 64 KiB is 413 (declared length and streamed bytes); signature through the existing `verify_request` (60 s window, 5 min nonce memory, constant time) is 401 `ORCH-BAD-SIGNATURE` with one body for every failure; not JSON media type 415; `parse_state_report` refusal 422; then new 204, repeat 200, mismatch 409. An impossible `(from, to)` pair is 204, stored, state not moved, one warning log (ids and state words only). A report with a lower `(epoch, transition)` than the highest seen is history too.
- `ingest.py` mounts it inside the existing `VULNMART_LAB_RUNTIME=1` block; `runtime.py` holds the store and shows `instance_states`; `demo_routes.py` gets a read route `GET /internal/v1/lab-demo/instances/{id}` (token guarded, demo only).
- Orchestrator `service.py`: `apply_env_fallbacks` fills `--report-url` and `--report-key-file` from `VM_ORCH_REPORT_URL` and `VM_ORCH_REPORT_KEY_FILE` when no flag is given (compose cannot omit a flag conditionally). An empty variable means unset, so the default is unchanged: reports off.
- `infra/compose/compose.yaml`: orchestrator gets `environment: VM_ORCH_REPORT_URL: ${VULNMART_ORCH_REPORT_URL:-}` (empty by default) and a comment. `infra/compose/lab.reports.yaml` (override, not named by the base file): adds the secrets `report_key` and `report_ca` and the variables `VM_ORCH_REPORT_KEY_FILE` and `SSL_CERT_FILE`.
- `scripts/check-lab-compose-rules.mjs`: the override file is scanned and may add nothing else (only those two secrets with fixed targets and those two variables, only to `orchestrator`); a signing key in `VM_ORCH_PLATFORM_KEY` or `VM_ORCH_REPORT_KEY` in the environment is refused.

## How it works
orchestrator container -> (signed POST, https, `SSL_CERT_FILE` trusts the private CA) -> ingest on vm-p -> `StateReportStore`. The pusher keeps order per instance and retries with a growing pause (0.2 s up to 5 s) until it gets 200 or 204.

## TLS check (task point 2)
The pusher uses `urllib` with the default SSL context, which honours the standard `SSL_CERT_FILE` variable. So a private CA can be trusted without a code change or a new option; only the CA file must be mounted and the variable set (done by `lab.reports.yaml`). The server certificate must also hold the host name or address used in the URL (hostname checking stays on). Tests: without the variable the pusher refuses a certificate of a private CA (`URLError`); with it the post is accepted. No orchestrator code change was needed for TLS. Note: `SSL_CERT_FILE` replaces the default trust store for the whole process, which is intended here (it only talks to the platform over this link and to the Docker proxy and gate over plain http).

## Files changed
- `apps/api/src/vulnmart/lab/state_reports.py` (new), `apps/api/src/vulnmart/lab/runtime.py`, `apps/api/src/vulnmart/lab/demo_routes.py`, `apps/api/src/vulnmart/kernel/entrypoints/ingest.py`
- `apps/api/tests/test_lab_state_reports.py` (new, 40 tests)
- `apps/orchestrator/src/vulnmart_orchestrator/service.py`, `apps/orchestrator/tests/test_report_env.py` (new, 9 tests)
- `infra/compose/compose.yaml`, `infra/compose/lab.reports.yaml` (new)
- `scripts/check-lab-compose-rules.mjs`, `scripts/check-lab-compose-rules.test.mjs`
- `docs/runbooks/edge-vm-i.md` (step 3 text replaced, new section 3b)
- `docs/assets/story-edge-7-state-reports/proof-run.mjs`, `proof-output.txt`

## Decisions made
No new ADR: the receiver follows IF-5 section 8, H-16 and F-3 as written. Env fallback chosen over a compose `command` change because compose cannot drop a flag when a variable is empty (the default `up` must stay unchanged). The override file was chosen over a profile so the base file never refers to a file that may be missing.

## Tests (real results)
- `uv run --locked --package vulnmart-api pytest apps/api/tests/test_lab_state_reports.py -q`: 39 passed, 1 skipped (POSIX file-mode test, skipped on Windows).
- `uv run --locked --package vulnmart-api pytest apps/api -q`: 1288 passed, 8 skipped (was 1249 and 7; Postgres tests skipped as before, plus the mode test).
- `uv run --locked --package vulnmart-orchestrator pytest apps/orchestrator -q`: 467 passed, 4 warnings (was 458; the 4 warnings are unraisable "I/O operation on closed file" notes; I did not trace which older test causes them, this story's 9 new tests alone pass with no warnings).
- `node --test scripts/check-lab-compose-rules.test.mjs scripts/dev.test.mjs`: 46 tests, 46 pass; the compose rules file alone: 21 pass.
- `node scripts/check-lab-compose-rules.mjs`: PASS (5 files).
- Local proof: `node docs/assets/story-edge-7-state-reports/proof-run.mjs`: 27 checks PASS (see Evidence). The refusal of a key file with a loose mode is a test that is skipped on Windows, so it did not run here at all (it needs a Linux run, for example in CI).

## Evidence
`docs/assets/story-edge-7-state-reports/proof-output.txt`. Setup: the receiver is the real ingest app (uvicorn with TLS, lab runtime, report key file) as a host process on loopback; the orchestrator is the compose container (`compose.yaml` + `lab.reports.yaml`) reaching it as `https://host.docker.internal`. The container was used because it is the deployed shape and exercises `SSL_CERT_FILE` from a file secret; it reached the host receiver without trouble. Two throwaway CAs in a temp folder (deleted at the end). Result: receiver 1 recorded transitions 1..4 (requested, provisioning, starting, ready); the receiver was stopped; destroy ran while it was down and the container log showed 6 failed pushes (exception class only); receiver 2 (empty memory) then received 5 and 6 (stopping, destroyed); the two histories join as 1..6 without gap or duplicate. The script also sends its own report to show new 204, identical repeat 200, same identity with another body 409, and an impossible transition 204 that does not move the state with one warning. After teardown no container, network or volume of the run is left (`docker ps -a` empty; the pre-existing volume `vm-gomod` is not ours).

## Problems met and how they were fixed
- The earlier partial work was never run as a whole. All suites passed on first run; nothing needed fixing in its code. The proof also passed on its first run.
- Dead end worth knowing: the receiver keeps history in memory (D-96), so a restart loses reports that were already delivered. The proof therefore reads each receiver process separately and joins them; it does not claim that one receiver holds all numbers across a restart.
- The real pusher never got a 200 in the run (a 200 happens only when a response is lost after the receiver stored the report). The 200 and 409 answers were shown with reports the proof script sent itself; the pusher against the receiver with repeats is also in the unit tests (`test_the_real_pusher_is_accepted_over_http_and_repeats_are_200`, through the ASGI app, not over a socket).

## Security notes
No weakness is implemented here. The receiver answers every signature failure with the same 401 body (no hint which check failed), logs no key, signature or free text `reason`, and the report key is read from a file (mode 0600 or stricter on POSIX), never from an environment value. The compose check refuses a signing key in an environment entry. No key value is in the repository or in the evidence (keys are random per run, in a temp folder, and redacted from the output).

## Limitations and follow-ups
- Live use on vm-p and vm-i is not done: the runbook section 3b gives the steps; the result is the developer's to report.
- Memory only (D-96): the platform loses its history on a receiver restart; a persistent store is a later story.
- The receiver is mounted only in the lab runtime of the ingest entrypoint; the production wiring on vm-p (supervision, certificate, port 9444) is the developer's deployment step.
- Closing H-147 point 1 in `HANDOFFS.md`, the changelog, the traceability rows and the tracker are not edited here; the caller does that.
