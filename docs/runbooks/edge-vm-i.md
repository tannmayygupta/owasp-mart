# Runbook: the labs edge on vm-i (edge stories 2, 3 and 5; D-61 to D-67 Proposed)

Everything here is a live step for **you** (the developer). Claude does not use SSH or AWS. The local proof on Docker Desktop is in `docs/assets/story-edge-2-edge-service/`, `docs/assets/story-edge-3-orchestrator-edge/` and `docs/assets/story-edge-5-session-epoch/`; none of it proves the live behaviour. **Rules for every step:** paste no secret, no certificate key, no real address and no full ticket or cookie into the repository or the dev-log; save only the evidence named in the step; the result of a live step is yours to record, Claude writes nothing as "passed" until you tell it what you saw. Every new AWS window first needs `$env:AWS_PROFILE = "vulnmart"`. Start vm-i only for these steps and stop it afterwards (rule from story 1.15).

Files used: `infra/compose/compose.yaml` (profile `lab`: `edge-gate`, `edge-caddy`, `docker-proxy`), `infra/caddy/Caddyfile.l`, `docs/runbooks/certificates.md`, `docs/runbooks/isolation-vm-i.md`, `docs/runbooks/deploy.md` Part E, `contracts/edge/gate-ticket.md`.

## OPEN POINT before step 3 (decide with Claude, not decided here)
The orchestrator runs on the host (Part E of `deploy.md`) but the gate admin listener answers only on the compose network `vulnmart-labs-core` under the alias `edge-gate-admin` (port 9090, never published, by design). A process on the host cannot resolve that alias, and `--gate-url` refuses a plain-http address that is neither loopback nor a single-label name. So the host-run orchestrator cannot push to the gate as built. Options to choose from: (a) run the orchestrator as a container on `vulnmart-labs-core` (the deployment unit of L-12 and L-13, not built yet); (b) publish the admin listener on `127.0.0.1` only (changes the compose rule and `server.mjs` bind, and puts the admin key's only protection on the host); (c) https with a certificate for the admin listener. Until one is chosen, steps 3 to 6 cannot be completed on vm-i. This is listed as an open row in `docs/dev/HANDOFFS.md` (H-143).

## 1. Labs name and wildcard certificate
1. Follow `docs/runbooks/certificates.md` for the labs zone (staging first, Part D, then production, Part E) with DNS-01 and lego. The name is a wildcard `*.<labs zone>`. The wildcard certificate covers one label only: `i-<16 chars>.<zone>` is fine.
2. Put the result on vm-i in one folder with exactly `fullchain.pem` and `privkey.pem` (default `/opt/vulnmart/lab/certs/live`, or set `VULNMART_EDGE_CERTS`). `privkey.pem` stays root-only.
3. Spike S-16 (DuckDNS wildcard resolution): from your PC run `nslookup i-aaaaaaaaaaaaaaaa.<zone>` and `nslookup i-bbbbbbbbbbbbbbbb.<zone>`; both must give the vm-i public address. Expected: both resolve. Save the two result lines with the address replaced by `<addr>`.
4. Evidence to save: the `openssl x509 -in fullchain.pem -noout -subject -dates` line (no key material), and the nslookup lines. Folder `docs/assets/edge-vm-i/certificate/`.

## 2. Gate key and gate admin secret (two secrets, files only)
1. On vm-i create the folder `/opt/vulnmart/lab/secrets` (or set `VULNMART_EDGE_SECRETS`), mode 700.
2. Create `gate_key_current` (at least 64 hex characters, e.g. `openssl rand -hex 32` gives 64), `gate_key_previous` (create it empty with `touch` when there is no previous key: an empty file means no previous key, and the file must exist because Docker makes a folder of a missing bind source), and `gate_admin_secret` (at least 16 characters, e.g. `openssl rand -hex 24`). Mode 600. Never print them.
3. The same `gate_key_current` bytes must be written on **vm-p** for the API (it signs the tickets; ADR 0009, handoff H-137). Copy it by hand, not through a chat. Rotation: put the new key in `gate_key_current` and the old one in `gate_key_previous`, restart `edge-gate`; remove the old one after 60 seconds plus the cookie life you accept (a cookie is signed with the key too, so a rotation ends the older browser sessions when the previous key is removed).
4. The orchestrator reads the admin secret from a file (`--gate-admin-key-file`, mode 600, same value as `gate_admin_secret`).
5. Evidence: `ls -l` of the folder with the names and modes only. Folder `docs/assets/edge-vm-i/secrets/`.

## 3. Start the edge and the orchestrator flags
1. Put the repository files on vm-i as in `isolation-vm-i.md` step 2 (`infra/compose/compose.yaml`, `infra/compose/docker-proxy/rules.cfg`, `infra/caddy/Caddyfile.l`, `apps/edge`).
2. `node scripts/check-lab-compose-rules.mjs infra/compose/compose.yaml` expects `PASS`. Then `VULNMART_LABS_ZONE=<zone> docker compose -f infra/compose/compose.yaml --profile lab up -d --build --wait docker-proxy edge-gate edge-caddy`. Expected: three containers healthy; only `edge-caddy` publishes a port (443): check `docker ps --format '{{.Names}} {{.Ports}}'`.
3. Orchestrator flags (after the open point above is decided): `--edge-container vulnmart-edge-gate --gate-url <url of the admin listener> --gate-admin-key-file <file>` next to the existing flags and `--docker-host` of Part E. Without `--edge-container` nothing is attached and nothing is pushed.
4. Create one stub instance through the orchestrator. Expected: `docker network inspect vm-<id>-e1-net` lists `vulnmart-edge-gate`; after destroy no `vm-` network, container or volume remains (`docker network ls`, `docker ps -a`, `docker volume ls`, filtered by `vm`).
5. Evidence: the three listings with ids shortened. Folder `docs/assets/edge-vm-i/start/`.

## 4. S-15 attach test with 20 instances
1. With the edge running, create 20 stub instances (the numbers 20 and the order are the plan of story 4.1). After each create record the time; after all 20 run `docker network ls --filter name=vm- | wc -l`, `docker stats --no-stream vulnmart-edge-gate vulnmart-edge-caddy`, and `docker inspect vulnmart-edge-gate --format '{{len .NetworkSettings.Networks}}'`.
2. Request check per hostname: open the gate in a new tab is not needed. For each of the 20 hostnames run `curl -s -o /dev/null -w '%{http_code}\n' https://i-<id>.<zone>/` from your PC. Expected without a ticket: the gate's refusal page (403 or the ended page, see `contracts/edge/gate-ticket.md`), never a shop page. Then restart the edge (`docker restart vulnmart-edge-gate`) and note that every instance answers as closed until the orchestrator syncs (the sync happens at the next reconcile pass); measure how long that took.
3. Destroy all 20 and check nothing is left. Evidence: the counts, the memory line, the 20 status codes, the sync delay. Folder `docs/assets/edge-vm-i/s15/`. Record whether 20 worked; if not, the number that did.

## 5. Event relay over the private link
1. Set `VULNMART_EDGE_INGEST_URL` to the ingest address on vm-p (the private link, port 9444 of H-68; this is a private address, do not paste it). Restart `edge-gate`.
2. From a stub instance network the ingest address must stay unreachable and only the relay answers on the edge's leg: run the probe of `docs/runbooks/isolation-vm-i.md` (`node scripts/isolation-probe.mjs`). Expected: the ingest address and the other legs of the edge are not reachable from an instance network.
3. Send one signed test event from a sidecar of a stub instance and check that the ingest on vm-p answers 202 and records it; send one with a wrong signature and check a 401 (security event). Evidence: status codes only. Folder `docs/assets/edge-vm-i/relay/`.

## 6. A real browser check (yours)
With the platform running and one live instance of your own account:
1. Click open: the instance opens in a new tab, address `https://i-...`, and the shop is shown.
2. Open it again in a second browser (or a private window) with the same account: the new tab works; **reload the first tab**: it must be refused (one active browser session, FR-SES-11).
3. Log in again with the same account in another browser: the older platform session is invalid and the instance tabs of the older session are refused until a new open (needs the platform side of H-136; if it is not built yet, write "not testable yet").
4. A second account (own invite) pastes the instance address: refused, and no ticket can be made for it.
5. Freeze the attempt from the platform: the instance tab shows the paused page at once; thaw: the old tab stays refused, a new open works.
6. Expiry or destroy: the tab shows the ended page; `docker network ls` shows no `vm-` network.
7. Evidence: one screenshot per step with the address bar hostname blurred and no cookie or ticket visible. Folder `docs/assets/edge-vm-i/browser/`.

## 7. Stop
`docker compose -f infra/compose/compose.yaml --profile lab down`, then stop vm-i (`vm_i_running = false`, `terraform apply`). Tell Claude exactly what you saw in each step so the dev-log and the traceability rows (FR-INS-10, FR-SES-11, S-15, S-16) can say it. Until then those live items stay open.
