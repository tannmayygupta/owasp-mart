# Runbook: cold start and memory per instance on vm-i (spike S-4, story 3.3)

Goal: real numbers for (1) how long an instance takes from `create` to `ready`, and (2) how much memory one instance uses, on the labs host `vm-i`. Stories 3.4 and 3.6 use them (idle/start timeouts, how many instances fit). The tool is `apps/orchestrator/src/vulnmart_orchestrator/measure.py`. It uses the real engine and the real Docker backend, with random fake flags, a random seed and event key. Nothing real is read or printed.

**Cost warning:** `vm-i` is stopped to save credits. Start it only for this run and stop it again after (step 8). Never create or replace a host while `vm_i_running=false` (rule from story 1.15).

All steps are yours. I (Claude) do not call AWS or SSH to hosts. Paste the redacted output back to me.

## Steps

1. **Start vm-i** (your AWS window, every new window needs the profile line first):
   `$env:AWS_PROFILE = "vulnmart"`, then in `infra\terraform\aws` set `vm_i_running = true` in `terraform.tfvars` and run `terraform apply` (see `docs/runbooks/aws-account-and-vms.md`, "What a stop of `vm-i` does"; do not start it by hand with the AWS CLI). Wait about 2 minutes, then SSH in with your own key. Cost warning: vm-i is stopped to save credits: start it first, stop it after, and never create or replace a host while `vm_i_running = false`.
2. **Get the code on the host** (vm-i's egress allows only tcp 443 and 80, DNS to the VPC resolver and NTP: no ssh and no git, so `git clone` cannot work). Copy the repository from your PC at the branch you want to measure, from the PC:
   `scp -r <repo folder> <user>@<vm-i address>:owasp-mart` or, without copying `.git` and `node_modules`: `git archive HEAD | ssh <user>@<vm-i address> "mkdir -p owasp-mart && tar x -C owasp-mart"`, then `cd owasp-mart` on the host. `uv`, `docker build` and `uv sync` need HTTPS egress only (443), which the host has.
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
8. **Stop vm-i** again: set `vm_i_running = false` in `terraform.tfvars`, run `terraform apply`, and confirm it shows stopped. Never create or replace a host while `vm_i_running = false`.

## What I do with the result

Fill `docs/research/s4-cold-start-and-memory.md` (the table is empty until your run), save the JSON as `docs/assets/orchestrator-measure/measure-result.json`, and set the defaults in story 3.4: health timeout = about 3 x the p95 cold start (rounded up), and capacity per instance = measured memory plus a margin.

## If something fails

- `no Docker daemon`: your user is not in the `docker` group; log out and in, or use `sudo` for the docker build only (the tool itself needs the Docker socket).
- `there are already containers ... labelled vm.instance`: leftovers of an earlier run; remove them with `docker rm -f $(docker ps -aq --filter label=vm.instance)` (this only matches VulnMart instance labels), then run again.
- A round says `error` or `failed`: paste that line; it carries the error code (`INST-HEALTH-TIMEOUT`, `INST-INJECT-*`), not a stack trace.
