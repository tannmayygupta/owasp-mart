# 06. Security architecture

Status: PROPOSED (2026-10-08). Facts cited `[EF-n]` (register in [README.md](README.md)). Related ADRs: 0004 (gate), 0005 (event path), 0007 (VM topology), 0009 (keys and secrets), 0010 (orchestrator and host rule), 0014 (organization scoping). Requirement IDs refer to [PRD.md](../prd/PRD.md). Nothing here contains a real secret, flag or key value.

## 1. Trust boundaries

| Boundary | Between | What crosses | Control |
|---|---|---|---|
| TB-1 | Internet and Vercel | Browser traffic, cookies | TLS (Vercel-managed), CSP and headers (NFR-SEC-03) |
| TB-2 | Vercel and the platform edge | Proxied API and SSE traffic, forwarded client IP | TLS, secret header `x-origin-secret` checked at `caddy-p`, IP trusted only when the secret is valid `[EF-01]`, `no-store` caching rule `[EF-02]` |
| TB-3 | Platform edge and API zone | Plain HTTP on `plat-app` | Private Docker network, no other tenants |
| TB-4 | API zone and data (Postgres, Valkey, keystore) | SQL, Valkey commands | `plat-data` is internal (no egress), per-service database roles, passwords, RLS |
| TB-5 | Platform zone (VM-P) and instance control (VM-I) | Orchestrator calls, state reports, relayed events | Private VCN link, mTLS, signed bodies, no shared secrets with the hostile zone |
| TB-6 | Instance control and the hostile instance zone | Player traffic inward, signed events outward | Per-instance internal networks, edge-only front network, host INPUT rule, hardened containers |
| TB-7 | Inside an instance: shop and sidecar | Proxied HTTP, app events | Sidecar holds the signing key and digests; shop does not |
| TB-8 | Platform and external services | Email API, Object Storage, GitHub anchor, Let's Encrypt, DNS | Outbound only, least-privilege tokens, egress network separate from data network |
| TB-9 | Developers and the repository, CI, VMs | Code, secrets, deploys | Private repo, SSH keys, no secrets in CI, human-run deploy |

**Rule of thumb:** everything inside TB-6 is assumed compromised (section 6). The platform's safety does not depend on the shop being correct.

## 2. STRIDE table

| Threat | Where | Example | Controls (this architecture) | PRD requirements |
|---|---|---|---|---|
| **Spoofing** | Login, invites, recruiter signup | Fake recruiter; stolen session; invite link used by another person | Work-email rules and admin approval of the company, TOTP for admin (optional for recruiters), session ID rotation, `__Host-` cookies, rate limits, single-use hashed invite tokens bound to one verified email, gate ticket per instance | FR-ACC-03, 07, 08, 10, FR-ORG-01..04, FR-ASM-02, 04, FR-SES-11 |
| Spoofing | Sidecar events | An instance claims to be another | Per-instance key derived from a master and the instance ID; signature covers instance ID and sequence number; ingest recomputes | FR-DET-04, NFR-ISO-04 |
| Spoofing | Orchestrator calls | A forged "create instance" | mTLS plus signed body with timestamp and nonce; the orchestrator accepts instance IDs and allowlisted template names only | NFR-SEC-04 |
| **Tampering** | Scores, milestones, flags | Candidate edits a score; forged milestone | Server-side scoring only from verified events and flags; held captures; digests in the sidecar; app events labelled `source: app` and corroborated | FR-SCR-09, FR-FLG-04, FR-ACH-02, NFR-SEC-08 |
| Tampering | Audit log | Rewrite history | Append-only roles, hash chain, daily anchor outside the VM, checkpoints on purge | FR-PRV-10, NFR-SEC-08 |
| Tampering | Images and supply chain | Altered image or dependency | Images pulled by digest from a release manifest, lockfiles, dependency and secret scanning, layer scan for flags (FR-FLG-03); C06's outdated library is allow-listed on purpose and isolated | NFR-SEC-04, 07, FR-FLG-03 |
| Tampering | Browser to API | Cross-site request forgery | `SameSite=Lax` plus CSRF token plus `Origin` check plus JSON content type; do not rely on SameSite alone (labs host may be same-site, see [03](03-origins-and-access.md)) | NFR-SEC-03 |
| **Repudiation** | Recruiter views, admin reads | Denying a view of a candidate's data | Every view, export, approval and break-glass read is audit-logged with a pseudonymous actor; candidates see company-level history | FR-PRV-10, 11, FR-DSH-02, FR-EXP-04 |
| **Information disclosure** | Cross-user and cross-company reads | IDOR on the platform itself | Object-level authorisation, organization filter in one place plus RLS, the same error for "missing" and "not yours", automated cross-role tests | FR-ORG-06, FR-DSH-06, NFR-SEC-08 |
| Information disclosure | Flags and secrets | Flag in logs, dashboards, docs | No flag table; flags derived; digests not values in the sidecar; injector via stdin; log filters tested; image scans | FR-FLG-03, 08, NFR-SEC-05, NFR-PRI-02 |
| Information disclosure | Candidate data at rest and in backups | Backup restore of deleted data | Per-attempt keys, keystore excluded from rolling backups, crypto-shredding with snapshot purge | FR-PRV-12 |
| Information disclosure | Admin reading answers | Curious admin | No default access; break-glass with reason, time box, alert, review | FR-ADM-03, 08 |
| Information disclosure | Cached API responses at Vercel | One user's JSON served to another | `Cache-Control: private, no-store` and `x-vercel-enable-rewrite-caching: 0` `[EF-02]` | NFR-SEC-03 |
| Information disclosure | Third party in the path | Vercel sees API traffic | Document as sub-processor (FR-ORG-07); no secrets in URLs except one-time tickets; fallback to serving dashboards from the VM | FR-PRV-07, NFR-PRI-01 |
| **Denial of service** | Signup, invites, login | Email bombing, brute force | Rate limits per IP and account, invite caps, outbox | FR-ACC-10, FR-ORG-08 |
| Denial of service | Instance creation | Exhaust the VM | Per-user, per-org and global quotas, queue back-pressure, resource limits per container | FR-INS-06, NFR-ISO-03 |
| Denial of service | Public instance hosts | Flooding a shop | Gate refuses without ticket or cookie; per-host rate limit and body size limit at the edge | (new, see P-14 in README) |
| Denial of service | Event path | Event storm from a hostile sidecar | Size and rate limits at the relay and ingest, buffering rules, aggregated summaries | FR-DET-04 |
| **Elevation of privilege** | Container escape | Shop to host | Dropped capabilities, non-root, read-only filesystem, default seccomp, no-new-privileges, internal networks, host INPUT rule, optional user namespaces and gVisor; **VM-P holds all personal data on a different VM from VM-I** | NFR-ISO-01..07 |
| Elevation of privilege | Orchestrator abuse | API caller gets root through Docker | Public API never holds the socket; orchestrator is a separate service on VM-I behind a socket proxy and builds containers from templates only; ASVS L3 | NFR-SEC-02, 04 |
| Elevation of privilege | Role change | Recruiter becomes admin | Account types are exclusive; role changes by Admin only and audited; admins created only by admins or a seed command | FR-ACC-05, 11 |

