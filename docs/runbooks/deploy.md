# Runbook: image builds in CI and the human-run deploy (hello stack)

**Cost warning:** vm-i is stopped to save credits: start it first, stop it after, never create or replace a host while `vm_i_running = false`.

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

## Part E. Docker socket proxy for the orchestrator on vm-i (story 4.2, ADR 0010 and 0038, D-58)
The orchestrator must never mount the Docker socket itself. The service `docker-proxy` (profile `lab`) is the only one that does, read-only, and lets through only what the orchestrator uses. These steps are yours: I (Claude) do not use SSH or AWS. Start `vm-i` only for this and stop it again afterwards (rule from story 1.15; every new AWS window first needs `$env:AWS_PROFILE = "vulnmart"`).

1. Start vm-i as in `docs/runbooks/isolation-vm-i.md` step 1, SSH in with your own key, and put the repository files on the host (same `git archive` step 2 of that runbook). Only `infra/compose/compose.yaml` and `infra/compose/docker-proxy/rules.cfg` are needed, in the same folder layout.
2. On the host, check the compose file against the rules and start the proxy: `node scripts/check-lab-compose-rules.mjs infra/compose/compose.yaml`, then `docker compose -f infra/compose/compose.yaml --profile lab up -d --wait docker-proxy`. Expected: `PASS lab compose rules`, then the container `vulnmart-docker-proxy` reports `healthy`. The image is pulled by digest over 443 (the host allows it); if the pull is refused, tell me before you go on.
3. Check that the filter works from the host (no secret in this output): `for p in "GET /_ping" "GET /containers/json" "GET /images/json" "GET /info" "POST /build" "POST /containers/x/exec" "POST /swarm/init"; do set -- $p; echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' -X $1 http://127.0.0.1:2375$2)"; done`. Expected: the first two print 200 and the other five print 403.
4. Check that the proxy answers nowhere but loopback: `ss -ltn | grep 2375`. Expected: only `127.0.0.1:2375` (and nothing on `0.0.0.0` or the vm-i private address). Paste the line with the address removed.
5. WARNING: the proxy port has no login. Any process on vm-i that can reach 127.0.0.1:2375 controls Docker as far as the proxy allows (including creating a root-equivalent container), so run nothing else on vm-i and never forward or publish this port. Start the orchestrator with the proxy as its Docker host: add `--docker-host tcp://127.0.0.1:2375` to the orchestrator command (the option already exists in `service.py`). Do not give the orchestrator process the `docker` group or the socket. Run `node scripts/isolation-probe.mjs` as in `isolation-vm-i.md` if you want the isolation result together with it (it uses the Docker CLI on the host, not the proxy).
6. Create, reset and destroy one stub instance through the orchestrator and check that `docker ps -a --filter label=vm.kind=inst` is empty at the end.
7. Stop the proxy when you are done: `docker compose -f infra/compose/compose.yaml --profile lab down`, then stop vm-i (`vm_i_running = false`, `terraform apply`).
8. Record in the dev-log: the digest line the pull printed, the five status codes of step 3, the `ss` line (address removed) and whether step 6 left anything behind. Do not claim a result you did not see.

The local proof on Docker Desktop (the tests of story 4.2) is in `docs/assets/story-4-2-socket-proxy/`. The orchestrator now runs as the compose service `orchestrator` (profile `lab`, edge story 6, H-143): it uses `--docker-host tcp://docker-proxy:2375` over `vulnmart-labs-core` instead of `127.0.0.1:2375`, so the host-run command of step 5 is the alternative, not the plan; the steps are in `docs/runbooks/edge-vm-i.md` step 3.

## Part F. The labs edge on vm-i (edge stories 2, 3 and 5)
The certificate, the two gate secrets, the edge services, the orchestrator container (its flags --edge-container, --gate-url and --gate-admin-key-file are set in the compose service), the S-15 attach test, the event relay and the browser check are in docs/runbooks/edge-vm-i.md (live steps for you; none of it has been run on vm-i).

## Add an image
Add one entry to `infra/images.json` (`name`, `context`, `dockerfile`, `platforms`, `public`), keep its Dockerfile in its own stream's folder, and run `node scripts/images-matrix.mjs` (it checks the entry and the files exist). The `public` flag in `images.json` is **advisory**: nothing in CI makes a GHCR package public. Making a package public is a manual step per image (Part B). `scripts/deploy.mjs` knows **only the hello stack**: a new image needs its own compose file, its own key in the manifest and a change to the deploy script (agree it with Tanmay), before it can be deployed. The manifest entry must also come from the registry named in `images.json` (another registry exits 2).

## Private images
A private GHCR image needs a login on the host before the pull. Create a fine-grained or classic token with only `read:packages`, store it on the host (`docker login ghcr.io -u <user> --password-stdin`, run once on the VM by you), never in this repository or in CI. The hello image is public on purpose so the first proof needs none.

## Limits and notes
- The workflow itself cannot run outside GitHub: it is covered by a shape test (permissions, no secret, pinned actions, no push on pull requests). The digest read (`docker buildx imagetools inspect`), the registry build cache and the artifact hand-over are unproven until Part A.
- The hello stack publishes only `127.0.0.1:18081` on the host: nothing opens in the firewall or the security group.
- Pinned third-party actions: checkout, setup-node, upload-artifact v7.0.2, download-artifact v8.0.2. Update them on purpose, never automatically.
