# Audit fixes, code findings (H1 to H3, M5 to M11, L13 to L23)

| Field | Value |
|---|---|
| Date | 2026-10-13 |
| Developer | tannmayygupta |
| Branch / commit | sprint-2-tanmay, working tree on top of 994aae3 (not committed by the agent; the developer commits) |
| Status | Done (see "Limitations and follow-ups" for what was only partly done) |
| Report tag | audit, hardening of the host scripts, the orchestrator service, the demo and the release pipeline |

## Requirements covered
D-49 (certificates), L-12 (images and deploy), L-13 (orchestrator, IF-5), IF-5 section 3 and 7 (capacity), IF-6 (volume profile), P-07 (origin secret), story 1.17 (local demo), L-09 (tag).

## Summary (plain language, 3-5 lines)
An independent audit listed weaknesses in the code. This task fixes the code ones: the certificate script could stamp a success after a failed copy, Caddy was never told about a renewal, the orchestrator could listen on all interfaces without TLS, took keys from the command line, counted the wrong memory, and could leave a record stuck. The deploy, image and tag scripts got stricter checks, and the demo no longer reports a skipped shop as a pass. Each fix has a test; the docs agent handles the contract and doc text.

## Why
The audit findings H1 to H3 (high), M5 to M11 (medium) and L13 to L23 (low). Items about guardCheck/CODEOWNERS self-approval, the `status` column of approvals, nonce memory per process and SBOM/provenance are accepted or documented risks and were not touched.

## What was built
One line per finding: the fix, then the test that proves it (the tests that fail on the old code are marked "fails before").

