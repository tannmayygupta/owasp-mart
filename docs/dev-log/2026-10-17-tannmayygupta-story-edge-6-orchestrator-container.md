# Edge story 6: the orchestrator as a container on labs-core (H-143)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay, on top of a3e065e; not committed yet |
| Status | Done locally (Docker Desktop); nothing run on vm-i |
| Report tag | Deployment of the labs host: orchestrator unit, gate admin reachability |

## Requirements covered
FR-INS-10 (the edge is attached to each instance network and gets the access state), NFR-SEC-04 (no Docker socket for the orchestrator, hardened containers, listener not public), D-58 (socket proxy), D-62 and D-66 (edge and attach), handoff H-143 (decided by the developer on 2026-10-17: option (a)).

## Summary (plain language)
The gate admin listener is only on the compose network `vulnmart-labs-core`, so a host-run orchestrator could not reach it. The developer chose to run the orchestrator as a container on that network. This adds a compose service `orchestrator` (profile `lab`), makes the compose lint check it, and proves on Docker Desktop that one stub instance can be created through the container, that the edge gate is attached to the instance network and gets the open state, and that destroy leaves nothing behind.

## Why
H-143: `--gate-url` refuses non-loopback plain http and the alias `edge-gate-admin` does not resolve from the host. Options (b) publish the admin listener on loopback and (c) https on the admin listener were not taken.

## What was built
- Compose service `orchestrator` (profile `lab`) in `infra/compose/compose.yaml`: image built from `apps/orchestrator/Dockerfile`, user 65532, read-only root, `cap_drop: ALL`, `no-new-privileges`, 256 MB, 128 pids, tmpfs `/tmp`, network `labs-core` only, no Docker socket.
- Docker: `--docker-host tcp://docker-proxy:2375`. The proxy is on `labs-core` already, so nothing about it changed (it still publishes `127.0.0.1:2375` for the host; the container does not use that).
- Edge: `--edge-container vulnmart-edge-gate --gate-url http://edge-gate-admin:9090 --gate-admin-key-file /run/secrets/gate_admin_secret`.
- Listener: chosen mutual TLS (not plain http). The process listens on `0.0.0.0:8443` inside the container (the service refuses a non-loopback address without TLS and the image sets that address), published as `${VULNMART_ORCH_BIND:-127.0.0.1}:9443:8443`. On vm-i, `VULNMART_ORCH_BIND` is the private address of vm-i (IF-5, port 9443); the default is loopback.
- Secrets as files under `/run/secrets` via top-level compose `secrets` (platform key, gate admin secret, TLS cert, key and CA); templates and the image manifest are read-only bind mounts under `VULNMART_ORCH_DIR`; state (tombstones) in the named volume `orch-state`.
- `apps/orchestrator/Dockerfile`: creates `/var/lib/vulnmart/orchestrator` owned by 65532 (so the named volume is writable by the non-root user) and the header comment no longer says there is no compose service. No orchestrator or edge code was changed.

## How it works
`orchestrator` (labs-core) -> `docker-proxy:2375` creates the `vm-*` containers and networks, and runs `network connect` of `vulnmart-edge-gate` to `vm-<id>-e1-net`; then it pushes the record to `edge-gate-admin:9090` with the admin header. The platform (vm-p) will call `https://<vm-i private address>:9443` with a client certificate and the signed headers.

## Files changed
- `infra/compose/compose.yaml`: service `orchestrator`, top-level `secrets` and volume `orch-state`, comment on the proxy.
- `apps/orchestrator/Dockerfile`: state folder owned by 65532, header comment.
- `scripts/check-lab-compose-rules.mjs` and `scripts/check-lab-compose-rules.test.mjs`: the new service is checked (see Tests).
- `docs/runbooks/edge-vm-i.md`: open point replaced by the decision, step 2 file ownership, step 3 rewritten for the container; `docs/runbooks/deploy.md`: Part E and F pointers.
- `docs/assets/story-edge-6-orchestrator-container/proof-run.mjs` and `proof-output.txt`: the proof script and its real output.

## Decisions made
H-143 option (a), decided by the developer (2026-10-17). No ADR written: the decision is recorded in the handoff row and the runbook; an ADR can follow if the developer wants one.

