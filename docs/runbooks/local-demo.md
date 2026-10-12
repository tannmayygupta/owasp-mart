# Local demo for the guide meeting

One command shows the work of all three streams running on your own machine:

    node scripts/dev.mjs demo

Options: `--keep` (leave the platform stack up afterwards; remove it with `node scripts/dev.mjs demo down`), `--stub-only` (do not try the real shop image), `--no-web` (skip the dashboards).

## Before you start
- Docker Desktop is running ("Engine running"). `uv` and Node 24 are installed (`node scripts/dev.mjs doctor`).
- Ports 3000, 8000 and 8025 are free on 127.0.0.1, and no `vulnmart-*` containers exist. The demo checks this first and stops with a clear message instead of touching anything.
- First run takes about 4 to 5 minutes (it builds the platform and shop images). Later runs take about 2.5 minutes.
- It uses its own Compose project `vulnmart-demo`. It never touches other containers or volumes (for example `n8n_data`).

## What each step proves
| Step | What it proves |
|---|---|
| preflight-tools, preflight-clean-machine | The machine is ready; nothing of VulnMart was already running. |
| platform-stack-up | Stream P: Postgres, Valkey, Mailpit, migrations, API and dashboards start and become healthy with Compose profiles. |
| api-health | The API answers its probes and checks Postgres and Valkey. |
| api-refuses-without-origin-secret | The API refuses `/api/*` calls that do not come through the proxy (403). |
| web-proxy-health | The dashboards page reaches `/api/v1/health` on the same origin (the proxy adds the secret). |
| origin-secret-hidden | The secret header is in no response header and no page body: the browser side never sees it. |
| stub-image-build, shop-image-build | Stream L builds the stub instance image; stream T's `apps/shop` image builds. |
| shop-role | The real shop is tried in the shop role. If it does not meet the instance contract the demo falls back to the stub and says so (this is not a failure). |
| orchestrator-start | Stream L: the real Python orchestrator service runs with the Docker backend, a random temporary signing key and a reduced two-component template (injector and shop). |
| client:host-status | The platform's own client (`HttpInstanceHost`, IF-5) reads the host status over signed requests. |
| client:create-and-ready | An instance is created from the template and reaches `ready` (the injector ran first, then the shop became healthy). |
| client:get-has-no-secrets | The answer has 12 fields and none holds a flag, seed, key or digest (7 fake secret values checked). |
| client:shop-readyz-inside | Inside the instance network, the shop answers `/readyz`. |
| client:open-access, client:list | Access is opened; the instance is listed. |
| client:create-again-is-idempotent | The same create again changes nothing (200, same epoch). |
| client:error-format-if8 | An unknown template gives the closed IF-8 error body with code `ORCH-TEMPLATE-UNKNOWN` and a request id. |
| client:destroy, client:destroy-again-is-idempotent | Destroy works, a second destroy is harmless. |
| client:nothing-left-over | No container, network or volume labelled `vm.instance` remains. |
| cleanup | The platform stack, its volumes, the orchestrator process and the temporary files are gone. |

The run saves a redacted copy of the table in `docs/assets/local-demo/demo-output.txt` (numbers, states and codes only; no address, key or flag).

## Talk track (about 5 minutes)
1. **Why (30 s).** VulnMart is a vulnerable shop for training. Every player gets a private instance. Three streams build it: P the platform, L the lab/orchestrator, T the target shop. This one command runs all of them locally.
2. **Stream P, platform (90 s).** Show `platform-stack-up` and the web steps. Say: one Compose file with profiles starts the API, database, cache, mail catcher and dashboards. The dashboards call the API on the same origin; the proxy adds a secret header that the browser never sees; calling the API directly without it gives 403.
3. **Stream L, orchestrator (120 s).** Show `orchestrator-start`, then the client steps. Say: the orchestrator is a separate service with a signed API (IF-5). It only accepts a template name, never an image or command. Create starts a volume keeper, the injector, then the shop; the instance is `ready` only after the injector exited and the shop is healthy. Show the get answer has no secrets, the idempotent repeat, the IF-8 error, and destroy leaving nothing behind (`nothing-left-over`).
4. **The platform client (30 s).** The same client class the platform API will use drove all of this. It is the proof that the contract between P and L works over real HTTP with signing.
5. **Stream T, the shop (60 s).** Show `shop-image-build` and `shop-role`. Say: the real shop image builds and follows the instance contract (non-root, read-only, flags from the injector). Today it does not yet pass as the shop role inside the orchestrator: the orchestrator's health check runs `wget`, which the minimal (distroless) shop image does not contain, so the demo uses the stub in that role and says so. Closing this gap is a follow-up between L and T. Sahil's import service, mock services and bot controller are on branch `origin/sprint-2-sahil` and are not in `main` yet, so the demo uses a reduced two-component template (injector and shop).
6. **Close (30 s).** Every step PASS, cleanup PASS, nothing left running, evidence file saved.

## Troubleshooting
- **"Docker is not running"**: start Docker Desktop, wait for "Engine running", run again.
- **"containers already exist" or "port(s) in use"**: an earlier stack is running. Run `node scripts/dev.mjs down` (or `node scripts/dev.mjs demo down` after a `--keep` run), or stop whatever uses the port. The demo will not remove containers it did not start in this run.
- **`platform-stack-up` fails**: look at `docker compose -p vulnmart-demo logs api` while it is still up (use `--keep`). First build needs internet for base images.
- **`orchestrator-start` fails**: `uv` must be installed; the step prints the last lines of the service log. Run `uv sync --locked` once if packages are missing.
- **`shop-role` says the real shop does not satisfy the role**: expected today (see talk track 5); not a failure.
- **A run was interrupted (Ctrl+C, power loss)**: run `node scripts/dev.mjs demo down` for the platform stack. For instance leftovers: `docker ps -a --filter label=vm.instance` lists them; remove only those.
- **`--keep`**: leaves the platform stack up for the meeting; the orchestrator and temporary files are always removed at the end of the run.