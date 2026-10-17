# S-3 and S-15 on vm-i: what blocks a container from the host, and how the edge behaves with many networks

Status: measured live on vm-i on 2026-10-18 (Claude over SSH on the developer's authorisation; story 4.3, task L-29 part 1). Evidence: `docs/assets/story-4-1-isolation-probe/vm-i-*.json` and `vm-i-*.txt`, `docs/assets/story-8-5-vmi-audit/vm-i-audit.txt`. Stub image, empty vm-i.

## S-3: which mechanism stops a container from reaching the host through the gateway address
**Answer: the per-subnet INPUT rule of `infra/hosts/vulnmart-egress.sh` is what blocks it. The internal network alone does not.**

Method (no firewall rule was changed; the runbook's way of deleting the rules was refused by a safety check): the probe was run twice, once on subnets the host rules cover (baseline) and once on two fixed subnets outside the covered sets (`--probe-subnet 10.250.250.0/24 --peer-subnet 10.250.251.0/24`, new options of `scripts/isolation-probe.mjs`), so the rule cannot match the second network.

| Target (from inside an internal network) | covered subnet (rule applies) | uncovered subnet (rule cannot apply) |
|---|---|---|
| network gateway, port 22 | timeout (dropped) | **OPEN** (the host's SSH answered) |
| network gateway, port 80 | timeout | refused (host reachable, nothing listens) |
| network gateway, port 443 | timeout | refused |
| network gateway, port 2375 | timeout | timeout (INPUT policy DROP, no accept rule) |
| docker0 address, host.docker.internal, peer network, metadata, public, LAN, platform names | blocked | blocked |

What it means for the design:
1. The internal network blocks everything except the host's own addresses on the instance network's gateway; the INPUT rule closes that last hole. Without it a hostile instance can talk to the host's SSH daemon.
2. The rule is per subnet, so every network the orchestrator creates must fall inside `LABS_DOCKER_SUBNETS`. On vm-i the daemon has one address pool (one /16 base, /24 networks, 256 in total) inside the covered set, so a network Docker allocates by itself is always covered (checked: step 3b and the `daemon-pools` and `host-rule-input` audit lines). A network created with a manual `--subnet` outside the set would not be covered: nothing in the orchestrator does that, and a template cannot ask for it (NFR-SEC-04).
3. The uncovered variant fails the probe on purpose; the exit code 1 and the line `FAIL open: network-gateway:22` are the proof the probe detects the hole.

## Persistence (runbook steps 8 and 9), vm-i empty
| After | docker | egress unit | lab INPUT rules | probe |
|---|---|---|---|---|
| `systemctl restart docker` | active | active | 2 | PASS (16 blocked, control reached) |
| `systemctl reboot` (back in about 45 s) | active | active | 2 | PASS (16 blocked, control reached); certificate timer enabled |

## Port scan (step 10) and the read-only audit
From an allowed source address vm-i shows only port 22 open; vm-p shows 22 and 443 (the origin gate). The read-only audit on the real command bundle: 8 PASS, 0 FAIL, 0 SKIP (seccomp default, pools allow 256 networks, live-restore, both host-rule lines, container hardening with 0 containers, listeners, IMDS v2 required on both hosts).

## S-15: the edge with many attached networks
The real edge-gate container, attached to N internal networks by a script (not by the orchestrator):

| Networks attached | Memory | `docker restart` returned | Healthy again | Attachments after the restart |
|---|---|---|---|---|
| 1 | 24.4 MiB | 0.33 s | 2.42 s | kept |
| 5 | 17.4 MiB | 0.51 s | 2.59 s | kept |
| 10 | 17.4 MiB | 0.73 s | 2.80 s | kept |
| 20 | 17.4 MiB | 1.18 s | 3.29 s | kept |

Attaching takes about 26 ms per network. Restart time grows slowly (about 0.05 s per network); the limit is the 256-network pool, not the edge. Not measured: 20 real instances behind the edge, the per-hostname gate check, and the time until the orchestrator re-syncs the gate after an edge restart (they need the reconcile pass); the attach was emulated.