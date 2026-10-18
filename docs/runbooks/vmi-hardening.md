# Runbook: VM-I isolation audit and hardening checklist (story 8.5, L-29)

Goal: see the isolation state of `vm-i` in one read-only table and save it as evidence (NFR-ISO-05 to 07, NFR-SEC-04). Before the demo this is **checking, not changing** (D-99, proposed): no new isolation mechanism goes onto `vm-i` between now and 19 Oct. A FAIL line is fixed with a control that already exists and is already tested (for example re-apply the host rule), then the audit is run again.

The tool is `scripts/vmi-audit.mjs`. It only parses text. It never calls the network, AWS or the host by itself. I (Claude) did not run anything on `vm-i`: no result of this runbook exists until you paste it back.

## Part A: do before the demo (read only)

Every AWS window needs the profile line first: `$env:AWS_PROFILE = "vulnmart"`.

1. **Run the existing probe** as written in `docs/runbooks/isolation-vm-i.md` (steps 1 to 4, host rule ON). Expected last line: `isolation probe: PASS (16 forbidden targets blocked, control reached)`. Do not do its steps 5 to 9 (they switch the rule off and restart Docker) if instances are running.
2. **Save the command outputs on the host** into one folder, with exactly these file names (every command is read-only). SSH to `vm-i` with your own key, then:

```sh
mkdir -p ~/vmi-audit && cd ~/vmi-audit
docker info --format '{{json .}}' > docker-info.json
cp /etc/docker/daemon.json daemon.json
sudo iptables -S DOCKER-USER > iptables-docker-user.txt
sudo iptables -S INPUT > iptables-input.txt
sudo iptables -S VULNMART-LABS > iptables-vulnmart-labs.txt
docker inspect $(docker ps -q) > inspect.json
ss -ltnH > ss.txt
```

   If no container runs, `docker ps -q` is empty and `docker inspect` fails: write `[]` into `inspect.json` instead (`echo '[]' > inspect.json`).
3. **IMDS check** (your AWS window, filtered to one value per instance; it prints no address):

```powershell
$env:AWS_PROFILE = "vulnmart"
aws ec2 describe-instances --query "Reservations[].Instances[].MetadataOptions.HttpTokens" --output json > imds.json
```

   Copy `imds.json` into the same folder. Every value must be `required`. If you skip this step the audit prints SKIP for that line.
4. **Copy the folder to your PC** (`scp -r <user>@<vm-i address>:vmi-audit .` from a folder outside the repository) and run the audit there:

```powershell
node scripts/vmi-audit.mjs --from <that folder> --instances 50 --out docs/assets/story-8-5-vmi-audit/vm-i-audit.txt
```

   `--instances` is the largest number of instance networks you plan to run at once (default 50). Exit code 0 means no FAIL.
5. **Save evidence** under `docs/assets/story-8-5-vmi-audit/`: `vm-i-audit.txt` (the `--out` file; addresses, account ids and instance ids are already redacted by the script, look once more before you commit) and the last line of the probe run. Do not save the raw input files: `inspect.json` holds environment variables and `docker-info.json` holds host details.
6. **Tell me** the result (PASS and FAIL lines). I record it in the traceability rows and the dev-log as your live result. Until then the rows say "checked locally on fixtures and Docker Desktop only".

### What each line checks

| Line | PASS means |
|---|---|
| `docker-seccomp` | The default seccomp profile is reported (not `unconfined`). The line also says rootless and user namespaces yes or no: reported, not required (checked, not extended). |
| `daemon-pools` | `default-address-pools` in `daemon.json` allow at least `--instances` networks (/24 networks counted from each base and size). |
| `daemon-live-restore` | `live-restore` is true. |
| `host-rule-docker-user` | The first `DOCKER-USER` rule jumps lab subnets to `VULNMART-LABS`, and every pool base is inside a jumped subnet. |
| `host-rule-input` | The first `INPUT` rule(s) drop new connections from the lab subnets (the host rule of story 4.1), and every pool base is covered. |
| `container-hardening` | No privileged container, no host network or PID, the Docker socket is mounted only by `docker-proxy` and read-only, no writable bind mount outside `/etc/vulnmart`, `/opt/vulnmart`, `/srv/vulnmart`, and every instance container (label `vm.instance` or name `vm-i-*`) drops ALL capabilities and sets `no-new-privileges`. |
| `listening-ports` | Every listener is on loopback, or on port 22, 80 or 443. |
| `imds-v2-required` | Every instance has `HttpTokens: required`. |

A line that cannot be read (empty or garbled input) is a FAIL, never a PASS. A missing required input file is a FAIL.

### Dry run on your PC (no VM needed)

