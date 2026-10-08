# RS-B — Per-user isolation, orchestration, flags, traffic monitor
Status: DRAFT research, NOT confirmed by the user · Date: 2026-10-08

Notes on dates: GitHub release pages show day and month only. Years are 2026 where the page or changelog confirms it; otherwise "year not shown". No experiments were run. Anything marked "spike" needs a real test.

## 1. Questions answered

1. **Orchestration.** What starts and stops a private container set per user? Compared: Docker Engine API (Python SDK), compose per user, Kubernetes (k3s) with namespaces, Nomad, and CTF tools (CTFd Whale, CTFd containers plugin, GZCTF, kCTF).
2. **Isolation.** How do we keep a deliberately vulnerable container from reaching the host, other users, the platform DB, secrets, cloud metadata or the internet? What is realistic on Windows+WSL2 and on a free Linux VM?
3. **Traffic monitor.** Reverse proxy per instance that logs requests, spots flags in responses and labels attack types with the OWASP Core Rule Set (CRS). Real tag names, engine choice, event contract.
4. **Flags.** Generation, injection, verification, tamper resistance, format, leaks, rotation.
5. **Lifecycle.** States, TTL, reset, health, startup targets, fast start.

Short answers:
- Use the **Docker Engine API from our own orchestrator service** (Python SDK). It is the only option that is the same on a laptop and a paid VM with zero change, and it is what the CTF tools use underneath.
- Make the network **default-deny by construction** (Docker `--internal` networks, no route out), not by firewall rules we must maintain. Give the SSRF challenge a **fake internal "metadata" container** so it works with no real egress.
- Use **Coraza + CRS 4.x in detect-only** inside a small per-instance proxy. Coraza is the actively released, easy-to-embed engine.
- Derive flags with **HMAC** from a secret that never enters the instance; the platform recomputes to verify.

## 2. Options compared

### 2.1 Orchestration

| Option | Fit with our constraints | Free-tier / cost | Complexity | Main risks | Evidence |
|---|---|---|---|---|---|
| **Docker Engine API via Python SDK (own orchestrator)** | Excellent. Same API on Docker Desktop (WSL2) and any Linux VM. Per-container memory/CPU/pids limits, labels for TTL, networks per user. Matches "FastAPI orchestration API" in the synopsis. | Free | Low to medium. We write the lifecycle logic. | Single host only (fine for our scope). Whoever reaches the Docker socket owns the host, so the socket must be reachable only by the orchestrator. We own TTL/cleanup bugs. SDK `docker-py` 7.x latest 7.2.0 (July, year not shown). | S1, S2 |
| **docker compose per user** | Good for dev. Compose project name per user gives a separate network and containers. Start/stop via CLI or API. | Free | Low | Shelling out to CLI, weaker error handling, no first-class TTL/limits API. Compose is a thin layer over the same Engine API, so it adds little over the SDK. Usable as the *definition* of one instance (template) if we want. | UNVERIFIED (general knowledge) |
| **Kubernetes (k3s) + namespace per user** | Strong isolation primitives: NetworkPolicy default-deny, ResourceQuota, RuntimeClass (gVisor/Kata), Pod Security. Works on a VM. | k3s free. Latest v1.37.1+k3s1 (30 Sep 2026). | High. Hard on a 15 GB laptop that also runs Docker Desktop. On Windows it needs `kind` inside Docker or a VM. NetworkPolicy needs a CNI that enforces it. | Memory overhead, slow start vs plain Docker, a lot more to learn. Laptop and cloud would differ (kind vs k3s). | S3 |
| **HashiCorp Nomad** | Good scheduler, Docker driver, one binary. | Free to run; latest v2.0.7 (18 Sep 2026). License not seen on the page, check before use. | Medium to high | Another system to run for one host. No CTF ecosystem. Isolation controls still come from Docker underneath. | S4 |
| **CTFd Whale** | Built for CTFd (we do not use CTFd). Uses Docker Swarm + frp. | Free | Medium | Tied to CTFd plugin model. Fork of glzjin/CTFd-Whale; no GitHub releases; no archive banner but maintenance not confirmable (last commit date not shown). Swarm adds a second orchestrator. | S5 |
| **CTFd "containers" plugin** | The repo URL I tried returned 404. Not assessed. | not found | n/a | n/a | S6 (404) |
| **GZCTF** | A full CTF platform (own platform, DB, scoring) that can run per-team containers on Docker or Kubernetes, with per-team dynamic flags. Active: v1.9.0 on 3 Oct 2026, v1.8.7 on 5 Jul 2026. | Free | Medium. We would be adopting a whole platform, not a library. Conflicts with our own dashboards, roles and scoring (D-03 to D-08). | Cannot reuse just the container part cleanly (UNVERIFIED how separable). Good **reference design** for per-team flags and traffic capture ideas. | S7, D-01 evidence in `initial.md` |
| **kCTF (Google)** | Kubernetes-based CTF infra aimed at GKE, has local testing walkthrough needing gcloud + Docker. | Free software, GKE costs | High | Built for shared challenges, not per-user-on-demand sets. No releases listed; activity not confirmable from the page. | S8 |

