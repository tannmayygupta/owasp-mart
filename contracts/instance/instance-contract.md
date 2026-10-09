# Instance contract v0 (IF-6)

- **Version:** 0.1.0 (draft, 0.x until the tag `contracts-v1.0.0` in story L-09). See [../CHANGELOG.md](../CHANGELOG.md).
- **Owner:** stream L (Tanmay) with stream T (Sahil). Sahil approves as consumer before merge (CODEOWNERS `/contracts/instance/`).
- **Source:** `docs/architecture/07-repo-and-workstreams.md` section 3.2 (the 11 topics below), `04-data-and-state.md` sections 11.1 and 11.3, `docs/design/challenge-specs.md` sections 8 and 10.
- **Check it:** `pnpm run contracts:check` (or `node scripts/validate-contracts.mjs`).

Plain terms: an **instance** is one private copy of the shop with its helper containers. This document says what every container in an instance must look like, so the orchestrator (L) and the shop and services (T) can be built separately. Words in **bold "to confirm"** are values the architecture does not fix; every one is listed in the table at the end ("Open points (to confirm)") for Sahil and Akshay.

What this contract does not cover: the body and names of events (IF-4, `contracts/events/app-events.md`), the orchestrator API (IF-5, L-04), the catalogue schema (IF-7, T-02) and the error registry (IF-8, P-02). Where they are needed, this document names the field or the code family only. Error code names written here as `INST-*` are placeholders until the registry is merged.

Machine-checkable parts: [injection-document.schema.json](injection-document.schema.json), [flags-file.schema.json](flags-file.schema.json), [instance-template.schema.json](instance-template.schema.json) (JSON Schema 2020-12), with valid and invalid examples in `examples/`. Rules that compare two fields (for example "the injector and the shop share one `/run/vm` volume") are checked by `scripts/validate-contracts.mjs`.

## 1. Containers and roles

Six roles, each exactly once per instance, with a unique `name` (the name is also the host name on the instance network):

| Role | What it is | Network | Ports (to confirm unless marked) | Healthcheck |
|---|---|---|---|---|
| `shop` | The marketplace (T) | `instance` | 3000 (architecture) | yes, `/readyz` |
| `sidecar` | Sidecar proxy (L) | `instance` | 8080 player traffic from the edge, 9000 app events from the shop, instance network only (both architecture) | yes |
| `injector` | One-shot: the shop image's `inject` entrypoint (T) | `none` (decision, open point 29) | none | no (it exits) |
| `import-service` | Runs import jobs (T) | `none` (always) | none, uses a unix socket | yes, socket |
| `mock-services` | Payment, KYC, metadata, collector (T) | `instance` | 9101 payment, 9102 KYC, 9103 metadata, 9104 collector | yes |
| `bot-controller` | Launches the browser per visit (T) | `instance` | 9200 | yes |

Rules (enforced by the template schema): every component declares `network_mode` (`instance` or `none`), `memory_mb`, `cpu_limit`, `pids_limit`, `mounts`, `env` and `labels`; `healthcheck` is required except for the injector; `ports` is required for the shop, sidecar, mock-services and bot controller. Image names in templates are placeholders like `{image:shop}`; the orchestrator maps them from its own allowlist (real image names are not part of v0). The instance id is `i-` plus 16 Base32 characters (to confirm).

The injector runs first and exits; the other containers start after it has written its files (see section 5). Start order and the injector entrypoint are prose only in v0; the orchestrator story L-13 implements them.

## 2. Environment variables (non-secret only)

Only these names are allowed in a template (the schema rejects any other name):

