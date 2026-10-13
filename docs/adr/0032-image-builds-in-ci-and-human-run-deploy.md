# 0032. Image builds in CI (amd64 now, arm64 behind a switch) and a human-run deploy script

- **Status:** Proposed (decided on the developer's delegation 2026-10-12, "do what is best, least tokens, free only"; recorded as D-51). Becomes Accepted when the developer confirms it after the live run (runbook `docs/runbooks/deploy.md`).
- **Date:** 2026-10-12
- **Deciders:** Tanmay (stream L), on delegation (D-51)
- **Requirements:** LE-4, NFR-POR-02, NFR-CST-02, D-14, D-28, D-41, ADR 0011, architecture 02 sections 6.1 and 6.2, story L-12

## Context
ADR 0011 and architecture 02 describe the design (CI builds and pushes images by digest, a human deploys) but nothing existed: no workflow, no deploy script, no image list. D-41 (ADR 0022) made both hosts amd64, so the arm64 build of D-28 and LE-4 is not needed today. Free services only.

## Options considered
1. **Matrix of native builds on GitHub runners, push by digest to GHCR, merge into a tag, release manifest; a human-run `scripts/deploy.mjs` (chosen).** Follows ADR 0011 option 2; no deployment credential in CI; GHCR and GitHub Free minutes cost nothing.
2. **Build on the VM (D-28).** No longer needed: both VMs are amd64 and CI builds amd64 natively.
3. **QEMU emulation for arm64.** Slow; not needed now.
4. **Deploy from CI over SSH.** Rejected: needs a deployment key in CI (ADR 0011, architecture 02); SSH is open only to the developer's address anyway.

## Decision
- D1: `.github/workflows/images.yml`: a matrix job reads `infra/images.json` (via `scripts/images-matrix.mjs`); on pull requests an image is built but never pushed and the token is read-only; on pushes to `main` and on `v*` tags each image is built natively per platform and pushed by digest, then merged into a tag (short commit sha, plus the git tag), and `release.json` (one `registry/owner/repo/name@sha256:...` reference per image plus the commit) is uploaded as an artifact. Plain `docker buildx` commands are used (only checkout, setup-node and the artifact actions are third-party, all pinned by SHA). The only token is the automatic `GITHUB_TOKEN` with `packages: write` in the two push jobs; no repository secret.
- D2: amd64 only now. The arm64 row stays in the matrix code and the workflow and is switched on by the repository variable `BUILD_ARM64=true` (default off) and by listing `linux/arm64` in an image's platforms, so a move to Graviton (t4g) or Oracle needs no redesign. This amends the arm64 part of LE-4 and NFR-POR-02 (D-51).
- D3: the hello image is public in GHCR (no secret in it), so the VMs pull without a login. A private image later needs a read-only token on the host (runbook note).
- D4: `scripts/deploy.mjs`, run by the developer: targets `p`, `i`, `local`; ssh with the developer's key like `scripts/verify-hosts.mjs`; pulls by digest from the release manifest and refuses a tag (exit 2); `--dry-run` prints the commands; `--continue` lets later targets run after a failure; no secret or address is printed.
- D5: one data file `infra/images.json` (name, context, dockerfile, platforms, public); adding an image is one entry.
- D6: free only; path filters on the workflow and a registry build cache (`buildcache-<arch>` tag per image).
- Files: `infra/images.json`, `scripts/images-matrix.mjs`, `scripts/images-release.mjs`, `.github/workflows/images.yml`, `infra/hello/`, `infra/compose/hello-stack.yaml`, `scripts/deploy.mjs`, runbook `docs/runbooks/deploy.md`.

## Consequences
Easier: one entry adds an image; every deploy is of a digest, so what runs is what CI built; no deployment secret anywhere. Harder: the deploy is a manual step; the first run of the workflow, the public-package switch and the VM pulls are the developer's; private images need a host token; the registry cache images take a little GHCR storage.
**Not proven (needs the live run):** the workflow itself (it cannot run here), the digest read from `imagetools inspect`, the registry cache behaviour, the artifact hand-over between jobs, GHCR pulls from the VMs, the minutes used. The tests check the matrix, the manifest, the deploy script (with injected runners) and the shape of the workflow.

## Evidence
- Design basis: ADR 0011, architecture 02 sections 6.1 and 6.2 (read 2026-10-12).
- Local checks: `docs/assets/image-builds-and-deploy/test-output.txt` (tests, `docker compose config`, a local build and health check of the hello image).
- Action pins read with `git ls-remote --tags` on 2026-10-12: actions/upload-artifact v7.0.2, actions/download-artifact v8.0.2. The Docker buildx documentation (push-by-digest, `imagetools`, registry cache) was not re-fetched in this story; those commands are unverified until the live run.
