# 0038. A socket proxy now, rootless Docker later (spike S-8 stays open)

- **Status:** Proposed (D-58, decided on the developer's delegation, story 4.2 "Docker socket behind a proxy for the orchestrator", 2026-10-16; to be confirmed)
- **Date:** 2026-10-16
- **Deciders:** Tanmay (by delegation to Claude Code)
- **Requirements:** D-23, D-58, NFR-SEC-02, NFR-SEC-04, NFR-ISO-04; ADR 0010; spike S-8, task L-29

## Context
The orchestrator must talk to the Docker daemon, which is root on the host (NFR-SEC-04). ADR 0010 chose "a separate orchestrator behind a socket proxy" and "rootless Docker as optional hardening after S-8". No proxy existed. Rootless Docker changes networking (slirp4netns or pasta, no DOCKER-USER chain in the same form, internal-network behaviour and the host rule of S-3 need to be proved again) and nobody has run it on vm-i yet.

## Options considered
1. **Tecnativa docker-socket-proxy in Compose, with its own HAProxy rules file (chosen).** Free, Apache-2.0, small, used widely, no change to how instances are built. Pro: works today with the proven networking and the host rule. Con: filters by method and path only, and the stock section switches are too coarse (container exec stays reachable under `CONTAINERS=1` and `POST=1`), so a custom rules file is part of the solution and must follow `SdkBackend`.
2. **The stock image with environment switches only.** Measured and rejected on 2026-10-16: `POST /containers/{id}/exec` is forwarded to the daemon.
3. **Rootless Docker now.** Removes the root-on-host risk but changes the network model that the isolation tests (ADR 0027, ADR 0037) were built on, and S-3 has not been run live. Too much change before the first live run. Kept open as spike S-8 and task L-29.
4. **Write our own filtering proxy.** More code to own and review; no gain over HAProxy rules. Rejected.

## Decision
Option 1 now. Rootless Docker (S-8) stays open and is revisited in L-29 with the live S-3 result. The proxy is not a substitute for the orchestrator's own rules (template id only, fixed profile, host rule); it is a smaller blast radius for orchestrator bugs and for a leak of the proxy port.

## Consequences
- A new image to keep patched: pinned by digest, updated on purpose (never automatically), checked through the image allowlist habits of the other images.
- The compose lint has one named exception (`docker-proxy`, read-only socket, no other bind, loopback ports only); any other service that mounts the socket fails CI.
- The proxy rules file must change when `SdkBackend` calls a new endpoint (the tests catch a missing one; a call that is allowed but unneeded is a review item).
- The container process is root inside the container (socket file ownership). Residual risk: a flaw in HAProxy or the image runs as root in a container with no capabilities, a read-only root and one read-only socket mount. Accepted for now.
- A compromised orchestrator can still ask the proxy to create a privileged container. The body is not filtered. The mitigations are in the orchestrator (see ADR 0010) and rootless Docker would remove the effect.

- **What an attacker who controls the orchestrator can still do through the proxy (plain words).** (1) Create is root-equivalent: the request body is not filtered, so a container that is privileged or binds `/` can be created (its name must start with `vm-`) and started. (2) List and inspect are open, so the environment of any container on the host can be read. (3) After the name rule, start, attach and remove of containers, and remove of networks and volumes, work only on objects named `vm-...`, so the platform's own objects cannot be removed or driven through the proxy. (4) Creating a network or a volume cannot be restricted by name (the name is in the body). (5) The loopback port `127.0.0.1:2375` has no login: any local process on vm-i controls Docker as far as the proxy allows. The proxy therefore limits a bug or a leak; it does not make a hostile orchestrator harmless.
## Evidence
Image: `tecnativa/docker-socket-proxy:v0.5.0`, index digest `sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459`, labels checked with `docker image inspect` on 2026-10-16 (license Apache-2.0, source https://github.com/Tecnativa/docker-socket-proxy, revision label `2e118a0c`). The stock config was read from `/tmp/haproxy.cfg` inside the running container: the `containers` allow rule has no exec exception. Local test results in `docs/assets/story-4-2-socket-proxy/`. Rootless Docker: not tested (UNVERIFIED for this project).