**Reading of the table:** every CTF tool that does per-user containers either wraps the Docker API or Kubernetes. None gives us what we need without taking over scoring and users. We should copy ideas (per-team flags, frp/proxy front door) but write a **small orchestrator**.

### 2.2 Isolation controls (what each buys)

| Control | What it stops | Works on Windows 11 + Docker Desktop (WSL2) | Works on free Linux VM (e.g. Oracle Always Free) | Evidence |
|---|---|---|---|---|
| One **user-defined bridge network per instance** | Other users' containers (Docker blocks traffic between different bridge networks) | Yes | Yes | S9 |
| **`--internal` network** (no outbound route) | Internet, cloud metadata (169.254.169.254), LAN. Containers can only talk to each other. Docker docs warn the gateway IP is still reachable from inside and the host can reach container IPs. | Yes (Docker feature) | Yes | S10 |
| Host firewall `DOCKER-USER` rules | Host-IP access from containers, as a second wall | Hard. Rules live in Docker Desktop's hidden VM; not a supported workflow (spike). | Yes, standard. Docker docs say not to edit Docker's own rules, so use `DOCKER-USER`. The docs page fetched did not describe DOCKER-USER (UNVERIFIED here). | S11 |
| **Resource limits** (memory, cpus, pids, ulimits) | Fork bombs, memory hogs, noisy neighbours | Yes. WSL2 VM has one global cap (`.wslconfig`) | Yes | UNVERIFIED (standard Docker flags) |
| `cap_drop: ALL`, `no-new-privileges`, non-root user, `read_only` + tmpfs | Privilege escalation inside container, persistence, tampering with app files | Yes | Yes | UNVERIFIED (standard flags) |
| **Default seccomp** profile | About 44 of 300+ syscalls blocked, including mount, unshare, ptrace, kernel modules, io_uring. Keep it on; never `unconfined`. | Yes | Yes | S12 |
| AppArmor profile | Extra file/mount restrictions | Not on WSL2 kernel in practice (UNVERIFIED) | Yes on Ubuntu | UNVERIFIED |
| **Rootless Docker** | A daemon or runtime escape lands as an unprivileged user, not root. Needs `uidmap`, 65,536 sub-UIDs. Docs list limits in networking, ports, cgroup v2, AppArmor, overlay. | Not applicable to Docker Desktop (it manages its own VM) | Yes on Ubuntu/Debian; test `--internal` and per-container limits under rootless (spike) | S13 |
| `userns-remap` | Root in container maps to unprivileged host UID | Docker Desktop: not user-configurable (UNVERIFIED) | Yes | S13 (concept) |
| **gVisor (`runsc`)** | Syscall-level sandbox; strongest practical upgrade for hostile code. Needs Linux 5.6+, x86_64 or ARM64. Installs with `runsc install` and `--runtime=runsc`. Page does not mention WSL. | Unknown. Docker Desktop does not let you add runtimes easily (spike). If it fails, the whole stack must still be safe without it. | Likely yes on x86_64 and Ampere ARM64 | S14 |
| Kata Containers (micro-VM) | Hardware-level boundary | Needs nested virtualisation; unlikely on WSL2 + Docker Desktop and on free VMs (not researched in depth, UNVERIFIED) | Usually no: free VMs rarely expose nested virtualisation (UNVERIFIED) | not found |
| Sysbox | Safer "container-in-container", better user-namespace isolation | No (needs its own Docker daemon install) | Yes on Ubuntu; v0.7.1 (31 Jul), needs recent kernels for new features. Only useful if we run Docker-in-Docker, which we avoid. | S15 |
| Docker Desktop **Hyper-V mode / Enhanced Container Isolation** | A VM boundary or extra hardening on the laptop | Docker docs mention both as stricter options. ECI availability on Windows Home not confirmed. | n/a | S16 |