## Tests
- `node --test scripts/check-lab-compose-rules.test.mjs`: 18 tests, 18 pass (was 13 before this story; 5 new tests for the orchestrator service: allowed form, published ports, socket and bypass flags, hardening, the committed service). One existing test used the name `orchestrator` as a stand-in for "any other lab service" and was changed to `relay`; another list now expects `['docker-proxy', 'edge-caddy', 'orchestrator']` as the services with ports.
- `node scripts/check-lab-compose-rules.mjs`: PASS, 4 files checked.
- `node --test scripts/dev.test.mjs scripts/check-lab-compose-rules.test.mjs`: 43 tests, 43 pass.
- `docker compose -f infra/compose/compose.yaml --profile platform config -q` and `--profile lab config -q` (with missing secret files): exit 0.
- The proof: `node docs/assets/story-edge-6-orchestrator-container/proof-run.mjs`, final run: `Result: all 30 checks PASS`. It checks: container healthy; no socket or docker bind in the mounts; not privileged, read-only, cap_drop ALL, no-new-privileges, user 65532; only network `vulnmart-labs-core`; the only published port is loopback 9443 to 8443; five secret files mode 400 owner 65532; flags as designed; no key in `docker inspect` or the log; from inside the container `docker-proxy:2375` and `edge-gate-admin:9090` accept a connection; no client certificate means a refused TLS handshake; `GET /v1/host` 200 with a client certificate; create 202 and the instance reaches `ready`; `vulnmart-edge-gate` is a member of `vm-<id>-e1-net` (`docker network inspect`) and `docker inspect` of the gate lists it; the instance network is internal; the gate answers 410 when the record is closed, 403 after `access open` (epoch 1), 423 after `frozen` (epoch 2); destroy 202 then state destroyed; no `vm-*` container or network afterwards, the gate has no instance network any more, and the gate answers 410 again. Teardown: `docker compose rm -sf -v orchestrator edge-gate`, volumes `vulnmart_orch-state` and the temporary secrets volume, network `vulnmart-edge-public`, temp folder removed; final listings show no object labelled with the run id.
- Not run: the orchestrator pytest suite (no orchestrator code changed), the loop e2e (left as is by instruction), the edge e2e, anything on vm-i.

## Evidence
`docs/assets/story-edge-6-orchestrator-container/proof-output.txt` (real output, loopback address shown as `<addr>` by the redaction helper) and `proof-run.mjs`.

## Problems met and how they were fixed
1. First run: the orchestrator container exited with `key file /run/secrets/platform_key has mode 777`. Cause: Compose 5.3.1 prints `secrets uid, gid and mode are not supported, they will be ignored` and bind-mounts the host file, and Docker Desktop shows bind-mounted files as mode 777; the service (correctly) refuses key files readable by others. Fix in the committed file: removed the unsupported `uid/gid/mode` keys and documented that on vm-i the host files must be owned by 65532:65532, mode 400 (runbook step 2 and 3, comment in the compose file). Fix in the proof: the temporary secrets are copied by a helper container into a named volume (owner 65532, mode 400) that the override mounts at `/run/secrets`, which gives the service the same view as on Linux. This means the proof does not show how the real bind mount behaves on Linux; that is a vm-i check (runbook step 3, `ls -ln`).
2. Second dead end: the instance went `failed` with `INST-START-FAILED`, and the orchestrator log had only request lines. The socket proxy log showed `network connect` followed straight away by `disconnect`, so the failure was the next step, the push to the gate. Cause: the create body of the example had `hostname fake-0001.instances.example.invalid` and the gate zone is `labs.invalid`, so the gate refused the record. Fix in the proof: the hostname is `<id>.labs.invalid`. (A test-data mistake, not a service bug.)
3. A check of my own looked for `docker` in every mount source and tripped on the named volume path `/var/lib/docker/volumes/...`; restricted it to bind mounts.
4. An existing `vulnmart-docker-proxy` container (up 3 hours, not started by this run) and the network `vulnmart-labs-core` were on the machine, and a volume `vm-gomod` and a container `recursing_leakey` that belong to something else. The proof reuses the proxy and does not stop or remove it (so `vulnmart-labs-core` stays, it still has the proxy attached); it removes everything else it started. The `vm-*` pre-check ignores the existing volume.

## Security notes (vulnerable parts only)
Not a vulnerable part. Note for NFR-SEC-04: the proxy port 2375 has no login; it is on `labs-core` (outbound-capable bridge) and published on loopback as before. Anything else attached to `labs-core` can reach it. Only the proxy, edge-gate and orchestrator are on that network; instance networks are never attached to it.

## Limitations and follow-ups
- Not run on vm-i or on Linux: file ownership/mode of bind-mounted secrets, `VULNMART_ORCH_BIND` with the private address, mutual TLS with the real vm-p client certificate (H-68).
- `--report-url` and the report key are not wired in the container (needs the vm-p ingest address); the platform gets no state reports from it until then.
- The service has no CPU limit (the other lab services have none either).
- The proof uses `--allow-local-images` and a relaxed template schema because the stub image cannot play every template role; production does neither.
- The image `vulnmart-orchestrator:local` built by the proof is left in the local image cache.
