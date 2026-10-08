# 0016. Per-consumer delivery of flag files, and an injector with no network

- **Status:** Accepted (D-36)
- **Date:** 2026-10-08
- **Deciders:** Tanmay (stream L). Consumers to confirm: Sahil (stream T).
- **Requirements:** FR-FLG-03, FR-FLG-08, FR-INS-02, FR-CHL-07 (C06), FR-CHL-11 (C10), NFR-ISO-03; D-23, D-26; IF-6 (contract `contracts/instance/instance-contract.md`, open points 16 and 29)

## Context
The injector writes flags, decoys and seed-derived values at instance start. Two challenge flags must exist only inside one container: the C06 flag in the import service and the C10 flag in mock-services. In the first version of the contract only the shop and the injector shared a memory-backed volume (`/run/vm`), so those two files had no way to reach their containers. Sharing `/run/vm` with everyone would let every container read every flag. The injector also held all flags and the seed while the architecture 02 drawing placed it on the instance network, although it only reads standard input and writes files.

## Options considered
1. **One small read-only memory-backed volume per consumer** (`/run/placement/import` for the import service, `/run/placement/mock` for mock-services), written only by the injector. Pros: each container sees only its own file; same pattern as `/run/vm` for the shop; no new component. Cons: two more volumes in the template.
2. **The orchestrator copies each file into the container before it starts.** Pros: no shared volume. Cons: the orchestrator would handle every flag file, and the injector's job changes.
3. **Share `/run/vm` read-only with all containers.** Pros: simplest. Cons: breaks "the flag exists only in its own container" (FR-FLG-08, C06, C10).

For the injector network: keep it on the instance network (matches architecture 02) or give it `network_mode: none` (least privilege).

## Decision
Option 1. Two memory-backed volumes, `vm-placement-import` and `vm-placement-mock`; the injector mounts both read-write; the import service mounts only the first and mock-services only the second, read-only; no other role may mount them. Files are mode 0400, owner 65532. The injector gets `network_mode: none`; this deviates from the architecture 02 drawing, which shows it on the instance network.

## Consequences
Easier: least privilege, flags confined to the one container that needs them, a schema and validator rule per volume. Harder: two more volumes to create and clean up in the orchestrator (L-13, L-14). Sahil must confirm that the import service and mock-services read these paths. A compromised container still sees its own files (any process in a container can read what the container mounts).

## Evidence
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html): environment variables are generally accessible to all processes and may appear in logs or system dumps; least privilege for access to secrets. Wording as quoted by a secondary source; the cheat sheet itself was not retrieved in full.
- CNCF Cloud Native Security Whitepaper: inject secrets at runtime through non-persistent mechanisms such as in-memory shared volumes instead of environment variables (as quoted in a [CyberArk developer post](https://developer.cyberark.com/?p=2096); not read in the original).
- Docker file-based secrets are read-only files on tmpfs under `/run/secrets` given only to the services that list them: community guides ([stackharbor](https://stackharbor.com/en/knowledge-base/docker-secrets-handling/), [phase.dev](https://phase.dev/blog/docker-compose-secrets/)); Docker's own documentation was not retrieved. Compose secrets conflict with a read-only root filesystem in some versions (Docker forum thread), which is why plain memory-backed volumes are used here.
- UNVERIFIED: that Docker's tmpfs volume driver options behave the same on Docker Desktop and the Oracle VMs; to be tested when the orchestrator creates volumes (L-13).