## 3. Recommendation

### 3.1 Reference isolation design (target)

```
 Internet
    |
 [Edge reverse proxy]  (TLS, routes by instance id; only thing with a public port)
    |
    |  ingress network (shared, contains only edge + each sidecar)
    |
 per instance "vm-<id>":
   [sidecar: Coraza+CRS proxy + flag watcher]   <- on ingress net AND instance net
        |
   instance net  (--internal, no route out, one per instance)
        |-- shop (Node app, non-root, read-only fs, limits)
        |-- shop DB (own, seeded, flags inside)
        |-- bot (simulated victim browser, if needed)
        |-- fake-metadata (decoy service for the SSRF challenge)

 Platform side (separate networks, never attached to instance nets):
   [orchestrator API]  <-- only holder of the Docker socket
   [platform DB, Redis, flag master key]
   Sidecar -> platform: one outbound HTTPS call (signed events) via a tiny "event relay" port.
```

Trust boundary: **everything inside the instance net is hostile.** The platform DB, Redis, flag master key and Docker socket are on networks the instance can never join. The only door from instance to platform is the sidecar's one-way signed event call, and the sidecar itself is not reachable from the shop's code (shop has no route to the ingress network).

Rules that make it hold:
1. No container gets `--privileged`, the Docker socket, host mounts, or `network_mode: host`. Drop all capabilities, `no-new-privileges`, default seccomp, non-root, read-only root fs, writable tmpfs only, memory/cpu/pids limits.
2. Instance net is `--internal`. No egress at all (stronger than an allow-list). SSRF is taught against the in-network decoy, so students still "reach metadata" without any real metadata address being routable. The decoy answers on a made-up address.
3. Caveat from Docker docs: on an internal network the gateway IP is still reachable. On a Linux VM add a `DOCKER-USER` drop rule from instance subnets to host addresses as a second wall. On Docker Desktop this is hard (spike).
4. Per-instance **sidecar** is the only egress for events, to a fixed platform URL.
5. Orchestrator talks to Docker through a narrow API; consider a socket proxy that allows only needed calls, because socket access equals host control (UNVERIFIED as a named product; design principle only).
6. Run the orchestrator and all instances in a **dedicated Linux VM/WSL distro**, not alongside personal data.

### 3.2 What is realistic where

- **Windows 11 + WSL2 (laptop demo):** per-instance `--internal` networks, caps dropped, seccomp, read-only fs, limits, non-root. This is a good wall against other users and the internet. It is **not** a hard wall against a kernel escape (shared Microsoft WSL kernel; gVisor/Kata/rootless not confirmed). Acceptable because on the demo the only attacker is the presenter, and the laptop should hold no secrets. Do not expose the laptop's instances publicly without a tunnel and authentication. Host-IP firewalling is the weakest piece.
- **Free Linux VM (e.g. Oracle Always Free):** everything above plus `DOCKER-USER` rules, rootless Docker or userns-remap, and probably gVisor. Oracle's free Arm shape is 2 OCPU / 12 GB total (page has no update date; shapes can be reclaimed if idle for 7 days and "out of host capacity" errors happen). Nested virtualisation for Kata is not expected.
- **Both:** same Compose/SDK definitions. Hardening level is a configuration (`runtime: runsc` on or off), not an architecture change.

