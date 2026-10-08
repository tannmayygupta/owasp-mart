# VulnMart architecture: index, evidence register, PRD issues, decisions

Status: PROPOSED (2026-10-08) except where marked "Accepted (D-28)". Locked decisions D-01 to D-32 in `initial.md` win over anything here. No real flag, key or secret appears in these files.

## Summary in plain language

Browsers talk only to the dashboards on Vercel. Vercel forwards `/api/*` to the platform on the Oracle VM, so cookies stay first-party (D-28). Each user's private shop copy runs on its own pair of internal Docker networks and gets its own hostname under a separate "labs" DuckDNS name with one wildcard certificate. A gate lets only the owner in. The shop can never call out; its sidecar sends signed events through the edge to the platform. Three streams (platform and dashboards, lab, target and challenges) meet only at written contracts with mocks.

## Index

| File | What it covers |
|---|---|
| [01-overview-and-components.md](01-overview-and-components.md) | Context diagram, 23 components with technology, data owner, requirement table, extensibility hooks |
| [02-deployment-and-network.md](02-deployment-and-network.md) | Environments, deployment views, configuration, CI/CD and arm64 builds, trust zones, allowed flows, host drop rule, startup, failure modes, observability, capacity and spikes |
| [03-origins-and-access.md](03-origins-and-access.md) | The four traps: browser path, instance addressing and TLS, network and event path, SSE; access gate |
| [04-data-and-state.md](04-data-and-state.md) | Schema outline, org scoping, audit chain, keys and crypto-shredding, retention jobs, Valkey, backups, state machines, flag derivation |
| [05-key-flows.md](05-key-flows.md) | Ten sequence diagrams with failure branches |
| [06-security.md](06-security.md) | Trust boundaries, STRIDE, secret inventory, orchestrator privileges, ASVS scope, compromised-instance assumptions |
| [07-repo-and-workstreams.md](07-repo-and-workstreams.md) | Monorepo, CODEOWNERS, contracts, mocks, CI checks, Compose dev, work-stream split, sprint zero, deadlock rules |

## Evidence register

Status words: VERIFIED (read in a primary source this session), UNVERIFIED, CONFLICTING. Numbers EF-27 and EF-28 are not cited and are unused.