- **H1** `infra/hosts/vulnmart-certs.sh`: `set -eu` is on its own line (it was glued to the end of a comment and dead). `publish()` is one `&&` chain (`cp crt && cp key && chmod && chmod && mv && mv`, any failure removes the `.new` files and returns 1), so a failed copy exits 1 and never stamps `certs-ok`. Tests in `scripts/certs-host.test.mjs`: the header has `^set -eu$`; "H1: a failing copy exits 1, writes no certs-ok stamp and leaves no .new file" uses a `cp` stub that fails only for the certificate (fails before: the old code copied the key and returned 0 from its last `mv`). The test harness now sources the script inside the wrapper shell so that stubs named like real tools (here `cp`) come first on PATH in Git bash.
- **H2** `infra/hosts/vulnmart-certs.service`: `ExecStartPost=-/usr/bin/docker exec vulnmart-origin-caddy-1 caddy reload ... --address unix//tmp/caddy-admin.sock` (container and socket from `infra/caddy/compose.p.yaml` and `Caddyfile.p`; the leading `-` means a failed reload never fails the unit). Test "H2: the service reloads the origin Caddy ..." parses the unit and checks the project name, service name and admin socket against the compose file and the Caddyfile (fails before). Runbooks `docs/runbooks/vercel-and-origin.md` (Part A step 4) and `docs/runbooks/certificates.md` (files section) now say the reload is automatic.
- **L19** same script: `check_token` refuses a token file with group or other permission bits (`stat -c %a` or `stat -f %Lp`; skipped under MINGW/MSYS shells, which cannot report modes). Test "L19: a token file readable by group or others is refused with exit 2 and no lego call" runs on POSIX only (skipped on Windows). The two-rename publish was left as it is (see follow-ups): a directory symlink swap needs a Caddy mount change in `compose.p.yaml`, so it is not "simple".
- **H3** `apps/orchestrator/src/vulnmart_orchestrator/service.py`: `main()` exits 2 when the listen host is not loopback and there is no TLS context, unless `--insecure-no-tls` is given; `--backend fake` needs `--allow-fake-backend`. The Dockerfile keeps `--host 0.0.0.0` and never sets either switch, so the image default is TLS-required (header comment says so). `scripts/demo.mjs` (127.0.0.1, docker backend) and `apps/api/tests/support.py` (fake backend, now with `--allow-fake-backend`) keep working. Tests in `apps/orchestrator/tests/test_service.py`: refusal for `0.0.0.0`, `192.0.2.1`, `::`, a name; the fake-backend refusal; loopback, `localhost` and `0.0.0.0 --insecure-no-tls` start; the image test checks the ENTRYPOINT/CMD lines carry no test switch (fails before).
- **M5** `builder.py` adds `InstancePlan.memory_mb` (every component plus the 64 MB keeper); `engine.py` builds the plan first and checks and records capacity with it (the request limits stay validated). Tests: `test_builder.py::test_plan_memory_is_every_component_plus_the_keeper` (1728 for the example template), `test_engine_service.py::test_capacity_uses_the_plan_memory_not_the_request_limit` and the reworked capacity tests (fail before: a 64 MB request limit fitted twice). The shared protocol tests in `apps/api/tests` use `instance_memory_mb(kind, request_mb)` in `support.py`: the Node fake and the in-memory fake keep counting the request value (the contract text is still request-based and is the docs agent's), the Python service counts the plan.
- **M6** `service.py`: `--key` and `--report-key` are gone from argv; keys come from `VM_ORCH_PLATFORM_KEY` / `VM_ORCH_REPORT_KEY` or from `--key-file` / `--report-key-file` (POSIX: a file with group or other bits is refused; Windows: no mode check). The parser has `allow_abbrev=False` so `--key` does not abbreviate `--key-file`. `demo.mjs` already used the environment; `apps/api/tests/support.py`, `test_service.py` and the Dockerfile header were updated. Tests: `--key X` and `--report-key X` are "unrecognized", `--key-file` read, POSIX mode 0644 refused with no key in the message (fails before).
- **M7** `scripts/deploy.mjs`: the image must be exactly `<registry>/<owner>/<repo>/hello@sha256:<64 hex>` with `owner/repo` from `release.json`; `scripts/images-release.mjs` now writes a `repo` field (lower-case owner/name) into the manifest. The remote verify command is `a=...; b=...; [ -n "$a" ] && [ -n "$b" ] && [ "$a" = "$b" ]`. Tests in `scripts/deploy.test.mjs` (another repo, nested and `..` paths, a manifest without `repo`; a shell run proving two empty ids are not equal) and `scripts/images-matrix.test.mjs`.
- **M8** `.github/workflows/images.yml`: the publish job checks out with `fetch-depth: 0` and `persist-credentials: false`, then runs `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` and exits 1 before login and before any tag is pushed. Test in `scripts/ci-workflow-shape.test.mjs` (step order, fetch-depth, pinned checkout).
- **M9** `builder.py`: the four shared tmpfs volumes get `noexec,nosuid,nodev`. Test `test_the_four_shared_volumes_are_noexec_nosuid_nodev`; the real-Docker tests (`test_docker_integration.py`) and the demo with the real Docker backend were run (see Tests).
- **M10** `engine.py` `abandon_create` / `release_destroy`, `service.py` wraps the spawn in `_create` and `_destroy`: a create whose worker cannot start moves `requested` to `provisioning` to `failed` with `INST-START-FAILED` and answers 500 `ORCH-INTERNAL`; a destroy clears its `destroying` flag so a repeat starts the work. Tests with a spawn that raises (`test_engine_service.py`, fail before: the record stayed in `requested` and `destroying` stayed true).
- **M11** `apps/api/src/vulnmart/kernel/settings.py` adds `env` (`VULNMART_ENV`, `dev` default, `test`, `staging`, `production`; there was no such setting before); `service.py` raises at app creation when the env is `staging` or `production` and no origin secret (an empty file counts as none) is set. Tests in `apps/api/tests/test_kernel_origin.py`. Not set anywhere yet: compose and the deploy of the API must set `VULNMART_ENV=production` for the check to be on (follow-up).
- **M12** `docs/runbooks/vercel-and-origin.md`: secrets folder 0700, files created with `( umask 077; sudo install -m 0600 /dev/stdin ... )` and `sudo install -m 0600 /dev/null ...` (also in the rotation step), with a `stat` check.
- **L13** `service.py`: uvicorn `limit_concurrency=64`; the request body must arrive within 10 s (`asyncio.timeout`, then a 422 `ORCH-VALIDATION` with `Connection: close`). There is no read deadline for the request line and headers in uvicorn without a custom protocol class, so that part is not done. The existing 64 KiB limit and `timeout_keep_alive=5` stay.
- **L15** `reports.py`: a report refused with 400, 401, 404, 409 or 422 is dropped after 10 tries with a log line holding the status only; the queue bound now counts every item (the oldest item that is not on the wire goes, at any position; if all are on the wire the new report is dropped), so it can never pass the bound. Tests in `test_reports.py` (fail before: unbounded growth with one instance, endless retries of a 409).
- **L16** `scripts/demo.mjs`: a failed shop build is a SKIP (stub fallback), a real shop that was tried and not accepted is a SKIP, only an accepted real shop is a PASS; the evidence file has an "Image in the shop role" line and says "no step FAIL; some steps SKIP" when there is a SKIP. Tests in `scripts/demo.test.mjs`.
- **L17** `scripts/demo.mjs`: `demo_client.py` prints `IID <id>` for every instance id it makes; the cleanup removes only containers, networks and volumes of those ids and the final check still reports anything else with a `vm.instance` label as a FAIL; `killTree` kills the orchestrator tree (Windows `taskkill /T /F`, POSIX the process group, `detached: true` at spawn) and an `exit` hook kills any child left. Tests in `scripts/demo.test.mjs` (including a real process tree).
- **L20** `images.py`: `fullmatch`, a regular reference must be `name@sha256:<hex>`; a bare `sha256:<hex>` is accepted only with `allow_local_ids` (constructor flag, `ImageAllowlist.load(..., allow_local_ids=)`, service flag `--allow-local-images`, `measure.py --allow-local-images`; `measure.py` sets it for its own stub image; the demo passes the flag). Tests in `test_states_images.py` (a trailing newline passed the old `$` anchor).
- **L22** `contracts/mocks/fake-orchestrator/server.mjs`: FORBIDDEN is now the same set as `FORBIDDEN_FIELDS`; `test_builder.py::test_the_fake_orchestrator_refuses_exactly_the_names_the_builder_refuses` compares the two.
- **L23** `scripts/tag-contracts.mjs`: `--create` runs `git fetch origin main` first and refuses when `origin/main` is absent or the fetch fails; a dry run only warns. Tests in `scripts/tag-contracts.test.mjs` (a stale `origin/main` is caught because of the fetch).

## How it works
Nothing new in the design: the fixes tighten checks that already existed (fail closed, one place for each rule). The one new data field is `repo` in `release.json`, written by `images-release.mjs` and read by `deploy.mjs`.

## Files changed
- `infra/hosts/vulnmart-certs.sh`, `infra/hosts/vulnmart-certs.service`, `scripts/certs-host.test.mjs`
- `docs/runbooks/vercel-and-origin.md`, `docs/runbooks/certificates.md` (wording of the reload and the secret files)
- `apps/orchestrator/src/vulnmart_orchestrator/{service,engine,builder,images,reports,capacity,measure}.py`, `apps/orchestrator/Dockerfile`
- `apps/orchestrator/tests/{support,test_service,test_engine_service,test_builder,test_states_images,test_reports,test_docker_integration}.py`
- `apps/api/tests/{support,test_protocol,test_http_service,test_kernel_origin}.py`, `apps/api/src/vulnmart/kernel/{settings,service}.py`
- `scripts/{deploy,images-release,demo,tag-contracts}.mjs`, `scripts/demo_client.py`, `scripts/{deploy,images-matrix,demo,tag-contracts,ci-workflow-shape}.test.mjs`
- `.github/workflows/images.yml`, `contracts/mocks/fake-orchestrator/server.mjs`
- `docs/assets/local-demo/demo-output.txt` (refreshed by a real run of the demo)

## Decisions made
No new ADR: no new technology was chosen. Choices inside the fixes: `VULNMART_ENV` as the name of the new API setting (none existed; the developer may rename it), `repo` recorded in `release.json`, 10 permanent failures and 10 s body deadline as the limits of L15 and L13.

## Tests
Real commands and results are in the final report of the task and below.

Run on Windows 11 (Git bash for the shell tests), 2026-10-13, after the last code change:
- `node scripts/check-contract-rules.mjs`: SUMMARY 29 PASS, 0 FAIL, 1 NOT-APPLICABLE (approvals, no tag yet).
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests`: 258 passed (includes the 3 real-Docker tests; run alone first: 3 passed, 15 s, with the noexec/nosuid/nodev volumes).
- `VM_ORCH_SERVICE=python uv run --locked --package vulnmart-api pytest -q apps/api/tests/test_protocol.py test_wire_rules.py test_http_service.py test_reports.py test_mtls.py`: 375 passed, 18 skipped (the reset and activity cases skipped for the Python service, story 3.4).
- `uv run --locked --package vulnmart-api pytest -q` (default): 963 passed, 7 skipped (the Postgres kernel tests need a DSN).
- `node --test --test-reporter=tap "scripts/*.test.mjs"`: pass 735, fail 0.
- `node scripts/check-text-files.mjs`: PASS. `node scripts/scan-secrets.mjs`: PASS. `uv lock --check`: resolved 71 packages, no change.
- `node scripts/dev.mjs demo` (full, real Docker, real shop): DEMO PASSED in 93 s; evidence refreshed in `docs/assets/local-demo/demo-output.txt`.
- Skipped on Windows by design: the L19 token-file mode test (POSIX only). Not run: any test on a real Linux host (the CI Linux job does that).

## Evidence
`docs/assets/local-demo/demo-output.txt` (real run of `node scripts/dev.mjs demo`).

## Problems met and how they were fixed
- The first H1 test used a certificate that is a directory; on Windows `[ -s dir ]` is false, so the old code failed too and the test proved nothing. Replaced by a `cp` stub that fails only for the certificate copy.
- The `cp` stub was not first on PATH: the Git bash launcher re-orders PATH when the wrapper re-executes bash. The wrapper now sources the script instead of `exec`-ing a new bash.
- argparse abbreviates `--key` to `--key-file`; fixed with `allow_abbrev=False` (found by the test of the removed flag).
- `[ -s ]`-style mode checks cannot be tested on Windows (chmod has no effect in Git bash): the mode tests of the token file and the key file run on POSIX only.

## Security notes (vulnerable parts only)
None of the changes touch the intentionally vulnerable parts. No flag, key or secret value is written in this file or in the tests (fake keys only).

## Limitations and follow-ups
- L19: the two-rename publish is not atomic for a reader that opens the two files between the renames; the directory symlink swap needs the compose mount and the runbook to change (a decision for stream L); left as it is.
- L13: no deadline for the request line and headers (uvicorn has none; a custom protocol class would be needed).
- M11: `VULNMART_ENV=production` must now be set in the deployment of the API (compose or the platform deploy); until then the check stays optional.
- M5: `contracts/orchestrator/orchestrator.openapi.yaml` and the Node fake still describe and count the request value `limits.memory_mb`; the docs agent owns the contract text. The Python service now counts the plan memory.
- M8: the `build` job (push by digest, untagged) is not gated; only the tagging and the release manifest in `publish` are.
- L23: `docs/runbooks/contracts-tag.md` should say that `--create` needs an `origin` remote (docs agent).
- Tracker, changelog and traceability rows are edited by the docs agent.