```powershell
node scripts/vmi-audit.mjs --from scripts/fixtures/vmi-audit/good     # expected: 8 PASS
node scripts/vmi-audit.mjs --from scripts/fixtures/vmi-audit/bad-privileged   # expected: one FAIL
node scripts/vmi-audit.mjs --local                                    # Docker Desktop: reads docker info and docker inspect only
```

`--local` skips the iptables, listener and IMDS lines with a reason. On Docker Desktop the daemon lines describe your PC, not `vm-i`.

### If a line is FAIL (use existing controls only)

| Line | Existing fix |
|---|---|
| `host-rule-docker-user` or `host-rule-input` | `sudo systemctl restart vulnmart-egress.service` (re-adds every per-subnet rule, checking first), then re-run steps 2 and 4. If the pool in `daemon.json` is wider than `LABS_DOCKER_SUBNETS` in `/etc/vulnmart/egress.env`, tell me: that is a config mismatch to fix, not a new mechanism. |
| `container-hardening` | Find the named container; if it is an instance, destroy it through the orchestrator (do not edit it by hand) and check which template or orchestrator setting produced it. Tell me before changing code. |
| `listening-ports` | Find what listens (`sudo ss -ltnp` on the host) and stop or bind it to loopback with the existing service file. |
| `daemon-pools`, `daemon-live-restore` | Compare with `infra/hosts/docker-daemon.json` (the intended file). A wider pool is Part B, not for the demo window: lower `--instances` to what the pool allows and say so. |
| `imds-v2-required` | Set the requirement in the Terraform of the host (the existing setting), not on the console. |

## Part B: after the demo only (NOT FOR 17 to 19 OCT)

Nothing here is applied before the demo. Each item needs a throwaway instance (a copy of `vm-i` or a separate small VM), the test first, and a written rollback. S-8 stays open until one of these passes its test and the developer decides.

1. **User namespace remap (`userns-remap`).** Test first on the throwaway host: set `"userns-remap": "default"` in `daemon.json`, restart Docker, run `node scripts/isolation-probe.mjs` and the stub instance harness (`node scripts/dev.mjs harness`). Known costs: volumes created before the change become unreadable, bind mounts need matching subuid ranges, some images fail. Rollback: remove the key, restart Docker, recreate the volumes.
2. **Rootless Docker.** Test first: install rootless Docker for a separate user on the throwaway host, run the orchestrator against that socket, run the probe. Known costs: no privileged ports, different network driver (slirp4netns or pasta), the host rules of `infra/hosts/vulnmart-egress.sh` do not apply the same way and need a redesign. Rollback: stop the user service, keep the rootful daemon.
3. **gVisor (`runsc`).** Test first: install `runsc`, register it as a Docker runtime, run one stub instance with `--runtime=runsc`, then the probe and the instance conformance check. Known costs: slower syscalls, some images fail, the Docker Compose network setup must be re-tested. Rollback: stop using the runtime flag; the default `runc` is unchanged.
4. **Wider address pools.** Test first on the throwaway host: set a larger `default-address-pools` in `daemon.json` (keep it inside `LABS_DOCKER_SUBNETS`, and add every new range to the rule file), restart Docker (this kills running instances), run the probe, and check `host-rule-*` in the audit. This is a change to `infra/hosts/**` and needs its own story (it is listed in `docs/bmad/initiative-lab/deferred-work.md`). Rollback: restore the old `daemon.json`, restart Docker, restart `vulnmart-egress.service`.

For each: record the test command, the result, and the rollback you used. Do not merge a mechanism into `infra/hosts/**` without a passing probe and audit on the throwaway host.

## Part C: how to write the spike results (S-3, S-8, S-15)

Put each result in the dev-log of the task that ran it (one short paragraph each) and in `docs/traceability.md` (the rows S-3, S-8, S-15), then record a decision only after you confirm it.

- **S-3** (which rule blocks a container from the host through the gateway address): from `isolation-vm-i.md` steps 3, 5 and 6. Write: gateway rows with the rule on (`timeout`), with the rule off (`refused`, `open` or `timeout`), and one sentence: "the INPUT rule is / is not what blocks the gateway".
- **S-8** (extra isolation: user namespaces, rootless, gVisor): write which of the four Part B items you tested, the test command, pass or fail, the cost you saw, and the decision. If none was tested: "open, not tested before the demo (D-99)".
- **S-15** (edge restart and many attached networks): from `isolation-vm-i.md` step 11. Write the three sizes (1, 5, 10 networks), the attached-network counts, the restart seconds and the seconds to healthy. If the edge was not built: "edge not built".

Never write an address, an account id or a key name in these notes.