| ID | Claim | Status | Source |
|---|---|---|---|
| EF-01 | Vercel external rewrites; forwards x-real-ip, x-forwarded-for/host/proto; origin-secret header pattern | VERIFIED | https://vercel.com/docs/rewrites |
| EF-02 | External rewrites honour upstream Cache-Control by default for projects created on or after 2026-04-06; opt-out header `x-vercel-enable-rewrite-caching: 0` | VERIFIED | https://vercel.com/docs/rewrites |
| EF-03 | Proxied (rewritten) request timeout maximum 120 seconds, else ROUTER_EXTERNAL_TARGET_ERROR | VERIFIED | https://vercel.com/docs/limits |
| EF-04 | CDN waits 120 s for first byte, then data at least every 120 s; all plans; rewrites and SSE not mentioned | VERIFIED (partial) | https://vercel.com/changelog/cdn-origin-timeout-increased-to-two-minutes |
| EF-05 | SSE unbuffered through a rewrite, longest stream, Set-Cookie passthrough, IP-literal destination | UNVERIFIED | No primary source found (spike S-14) |
| EF-06 | Hobby included usage (100 GB transfer, 10 GB origin transfer, 1M CDN requests, 1M invocations, 4 CPU-h), function max 300 s, non-commercial personal use | VERIFIED | https://vercel.com/docs/plans/hobby |
| EF-07 | Third-party cookies: Firefox TCP, Safari blocked, Chrome not blocked by default, Edge partial; Chrome's future plan not stated | VERIFIED (browsers); Chrome plan UNVERIFIED | https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies ; https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ |
| EF-08 | Public Suffix List contains vercel.app, duckdns.org, github.io; sslip.io and nip.io are **absent** (the lead session downloaded the full list on 2026-10-08 and checked every line: `sslip.io`, `nip.io` and `traefik.me` not listed) | VERIFIED (present and absent) | https://publicsuffix.org/list/public_suffix_list.dat |
| EF-09 | Let's Encrypt limits: 50 certificates per registered domain per 7 days, 5 duplicates per 7 days, 300 orders per 3 h, 5 failed validations per identifier per hour; each IPv4 counts as its own registered domain | VERIFIED | https://letsencrypt.org/docs/rate-limits/ |
| EF-10 | Wildcard certificates require DNS-01 | VERIFIED | https://letsencrypt.org/docs/faq/ |
| EF-11 | IP certificates: `shortlived` profile, 160 hours, identifiers DNS and IP; HTTP-01 and TLS-ALPN-01 only (from D-16 sources) | VERIFIED (profile); challenge types via D-16 text | https://letsencrypt.org/docs/profiles/ |
| EF-12 | Caddy IP-certificate support: reported working for IPv4, tracking issue open, one rejection report | CONFLICTING | https://github.com/caddyserver/caddy/issues/7399 ; https://caddy.community/t/shortlived-certificates-from-lets-encrypt/33399 |
| EF-13 | sslip.io and nip.io: no wildcard certificate, per-hostname HTTP-01, Let's Encrypt raised their limit to 250,000, no uptime guarantee stated | VERIFIED | https://nip.io/ ; https://github.com/cunnie/sslip.io |
| EF-14 | DuckDNS: HTTPS update API, TXT API usable for Let's Encrypt, TXT applies to all sub-subdomains, wildcard A resolution not stated | VERIFIED (partial); wildcard A UNVERIFIED | https://www.duckdns.org/spec.jsp ; https://www.duckdns.org/faqs.jsp |
| EF-15 | arm64 standard runners (`ubuntu-24.04-arm`) in private repos since 2026-01-29, 2 vCPU, count toward free minutes; free and unlimited in public repos (4 vCPU) | VERIFIED | https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories ; https://docs.github.com/en/actions/reference/runners/github-hosted-runners |
| EF-16 | GitHub Free: 2,000 min/month private, 500 MB artifacts and packages, 10 GB cache; per-minute rates Linux x64 $0.006, arm64 $0.005; arm64 minute ratio against free minutes not stated | VERIFIED; ratio UNVERIFIED | https://docs.github.com/en/billing/concepts/product-billing/github-actions |
| EF-17 | GHCR "currently free" while the same page lists 500 MB and 1 GB per month for private packages | CONFLICTING | https://docs.github.com/en/billing/concepts/product-billing/github-packages |
| EF-18 | Docker multi-platform CI: QEMU on one runner can significantly extend build time, or distribute builds across runners | VERIFIED | https://docs.docker.com/build/ci/github-actions/multi-platform/ |
| EF-19 | Docker `--internal`: gateway IP and host services reachable, host can reach container IPs | VERIFIED | https://docs.docker.com/reference/cli/docker/network/create/ |
| EF-20 | Docker rules sit in FORWARD, jumping to DOCKER-USER; docs silent on container-to-host traffic (INPUT is an inference) | VERIFIED (FORWARD); INPUT UNVERIFIED | https://docs.docker.com/engine/network/firewall-iptables/ |
| EF-21 | Oracle Always Free: A1 1,500 OCPU-h and 9,000 GB-h, 200 GB block, 5 volume backups, Object Storage 20 GB and 50,000 requests, Vault 150 secrets, 10 TB outbound, 3,000 emails, idle reclaim rule; the lead session's fetch of the page reads "one or two OCI Ampere A1 Compute instances, 2 OCPUs total" (up to two instances of 1 OCPU each) | VERIFIED (including the two-instance limit); minimum memory per OCPU not found, both old and new totals equal 6 GB per OCPU | https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm |
| EF-22 | SSE: Last-Event-ID on reconnect, non-200 or 204 stops reconnect, retry field, 15 s comments, no custom headers, 6-connection limit without HTTP/2 | VERIFIED | https://html.spec.whatwg.org/multipage/server-sent-events.html ; https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events |
| EF-23 | Caddy reverse_proxy flushes text/event-stream immediately; placeholders in upstream need no scheme and a port; stream_timeout | VERIFIED | https://caddyserver.com/docs/caddyfile/directives/reverse_proxy |
| EF-24 | Valkey Streams: XADD with MAXLEN and MINID (6.2.0), IDs ms-seq, XREAD BLOCK in ms, `$` only first call | VERIFIED | https://valkey.io/commands/xadd/ ; https://valkey.io/commands/xread/ |
| EF-25 | PostgreSQL 18 RLS: owners and BYPASSRLS skip it, FORCE option, default deny; session-variable pattern is general practice, not on the page | VERIFIED | https://www.postgresql.org/docs/18/ddl-rowsecurity.html |
| EF-26 | Docker Desktop Mac supports Intel (current and two previous macOS); Windows page omits Home from WSL 2 requirements yet says Home runs Linux containers | VERIFIED (Mac); CONFLICTING (Windows Home) | https://docs.docker.com/desktop/setup/install/mac-install/ ; https://docs.docker.com/desktop/setup/install/windows-install/ |
| EF-29 | ASVS 5.0.0 is the latest stable; level definitions not on the page | VERIFIED (version); levels UNVERIFIED | https://owasp.org/www-project-application-security-verification-standard/ |
| EF-30 | CODEOWNERS: last pattern wins, owners need write access, any one owner's approval satisfies, enforced by branch protection; plan availability for private personal repos not stated | VERIFIED (rules); availability UNVERIFIED | https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners |

Other items named UNVERIFIED in the text: Dramatiq with Valkey, Caddy DuckDNS plugin and on-demand TLS `ask`, Prism, oasdiff, Schemathesis, Tecnativa socket proxy behaviour, OCI notification limits beyond the Oracle page, Vercel private-repo support on Hobby, iptables rule persistence across Docker restarts.

## PRD issues (unclear, missing or contradictory)

| ID | Requirement | Issue | Where handled |
|---|---|---|---|
| P-1 | NFR-ISO-06 vs D-15, OI-28 | Orchestrator and instances must be on a dedicated VM "not next to personal data", but D-15 puts API and instances on one VM and the database holds personal data | ADR 0007 |
| P-2 | NFR-SEC-03, D-15, D-21 | Same-origin and no open CORS conflict with dashboards on another site | Resolved by D-28 (rewrite) |
| P-3 | FR-INS-10, FR-SES-11 | "Only the owner reaches the instance" has no mechanism | ADR 0004 |
| P-4 | FR-INS-03 | "Platform session heartbeat" is undefined | 03 section 3 |
| P-5 | FR-DET-04 | "Instance can post only for its own ID" leaves forged app events inside an instance | 06 section 6 |
| P-6 | FR-FLG-04 | Sidecar must "check validity" but has no key; digests proposed | ADR 0009 |
| P-7 | FR-INS-07, NFR-MNT-02 | "Only the orchestrator writes instance state" vs "only the API writes the database" | 01 section 2.2 |
| P-8 | FR-INS-07, FR-SES-04 | State list has no frozen state; access flag proposed | 04 section 10.2 |
| P-9 | FR-PRV-12, D-25 | "Per-assessment key" cannot shred one candidate; per-attempt key proposed | ADR 0008, 0009 |
| P-10 | FR-PRV-12, NFR-AVL-05 | Key placement relative to 14-day backups unspecified | ADR 0008 |
| P-11 | FR-PRV-10 | Chain behaviour on 12-month purge and concurrent writes unspecified | 04 section 4 |
| P-12 | NFR-ISO-02 | Names DOCKER-USER; Docker documents it in FORWARD, container-to-host is INPUT | ADR 0010 |
| P-13 | NFR-SEC-06, D-16 | "Never plain HTTP" vs loopback development and internal hops | ADR 0003 |
| P-14 | (missing) | No requirement for rate and size limits on public instance hosts | 06 STRIDE |
| P-15 | FR-NTF-03, D-21 | Resend needs a verified domain; DuckDNS cannot publish SPF and DKIM | 03 section 7, OI-32 |
| P-16 | NFR-CST-02, R-4, FR-ORG-07 | Hobby is non-commercial; Vercel as sub-processor not in the processing terms | ADR 0002 |
| P-17 | FR-INS-02, FR-CHL-07 | Container list omits bot controller and injector; how a network-less import service receives jobs | 07 section 3.2 |
| P-18 | FR-INS-02 | "Separate read-only catalog store": container or read-only file | 01 K-17 |
| P-19 | FR-INS-03, FR-ACC-04 | Whether an open SSE stream counts as activity | 03 section 3 |
| P-20 | NFR-MNT-04 | 2,000-minute budget unverified; arm64 minute accounting unknown | ADR 0011 |
| P-21 | (missing) | No staging environment defined | 02 section 1 |