### 3.3 Minimum viable version

1. FastAPI orchestrator using `docker-py`: create network (`internal=True`), start shop + DB + sidecar with labels `vm.instance`, `vm.expires`.
2. Hardening flags above; limits (e.g. start with 0.5 CPU / 512 MB shop, 256 MB DB; numbers are a spike).
3. A reaper loop deleting expired or idle instances (by label).
4. Sidecar = Coraza-based proxy with CRS in detect-only plus a response flag matcher, posting events.
5. HMAC flags injected as env/seed at start.
6. Fake-metadata container for SSRF. Skip gVisor and rootless in MVP; add on VM.

### 3.4 This would be wrong if

- We must run **untrusted third-party code** (not our own intentionally vulnerable app): then require gVisor or a VM boundary, not plain Docker.
- A challenge needs **real egress** (e.g. fetching a real URL): then internal-only fails; add a locked-down egress proxy with a domain allow-list.
- Concurrency goes to **hundreds of users on many hosts**: then Kubernetes (or Nomad) beats a hand-written single-host orchestrator.
- Docker Desktop's WSL2 VM cannot enforce `--internal` as documented (spike S-B1 would show this).

## 4. Decision candidates for the user

1. **Orchestrator technology.** (a) Own FastAPI orchestrator on Docker Engine SDK; (b) k3s + namespaces; (c) adopt GZCTF as the platform. **Recommend (a):** portable, simplest, keeps our own roles and scoring.
2. **Egress policy for instances.** (a) No egress at all, SSRF taught against an in-network decoy; (b) allow-list proxy to selected hosts; (c) full internet. **Recommend (a):** nothing to misconfigure, safest.
3. **Hardening level on the free VM.** (a) Baseline flags only; (b) baseline + `DOCKER-USER` rules + userns/rootless; (c) (b) + gVisor. **Recommend (c) if the spike passes, else (b):** best protection a free VM can give.
4. **Traffic monitor engine.** (a) Coraza + CRS (own small Go/Caddy-based proxy); (b) nginx + ModSecurity v3; (c) mitmproxy + our own rule logic. **Recommend (a).** Actively released, embeds CRS, simple container.
5. **Flag generation.** (a) HMAC-derived from a master key; (b) random per instance, stored in DB. **Recommend (a)** with key versioning (no flag table to leak or sync; (b) is fine if you want per-instance revocation).
6. **Flag detection by monitor in addition to paste.** (a) Both, as D-01; (b) paste only first. **Recommend (a)**, already decided; this is confirmation of mechanism: response matcher in sidecar.
7. **Instance timing defaults.** (a) Learner: 60 min inactivity, 4 h hard cap; candidate: fixed assessment window; (b) shorter; (c) longer. **Recommend (a)** as a starting point, tuned after the spike.
8. **Warm pool.** (a) Pre-start a few ready instances; (b) cold start only. **Recommend (b) first, (a) if cold start exceeds about 15 s.**

## 5. Evidence

