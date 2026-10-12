---
title: 'Image builds in CI and the human-run deploy script (hello stack on both VMs and the laptop)'
type: 'feature'
ticket: '4'
created: '2026-10-12'
status: 'built'
baseline_revision: '49f7f4feed57873c1cd1dcbeb0a0567e6346c910'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [edge-case-hunter]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing builds the project's images in CI or puts them on the two VMs and the laptop, so no stream can deploy. ADR 0011 and architecture 02 already describe the design: CI builds and pushes images by digest, a human-run script deploys them. D-41 made both hosts amd64.

**Approach:** A CI workflow builds the images listed in one data file and publishes a release manifest of digests; `scripts/deploy.mjs` pulls by digest on a target (a VM over SSH, or the laptop) and starts a hello stack. The live run (Actions, GHCR, both VMs, the laptop) is the developer's steps.

## Boundaries & Constraints

**Always:** Decisions (developer, 2026-10-12: do what is best, least tokens, free only): D1 Follows ADR 0011: matrix of native builds, push by digest to GHCR, merge into a tag, release manifest, no deployment credentials in CI (only the automatic `GITHUB_TOKEN` with `packages: write`, on pushes to `main` and tags, never on pull requests). D2 amd64 only now (D-41: both hosts are x86); the arm64 job stays in the workflow behind the repository variable `BUILD_ARM64` (default off), so a switch to t4g or Oracle needs no redesign; record D-51 (amends the arm64 part of LE-4 and NFR-POR-02) and ADR 0032. D3 The hello image is public in GHCR (no secret in it) so the VMs pull without a login; private images later need a read-only token on the host (runbook note). D4 Deploy is `scripts/deploy.mjs`, run by the developer: targets `p`, `i`, `local`; ssh with the developer's key like `scripts/verify-hosts.mjs`; pulls by digest from the manifest; no secret or address printed. D5 One data file `infra/images.json` lists images (name, context, dockerfile, platforms, public); adding an image is one entry. D6 Free only: GitHub Free minutes and GHCR; the workflow uses path filters and the build cache.

**Never:** a token, key or address in any file; Claude runs no docker push, ssh, terraform or AWS command against live systems; no push; no change to other streams' Dockerfiles; no deployment from CI.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Matrix | `infra/images.json` | `images-matrix.mjs` prints the build matrix (amd64; arm64 only with the variable) | exit 1 on an invalid entry |
| Pull request | workflow on a pull request | builds without pushing, no `packages: write` | none |
| Manifest | built images | `release.json` with a digest reference per image and the commit | missing digest fails the job |
| Deploy dry run | manifest, target | prints the commands, runs nothing | none |
| Deploy | manifest by digest | pull, compose up, health check, one line per step | exit 1 on any failed step |
| Tag instead of digest | manifest entry without `@sha256:` | refused | exit 2 |
| Local | `--target local` | same compose file on the laptop | none |
| Unreachable host | ssh fails | clear error, other targets still run only with `--continue` | exit 1 |

</frozen-after-approval>

## Code Map

- `.github/workflows/ci.yml` (job pins: actions by SHA, top-level `contents: read`), `scripts/ci-workflow-shape.test.mjs` (pattern for pinning and token rules), `infra/compose/compose.yaml` (`hello`), `scripts/dev.mjs`, `scripts/verify-hosts.mjs` and `scripts/cloud-hosts.mjs` (ssh runner, hosts file, redaction), `apps/shop/Dockerfile`, `contracts/mocks/stub-instance/Dockerfile`.
- New: `infra/images.json`, `scripts/images-matrix.mjs`, `.github/workflows/images.yml`, `infra/hello/Dockerfile` and `infra/compose/hello-stack.yaml` (image from `HELLO_IMAGE`), `scripts/deploy.mjs`, tests, ADR 0032, D-51, `docs/runbooks/deploy.md`.
- Architecture: `docs/architecture/02-deployment-and-network.md` section 6.1 and 6.2; ADR 0011; H-102, H-115, H-117 (stock Caddy, reload command).

## Tasks & Acceptance