| Name | Meaning | Value in the example template |
|---|---|---|
| `VM_INSTANCE_ID` | Instance id | `{instance_id}` placeholder, replaced at create |
| `VM_EPOCH` | Flag epoch | `{epoch}` placeholder |
| `VM_PUBLIC_HOST` | Public host name of the instance | `{host}` placeholder |
| `VM_SIDECAR_EVENTS_URL` | Base URL of the sidecar's event endpoint (path belongs to IF-4) | `http://sidecar:9000` |
| `VM_MOCK_URL` | Base host of mock-services (ports in section 1) | `http://mock-services` |
| `VM_IMPORT_SOCKET` | Unix socket of the import service | `/run/import/import.sock` |
| `VM_DB_PATH` | Shop database (SQLite) | `/data/shop.db` |
| `VM_CATALOG_DB_PATH` | Catalogue store (SQLite) | `/data/catalog.db` |
| `VM_SNAPSHOT_PATH` | Patched snapshot written by the injector | `/run/vm/snapshot.db` |
| `VM_FLAGS_PATH` | Flags file | `/run/vm/flags.json` |
| `PORT` | Listen port | per role |
| `TZ` | Time zone | `UTC` |
| `VM_LOG_LEVEL` | Log level | `info` |

Other rules: a value is a string of at most 512 characters and never contains the flag format. **No key and no flag in the environment.** Names starting with `VM_FLAG_` or ending in `_KEY`, `_SECRET`, `_TOKEN` or `_PASSWORD` are rejected even if someone adds them to the list later. The injection seed is a secret too and never goes in the environment.

### The flag-in-env exception (FR-FLG-03)

A challenge whose catalogue entry says `flag_delivery: env` may receive its flag in the environment of the **shop** only. The template declares it in a separate field `flag_delivery_env` (not in `env`):

```
"flag_delivery_env": { "challenge_key": "C05", "env_name": "VM_FLAG_C05", "reason": "<at least 20 characters, not blank>" }
```

Rules: `env_name` is exactly `VM_FLAG_` plus `challenge_key`; `reason` is written down and non-blank; only the `shop` role may have it. Mechanism: when the orchestrator creates the shop container it reads the flag for `challenge_key` from the injection document and sets that one variable. The value is then visible to `docker inspect`. This is accepted for that challenge and is the reason the field must explain why the path needs it. No other variable ever carries a flag.

## 3. Health

- `GET /healthz`: the process is up.
- `GET /readyz`: 200 only after the injector marker exists (section 5) and the database is open. The example template points the shop's Docker healthcheck at `/readyz`, so "healthy" means "ready".
- `GET /version`: build id and catalogue version, no secrets.

The orchestrator reads Docker's built-in health status of each container; the check runs inside the container. The healthcheck object has `kind` (`http` with `port` and `path`, `tcp` with `port`, or `socket` with `path`), `interval_s`, `timeout_s` and `retries`. Example values (interval 2 s, timeout 2 s, 15 retries) follow the hello container until spike S-4 gives real numbers (to confirm).

These paths are not routed to players. `/_vm/` is a reserved path prefix on the public host and the shop must not use it. `/_ops/diagnostics` belongs to challenge C05.

## 4. Labels

Every container and network carries nine labels. A template holds placeholders; the orchestrator fills them in.

| Label | Template value | Runtime value |
|---|---|---|
| `vm.schema` | `0.1` | contract version |
| `vm.instance` | `{instance_id}` | the instance id |
| `vm.epoch` | `{epoch}` | the flag epoch |
| `vm.component` | equals the component `name` | same |
| `vm.template` | equals `template_id` | same |
| `vm.expires` | `{expires}` | UTC date-time |
| `vm.host` | `{host}` | public host name |
| `vm.kind` | `inst` | `inst` for instance containers (`front` is used by edge containers, not by templates) |
| `vm.owner` | `{owner_hash}` | 64 lowercase hex characters, an opaque hash, **never an email** (FR-INS-05) |

The `{owner_hash}` value comes from the required field `owner_hash` of the create body of the orchestrator API (IF-5, [orchestrator-api.md](../orchestrator/orchestrator-api.md) section 2). The platform computes it (the orchestrator never sees a user id), the orchestrator applies it as the `vm.owner` label and never returns it. A reset keeps the owner of the instance.

