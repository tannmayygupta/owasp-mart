# Runbook: image builds in CI and the human-run deploy (hello stack)

Story: L-12 (D-51, ADR 0032, ADR 0011). Files: `infra/images.json`, `.github/workflows/images.yml`, `scripts/images-matrix.mjs`, `scripts/images-release.mjs`, `scripts/deploy.mjs`, `infra/hello/`, `infra/compose/hello-stack.yaml`.

Everything here is free (GitHub Free minutes, GHCR). CI builds and pushes images by digest and writes a release manifest; **you** deploy with `scripts/deploy.mjs`. CI holds no deployment credential and never touches the VMs. Claude ran none of the steps below against GitHub, GHCR, the VMs or the laptop: they are yours, and the result is yours to record.

## How it works (short)
- `infra/images.json` lists the images (name, context, dockerfile, platforms, public). Today: `hello`, amd64 only (both hosts are x86, D-41).
- On a pull request the workflow builds each image and pushes nothing. On a push to `main` (when a listed path changed), on a `v*` tag, or by hand (Actions, "Run workflow"), it builds natively, pushes by digest, merges into the tag `<short commit sha>` (and the git tag) and uploads the artifact `release-manifest` (`release.json`).
- `scripts/deploy.mjs` reads `release.json`, and for each target: copies `hello-stack.yaml`, pulls the image by digest, runs `docker compose up -d`, waits for the container health check. A manifest entry that is a tag and not `@sha256:` is refused (exit 2).
- arm64: off. To build it later (a move to t4g or Oracle) set the repository variable `BUILD_ARM64` to `true` and add `linux/arm64` to the image's `platforms`.

## Part A. Run the workflow
0. Note: a manual run only builds and pushes when started on `main` (or on a `v*` tag); from any other branch only the matrix job runs.
1. Push the branch through a pull request as usual, merge it to `main` (the workflow builds on pushes to `main` that touch `infra/images.json`, `infra/hello/**`, `apps/**`, `contracts/mocks/**`, the two image scripts or the workflow itself), or start it by hand: GitHub, Actions, `images`, "Run workflow" on `main`.
2. Open the run. Expected: jobs `build matrix`, `build and push hello amd64`, `tag and release manifest` green.
3. Record the minutes used: Settings, Billing, Usage, Actions (or the run's "Billable time"). Note them in the dev-log. If a job fails, copy only the failing step's last lines into the dev-log (no tokens).
4. Download the artifact `release-manifest` from the run page (a zip with `release.json`). It holds the commit and one `ghcr.io/<owner>/<repo>/hello@sha256:...` line.

## Part B. Make the hello package public (once)
GitHub, your profile or organisation, Packages, `<repo>/hello`, Package settings, "Change visibility", Public. The hello image holds no secret. Without this the VMs would need a login to pull. (The `buildcache-amd64` tag lives in the same package; it can stay.)

## Part C. Deploy
Use the same SSH key and address file as `scripts/verify-hosts.mjs` (`hosts.local.json` in your provider's Terraform folder; your IP must be in the security group). Run from the repository root:
1. Dry run (prints the commands, runs nothing): `node scripts/deploy.mjs --manifest <path>/release.json --target p,i,local --dry-run`
2. Both VMs: `node scripts/deploy.mjs --manifest <path>/release.json --target p,i --identity <ssh-key-path> --provider aws`
3. The laptop (Docker Desktop running): `node scripts/deploy.mjs --manifest <path>/release.json --target local`
4. Expected: for each target the lines `PASS <host> copy compose file`, `pull`, `compose up`, `health check`, then `RESULT PASS`. Exit code 0.
5. Check by hand on a VM (optional): `ssh <vm> "curl -s http://127.0.0.1:18081/"` prints `hello`. On the laptop the same stack listens on `http://127.0.0.1:18081/`.
6. Clean up when done: on a VM `sudo docker compose -f ~/vulnmart-deploy/hello-stack.yaml down` needs `HELLO_IMAGE` set (any digest reference works for `down`); on the laptop `docker rm -f vulnmart-hello-stack`.

The deploy recreates the container (`--force-recreate`) and fails the step `verify image` unless the running container uses the image that was pulled by digest. Each ssh or docker call has a time limit (`--timeout <seconds>`, default 600). `--user` must match `^[a-z_][a-z0-9_-]*$`.

Options: `--continue` keeps going with the next target after a failure (exit is still 1); `--user` changes the ssh user (default `ubuntu`). Exit codes: 0 ok, 1 a step failed or a host is unreachable, 2 bad input (tag instead of digest, missing key, unknown target).

## Part D. What to record (dev-log, not claimed in advance)
- The workflow run link or number, the run time and the minutes used.
- The digest line (not secret) and that both VMs and the laptop reached `RESULT PASS`.
- Anything that failed and how it was fixed. Then set Done = Yes in the Excel sheet and tick L-12 in `docs/dev/dev1-tanmay.md` only when you are satisfied.

## Add an image
Add one entry to `infra/images.json` (`name`, `context`, `dockerfile`, `platforms`, `public`), keep its Dockerfile in its own stream's folder, and run `node scripts/images-matrix.mjs` (it checks the entry and the files exist). The `public` flag in `images.json` is **advisory**: nothing in CI makes a GHCR package public. Making a package public is a manual step per image (Part B). `scripts/deploy.mjs` knows **only the hello stack**: a new image needs its own compose file, its own key in the manifest and a change to the deploy script (agree it with Tanmay), before it can be deployed. The manifest entry must also come from the registry named in `images.json` (another registry exits 2).

## Private images
A private GHCR image needs a login on the host before the pull. Create a fine-grained or classic token with only `read:packages`, store it on the host (`docker login ghcr.io -u <user> --password-stdin`, run once on the VM by you), never in this repository or in CI. The hello image is public on purpose so the first proof needs none.

## Limits and notes
- The workflow itself cannot run outside GitHub: it is covered by a shape test (permissions, no secret, pinned actions, no push on pull requests). The digest read (`docker buildx imagetools inspect`), the registry build cache and the artifact hand-over are unproven until Part A.
- The hello stack publishes only `127.0.0.1:18081` on the host: nothing opens in the firewall or the security group.
- Pinned third-party actions: checkout, setup-node, upload-artifact v7.0.2, download-artifact v8.0.2. Update them on purpose, never automatically.
