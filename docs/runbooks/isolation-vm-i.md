# Runbook: isolation probe on vm-i (spikes S-3 and S-15, story 4.1)

Goal: show from inside a network built like an instance network that a lab container reaches nothing but its own sidecar, on the real labs host `vm-i` (NFR-ISO-01 to 04). Two answers come out of it:

- **S-3:** which rule stops a container from reaching the host through the network gateway address: the INPUT rule of `infra/hosts/vulnmart-egress.sh` (step 3 of that script) or the DOCKER-USER chain. Run the probe with the host rule on and off and compare.
- **S-15:** how long a restart of the labs edge takes and how it behaves with many attached networks (step 11).

The tool is `scripts/isolation-probe.mjs`. It uses only the Docker CLI. It creates objects labelled `vm.kind=isolation-probe` (two internal networks, three small hardened containers) and removes them in every case. It prints no secret and no address of the machine. The local run on Docker Desktop (evidence `docs/assets/story-4-1-isolation-probe/`) proves the internal network only: Docker Desktop's host is a VM, so the host INPUT rule cannot be seen there. This runbook is the run that shows the host rule.

**Cost warning:** `vm-i` is stopped to save credits. Start it only for this run and stop it again at the end (step 12). Never create or replace a host while `vm_i_running=false` (rule from story 1.15).

All steps are yours. I (Claude) do not call AWS or SSH to hosts. Paste back the redacted output.

## Before you start

- **One run at a time.** Never start two probes together on the same host. If a run was killed, clean up by hand: `docker rm -f $(docker ps -aq -f label=vm.kind=isolation-probe)` and then `docker network rm $(docker network ls -q -f label=vm.kind=isolation-probe)`. (A Ctrl-C of the script cleans up itself and exits 130.)
- **Only on an empty vm-i.** Steps 8 and 9 restart Docker and reboot the host: they kill every running instance. Do them only when no instance is running.
- Every new AWS window needs the profile line first: `$env:AWS_PROFILE = "vulnmart"`.
- The probe needs an image with `node`. It uses `vulnmart-stub-instance:local` if present, otherwise `node:24.21.0-alpine` (pulled over 443, which the host allows).

## Steps

1. **Start vm-i** (your AWS window): in `infra\terraform\aws` set `vm_i_running = true` in `terraform.tfvars`, run `terraform apply` (see `docs/runbooks/aws-account-and-vms.md`, "What a stop of `vm-i` does"). Wait about 2 minutes, then SSH in with your own key.
2. **Get the code on the host** (vm-i has no ssh or git egress): from your PC, `git archive HEAD | ssh <user>@<vm-i address> "mkdir -p owasp-mart && tar x -C owasp-mart"`, then `cd owasp-mart` on the host. Build the image if you want the stub: `docker build -q -f contracts/mocks/stub-instance/Dockerfile -t vulnmart-stub-instance:local .` The probe script itself runs on the host and needs Node 24 there (`node --version`); if the host has no Node, tell me before you go on (the script must not run from a container, because it would then need the Docker socket).
3. **Baseline, host rule ON** (the normal state): `node scripts/isolation-probe.mjs --out /tmp/probe-rule-on.json`.
   Expected: exit code 0, last line `isolation probe: PASS (16 forbidden targets blocked, control reached)`, `"control": "open"`, every `network-gateway:*` target `timeout` (the INPUT rule drops the packet), none `open`. The report holds `subnets.probe` and `subnets.peer`. Then `docker ps -a --filter label=vm.kind=isolation-probe -q | wc -l` and `docker network ls --filter label=vm.kind=isolation-probe -q | wc -l` must both print 0.
3b. **Subnet check (the run is invalid without it).** Take `subnets.probe` from the report and compare it with the set `LABS_DOCKER_SUBNETS` in `/etc/vulnmart/egress.env` (the same set the rules in `infra/hosts/vulnmart-egress.sh` use): the probe subnet must lie inside one of them. If it does not, the rules never applied to the probe network, the run proves nothing about the host rule, and S-3 is not answered: stop and tell me. Also check that `subnets.peer` differs from `subnets.probe`.
4. **Read the gateway rows** of `/tmp/probe-rule-on.json`: `network-gateway:22`, `:80`, `:443`, `:2375`. With the INPUT rule on the expected state is `timeout` (the packet is dropped). Note exactly what you see. (On Docker Desktop the same rows show `refused`, because the gateway answers with a reset; on vm-i with the rule on the expected state is `timeout`, as in step 3.)
5. **Switch the INPUT rule off** (S-3, on purpose, for a few minutes only). **Safety net first:** start a timer that restores every rule after 10 minutes even if you forget or lose the session: `sudo sh -c 'sleep 600; systemctl restart vulnmart-egress.service' &`. Then list the rules: `sudo iptables -S INPUT | grep -i vulnmart` (note the line). There is one INPUT rule per lab subnet that drops a new connection from it: delete EACH of them (`sudo iptables -D INPUT <the same rule specification>`, once per rule) or the host rule is still partly on and the result is wrong. Do not touch DOCKER-USER or VULNMART-LABS.
6. **Probe with the host rule OFF:** `node scripts/isolation-probe.mjs --out /tmp/probe-rule-off.json`.
   Expected for the S-3 question: if the gateway rows turn `refused` (or `open`) the INPUT rule was the thing blocking them, and the other targets stay blocked (DOCKER-USER and the internal network hold). If the rows stay `timeout`, something else (DOCKER-USER or the internal network alone) also blocks them. Both outcomes are results; record which. An `open` row on a non-gateway target is a failure: stop and tell me.