## 5. Flag injection

The injector is the shop image's `inject` entrypoint run as a one-shot container with `network_mode: none` (the schema enforces this, open point 29). It has no network: it reads its document on standard input and writes only to volumes. The orchestrator writes one JSON document on its standard input and closes it. The document follows [injection-document.schema.json](injection-document.schema.json): `schema_version`, `instance_id`, `epoch`, optional `issued_at`, `seed`, `flags` (one per challenge, `VM{` plus 24 Base32 characters `}`) and `decoys`. The digests of the flags go to the sidecar, not to the injector (architecture 04 section 11.3).

What the injector does, in order:

1. Reads and validates the document. A bad document stops here.
2. Patches the snapshot database and writes the read-only placement files named in the catalogue (`flag_placement`). Placement kinds from the challenge specs (section 8.2): database seed, catalogue store, sentinel table, file in the import service, file in mock-services.
3. Writes `/run/vm/flags.json` ([flags-file.schema.json](flags-file.schema.json), mode 0400) for sentinel logic. It carries the epoch so a file from before a reset can be recognised.
4. Writes the marker file `/run/vm/injected` (to confirm: empty file, mode 0444), last, and exits.
5. The orchestrator removes the injector container at once.

**Placement files.** For each `flag_placement` of kind "file in import service" the injector writes the file under `/run/placement/import`; for kind "file in mock-services" under `/run/placement/mock`. Each file has mode 0400 and owner 65532 (the run user). Each of these two paths is a separate memory-backed volume (`vm-placement-import`, `vm-placement-mock`) that the injector mounts read-write; only the import service may mount the first and only mock-services the second, each read-only and each from the injector's volume. The consumer must mount its volume. The shop, sidecar and bot controller mount neither. The four volumes (`/run/vm`, the two placement volumes and `/run/import`) are four different volumes, each mounted at exactly one target path, and the injector, shop, import service and mock-services run as the same user so they can read the 0400 files.

Order and lifetime: the shop, import service and mock-services start only after the injector has exited 0 (the orchestrator waits; start order is L-13), so a placement file is never read half-written. The orchestrator creates fresh `/run/vm` and placement volumes for every epoch, so files of an old epoch never survive a reset. The orchestrator must create the memory-backed volumes writable for uid 65532 (volume options uid and gid; to confirm in L-13). A placement file larger than the volume size makes the injector exit 12.

**Shared volume.** `/run/vm` is one memory-backed named volume, mounted read-write by the injector and read-only by the shop (and by no other container in v0). Without a shared volume the shop could never see the injector's files or marker; the validator rejects a template where the two do not share one. The same pattern holds for `/run/import`: one memory-backed volume shared by the shop and the import service for the unix socket.

**`issued_at` and replay.** `issued_at` is optional and informational in v0: the injector does not reject old documents. A replayed or stale document is recognised by its `epoch`, because the orchestrator creates a new document with a new epoch for every reset, and the epoch is written into the flags file. The orchestrator must write each document once, to one injector.

**Seed.** `seed` is random, at least 32 and at most 128 characters from `A-Z a-z 0-9 _ -`. It is a secret like the flags: never in an environment variable, a log line, a label or an event. It drives the per-instance seeded passwords and data.

**Exit codes** (the `INST-*` names are placeholders until the error registry, story P-02, is merged):

| Exit code | Meaning | Placeholder error code |
|---|---|---|
| 0 | Injected, marker written | none |
| 10 | The document is missing, not JSON or fails the schema | `INST-INJECT-BAD-DOCUMENT` |
| 11 | The snapshot patch failed | `INST-INJECT-SNAPSHOT-PATCH` |
| 12 | A placement file could not be written | `INST-INJECT-PLACEMENT-WRITE` |
| 13 | The flags file or the marker could not be written | `INST-INJECT-MARKER-WRITE` |
| any other | Crash or kill | `INST-INJECT-FAILED` |