## Decisions needing the user

> **Update 2026-10-08 (user decisions):** #1 **two VMs** (D-34); #9 **split P, L, T with Tanmay L, Akshay P, Sahil T** (D-33); #12 **"never plain HTTP" applies to public addresses only** (D-35); #13 **ASVS level 3 also for the key service and audit log** (D-35); the **per-attempt key** part of #5 (D-35); and PRD issue P-18 (**read-only catalog as a second SQLite file**, D-35). Still open: #2, #3, #4, #5 (rest), #6, #7, #8, #10, #11, #14.

Accepted by the user in D-28 (shown for completeness, with refinements still Proposed): ADR 0002, 0003, 0005, the self-hosted data choice in 0008, and arm64 builds on the VM in 0011.

| # | Question | Options | Recommendation | ADR |
|---|---|---|---|---|
| 1 | One Oracle VM or two (platform VM and instance VM)? | A one VM (D-15 as written); B two VMs, 1 OCPU each; C managed data stores | B for blast radius and NFR-ISO-06, but it needs a D-15 wording change and costs CPU and ops; A if you accept the residual risk and amend NFR-ISO-06 | 0007 |
| 2 | How is instance access controlled? | Ticket plus host-only cookie via gate; mTLS client certificates; unguessable hostname only | Ticket plus cookie | 0004 |
| 3 | Live-update fan-out design | Valkey Streams plus outbox; pub/sub only; Postgres LISTEN/NOTIFY | Streams plus outbox; plan B ticketed direct SSE needs your OK on exact-origin CORS | 0006 |
| 4 | Backups, keystore rule and audit anchor | Latest-only keystore snapshot; keys in main backups; external KMS. Anchor: private repo, email, object | Latest-only keystore, anchor by repo plus email | 0008 |
| 5 | Key design | Independent versioned keys and file secrets; one root key; OCI Vault. Flag digests in the sidecar; per-attempt key | Independent keys, files, digests, per-attempt key | 0009 |
| 6 | Orchestrator privilege and host rule | Socket proxy plus template-only builder; rootless Docker; SSH-remote daemon. Rule in INPUT or DOCKER-USER | Proxy plus builder plus INPUT rule; rootless optional | 0010 |
| 7 | CI and registry | arm64 on the VM (locked) with optional GitHub arm runner; QEMU; registry GHCR or build on VM | Keep D-28; use GitHub arm runner only if minutes allow | 0011 |
| 8 | Repo layout and contract tools | Monorepo with spec-first fragments; polyrepo; code-first only | Monorepo, spec-first, generated clients | 0012 |
| 9 | Work-stream split (and who takes which) | By layer; by slice; by component; by contract boundary | Contract boundary: P, L, T; assignment suggestion only | 0013 |
| 10 | Organization scoping | App filter only; RLS only; both | Both | 0014 |
| 11 | Laptop fallback engine | Docker Desktop; dedicated WSL2 engine; VM | Dedicated WSL2 engine if S-3 shows the drop rule works there | 0015 |
| 12 | Reading of "never plain HTTP" | Public only; also internal hops; also loopback | Public only, loopback allowed | 0003 |
| 13 | ASVS level 3 for key service and audit | Orchestrator and admin only; add key and audit | Add them | 06 section 5 |
| 14 | Vercel as sub-processor on Hobby | Accept; dashboards on VM now | Accept, with the VM fallback ready | 0002 |

## Spikes

From the PRD: S-1 certificate for the VM, S-2 SSE through the real path, S-3 host blocking and socket proxy, S-4 start time and memory, S-5 bot memory, S-6 Coraza and CRS, S-7 sidecar form, S-8 gVisor and rootless, S-9 C06 input and flag matcher, S-10 crypto-shredding and chain, S-11 Oracle shape, S-12 Argon2id, S-13 orchestrator crash.

New (details in 02 section 13.3): S-14 Vercel rewrite behaviour, S-15 edge attached to many networks, S-16 DuckDNS wildcard and DNS-01, S-17 two-VM private link, S-18 Dramatiq on Valkey, S-19 keystore snapshot restore, S-20 Compose on Windows and macOS, S-21 build minutes, S-22 memory growth and sidecar buffer.
