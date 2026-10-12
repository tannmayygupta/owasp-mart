# Runbook: cold start and memory per instance on vm-i (spike S-4, story 3.3)

Goal: real numbers for (1) how long an instance takes from `create` to `ready`, and (2) how much memory one instance uses, on the labs host `vm-i`. Stories 3.4 and 3.6 use them (idle/start timeouts, how many instances fit). The tool is `apps/orchestrator/src/vulnmart_orchestrator/measure.py`. It uses the real engine and the real Docker backend, with random fake flags, a random seed and event key. Nothing real is read or printed.

**Cost warning:** `vm-i` is stopped to save credits. Start it only for this run and stop it again after (step 8). Never create or replace a host while `vm_i_running=false` (rule from story 1.15).

All steps are yours. I (Claude) do not call AWS or SSH to hosts. Paste the redacted output back to me.

## Steps

1. **Start vm-i** (your AWS window, every new window needs the profile line first):
   `$env:AWS_PROFILE = "vulnmart"` then start it the way you did for the earlier checks (`docs/runbooks/aws-account-and-vms.md`). Wait about 2 minutes, then SSH in with your own key.
2. **Get the code on the host** (clone is private, use your own deploy method; no token in this repo):
   `git clone git@github.com:tannmayygupta/owasp-mart.git && cd owasp-mart && git switch shared-L-13`
   (after the L-13 pull request is merged, use `main`). If the host has no git access, copy the folder with `scp -r` instead.
3. **Install uv** if missing: `curl -LsSf https://astral.sh/uv/install.sh | sh`, then `source ~/.bashrc`.
4. **Build the stub instance image** (the real shop image comes with L-12 and T-04; the stub has the same shape: injector, then a shop with `/readyz` and a healthcheck):
   `docker build -q -f contracts/mocks/stub-instance/Dockerfile -t vulnmart-stub-instance:local .`
   Note: the stub is much lighter than the real shop. Repeat steps 5-6 with the real images (`--manifest <release.json>`) once Sahil's shop is built; the numbers of the stub are a floor, not the answer.
5. **Idle baseline** (nothing of VulnMart running): `free -m` and `docker ps -q | wc -l`. Keep the output.
6. **Measure** (about 3-6 minutes):
   `uv run --package vulnmart-orchestrator python -m vulnmart_orchestrator.measure --stub-image vulnmart-stub-instance:local --rounds 10 --count 10 --out /tmp/s4`
   - `--rounds 10`: ten cold starts, one at a time.
   - `--count 10`: ten instances running together; the tool then reads the memory of every container and the drop of the host `MemAvailable`.
   - Exit code 0 means no failed instance and nothing left behind. Exit 1 means a failure or leftovers (the JSON says which).
   Optional, to see the limit: repeat with `--count 20`.
7. **Paste back** the JSON printed at the end plus the `free -m` of step 5. It holds only numbers and the host class (kernel, CPU count, total memory): no address, no name. Also run `docker ps -a | wc -l` and `docker volume ls | wc -l` and tell me the counts (both should be unchanged from before).
8. **Stop vm-i** again (same AWS way as step 1) and confirm it shows stopped.

## What I do with the result

Fill `docs/research/s4-cold-start-and-memory.md` (the table is empty until your run), save the JSON as `docs/assets/orchestrator-measure/measure-result.json`, and set the defaults in story 3.4: health timeout = about 3 x the p95 cold start (rounded up), and capacity per instance = measured memory plus a margin.

## If something fails

- `no Docker daemon`: your user is not in the `docker` group; log out and in, or use `sudo` for the docker build only (the tool itself needs the Docker socket).
- `there are already containers ... labelled vm.instance`: leftovers of an earlier run; remove them with `docker rm -f $(docker ps -aq --filter label=vm.instance)` (this only matches VulnMart instance labels), then run again.
- A round says `error` or `failed`: paste that line; it carries the error code (`INST-HEALTH-TIMEOUT`, `INST-INJECT-*`), not a stack trace.