The size limit and the UTF-8 handling of the document on standard input are for the injector to define (to confirm, open point 32). The injector never prints a flag, seed or part of the document to its output.

**Rules the schema cannot express** (checked by the validator): one flag per `challenge_key`; a decoy never equals a real flag; one decoy per `challenge_key` and `index`. The placement field of a decoy is called `decoy_placement`; its content is for stream T to define.

## 6. Event emission

Defined by IF-4 in [../events/app-events.md](../events/app-events.md) (story L-03). The path stays as fixed here: the shop sends events to the sidecar's event endpoint on the instance network, port 9000, base URL in `VM_SIDECAR_EVENTS_URL`; IF-4 adds the path `/v1/events` (POST only), the body, the event names, the signing and the size caps. Events carry no secrets. At start the orchestrator gives the sidecar, on its standard input, the event key, the flag digests and the first sequence number `first_seq` that the platform sent in the create or reset body (IF-4 section 6, orchestrator contract open point 31); the exact shape of that input is defined with stories L-06 and L-13 (open point 35 below).

## 7. Runtime profile

Every component, without exception (the schema rejects anything else):

- Non-root numeric `user` as `uid:gid`, both above 0. Proposal for all components: `65532:65532` (to confirm). Files the injector writes with mode 0400 are readable by the shop because both run as the same user.
- `read_only: true` root filesystem; `no_new_privileges: true`; `privileged: false`; `cap_drop: ["ALL"]` and no added capabilities; `egress: false`.
- Writable places are only memory-backed: `tmpfs` mounts at `/tmp` and `/data` (one per component, not shared) and the four shared named volumes at `/run/vm`, `/run/import`, `/run/placement/import` and `/run/placement/mock`. Mount targets are exactly these six and unique per component. No bind mounts, no host paths, no anonymous volumes.
- Every volume in the template is `memory_backed` and has a `size_mb`; every mounted volume must be declared.
- `memory_mb`, `cpu_limit` (CPUs, for example 0.5) and `pids_limit` are required. The example numbers are placeholders until spikes S-4 and S-5 (to confirm).
- The validator also rejects any other role mounting `/run/vm` (only the injector and the shop do, the shop read-only from the injector's volume), `/run/import` (only the shop and the import service), `/run/placement/import` (only the injector and the import service, read-only from the injector's volume) or `/run/placement/mock` (only the injector and mock-services, same rule); the sidecar, mock-services and bot controller never mount `/run/vm`.
- Required mounts (validator): shop `/tmp`, `/data`, `/run/vm` read-only, `/run/import`; injector `/tmp`, `/run/vm`, `/run/placement/import` and `/run/placement/mock` read-write; import service `/tmp`, `/run/import` and `/run/placement/import` read-only; mock-services `/run/placement/mock` read-only.
- Hand-over of data (to confirm with T): the injector writes the patched snapshot to `/run/vm`; the shop copies it into its own `/data` before it reports ready. The files for the import service and mock-services (placement kinds "file in import service" and "file in mock-services") reach those containers through the two placement volumes described in section 5.

- Restart and data loss: the shop's `/data` is memory-backed, so a restart loses it (see OI-23 for candidate behaviour). There is no restart policy in v0; a dead shop means the orchestrator resets the instance.
- Labels on networks are applied by the orchestrator at create time and are not checked by this schema (the schema covers container labels in the template only).

## 8. Import service

Proposal for T to confirm: the container has `network_mode: none` (the schema enforces this) and talks to the shop through a unix socket on the shared `/run/import` volume, with a fresh process per job. It also mounts `/run/placement/import` read-only to read its flag file. This is how "no network, no database access" (FR-CHL-07, FR-INS-02) holds while the shop still sends jobs. Its healthcheck is of kind `socket`.

## 9. Bot controller