## 3. Key and secret inventory

Secrets are files mounted into the container that needs them (Compose file secrets under `/run/secrets`), sourced from root-only files on the VM (`/opt/vulnmart/secrets`, mode 0400, created by a bootstrap script). Long-lived keys are **not** passed as environment variables, because `docker inspect` and `/proc` reveal them (RS-B). Development uses throwaway keys; production secrets never appear in the repository, CI, logs or docs (NFR-SEC-05). Oracle's Always Free tier includes a Vault with 150 secrets and unlimited software-protected keys `[EF-21]`; using it is possible later but adds IAM setup, so files are proposed first (ADR 0009).

| Secret | Purpose | Lives where | Who can read it | Rotation | If lost or leaked |
|---|---|---|---|---|---|
| `K_flag[v]` flag master key | Derive and verify flags and decoys (D-23) | VM-P secrets file, mounted into workers and API only | Workers, API. **Never** orchestrator, VM-I or any instance | New version per rotation; old versions kept until the last instance using them is gone | Leaked: flags of live instances can be forged, so rotate and destroy instances. Lost: cannot verify pasted flags of running instances |
| `K_evt[v]` event master key | Derive per-instance signing keys | VM-P secrets file, mounted into ingest and workers | Ingest, workers | Versioned | Leaked: forge events for any instance. Per-instance key leak: forge events for that instance only |
| Per-instance event key | Sign events from one sidecar | Sidecar process memory (standard input at start) | The sidecar | Per instance, discarded at destroy | Leak: forged events for this instance, which is already assumed hostile |
| Per-instance flag digests | Compare flag-shaped strings | Sidecar memory | The sidecar | Per epoch | Leak reveals no flag (one-way hashes of high-entropy values) |
| Flag values | Planted for the player to find | Shop rows and read-only files (inside the instance), the worker briefly | The shop | Per epoch | Visible to anyone with code execution in the shop; hence the rule that no challenge allows it (FR-CHL-13) |
| `KEK[v]` key-encryption key | Wrap per-attempt keys | VM-P secrets file; offline sealed copy | Key service in the API | Versioned, DEKs re-wrapped | Lost: all evidence unreadable. Leaked: keystore plus a leaked keystore backup would decrypt data |
| Per-attempt DEK | Encrypt evidence and answers | `vm_keystore` database (wrapped) | Key service, one attempt at a time | Never rotated, shredded at deletion | See shredding rule in [04](04-data-and-state.md) section 5 |
| `K_field` field key | Encrypt TOTP secrets | Derived from the KEK material with its own label | API | With KEK | Leak exposes TOTP seeds |
| Session IDs and CSRF values | Authentication, CSRF defence | Opaque random values, stored hashed (sessions) | Nobody (hashes only) | Per login, rotated at privilege change | Single session affected |
| `ORIGIN_SECRET` | Prove a request came through Vercel | Vercel project environment and VM-P secret | `caddy-p`, Vercel build config | Accept old and new values during rotation, as Vercel documents `[EF-01]` | Leak: direct access to the API host. Cookies and CSRF still protect users |
| `K_gate` | Sign and verify access tickets and gate cookies | VM-P (API) and VM-I (gate) | API, gate | Two-key accept window | Leak: tickets forged to open instances (hostile zone only) |
| Orchestrator mTLS certificates and request-signing key | Authenticate platform to orchestrator and back | Private CA (key kept offline), leaf certificates on both VMs | Workers, orchestrator, ingest listener | Leaf certificates short-lived, renewed by script | Leak of orchestrator side: forged state reports and event relays (platform treats them as claims) |
| Database and Valkey passwords | Service access | VM-P secrets files, one role per service | The service | Per rotation | Per-service impact limited by roles |
| TLS private keys (platform host, wildcard for the labs zone) | HTTPS | Caddy storage on each VM | Caddy | Automatic renewal | Labs wildcard leak: impersonate instance hosts, never the platform host (different key and zone) |
| DNS provider token | DNS-01 challenge for the wildcard | Secret in `caddy-l` | `caddy-l` | Manual | Leak: change DNS for names under that account. Use a **separate account** for the labs zone so the API name is not exposed (assumes tokens are per account, UNVERIFIED) |
| Email provider API key | Send mail | Workers only | Workers | Manual | Abuse of sending quota |
| Backup encryption key pair | Encrypt dumps before upload | Public half on VM-P, private half offline | Operators for restore drills | Per policy | VM compromise cannot read old backups |
| Object Storage credentials | Upload backups | Scheduler secret (write-only to one bucket); restore credentials kept off the VM | Scheduler | Manual | Overwrite risk limited by write-only use and lifecycle rules |
| Audit anchor signing key and repository deploy key | Sign and push the daily anchor | VM-P scheduler secret | Scheduler | Manual | Forged anchors possible only with both repository and key access |
| GHCR pull token | Pull images on the host | Host-level Docker login on each VM (read-only scope) | Root on the VM | Manual | Read access to private images (challenge code) |
| Deploy SSH keys | Maintain VMs | Developers' own machines | Each developer | Per developer | Q-32 decides who has access |
| Optional password pepper | Extra hashing secret | Would live with the keys | API | Versioned | Not proposed by default (OWASP lists it as optional, RS-H) |