**Execution:**
- [x] `infra/images.json`, `scripts/images-matrix.mjs` and test -- the matrix and its validation -- one place to add an image
- [x] `infra/hello/Dockerfile`, `infra/compose/hello-stack.yaml` -- a tiny pinned hello service with a health check -- the hello stack
- [x] `.github/workflows/images.yml` and shape test -- build, push by digest, manifest artifact, no PR push, token rules, arm64 behind the variable -- CI
- [x] `scripts/deploy.mjs` and test (injected ssh and docker runners) -- the matrix rows -- deploy
- [x] ADR 0032, D-51, runbook (developer steps: run the workflow, make the hello package public, deploy to both VMs and the laptop, record minutes used), handoff for adding an image, dev-log, CHANGELOG, traceability LE-4 -- documentation rule

**Acceptance Criteria:**
- Given the repository, when the tests run, then every matrix row passes without Docker, GitHub or SSH.
- Given the workflow, when its shape test runs, then no job outside the push build has `packages: write`, no secret is used, and every action is pinned by SHA.
- Given the runbook, when followed, then the hello stack runs from a CI digest on both VMs and the laptop; those runs are the developer's boxes, not claimed here.

## Implementation Notes

Built 2026-10-12: all five execution items. Extra file `scripts/images-release.mjs` (release manifest, tested in `scripts/images-matrix.test.mjs`). Plain `docker buildx` commands in the workflow (no docker/* actions). Not run: the workflow on GitHub, any push, ssh, deploy; the live steps are in `docs/runbooks/deploy.md`. Status stays in-progress until the developer confirms.

## Plan Change Log

## Review Triage Log

Pass 1 (quick, one lens: edge-case-hunter; token-limited by the developer's instruction). 38 raw findings, no intent_gap, no bad_plan.

| # | Finding | Verdict | Route | Evidence |
|---|---|---|---|---|
| 1 | `workflow_dispatch` on any branch runs build and publish with `packages: write` (plan says main and tags only) | medium | patch | the jobs only exclude `pull_request` |
| 2 | deploy.mjs BOM strip uses mojibake characters, a real BOM is not stripped | medium | patch | the regex literal is not U+FEFF |
| 3 | deploy.mjs: `--user` and host are passed to ssh without validation or `--`; option values may be missing | low | patch | argument injection from the developer's own command line |
| 4 | deploy.mjs: output is truncated before redaction, a cut address escapes the match | low | patch | order of firstLine and redact |
| 5 | deploy.mjs: no ssh or command timeout, a stalled pull hangs | medium | patch | no ConnectTimeout, no runner timeout |
| 6 | deploy.mjs: health can come from an old container; the image run is not compared with the pulled digest | medium | patch | `up -d` does nothing when the container already runs |
| 7 | deploy.mjs: a manifest ref from another registry is pulled | low | patch | no prefix check |
| 8 | images-release.mjs: missing required flags give a TypeError | low | patch | no usage check |
| 9 | infra/hello/Dockerfile: the copied index.html keeps host permissions, uid 65532 may not read it | low | patch | Windows checkout modes |
| 10 | "Adding an image is one entry" is not true: the public flag is advisory (visibility is a manual GHCR step) and deploy reads only `hello` | low | patch (docs) | runbook and H-118 wording |
| 11 | paths filter together with tags; builder name reuse; concurrent retag; tag name characters; empty matrix; symlinks; env leak; sudo hints; missing Health block; 255 exit; project name collision; partial merge when a leg fails | low | reject | GitHub does not apply path filters to tag pushes; hosted runners are ephemeral; `publish` needs every build leg; the matrix always has hello; the hello container was run read-only and healthy locally |
## Design Notes

Why a human-run deploy: ADR 0011 and architecture 02 keep deployment credentials out of CI; SSH is only open to the developer's address anyway. Why a public hello image: the first proof needs no registry login; real images join the same matrix and a host token comes with the first private image.

## Verification

**Commands:**
- `node --test scripts/images-matrix.test.mjs scripts/deploy.test.mjs scripts/ci-workflow-shape.test.mjs` -- expected: all pass
- `node --test "scripts/*.test.mjs"`, `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs`, `docker compose -f infra/compose/hello-stack.yaml config -q` -- expected: pass