An always-present small container with one internal port (proposal 9200). The browser process is launched per visit with a fresh context, a fixed lifetime and only the shop origin, then closed (FR-SHP-11). The always-on count includes the controller. Memory and process limits are higher than the others in the example (to confirm).

## 10. Database ownership

The shop's SQLite files belong to stream T. The shop never contacts the platform database, Valkey, the orchestrator or other instances (FR-SHP-14); it has no egress. Instance containers write to memory-backed storage only.

## 11. Catalogue fields the instance depends on

Named only; the schema is IF-7 (T-02): `flag_placement`, `flag_delivery` (`env` or default), `start_state` (seeded login for the player), milestone definitions (event names or sidecar rule IDs), exploit test path, fixed-build reference. The injector reads placement from the catalogue; the template reads `flag_delivery`.

## Versioning

`0.x` until the tag `contracts-v1.0.0` (L-09). Until then the rule is: adding something optional is a minor bump (0.1.0 to 0.2.0); renaming or removing a field, or making an optional field required, is breaking and also needs Sahil's approval. After v1.0.0: additive = minor, rename or removal = major. Every change adds an entry to [../CHANGELOG.md](../CHANGELOG.md).

## Open points (to confirm)

Every value below was chosen by this draft because the architecture does not fix it. Sahil (T) and Akshay (P) please confirm, change or reject each one; the schemas and examples follow the table.