## 4. The orchestrator's privileges and the socket proxy

Docker socket access is equivalent to root on the host (OWASP Docker Security Cheat Sheet rule 1, UNVERIFIED here, search summary only in RS-D). The design confines it (NFR-SEC-04, ASVS L3 per NFR-SEC-02):

1. **Where**: the orchestrator runs only on VM-I, never on VM-P and never inside the public API. Only the platform's workers can call it.
2. **How it reaches Docker**: through a socket proxy container that exposes only the API sections needed (containers, networks, create, start, stop, remove, inspect, events, list). The proxy filters by API section and method; it does not inspect request bodies (UNVERIFIED for the tool named in RS-D, Tecnativa `docker-socket-proxy`, not read this session). Therefore **the orchestrator's code is the real control**.
3. **What it accepts**: instance IDs matching a strict pattern and **template names** from an allowlist that maps to image digests in a signed release manifest. It never accepts an image name, command, volume, port, network or environment from a request (NFR-SEC-04).
4. **What it builds**: containers from fixed specifications: no privileged mode, no host mounts, no host network, all capabilities dropped, `no-new-privileges`, default seccomp, non-root user, read-only root filesystem with memory-backed writable areas, memory, CPU and process limits, labels. Never a socket mount.
5. **Where it listens**: on `labs-core` and on the VCN private address with mTLS; never `0.0.0.0` on a public interface. Calls are rate-limited, replay-protected (timestamp and nonce) and each is written to the audit log with a system actor.
6. **What it holds**: no master keys, no database credentials. It receives flags and keys per instance in the create call and forwards them by standard input, without persisting them.
7. **Blast radius if compromised**: root on VM-I, the instances present, the gate key and TLS keys for the labs zone. It cannot read the platform database, the keystore or the flag master key, because they are on VM-P and not reachable from VM-I except through the signed ingest listener.
8. **Rootless Docker or user-namespace remapping** would lower the damage of a daemon-level escape but changes networking behaviour (rootless limits are listed in Docker's docs; RS-B); it is an optional hardening tested in spike S-8 and must not change the architecture (NFR-ISO-05). The host INPUT rule behaves differently under rootless networking and must be re-tested there (ADR 0010).
9. **Tests**: the L3 review includes tests that malformed IDs, unknown templates, oversize bodies and replayed requests are rejected.

## 5. ASVS level scope

ASVS 5.0.0 is the latest stable version per OWASP's project page (VERIFIED, `[EF-29]`). That page does not define the three levels and RS-D's description of them came from a secondary source, so **level definitions are UNVERIFIED** and the official document must be read before the report (NFR-SEC-01). Chapter numbers are intentionally not quoted here.

| Scope | Level | Components |
|---|---|---|
| Platform (D-21) | **2** | Dashboards K-01, platform edge K-02, API K-03, workers K-04, scheduler K-05, ingest K-06, SSE hub K-07, database and Valkey configuration K-08, K-09 |
| Orchestrator and admin (D-21) | **3** | Orchestrator K-13, admin functions: authentication and MFA of admins, user management, company approval, break-glass, audit access, settings |
| **Proposed addition for the user to confirm** | 3 | Key service K-12 and audit subsystem K-11, because break-glass and shredding depend on them. This extends D-21 beyond "orchestrator and admin", so it needs the user's agreement |
| Not in scope | none | The shop and its parts (intentionally vulnerable); their safety comes from isolation, not from ASVS |

Evidence is kept as a table in `docs/traceability.md` (requirement, how met, test, result) per NFR-SEC-01. Topic areas to cover: authentication, sessions, access control, input validation and output encoding, cryptography, error handling and logging, data protection, communication security, API and web service, configuration, file handling (none on the platform), business logic, and front-end security.

## 6. What the platform assumes about a compromised instance

Assumption: an attacker has full control of any container in an instance's `inst-<id>` network (the shop, import service, mock-services, bot), even though no challenge is meant to allow that (FR-CHL-13). Consequences and controls:

| The attacker can | The attacker cannot |
|---|---|
| Read every flag and decoy of **their own** instance and forge app events for their own instance | Read any flag of another instance (derived from a key they never see) |
| Send arbitrary traffic inside their own instance network | Reach another instance, the platform, Valkey, Postgres, the orchestrator, the socket proxy or the host (no route, INPUT rule) |
| Attack the sidecar through the instance network, if it listens there | Reach the front network (not attached), so cannot reach the edge or ingest directly |
| Exhaust their container limits | Exhaust the host: limits per container and per user quota apply |
| Hold open or abuse the event relay only through the sidecar | Forge events for another instance (key derived from instance ID) |
| Read the event signing key **only if** the sidecar is compromised | Read it from the shop container (never in its environment or filesystem) |

What the platform therefore does **not** trust: app events as proof of a capture (corroborated by sidecar-observed traffic or flags and the activity-versus-capture check); the instance clock (platform timestamps arrival and uses per-instance sequence numbers); any text from an instance rendered in dashboards (evidence and event payloads are escaped, shown as data, never as HTML; the recruiter dashboard shows requests as plain text, the admin Security Alerts page of the shop encodes output, FR-CHL-10).

Compromise of an instance spoils **that attempt's integrity** (all that attempt's flags are known to the attacker). Detection signals: activity-versus-capture inconsistency, decoy and timing signals, and the paste path. These go to a human, never to automatic rejection (FR-ACH-06). Impact outside that attempt is zero by design.