7. **Put the rules back:** `sudo systemctl restart vulnmart-egress.service` (it re-adds ALL the per-subnet rules, checking with `-C` first). Confirm with `sudo iptables -S INPUT | grep 'ctstate NEW -j DROP$'` that EVERY line of step 5 is back, then run step 3 again and check it passes.
8. **After a Docker restart (only on an empty vm-i: it kills every running instance):** `sudo systemctl restart docker`, wait 20 seconds, then `systemctl is-active vulnmart-egress.service` and run `node scripts/isolation-probe.mjs --out /tmp/probe-after-docker-restart.json`. Expected: PASS (the unit reruns when Docker restarts).
9. **After a reboot (only on an empty vm-i: it kills every running instance):** `sudo reboot`, SSH in again after about 1 minute, `systemctl is-active vulnmart-egress.service`, run the probe again: `--out /tmp/probe-after-reboot.json`. Expected: PASS.
10. **Port scan note** (from the platform host `vm-p`, or from your PC if the security group allows it; the aim is what the internet side sees of `vm-i`): `nmap -Pn -p 1-1024,2375,2376,9443,9444 <vm-i address>`. Expected: only 22 open (from your listed address); anything else open is a finding. Write down only the open ports, not the address.
11. **S-15, attach and restart timing** (the labs edge is the front container that joins every instance network): with the orchestrator running, create instances until you have 1, 5 and 10 attached networks (or use `scripts/dev.mjs` against a stub). At each size run `docker network ls --filter label=vm.kind=inst -q | wc -l` and `docker inspect --format '{{len .NetworkSettings.Networks}}' <edge container>` and note both numbers. Time an edge restart: `time docker restart <edge container>` and note the seconds, then the time until `docker inspect --format '{{.State.Health.Status}}' <edge container>` is `healthy`. If the edge is not built yet, write "edge not built" for S-15 and keep the probe results only.
12. **Stop vm-i** again: set `vm_i_running = false`, run `terraform apply`, confirm it shows stopped.


**Live record (2026-10-17):** steps 1 to 4 ran on vm-i (Claude over SSH, developer's authorisation): Node 24.21.0 had to be installed first (vm-i has none; a tarball into the home folder, checksum verified; run the probe as `sudo env PATH=$HOME/nodejs/bin:$PATH node scripts/isolation-probe.mjs`, plain `sudo node` does not see it), baseline PASS with the host rule on (16 blocked, control reached, gateway rows timeout). Steps 5 to 7 (host rule off) were refused by the auto-mode safety check when Claude tried them, so they are still to be run by the developer, and steps 8 to 12 are not run. Evidence: `docs/assets/story-4-1-isolation-probe/vm-i-rule-on.json` and `vm-i-stdout.txt`.

## Evidence to save under `docs/assets/story-4-1-isolation-probe/`

- `vm-i-rule-on.json`, `vm-i-rule-off.json`, `vm-i-after-docker-restart.json`, `vm-i-after-reboot.json` (the `--out` files; they hold target names and states only).
- `vm-i-iptables-input.txt`: `sudo iptables -S INPUT` before step 5 and after step 7 (look first for an address of your own and remove it).
- `vm-i-stdout.txt`: the last line of every probe run (`isolation probe: PASS ...` or `FAIL ...`) and its exit code.
- `vm-i-subnet-check.txt`: `subnets.probe`, `subnets.peer` and the value of `LABS_DOCKER_SUBNETS` with one sentence: probe subnet inside the set, yes or no.
- `vm-i-port-scan.txt`: the open ports only.
- `vm-i-s15-timing.txt`: attached networks and seconds.
- A note of the S-3 answer in one sentence: "the INPUT rule is / is not what blocks the gateway".

Then tell me and I record the results in the traceability rows S-3 and S-15 (they are marked "developer's live result" until then).

## What the probe checks, in short

Targets tried from inside the probe container (all must be blocked): the network gateway on ports 22, 80, 443 and 2375; `host.docker.internal`; the docker0 address on 22 and 2375; a container on another internal network (by address); `169.254.169.254`; one public address on 443 and on 53; three RFC1918 addresses; two platform-like names. The control (the alias `sidecar` on the same network) must be reached, or the run fails: a probe that reaches nothing proves nothing. Open means a completed TCP connect; timeout, refused, unreachable and name-not-found are blocked.

## Proposal for later (not done here)

The Docker daemon address pool (`infra/hosts/docker-daemon.json`) limits how many instance networks fit. A larger pool is a change to `infra/hosts/**` and needs its own story; it is listed in `docs/bmad/initiative-lab/deferred-work.md`.