| # | Value | Proposal in v0 | To confirm by |
|---|---|---|---|
| 1 | Instance id shape | `i-` plus 16 Base32 characters | Akshay, Sahil |
| 2 | Flag length and alphabet | 24 characters from `A-Z2-7` inside `VM{ }` (architecture 04 section 11.1 calls the format a placeholder, FR-FLG-02) | Sahil, Akshay |
| 3 | Maximum flags per document | 11 (C01 to C11) | Sahil |
| 4 | Seed length and alphabet | 32 to 128 characters of `A-Z a-z 0-9 _ -` | Sahil |
| 5 | Exit codes and placeholder names | 0, 10, 11, 12, 13 and `INST-INJECT-*` (section 5) | Akshay (registry P-02) |
| 6 | Marker file content and mode | `/run/vm/injected`, empty, mode 0444 (the path is from the architecture) | Sahil |
| 7 | Flags file | `/run/vm/flags.json`, mode 0400 (from the architecture), fields in the schema | Sahil |
| 8 | Run user | `65532:65532` for every component | Sahil |
| 9 | Ports | shop 3000, sidecar 8080 and 9000 (architecture); mock-services 9101 payment, 9102 KYC, 9103 metadata, 9104 collector; bot controller 9200 | Sahil |
| 10 | Memory, CPU and process limits | shop 512 MB, 1 CPU, 256 pids; sidecar 256 MB, 0.5, 128; bot controller 512 MB, 1, 256; injector, import service, mock-services 128 MB, 0.5, 64; the memory-backed sizes of a component (its tmpfs mounts plus the volumes it mounts) must not exceed its `memory_mb` (validator) | Tanmay after spikes S-4, S-5 |
| 11 | Memory-backed sizes | `/tmp` 16 MB (shop 64, bot 128), `/data` 256 MB (injector 64), volumes `/run/vm` 16 MB, `/run/import` 8 MB, `/run/placement/import` and `/run/placement/mock` 2 MB each | Sahil, Tanmay |
| 12 | Volume names | `vm-run`, `vm-import`, `vm-placement-import` and `vm-placement-mock` (the orchestrator adds the instance id when it creates them) | Tanmay |
| 13 | Paths | shop DB `/data/shop.db`, catalogue DB `/data/catalog.db`, snapshot `/run/vm/snapshot.db`, import socket `/run/import/import.sock` | Sahil |
| 14 | Mount targets | exactly `/tmp`, `/data`, `/run/vm`, `/run/import`, `/run/placement/import`, `/run/placement/mock` | Sahil |
| 15 | Snapshot hand-over | The injector writes the patched snapshot to `/run/vm`; the shop copies it to `/data` before ready | Sahil |
| 16 | Delivery of placement files to the import service and mock-services | Decision by Tanmay (2026-10-08): two extra memory-backed volumes, `vm-placement-import` at `/run/placement/import` (injector read-write, import service read-only) and `vm-placement-mock` at `/run/placement/mock` (injector read-write, mock-services read-only), files mode 0400, owner 65532. To confirm with Sahil that the consumers read these paths | Sahil |
| 17 | Healthcheck numbers and kinds | interval 2 s, timeout 2 s, 15 retries; kinds `http`, `tcp`, `socket`; shop checks `/readyz` | Tanmay (spike S-4) |
| 18 | Import service transport | unix socket, no network, fresh process per job, healthcheck by socket | Sahil |
| 19 | Decoy placement field | `decoy_placement` (optional string, content defined by T) | Sahil |
| 20 | Network mode names | `instance` and `none`; the import service and the injector are always `none`; the others use `instance` | Tanmay |
| 21 | Template and component names | template id such as `shop-v0`; component name equal to the role name | Tanmay |
| 22 | Event endpoint base URL | `http://sidecar:9000` (path `/v1/events`, defined by IF-4); mock base `http://mock-services` | Tanmay, Sahil |
| 23 | Label value shapes | tokens `{instance_id}`, `{epoch}`, `{expires}`, `{host}`, `{owner_hash}`; owner hash is 64 lowercase hex and arrives as the required `owner_hash` of the IF-5 create body, computed by the platform (proposal: HMAC-SHA256 of the user id with a platform label key; handoff H-20); `vm.schema` equals `0.1`; `vm.kind` is `inst` in templates | Akshay (owner hash), Tanmay |
| 24 | Env value limit and reason length | value at most 512 characters; flag-in-env reason 20 to 300 characters, not blank; only the shop may use the exception | Sahil |
| 25 | Env allowlist | the 13 names in section 2 | Sahil |
| 26 | `issued_at` handling | optional, advisory and not enforced in v0, no age check | Tanmay |
| 27 | Sentinel and file paths of the placement kinds | file names are defined by the catalogue (IF-7); the directories `/run/placement/import` and `/run/placement/mock` are fixed here (row 16) | Sahil (T-02) |
| 28 | Shop restart and data loss | `/data` is memory-backed and lost on restart; no restart policy in v0; a dead shop means the orchestrator resets the instance (refers to OI-23) | Tanmay, Sahil |
| 29 | Injector network mode | Decision by Tanmay (2026-10-08): `network_mode: none` for the injector, enforced by the schema. This deviates from the architecture 02 drawing, which shows the injector on the instance network | Tanmay |
| 30 | Network labels | Applied by the orchestrator at create time, not checked by this schema | Tanmay |
| 31 | Start order and injector entrypoint | Prose only in v0; implemented by the orchestrator (L-13) | Tanmay |
| 32 | Injection document size limit and UTF-8 handling on standard input | Left to the injector | Sahil |
| 33 | Who mounts the shared volumes | Only the injector and the shop mount `/run/vm` (the shop read-only); only the shop and the import service mount `/run/import`; only the injector and the import service mount `/run/placement/import`; only the injector and mock-services mount `/run/placement/mock`; the sidecar, mock-services and bot controller never mount `/run/vm` | Sahil |
| 34 | Volume owner and mode options | The orchestrator creates the memory-backed volumes with uid and gid 65532 and a writable mode for that user (volume options to be confirmed in L-13) | Tanmay |
| 35 | Sidecar start input | The orchestrator gives the sidecar the event key, the flag digests and `first_seq` on standard input at start (never in the environment or a label); the exact shape, size limit and encoding are defined with L-06 and L-13 (handoff H-59) | Tanmay, Akshay |