| ID | URL | What it supports | Status |
|---|---|---|---|
| S1 | https://github.com/docker/docker-py/releases | docker-py latest 7.2.0 (9 Jul, year not shown) | VERIFIED |
| S2 | https://docs.docker.com/engine/network/drivers/bridge/ | Bridge networks isolate each other; `enable_icc` default true; Docker rules are "implementation details" | VERIFIED |
| S3 | https://github.com/k3s-io/k3s/releases | k3s v1.37.1+k3s1 on 30 Sep 2026 | VERIFIED |
| S4 | https://github.com/hashicorp/nomad/releases | Nomad v2.0.7 on 18 Sep 2026 | VERIFIED (license not seen) |
| S5 | https://github.com/frankli0324/ctfd-whale | Whale uses frp + Docker Swarm; no releases; fork of glzjin; maintenance unclear | VERIFIED (maintenance NOT determined) |
| S6 | https://github.com/CTFd/containers | 404 when fetched | not found |
| S7 | https://github.com/GZTimeWalker/GZCTF/releases | GZCTF v1.9.0 3 Oct 2026, v1.8.7 5 Jul, v1.8.6 6 Jun | VERIFIED (release dates only; features from D-01 evidence, UNVERIFIED here) |
| S8 | https://github.com/google/kctf | Kubernetes CTF infra, GKE walkthrough, local test needs gcloud+Docker, no releases listed | VERIFIED (activity not determined) |
| S9 | https://docs.docker.com/engine/network/drivers/bridge/ | Different bridge networks only talk via published ports | VERIFIED |
| S10 | https://docs.docker.com/reference/cli/docker/network/create/ | `--internal`: containers talk to each other, not other networks; gateway IP still reachable | VERIFIED |
| S11 | https://docs.docker.com/engine/network/packet-filtering-firewalls/ | Do not modify Docker-created rules; page did not describe DOCKER-USER | VERIFIED (DOCKER-USER usage UNVERIFIED) |
| S12 | https://docs.docker.com/engine/security/seccomp/ | Default seccomp: ~44 of 300+ syscalls blocked, incl. io_uring | VERIFIED |
| S13 | https://docs.docker.com/engine/security/rootless/ | Rootless prerequisites; limits listed but not detailed | VERIFIED |
| S14 | https://github.com/google/gvisor/blob/master/g3doc/user_guide/install.md | gVisor needs Linux 5.6+, x86_64/ARM64, `runsc install`; WSL not mentioned | VERIFIED |
| S15 | https://github.com/nestybox/sysbox/releases | Sysbox v0.7.1 (31 Jul), Ubuntu 24.04 kernel 6.8+ support | VERIFIED |
| S16 | https://docs.docker.com/desktop/features/wsl/ | WSL2 backend uses Microsoft kernel; Hyper-V mode and ECI suggested for stricter isolation; WSL >= 2.1.5 | VERIFIED |
| S17 | https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm | Always Free A1: 2 OCPU/12 GB; micro 1 GB; idle reclaim rules; capacity errors. No last-updated date shown | VERIFIED |
| (traffic monitor evidence in section 3 of this file's tables below) | | | |

## 6. Traffic monitor ("sidecar") — compared

| Option | Fit | Cost | Complexity | Main risks | Evidence |
|---|---|---|---|---|---|
| **Coraza (Go) + CRS** | Best. Embeds CRS, single small binary/container. Coraza v3.8.1 (2 Oct 2026), v3.8.0 (30 Sep), v3.7.0 (Apr, bumped CRS to 4.25). Caddy plugin `coraza-caddy` v2.6.1 (9 Sep 2026) with embedded CRS v4.25 (v2.5.0). | Free | Low to medium | We write a thin Caddy/Go layer for response flag matching and event posting. Response-body inspection costs memory. | S18, S19, S20 |
| nginx + ModSecurity v3 (libmodsecurity) | Mature, widely used. ModSecurity v3.0.17 and v2.9.15 both released 29 Sep 2026 with security fixes. Connector `ModSecurity-nginx` v1.0.4 (21 May, year not shown). | Free | Medium (dynamic module build, config) | Heavier build. C code with recent security fixes. Still maintained, so not wrong, just more work. | S21, S22 |
| Envoy + coraza-proxy-wasm | Fits if we later use Envoy/Istio. CRS embedded. Requires TinyGo 0.34.0 build; no releases listed. | Free | High | WASM build constraints, version pinning. | S23 |
| Traefik + Coraza plugin | README calls it early-stage, "for learning"; recommends native integration for production. No releases listed. | Free | Medium | Not production grade per its own README. | S24 |
| mitmproxy | Great for capture and scripting responses; **no CRS**, we would write our own attack classification. | Free | Medium | Classification is custom, which D-07 wanted to avoid. Acceptable only as a recorder. | UNVERIFIED (not fetched) |

**Verified CRS facts**
- Latest CRS release: **v4.30.0** (2 Oct 2026). LTS line **v4.25.2** (2 Oct 2026). Main branch header says 4.31.0-dev (S25, S26).
- Real tags in rule files (from `REQUEST-942-...SQLI.conf` rule 942100): `attack-sqli`, `paranoia-level/1`, `OWASP_CRS`, `OWASP_CRS/ATTACK-SQLI`, `capec/1000/152/248/66`, plus `application-multi`, `language-multi`, `platform-multi`.
- `REQUEST-934-...GENERIC.conf` carries `attack-rce`, `attack-injection-generic`, **`attack-ssrf`** (rules 934110, 934120, 934170, 934190) and `attack-ssti`.
- Rule files present: 911 method, 913 scanner, 920 protocol, 921 protocol attack, 922 multipart, 930 LFI, 931 RFI, 932 RCE, 933 PHP, 934 generic, 941 XSS, 942 SQLi, 943 session fixation, 944 Java, 949 inbound blocking, 950-956 response leaks, 959, 980 correlation (S27).
- Tag names for 930/931/932/933/941/943/944 were **not read**; by the same pattern they are probably `attack-lfi`, `attack-rfi`, `attack-rce`, `attack-xss`, `attack-fixation`, `attack-java` (UNVERIFIED, check in spike).
- Scoring: rules add to an anomaly score (critical 5, error 4, warning 3, notice 2); blocking thresholds are separate (inbound 5, outbound 4). In detect-only we ignore blocking and read matched rule tags (S28). Detect-only behaviour itself was not confirmed from the CRS page read (set `SecRuleEngine DetectionOnly`; UNVERIFIED here).
- **Classifier limits:** CRS only covers generic web attacks. It will **not** recognise business-logic bugs (price manipulation, IDOR, coupon stacking, broken access control, weak reset). For those, challenge-specific state checks in the app (for example "order total changed", "seller read another seller's order") should emit events too. This agrees with D-07's three-layer idea and is a risk to the "auto technique" claim. See impact on RS-E/F.

**Event contract (sidecar to platform).** One JSON POST per event to `POST /internal/v1/events`, HMAC-signed with a per-instance key (header `X-VM-Signature`), idempotent via `event_id`.
```
{ "event_id": uuid, "instance_id": "...", "ts": "RFC3339",
  "type": "request" | "flag_seen" | "crs_match" | "state_change",
  "request": { "method","path","query_hash","status","req_body_snippet","resp_len","client_ip_class" },
  "crs": { "rule_ids":[942100], "tags":["attack-sqli","OWASP_CRS/ATTACK-SQLI","capec/..."], "anomaly_score": 5 },
  "flag": { "challenge_id":"C03", "match":"hmac-valid" },   // only when type=flag_seen
  "evidence_ref": "stored raw request id" }
```
Rules: sidecar logs **requests**, does not decide scoring; platform decides credit. Redact `Authorization`/cookies of the user's own session in stored evidence; never log the flag value itself (store a hash or challenge id, see section 7). Batch and buffer on platform outage.

Flag detection in sidecar: scan response bodies/headers for the flag **format regex**, then check validity (recompute HMAC for this instance), so decoys and other users' flags do not credit. Caveat: flags that leave via other channels (DB exfil over SQLi encoded, blind techniques, base64) will not appear literally; use paste as backup (D-01) and keep detection per challenge.

## 7. Flag generation and delivery

- **Derived (recommended):** `flag = "VM{" + base32(HMAC-SHA256(master_key_vN, instance_id | challenge_id | attempt_epoch))[:24] + "}"`. Platform verifies by recomputing, needs no flag table, cannot be forged without the key. Key never enters an instance or image. Version the key (`vN`) to allow rotation. Include an `attempt_epoch` so a reset gives new flags.
- **Random and stored:** a table of (instance, challenge, flag hash). Simple, allows revoking one flag, but needs a secure store and sync; store only a hash (SHA-256 of high-entropy flag is safe).
- Either way: format is fixed and recognisable (`VM{...}`) for the regex; high-entropy tail; no instance id in clear.
- **Injection:** the orchestrator computes flags at start and injects them into the **DB seed** (SQL run at container start) or a root-owned read-only file, or env for challenges that need it. Prefer seed/file for flags placed in data. Env vars leak through `docker inspect` and `/proc`, and SSRF/RCE challenges can read them, so use env only for challenges where that is the intended path. Docker secrets need Swarm/Compose file secrets; a read-only mounted file is the practical equivalent here (UNVERIFIED as best practice, standard approach).
- **Image hygiene:** images contain no flags (flags arrive at runtime). CI check: grep image layers for the flag pattern. Do not print flags in orchestrator or container logs; log hashes.
- **Tamper resistance:** students have root-equivalent control only inside their own instance, so they can read their own flags (intended) but cannot affect other instances or the key. Detect paste of another instance's flag (valid HMAC but wrong instance) and log it as a sharing signal (as in D-01 evidence).
- **Rotation on reset:** reset = destroy instance, create new with new `attempt_epoch` and fresh DB seed; old flags become invalid.

## 8. Instance lifecycle

States: `requested -> provisioning -> starting -> ready -> active -> idle -> stopping -> destroyed`, plus `failed` and `resetting`. Orchestrator is the only writer of state; DB is the record, Docker labels are the fallback so a restart can rebuild truth.

- **TTL:** hard cap (`vm.expires` label) plus inactivity timer (last proxied request from the sidecar, plus platform session heartbeat). Reaper loop every 30 to 60 s. Candidates: window fixed by the assessment, not killed mid-attempt by idle timer unless the recruiter allows it.
- **Reset:** destroy and recreate (cleanest, new flags). Ask user to confirm; log it (affects scoring and time rules in RS-C).
- **Health:** container healthcheck on shop `/health`, orchestrator waits for `ready` before returning the URL; failed start retried once, then reported.
- **Startup targets (proposal, not measured):** ready in under 15 s cold, under 3 s from warm pool. These are guesses; spike S-B4 measures.
- **Speed:** pre-built images pushed to a registry (build in CI), small base images, DB seeded from a pre-made data directory or SQL dump, shared read-only image layers, lazy-start the bot. Warm pool of pre-started instances assigned on request (flags injected at assignment, so the seed must support late flag injection). Docker Desktop: keep the images and WSL disk on D: (C: has only ~22 GB free).
- **Capacity:** memory per instance unknown until measured; with 15.3 GB on the laptop and Docker Desktop plus Windows overhead, expect a handful to tens of instances, not hundreds (RS-A owns the numbers).

## 9. Open questions and spikes to run later

| ID | Spike | Why |
|---|---|---|
| S-B1 | On Docker Desktop (WSL2): does an `--internal` network block internet, LAN, host IP and 169.254.169.254? Can a container reach the gateway or `host.docker.internal`? | Core of the trust boundary |
| S-B2 | Can we add `DOCKER-USER` rules on Docker Desktop; or run our own WSL2 Docker engine instead (Ubuntu distro with systemd)? | Host-IP wall on laptop |
| S-B3 | gVisor (`runsc`) on a WSL2 distro and on an Ampere/x86 free VM: does the Node+DB stack run? Performance cost? | Optional extra wall |
| S-B4 | Measure start time and RAM per instance (shop+DB+sidecar). Pick limits. | Capacity and startup targets |
| S-B5 | Rootless Docker on the VM: does `--internal`, limits and port mapping still work? | Hardening choice |
| S-B6 | Coraza+CRS in detect-only as sidecar: events for SQLi, XSS, SSRF, path traversal payloads; confirm tag names of 930/931/932/941/943/944; check false-positive rate and added latency, response-body inspection cost. | Classifier accuracy claim |
| S-B7 | Flag detection through typical exfil paths (UNION, blind, error-based) to see what the sidecar can and cannot see. | D-01 auto-detection coverage |
| S-B8 | Orchestrator crash recovery and reaper correctness; leak test (kill orchestrator, check orphan containers/networks). | F6, F8 |
| S-B9 | Fake-metadata decoy for SSRF: is it convincing and are there no routes to real addresses? | Challenge C10 |

Open questions:
- Do the other two developers' machines run Docker the same way (Q-24)?
- Is the demo exposed publicly from the laptop (tunnel) or only local? Changes the threat model.
- Does the hiring use require stricter isolation (candidates are strangers) than learner practice? Likely yes.
- Not found: reliable maintenance status for CTFd Whale and kCTF; CTFd containers plugin URL; Kata and WSL2 evidence; whether gVisor works under Docker Desktop.

## 10. Impact on other streams

- **RS-A (hosting):** needs a VM with Docker where the orchestrator can run; Oracle free Arm shape means **ARM64 images** must be built (multi-arch) if used. Platform DB/Redis must be on a network instances cannot reach; no Docker socket on PaaS hosts such as Vercel/Railway, so the orchestrator must live on a machine we control.
- **RS-C (scoring):** timing events come from sidecar events; reset and TTL policy affect "time taken". Flag-sharing detection (valid HMAC, wrong instance) feeds anti-cheat.
- **RS-D (platform):** define `/internal/v1/events` and orchestrator API (create/reset/stop/status) as stable contracts early; platform secrets (flag master key, event signing keys) need a secrets plan; Docker socket exposure is part of platform security.
- **RS-E/F (challenges):** CRS covers only injection-style classes; logic and access-control challenges need app-side state events. SSRF challenge must target an in-network decoy, not real metadata. Each challenge must say where its flag lives (DB seed vs file vs env) and how it can be exfiltrated.
- **RS-G (shop):** shop must run non-root with read-only filesystem and accept late flag injection into seed; must expose `/health`; no outbound calls other than to the decoy.
- **RS-H (privacy):** sidecar stores request bodies (evidence), so redaction and retention rules apply; candidate data deletion must cover stored evidence.

Additional evidence rows

| ID | URL | What it supports | Status |
|---|---|---|---|
| S18 | https://github.com/corazawaf/coraza/releases | Coraza v3.8.1 (2 Oct), v3.8.0 (30 Sep), v3.7.0 (6 Apr, CRS bump to 4.25), 2026 assumed | VERIFIED (year not shown) |
| S19 | https://github.com/corazawaf/coraza-caddy/releases | coraza-caddy v2.6.1 (9 Sep 2026), embedded CRS v4.25 in v2.5.0 | VERIFIED |
| S20 | https://github.com/coreruleset/coreruleset/releases | v4.30.0 and 4.25.2 LTS (2 Oct 2026); mentions libmodsecurity3/coraza fix | VERIFIED |
| S21 | https://github.com/owasp-modsecurity/ModSecurity/releases | ModSecurity v3.0.17 and v2.9.15 (29 Sep), security fixes | VERIFIED (year not shown) |
| S22 | https://github.com/owasp-modsecurity/ModSecurity-nginx/releases | Connector v1.0.4 (21 May) | VERIFIED (year not shown) |
| S23 | https://github.com/corazawaf/coraza-proxy-wasm | Envoy/Istio WAF, CRS embedded, TinyGo 0.34.0, no releases | VERIFIED |
| S24 | https://github.com/jcchavezs/coraza-http-wasm-traefik | Traefik plugin "early stages", prefers native integration | VERIFIED |
| S25 | https://github.com/coreruleset/coreruleset/releases | Latest CRS 4.30.0 | VERIFIED |
| S26 | https://raw.githubusercontent.com/coreruleset/coreruleset/main/rules/REQUEST-942-APPLICATION-ATTACK-SQLI.conf | Tag names (`attack-sqli`, etc.) and header 4.31.0-dev | VERIFIED |
| S27 | https://github.com/coreruleset/coreruleset/tree/main/rules and `.../REQUEST-934-APPLICATION-ATTACK-GENERIC.conf` | Rule file list; `attack-ssrf` tag on 934110/934120/934170/934190 | VERIFIED |
| S28 | https://coreruleset.org/docs/2-how-crs-works/2-1-anomaly_scoring/ | Anomaly scoring and thresholds; DetectionOnly not covered | VERIFIED |
