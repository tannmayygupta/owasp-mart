# T-32: exploits on a deployed instance, in both builds

Status: the script and the local proof exist and ran (2026-10-21). The live run on VM-I has NOT been run; nobody could run it from the development machine. Run it on VM-I and record the result under `docs/assets/t-32/`.

## What T-32 asks

Every one of the 11 exploits passes on the vulnerable build and fails on the fixed build, on a deployed instance (not only in a test process). The vulnerable leg was run live on 2026-10-20 (`scripts/e2e-live-exploits.mjs`, 57 of 57 checks, through the platform). The missing leg is the fixed build, deployed.

## The two builds

The shop decides per challenge from its flags file: a challenge is exploitable only if the injection document carries a flag for it. For a verification run the same instance can be made fixed without a second image: start the shop with `VM_BUILD=fixed` (apps/shop/src/instance/instance.mjs). Every challenge then runs its fixed code, over the same planted data. `VM_BUILD` is not on the instance-contract environment allowlist and the orchestrator never sets it: a player instance can never be fixed by accident.

## The script

```
node scripts/verify-deployed-exploits.mjs --base <shop origin> --build vulnerable|fixed [--cookie "name=value"] [--only C01,C05] [--json out.json]
```

- `--build vulnerable`: every exploit must hold and a flag-shaped value must come back.
- `--build fixed`: every exploit must fail with a clean assertion (a network error or timeout is a FAIL, never "fixed") and no flag-shaped value may come back in any response.
- It talks only to the shop. No platform account, nothing credited. Exit 0 only when all challenges behave as the chosen build must.
- `--cookie` adds the instance's gate cookie (use it with the public origin of an instance, like `e2e-live-exploits.mjs`). Without a gate, tunnel to the shop container's published port.
- C03 runs its live exploit (the support bot and the collector are needed) and C06 needs the import service of the same instance; run it with `--only` for the challenges whose companions run.
- Nothing is printed that looks like a flag.

## Proven locally (the script itself, both builds)

`node scripts/e2e-local-flags.mjs --build fixed --deployed-script yes` and `--build vulnerable --only C01,C02,C04,C05,C07,C08,C09,C10,C11 --deployed-script yes` start the real shop in instance mode (injector, companions, event door) and run the script against it. Results are in the dev-log `docs/dev-log/2026-10-21-tannmayygupta-wp-d-shop-challenges.md`. C06 needs a unix socket and runs only on Linux (`--docker` of the same script).

## Live run on VM-I (to do)

Prerequisites: the released shop, import-service and mock-services images on VM-I (the release manifest), SSH access (the usual `ssh.exe` path and `sudo docker`, see `docs/runbooks/live-deploy.md`).

Option A, through the platform (needs a decision first):
1. Add the name `VM_BUILD` to the environment allowlist of the instance contract for the shop component, and a template `shop-v0-fixed` whose shop component sets `VM_BUILD=fixed`. This is a contract and orchestrator change that this work package does not make (open handoff in `docs/dev/HANDOFFS.md`).
2. The learner API starts only `shop-v0` today (no template choice on `POST /api/v1/instances`), so the operator starts the fixed instance through the orchestrator directly and opens it with a gate ticket.
3. `node scripts/verify-deployed-exploits.mjs --base <instance origin> --cookie "<gate cookie>" --build fixed --json docs/assets/t-32/fixed.json`
4. The same with `--build vulnerable` on a normal instance (or the existing `scripts/e2e-live-exploits.mjs` run).

Option B, direct on VM-I (no contract change): on VM-I run the released images by hand on a throwaway docker network: the injector one-shot with a document on standard input (flags made fresh, never real ones), the shop with `-e VM_BUILD=fixed -e VM_SNAPSHOT_PATH=/run/vm/snapshot.db -e VM_FLAGS_PATH=/run/vm/flags.json -e VM_DB_PATH=/data/shop.db` and the same read-only, non-root, no-capability flags as `apps/shop/instance-harness/shop-instance-check.mjs`, then mock-services and import-service with their placement volumes. Tunnel the shop port and run the script with `--build fixed`, then restart the shop without `VM_BUILD` and run `--build vulnerable`. The exact `docker run` flags are in `apps/shop/instance-harness/shop-instance-check.mjs`; copy them rather than inventing others.

After the run: record both JSON files, mark T-32 done in `docs/dev/dev3-sahil.md` and the tracker (`docs/bmad/initiative-target`) only with that real output, and tick the Excel row by hand.