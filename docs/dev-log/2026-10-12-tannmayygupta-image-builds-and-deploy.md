# Image builds in CI and the human-run deploy of the hello stack (preparation for L-12)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | tannmayygupta |
| Branch / commit | sprint-2-tanmay; not committed when this entry was written (the developer commits) |
| Status | Partly done: the local preparation is done and tested; the workflow run on GitHub, the public package and the deploy to both VMs and the laptop are open (the developer's). L-12 is not ticked, the story is not marked done |
| Report tag | CI image builds, registry, deploy by digest, free hosting |

## Requirements covered
LE-4 (arm64 part amended), NFR-POR-02, D-28, D-41, D-51 (new, Proposed), ADR 0011, ADR 0032 (new, Proposed); handoff H-118 added.

## Summary (plain language, 3-5 lines)
A GitHub workflow now builds the images listed in one data file and publishes a release manifest of digests; a script run by the developer pulls those digests onto vm-p, vm-i or the laptop and starts a small hello stack. arm64 is off (both hosts are amd64) but stays behind a repository variable. Everything is tested locally without Docker pushes, GitHub or SSH; the live run is the developer's.

## Why
LE-4 and the "Done when" of L-12: a hello stack from CI on both VMs and the laptop. D-41 made both hosts amd64, so the arm64 build is no longer needed now.

## What was built
- `infra/images.json` (one entry per image), `scripts/images-matrix.mjs` (validation and matrix), `scripts/images-release.mjs` (release manifest, fails on a missing digest).
- `.github/workflows/images.yml`: matrix job; pull requests build without pushing; pushes to `main` and `v*` tags build natively, push by digest, merge into a tag, upload `release.json`. Plain `docker buildx` commands; the job token has `packages: write` in the two push jobs only; no secret.
- `infra/hello/` (busybox, pinned by digest, non-root, health check) and `infra/compose/hello-stack.yaml` (image from `HELLO_IMAGE`).
- `scripts/deploy.mjs`: targets p, i, local; by digest, tags refused (exit 2); dry run; `--continue`; ssh runner shared with `verify-hosts.mjs`; addresses redacted.
- ADR 0032, D-51, runbook `docs/runbooks/deploy.md`, handoff H-118.

## How it works
CI: matrix (from `infra/images.json`, arm64 rows only if `BUILD_ARM64=true`) -> build per platform and push by digest -> merge into a tag and read the merged digest -> `release.json`. Deploy: read `release.json`, copy the compose file, `docker pull <digest>`, `docker compose up -d --pull never`, wait for the container health.

## Files changed
New: `infra/images.json`, `infra/hello/Dockerfile`, `infra/hello/index.html`, `infra/compose/hello-stack.yaml`, `scripts/images-matrix.mjs`, `scripts/images-release.mjs`, `scripts/deploy.mjs`, `scripts/images-matrix.test.mjs`, `scripts/deploy.test.mjs`, `.github/workflows/images.yml`, `docs/adr/0032-...md`, `docs/runbooks/deploy.md`, `docs/assets/image-builds-and-deploy/test-output.txt`, the story plan file (notes). Changed: `scripts/ci-workflow-shape.test.mjs` (four tests), `initial.md` (D-51), `docs/adr/README.md`, `docs/dev/HANDOFFS.md`, `docs/dev/dev1-tanmay.md`, `docs/traceability.md`, `CHANGELOG.md`.

## Decisions made
ADR 0032 / D-51 (Proposed, on the developer's delegation): amd64 only with arm64 behind `BUILD_ARM64`; public hello image; human-run deploy; one data file; plain docker commands instead of docker/* actions (fewer third-party actions to pin); registry build cache.

## Tests
Real commands and results are in `docs/assets/image-builds-and-deploy/test-output.txt`:
- `node --test scripts/images-matrix.test.mjs scripts/deploy.test.mjs scripts/ci-workflow-shape.test.mjs` (after the review fixes): tests 36, pass 36, fail 0, skipped 0.
- `node --test "scripts/*.test.mjs"` (full suite): 578 tests, 576 pass, 1 skipped (flock, Windows), 1 fail: the text-file check found a byte order mark in two new files. Fixed; `node scripts/check-text-files.mjs` then passed, and `check-text-files.test.mjs`, `scan-secrets.test.mjs` and the three L-12 test files passed together (49 tests). Final full run after the review fixes: 585 tests, 584 pass, 0 fail, 1 skipped.
- `node scripts/scan-secrets.mjs`: pass. `docker compose -f infra/compose/hello-stack.yaml config -q` with a dummy digest: exit 0.
- Local `docker build` of `infra/hello`, run read-only: health `healthy`, body `hello`. No push, no remote command.
The workflow cannot run here. Not run: GitHub Actions, GHCR, ssh to a VM, the deploy to the laptop.

## Evidence
`docs/assets/image-builds-and-deploy/test-output.txt`.

## Problems met and how they were fixed
- PowerShell `Set-Content -Encoding utf8` writes a byte order mark; the text-file test caught it in `infra/images.json` and the ADR; removed.
- A missing manifest file made `deploy.mjs` exit 1 with a raw error; it is now exit 2 with a clear message (tested).
- YAML anchors for the path filter were dropped (support in Actions is not certain); the list is written twice.
- A first edit of `CHANGELOG.md` with `Get-Content -Raw` damaged non-ASCII characters in other lines; reverted with git and redone safely.

- Review fixes (2026-10-12, after the coordinator's review): (1) `build` and `publish` now also need `github.ref == 'refs/heads/main'` or a tag, so a manual run from a feature branch cannot push (shape test extended); (2) the BOM strip in `deploy.mjs` had mojibake characters instead of U+FEFF, now `﻿` (test with a BOM manifest); (3) `deploy.mjs`: `--user` validated, an identity starting with `-` refused, `--` before the ssh destination (in `sshRun` of `cloud-hosts.mjs`, which also got ConnectTimeout=15 and ServerAliveInterval=15), error text redacted before it is truncated, `--timeout` (default 600 s per ssh or docker call, child killed on expiry), `--force-recreate` plus a `verify image` step (running container's image id equals the pulled image's id), a manifest ref must come from the registry in `infra/images.json` (exit 2); an option that needs a value but has none already exited 2 and is now tested; (4) `images-release.mjs` validates its four flags up front, prints usage, exit 2 (test); (5) `infra/hello/Dockerfile` uses `COPY --chmod=0444`; the first try made `/www` itself unreadable (`httpd: can't change directory to '/www'`), fixed with `WORKDIR /www` before the COPY; (6) runbook and H-118 say that `public` is advisory and that `deploy.mjs` knows only the hello stack. After the Dockerfile fix the local read-only health check was re-run once: `healthy`, body `hello`.

## Security notes (vulnerable parts only)
Not a vulnerable part. No secret, token or address is in any file; the workflow uses only the job token; actions pinned by SHA (checked by a test).

## Limitations and follow-ups
Open and not claimed: the first workflow run (digest read from `imagetools inspect`, registry cache, artifact hand-over, minutes used), making the hello package public, the deploy to vm-p, vm-i and the laptop, the arm64 path (never built). The deploy script only knows the hello stack. Docker buildx command details were not checked against the docs in this session.