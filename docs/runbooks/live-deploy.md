# Runbook: the live demo deployment (platform on vm-p, lab on vm-i)

Story: production readiness 9.5 (stream L). This is how the deployed system of the demo is made and checked. Every step is a command of the repository; secrets go as files over ssh and are never printed or committed. The two hosts and their addresses come from `terraform output` in `infra/terraform/aws` (open the shell with `$env:AWS_PROFILE = "vulnmart"`); the allowed source address in the security group must be your current address (`ssh_source_cidrs` in `terraform.tfvars`, then `terraform apply`).

**Cost:** vm-i and vm-p run until you stop them (`vm_i_running = false`, `terraform apply`).

## What runs where
- **vm-p** (`infra/deploy/platform.compose.yaml`, project `vulnmart-platform`): Postgres 18, Valkey, Mailpit (a mail catcher, page on 127.0.0.1:8025), the API with the lab runtime (`VULNMART_LAB_RUNTIME=1`, state in Postgres), the mail worker, and Caddy. Caddy serves the site on 443 (the lego certificate of the platform name; the demo console `apps/lab-console` and `/api/*`, with the origin secret added by Caddy because the console is served from the same host) and a private TLS listener on `<vm-p private address>:9444` that carries only `POST /internal/v1/events` and `POST /internal/v1/orch/state` for vm-i.
- **vm-i** (`infra/compose/compose.yaml`, profile `lab`): the Docker socket proxy, the edge (Caddy 443 with the wildcard certificate of the labs zone and the gate), and the orchestrator (mutual TLS on `<vm-i private address>:9443`). Instances are created by the orchestrator from the images in `images.json` (digest-pinned references to a local registry on 127.0.0.1:5000 of vm-i).
- Instance contents: the **real shop** (`apps/shop`, distroless, with a seeded snapshot baked into the image) started by its own `inject` script as the one-shot injector (IF-6 section 5; handoff H-26), the **product** sidecar, import service, mock services and bot controller. Only the volume keeper still uses the stub image (it only holds the volumes). An instance now declares 832 MB (shop 192, sidecar 160, injector 128, import 64, mock 96, bot 128, keeper 64), so `--capacity-mb 5600` admits 6 instances. Challenges are exploitable in an instance exactly when their flag was planted (the shop reads the flags file).

## Steps (from the repository root, on your PC)
1. `node scripts/deploy-secrets.mjs --out %USERPROFILE%\.vulnmart-deploy\prod --vmi-ip <vm-i private> --vmp-ip <vm-p private> --days 90` (once; `--force` replaces everything, which also means new certificates everywhere).
2. `node scripts/live-deploy.mjs build` (eight images, a few minutes), then `ship-i` and `ship-p` (they `docker save`, copy and `docker load`).
3. `node scripts/live-deploy.mjs lab --secrets <folder> --zone <labs zone>` stages the secrets on vm-i (owner 65532, mode 400), starts a local registry, pushes the images, writes `images.json` from the digests it got and starts the lab stack.
4. `node scripts/live-deploy.mjs platform --secrets <folder> --zone <labs zone> --platform-host <platform name>` does the same on vm-p (it also creates a 2 GB swap file; vm-p has 2 GB of memory).
5. `node scripts/live-deploy.mjs status`.
6. `node scripts/e2e-live.mjs --base https://<platform name> --mailpit-ssh ubuntu@<vm-p address> --json docs/assets/<folder>/e2e.json` (one learner start to finish) and with `--load N` for the load check.
7. `node scripts/vmi-audit.mjs --from <folder of the saved outputs>` for the isolation audit; `node scripts/backup.mjs` for the backup and restore test (docs/runbooks/backup-restore.md).

## Stopping and repairing
`node scripts/live-deploy.mjs down-lab | down-platform`. A command can be run again at any time: files are replaced, containers are recreated only when they changed.

## For people who must use the live site (a demonstration)

- **Link:** https://tanmay-platform-prod.duckdns.org/ (the console; ports 80 and 443 are open to everybody since 2026-10-19; SSH only to the developer's address, refresh it with `node scripts/allow-my-ip.mjs`).
- **Accounts:** there is no mail provider key yet, so the confirmation mail of a sign-up goes to Mailpit on vm-p (private) and a person who signs up alone never receives it. Make confirmed demo accounts with `node scripts/demo-accounts.mjs --base https://tanmay-platform-prod.duckdns.org --mailpit-ssh ubuntu@<vm-p address> --out <file outside the repository> --count 5 --prefix demo`. It prints the e-mail addresses (`demoN@vulnmart.example`) and writes the passwords to the file (mode 0600), never to the screen or the repository. The developer holds the file made on 2026-10-19 (`C:\Users\tanma\.vulnmart-deploy\prod\demo-accounts.txt`).
- **What a visitor does:** sign in, press Start, wait a few seconds for the instance, press Open (the console opens the shop in a new tab through the gate), attack the shop, paste or let the sidecar credit a flag, see the score, press Submit. The deployed journey `scripts/e2e-live.mjs` does exactly this through the API (31 checks).
- **Deploying the console:** `live-deploy.mjs platform` replaces the CONTENT of `console/` and `catalog/` (never the folder): a folder that is deleted and recreated leaves a running container with an empty, stale mount (this made the site answer 404 at the root until Caddy was restarted on 2026-10-19; the journey now checks the root page).