Residual risks to state to the user: a kernel-level escape from a container on VM-I reaches the orchestrator and the other instances' data on the same host (not the platform database, ADR 0007); the labs edge is a shared hub attached to many front networks and is therefore kept minimal and patched (ADR 0005); on the laptop fallback the host-side rule cannot be installed on Docker Desktop, so the laptop must hold no platform secrets and not be publicly exposed (RS-B, ADR 0015).

## 7. Other controls worth naming

- **Web controls (NFR-SEC-03):** HSTS on platform hosts, nonce-based CSP, `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, `Cache-Control: no-store` on authenticated responses, generic error pages with a request ID. Instance hosts do **not** get HSTS or CSP from the edge (it would alter the lab).
- **Origin secret and cookie-free API host:** a script on a shop host cannot reach the API with credentials ([03](03-origins-and-access.md)).
- **Abuse of the labs zone:** instances have no egress, so a lab cannot be used to attack third parties; this also supports the provider-terms position (R-4).
- **CI:** untrusted code never runs with secrets (private repository, no deploy credentials in CI); secret scanning and dependency audits run on every push (NFR-SEC-07, NFR-MNT-04).
- **Documentation hygiene:** the docs and dev-logs never contain real flags, keys or personal data (CLAUDE.md, NFR-PRI-02).
