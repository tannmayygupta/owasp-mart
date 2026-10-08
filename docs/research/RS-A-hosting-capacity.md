# RS-A — Hosting on free tiers, deployment topology, capacity
Status: DRAFT research, NOT confirmed by the user · Date: 2026-10-08

Plain-language note: "free tier" pages change often. Every limit below was read on 2026-10-08 unless marked UNVERIFIED. Re-check the vendor page on the day you sign up. Where the vendor page was silent, this file says "not found" instead of guessing.

## 1. Questions answered

### 1.1 What can run on free tiers today (per platform part)

Short answer:
- **(a) Dashboards (Next.js):** yes, easily, on several free tiers.
- **(b) Platform API (FastAPI + WebSockets):** only on an always-on VM, or on a free web service that sleeps. Serverless hosts are a poor fit for WebSockets.
- **(c) PostgreSQL:** yes, small (about 0.5 to 1 GB) on Neon or Supabase. Render's free Postgres expires after 30 days, so avoid it.
- **(d) Redis:** yes, small, on Upstash (500K commands per month) or self-hosted on the VM.
- **(e) Per-user shop instances (several containers each, started and stopped by our API):** **no free PaaS offers this well.** Free PaaS tiers give 1 to 3 services and 0.1 to 1 vCPU. The only free place with real room is a VM we control (Oracle Always Free, or our laptop).

Per-provider table. "On-demand API" means: can our API create, start and stop containers at will?

| Provider | Current free limits (read 2026-10-08) | Containers on demand via API? | Sleep / idle | Card needed? | ToS on vulnerable / training / pentest targets |
|---|---|---|---|---|---|
| **Vercel (Hobby)** | 100 GB transfer, 1M function calls, 4 h active CPU per month. Hobby is "restricted to non-commercial personal use only". | No. Serverless and static only. Not for Docker. WebSocket support on functions: UNVERIFIED (generally not supported). | Serverless, no always-on process | Not checked | Pentest page: "This is not permitted for Hobby users." and pro/enterprise "are permitted to test their own applications"; hosting intentionally vulnerable apps: **not found**. Hosting only the dashboards on Vercel is safe on this point. |
| **Railway** | Free plan: $1 per month credit, 1 vCPU / 0.5 GB per service, 3 services, 1 project, 500 MB volume. Trial: one-time $5 for 30 days, no card. | It has an API, but limits (3 services) make per-user stacks impossible. | Credit runs out, services stop | Trial: "No credit card required". Free plan: **not found** | Fair-use page: no clause on security testing or vulnerable apps (**not found**). Quote: prohibits using services to "distribute malware" as part of attack activity; "If you are unsure whether your use case is allowed, ask us before deploying." |
| **Render** | Free web service: 750 h per month, spins down after 15 min idle, about 1 min to wake, no disk. Free Postgres: 1 GB, **expires after 30 days** (+14 days grace). Free Key Value: in-memory only, lost on restart. | No. Free tier: one instance, no private-network inbound, no jobs. | Spins down after 15 min | **not found** (without a card, services suspend when bandwidth runs out) | Acceptable-use text could not be read (page returned only the title). **Not found.** |
| **Fly.io** | **No free tier** for new organizations. Trial: 2 hours of runtime or 7 days. Then card required. Example price: shared-cpu-1x 256 MB about $2.19/month. | Yes, technically the best fit (Machines can be created and stopped by API; UNVERIFIED on the pricing page, known from Fly docs). But not free. | Auto-stop supported | Yes, after trial | ToS has no AUP. Clause 4.1(c): customer data must not "contain any viruses, worms or other malicious computer programming codes intended to damage" systems or data. Security testing and vulnerable apps: **not found**. |
| **Koyeb** | Free instance: 512 MB, 0.1 vCPU, 2 GB disk, one per organization, only Frankfurt or Washington, scales to zero after 1 hour (secondary sources). Free Postgres: 0.25 vCPU, 1 GB, 5 h compute per month (official pricing page). | No, one free instance only. | Scales to zero | **CONFLICTING** (FAQ quote "We require a credit card to prevent fraud and abuse"; pricing page says no payment method on Hobby) | **not found** (ToS not read). Note: a February 2026 report says Mistral AI agreed to acquire Koyeb (UNVERIFIED), so terms may change. |
| **Oracle Cloud Always Free** | Ampere A1: 1,500 OCPU-hours and 9,000 GB-hours per month, "equivalent to 2 OCPUs and 12 GB of memory" (down from 4 OCPU / 24 GB; secondary source says the change took effect 2026-06-15 and enforcement is uneven). Up to two 1-OCPU instances or one big instance. 200 GB block storage total. Also AMD micro VMs (1/8 OCPU, 1 GB; UNVERIFIED this session). | **Yes, full control.** It is a plain VM: run Docker and our API. Or use the OCI API to create instances. | **Idle reclaim:** reclaimed if, over 7 days, CPU p95 below 20% **and** network below 20% **and** memory below 20% (memory test is A1 only). | Yes (about $1 hold, secondary source) | Acceptable-use page could not be fetched (HTTP 403). Security-testing policy page not found (404). **Not found.** |
| **Google Cloud** | Always Free: 1 e2-micro VM (us-west1, us-central1 or us-east1), 30 GB disk, 1 GB egress per month. Cloud Run: 2M requests, 360,000 GB-s, 180,000 vCPU-s per month. $300 credit for 90 days. | e2-micro: yes (a small VM, about 1 GB RAM, too small for us). Cloud Run: stateless, no multi-container per-user stack. | Cloud Run scales to zero | **Yes**: "requires a credit card or other payment method" | AUP not read. **Not found.** |
| **AWS** | New "Free plan": $100 credit at once, up to $100 more; "The account closes on its own 6 months after you open it or when your credits run out, whichever comes first." 30+ always-free services. | EC2 is available on both plans, so on-demand containers are possible, but only for 6 months. | n/a | Page does not say. **Not found.** | AUP not read; AWS has a published penetration-testing policy (UNVERIFIED). |
| **Azure** | Free account: 12-month services, "65+ always-free services". Exact VM hours and credit not stated on the page read. Student offer: $100, no card. | VMs possible, time-limited. | n/a | Standard account: not stated. Students: no card. | **Not found.** |
| **Cloudflare** | Tunnel (cloudflared): outbound-only secure connection, automatic HTTPS and DDoS protection. A domain on Cloudflare is "required to publish applications"; Quick Tunnels give a temporary `trycloudflare.com` address with no account. Pages and Workers free tiers: not read this session (**UNVERIFIED**). | Not a compute host for our containers. Tunnel can point at a machine we control. | Quick Tunnel "Ends with the process" | Quick Tunnel: no account. Named tunnel: free account (UNVERIFIED on plan terms). | Website terms: "You may not transmit any viruses, worms, defects, Trojan horses, or any items of a destructive nature." and bans unauthorized access attempts. No clause on training targets (**not found**). The Self-Serve Subscription Agreement (the contract that matters for the tunnel) was **not read**. Cloudflare could still suspend on abuse reports. |
| **Neon (Postgres)** | 1 GB storage per project, 100 CU-hours per month, up to 100 projects. | n/a (database) | Suspends after 5 min idle (cannot disable). Wakes in about a second (UNVERIFIED). | Page does not say | n/a (we would store only platform data, no vulnerable app) |
| **Supabase (Postgres)** | 2 free projects, 500 MB database each. | n/a | "We may pause applications on the Free Plan that exhibit low activity in a 7-day period" | **not found** | n/a |
| **Upstash (Redis)** | 500K commands per month, 256 MB, 10 GB bandwidth. | n/a | Serverless | No card ("A credit card is needed to upgrade") | n/a. Number of free databases is CONFLICTING (FAQ says 10, table says 1). |

**Terms-of-service summary (important for the report):** no provider read so far has a clause that **allows** or **bans** hosting an intentionally vulnerable training app by name. The closest clauses ban malware, unauthorized access and platform interference. This means a free host could still suspend us after an abuse report. Safest reading: keep the vulnerable containers off other people's PaaS and on a machine we control, and ask the provider in writing before deploying (Railway explicitly invites this).

### 1.2 Three deployment topologies

| | T1: everything on one free cloud VM | T2: hybrid (dashboards, API, DB on cloud free tiers; user instances on our machine behind a tunnel) | T3: laptop only plus a minimal online page |
|---|---|---|---|
| What an examiner or user sees | One public URL set; everything works from anywhere; the whole stack is online 24/7 | Public dashboards and API (cloud); shop instances reached by public tunnel addresses, available only while the laptop is on | Live demo on the laptop, over localhost or a shared tunnel; online page shows project info, screenshots, maybe a read-only demo |
| Satisfies "online deployment is a must-have" | Fully | Mostly (instances need the laptop on) | Weakest; risks being judged as not online |
| Risk of exposing vulnerable containers to the internet | Highest: they sit on a public IP in a cloud account that can be suspended. Needs strict firewall, egress blocking, one VM per trust zone (RS-B) | Medium: only the proxy sidecar is reachable, through a tunnel, and the home network stays hidden. The laptop holds exploitable code, so it needs isolation (RS-B) | Lowest: no inbound exposure unless a quick tunnel is used for the demo |
| Capacity | 2 OCPU / 12 GB if Oracle gives it; else tiny | Laptop-limited (about 10 to 20 idle instances) | Laptop-limited |
| Free-tier fragility | Oracle capacity errors; idle reclaim; free-quota cuts (already cut once) | Free PaaS sleeps (Render) unless API runs on the VM | Minimal |
| Moving to a paid server | Configuration only: change the VM size or add VMs | Configuration only if the "instance host" is an address in config (host URL and credentials) and the tunnel is replaced by a public IP | Configuration only if the orchestrator is behind the same interface |

**Portability rule (all topologies):** the API must talk to an "instance host" through one stable interface (Docker Engine API over a secure channel, or an agent). Then "laptop", "Oracle VM" and "paid server" are only different configuration values. This must be fixed in the architecture, and is noted for RS-B and RS-D.

### 1.3 Capacity estimate (all numbers are estimates, not measurements)

**Assumptions for one per-user instance**
- Shop: Node.js/Express, one process. About 80 to 150 MB resident memory idle; up to 250 MB under load.
- Database container: if PostgreSQL, about 60 to 150 MB idle (default settings can grow). If MariaDB or SQLite-in-the-app, similar or lower.
- Sidecar (reverse proxy with request logging and optional ModSecurity + CRS in detect-only mode, per D-07): about 40 to 150 MB (CRS adds rules compiled into memory; **depends on the build, must be measured**).
- Total per instance: **about 250 to 500 MB memory, rule of thumb 400 MB**. CPU: **about 0.02 to 0.05 core idle; 0.3 to 1 core bursts** during scanner use (sqlmap, ffuf, Burp), which attackers will do.
- Container overheads: each container adds a few MB for the runtime and logs.

**Laptop (15.3 GB RAM)**
- Windows 11 and normal apps: 4 to 6 GB (only 2.7 GB was free at check time).
- Docker Desktop UI and the WSL2 utility VM overhead: about 0.5 to 1.5 GB (UNVERIFIED, estimate).
- A WSL limit of 6 to 8 GB is sensible (see 1.4). Usable for instances: about 5 to 7 GB.
- **Idle instances: about 10 to 20.** **Instances under active attack at the same time: about 4 to 8** (CPU bound on 6 cores / 12 threads, and memory bursts).
- Demo with one presenter: 1 to 3 instances. Comfortable.

**Best free VM (Oracle A1, 2 OCPU / 12 GB; also check 4/24 if still granted)**
- Leave about 2 GB for OS, Docker, API, Postgres, Redis. About 9 to 10 GB for instances.
- **Idle: about 20 to 30. Active attack: about 6 to 10** (2 OCPU is the limit; ARM64 images required, all images must be multi-arch).
- Other free VMs (GCP e2-micro, about 1 GB; Oracle AMD micro, 1 GB) fit only the API or nothing.

**Spikes to measure later (do not run now)**
1. Real RSS per container at idle and after 100 requests.
2. Sidecar memory with and without ModSecurity CRS.
3. Time to start a full instance (cold, image cached) and to create it after pulling images. This sets F1 "short bounded time".
4. CPU during sqlmap and directory brute-force scans against one instance.
5. Memory growth in the shop after seeding (marketplace data, bots running a headless browser for stored XSS; a Chromium bot can use 300 to 600 MB alone and is the biggest unknown).
6. WSL2 VM memory give-back after instances stop (`autoMemoryReclaim`).
7. Disk per instance and per image layer (shared layers help).
8. Oracle: time-to-first-capacity, and whether the 7-day idle rule would reclaim an idle demo VM.

### 1.4 Docker Desktop + WSL2 on Windows 11 Home (C: has 22 GB free)

Why this matters: WSL2 and Docker store disk images as `.vhdx` files, by default under the C: user profile, and they grow and do not shrink by themselves.

1. **Install WSL before Docker.** `wsl --install --no-distribution` (UNVERIFIED flag; check `wsl --help`). Docker Desktop makes its own `docker-desktop` distro, so an Ubuntu distro is optional.
2. **Move Docker's data.**
   - Option A: Docker Desktop GUI, Settings, Resources, Advanced, "Disk image location". **CONFLICTING:** Docker's official settings page lists the disk image setting only for Mac, Linux and Windows Hyper-V; community posts say it works with WSL2 and report hangs in some versions. Check what your installed version shows.
   - Option B: manual move of the Docker WSL distro with export and import: `wsl --export docker-desktop <tar>`, `wsl --unregister docker-desktop`, `wsl --import docker-desktop D:\wsl\docker-desktop <tar>` (community-sourced, UNVERIFIED; older docs used the name `docker-desktop-data`). Docker may recreate the default file on startup, so verify after a restart. `wsl --manage <distro> --move <path>` also exists in current WSL builds (UNVERIFIED this session; check `wsl --help`).
   - Option C (cleanest for new installs): set `distributionInstallPath` in `.wslconfig` before any distro is installed. Verified in Microsoft docs: default is `%LocalAppData%\wsl`.
3. **Limit resources** with `C:\Users\tanma\.wslconfig` (verified keys on Microsoft Learn, page updated 2026-09-16):
   ```
   [wsl2]
   memory=8GB          # default is 50% of RAM (7.65 GB here)
   processors=8        # default is all 12 logical
   swap=4GB            # default 25% of RAM
   defaultVhdSize=100GB   # only applies to new VHDs
   [experimental]
   autoMemoryReclaim=gradual   # default is dropCache
   sparseVhd=true             # new VHDs only
   [general]
   distributionInstallPath=D:\\wsl
   ```
   Then run `wsl --shutdown` and wait about 8 seconds. Docker's own docs say CPU, memory and swap for the WSL2 backend are set in `.wslconfig`, not in the Docker Desktop UI.
4. **Windows Home note:** Hyper-V tools such as `Optimize-VHD` are not on Home (community source), so shrinking a grown disk needs other methods. Prefer `defaultVhdSize` and `sparseVhd` up front, and `docker system prune` regularly.
5. **Docker Desktop licence** is a separate question (free for personal and small-business use; not researched here).

## 2. Options compared

| Option | Fit with our constraints | Free-tier / cost | Complexity | Main risks | Evidence |
|---|---|---|---|---|---|
| T1 One free cloud VM (Oracle A1) | Best for "online must-have"; one stable URL; same Docker setup as laptop | Free (card needed). 2 OCPU / 12 GB | Medium: firewall, TLS, ARM images | Capacity errors; idle reclaim; quota cut; public exposure of vulnerable code; account termination risk | Oracle docs (VERIFIED), InfoQ search result (UNVERIFIED) |
| T2 Hybrid: cloud dashboards/API/DB + laptop instances via tunnel | Satisfies online; hides laptop IP; uses laptop capacity; keeps vulnerable code off other people's PaaS | Free except a domain (needed for named tunnel; quick tunnels free) | Higher: two places to run things; tunnel setup | Demo depends on laptop on and tunnel stable; Cloudflare terms on proxying attack traffic not fully read | Cloudflare docs (VERIFIED), tunnel limits (UNVERIFIED) |
| T3 Laptop only + minimal online page | Safest and simplest; weakest on "online" | Free | Low | Examiners may reject as not deployed | n/a |
| Free PaaS for instances (Railway/Render/Koyeb) | Poor: 1-3 services, 0.1-1 vCPU | Free but tiny | High (workarounds) | Cannot hold per-user stacks; sleeps; ToS unclear | Vendor pages (VERIFIED) |
| Fly.io Machines for instances | Best technical fit for on-demand containers | **Not free** (card, about $2 to $7 per small machine per month) | Medium | Violates "free only" | Fly pricing (VERIFIED) |

## 3. Recommendation

**Primary: T2 as the target design, with T1 (Oracle) as the optional upgrade of the instance host, and T3 as the guaranteed fallback.** They are one architecture with different "instance host" settings.

- Dashboards: Vercel Hobby (or Cloudflare Pages). Free, non-commercial, fine for a college project (keep in mind "non-commercial" if the recruiter use is ever paid).
- Platform API (FastAPI + WebSockets): an always-on place that does not sleep. First choice: the same Oracle VM, if capacity is granted; otherwise the laptop during the demo. Do not use Render free for the API during the demo (15-minute sleep, 1-minute wake).
- Postgres: Neon free (1 GB, wakes from 5-minute suspend). Redis: Upstash free, or Redis in a container.
- User instances: Docker on the instance host (laptop now, Oracle VM or paid server later), reached through a Cloudflare Tunnel or similar, with an API-to-host interface that is only configuration.

**Provider shortlist:** (1) Oracle Always Free A1 (host), (2) Cloudflare Tunnel (reachability), (3) Vercel Hobby (dashboards), (4) Neon (Postgres), (5) Upstash (Redis). Backups to consider: GCP e2-micro or Supabase.

**This would be wrong if:**
- Oracle refuses capacity or the account is rejected, and we need a public host: then T2 relies fully on the laptop, which is fragile for a live demo with unknown Wi-Fi. A Cloudflare quick tunnel could also fail on the day; keep a localhost fallback.
- The examiners require instances to stay online without the laptop: only a paid host (Fly or a VPS) or Oracle would satisfy that.
- Cloudflare's service agreement or abuse team does not allow proxying attack traffic to deliberately vulnerable targets (not verified). Then a different tunnel (SSH reverse tunnel to a VPS, Tailscale Funnel, or a direct port) is needed.
- RS-B concludes that a shared host cannot be made safe for vulnerable containers.

## 4. Decision candidates for the user

1. **Which topology is the target design?** (a) T1 one cloud VM, (b) T2 hybrid, (c) T3 laptop plus minimal online page. Recommend **T2**, designed so T1 and T3 are only configuration. Reason: meets "online" and keeps vulnerable code on a machine we control.
2. **Where should the platform API run during the live demo?** (a) Oracle VM, (b) laptop, (c) free PaaS that sleeps. Recommend **(a) if capacity is granted, else (b)**. Reason: WebSockets and instance control need an always-on process.
3. **Will you create an Oracle Cloud Always Free account (card needed for verification)?** (a) yes, (b) no. Recommend **yes**, with a budget alert. Reason: the only free VM with real capacity; if refused, fall back to the laptop.
4. **How do user instances become reachable online?** (a) Cloudflare Tunnel with a domain you own, (b) Cloudflare quick tunnel, (c) direct public IP on the Oracle VM. Recommend **(a)**. Reason: no open ports on the laptop, stable names. Needs a domain (small cost, may break "free only", so decide).
5. **Dashboards host?** (a) Vercel Hobby, (b) Cloudflare Pages, (c) on the VM. Recommend **(a)**. Reason: simplest, free, supports Next.js.
6. **Postgres and Redis?** (a) Neon plus Upstash, (b) both self-hosted on the VM or laptop. Recommend **(b) for the demo if the API runs on the same machine, (a) otherwise**. Reason: fewer cold starts and no quotas.
7. **WSL memory cap for the laptop?** (a) 6 GB, (b) 8 GB, (c) default (7.65 GB). Recommend **(b) 8 GB with `autoMemoryReclaim=gradual`**. Reason: leaves about 7 GB for Windows and the browser.
8. **Where do WSL and Docker data live?** (a) D:, (b) C: (not enough room). Recommend **(a) D:**. Reason: 22 GB on C: will fill.
9. **Should we email providers (Oracle, Cloudflare, Vercel) to ask if hosting a deliberately vulnerable training platform is allowed?** (a) yes, (b) no. Recommend **(a)** for Oracle and Cloudflare. Reason: no ToS clause found either way; written permission is the only safe evidence (and good for the report).

## 5. Evidence

| URL | What it supports | Status |
|---|---|---|
| https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm | A1 limits (1,500 OCPU h, 9,000 GB h = 2 OCPU / 12 GB), idle reclaim rule (7 days, below 20% CPU p95, network, memory for A1) | VERIFIED |
| https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/ (from search result) | Reduction from 4/24 on 2026-06-15; uneven enforcement | UNVERIFIED (search snippet) |
| https://medium.com/@imvinojanv/setup-always-free-vps-with-4-ocpu-24gb-ram-and-200gb-storage-the-ultimate-oracle-cloud-guide-bed5cbf73d34 | Card needed; out-of-capacity advice | UNVERIFIED |
| https://docs.fly.io/about/pricing | Fly has no free tier; trial 2 h or 7 days; card needed; machine prices | VERIFIED |
| https://fly.io/legal/terms-of-service/ | Fly ToS clauses 1.4, 4.1(c); no security-testing clause | VERIFIED |
| https://render.com/docs/free | Render free limits (750 h, 15 min sleep, Postgres 30-day expiry, Key Value ephemeral) | VERIFIED |
| https://render.com/acceptable-use | Render AUP | Could not be read (not found) |
| https://railway.com/pricing | Railway Free / Trial limits; trial no card | VERIFIED |
| https://railway.com/legal/fair-use | Railway fair-use clauses; "ask us before deploying" | VERIFIED |
| https://www.koyeb.com/pricing | Free Postgres spec; no free compute listed on the page read | VERIFIED (partial) |
| Koyeb free instance details (search result, snapdeploy.dev, agentdeals.dev) | 512 MB / 0.1 vCPU, scale-to-zero, card conflict | CONFLICTING |
| https://vercel.com/docs/limits/fair-use-guidelines | Hobby non-commercial; Hobby usage allowances | VERIFIED |
| https://vercel.com/kb/guide/penetration-testing-on-vercel | Pentest not permitted for Hobby | VERIFIED |
| https://docs.cloud.google.com/free/docs/free-cloud-features | GCP e2-micro, Cloud Run free quota, card required, $300 for 90 days | VERIFIED |
| https://aws.amazon.com/free/ | AWS Free plan: $100 + $100, closes after 6 months | VERIFIED |
| https://azure.microsoft.com/en-us/pricing/free-services | Azure free account generalities; students no card | VERIFIED (partial) |
| https://developers.cloudflare.com/tunnel/setup/ | Tunnel needs a domain on Cloudflare to publish applications; quick tunnels temporary | VERIFIED |
| https://try.cloudflare.com/ | Quick tunnel: no account, ends with process, outbound-only | VERIFIED |
| https://www.cloudflare.com/website-terms/ | Website terms clauses (malware, unauthorized access); does not cover the Self-Serve agreement | VERIFIED (partial) |
| https://neon.com/docs/introduction/plans | Neon free limits, 5 min suspend | VERIFIED |
| https://supabase.com/docs/guides/platform/billing-on-supabase | Supabase free: 2 projects, 500 MB | VERIFIED |
| https://supabase.com/docs/guides/deployment/going-into-prod (as returned) | Low-activity projects may be paused after 7 days | VERIFIED (as quoted by fetch tool) |
| https://upstash.com/pricing/redis | Upstash free: 500K commands, 256 MB; database count conflicts | VERIFIED (partial), CONFLICTING on count |
| https://learn.microsoft.com/en-us/windows/wsl/wsl-config | `.wslconfig` keys, defaults, `distributionInstallPath`, `sparseVhd`, `autoMemoryReclaim` | VERIFIED |
| https://docs.docker.com/desktop/settings-and-maintenance/settings/ | WSL2 resource limits are set in `.wslconfig`; disk image location listed for non-WSL2 modes | VERIFIED |
| https://forums.docker.com/t/moving-wsl2-docker-engine-data-from-one-server-to-another/135698 and https://forums.docker.com/t/troubles-with-moving-docker-desktop-data-to-new-disk-in-version-4-46/149875 | Community moves of Docker WSL data; GUI move hangs reported | UNVERIFIED |
| Per-instance memory figures in section 1.3 | Engineering estimates | UNVERIFIED (must be measured) |

## 6. Open questions and spikes to run later

- Oracle: does a new account get 2/12 or 4/24, and is A1 capacity available in the chosen home region? Does an idle demo VM trip the reclaim rule (all three metrics below 20% over 7 days)? A light cron load would not be honest use; plan real traffic or accept the risk.
- Oracle, Render, Railway, Koyeb, Google, AWS, Azure: acceptable-use policies were not fully read (403 or 404 or not opened). Read them before committing.
- Cloudflare: Self-Serve Subscription Agreement and any quick-tunnel limits (in-flight requests, streaming) were not read. Test with real traffic, including WebSockets.
- Whether the college network blocks tunnels or outbound ports during the demo. Test on campus.
- Domain: do we have one? A named tunnel needs it.
- Spikes: items 1 to 8 in 1.3.
- Docker Desktop: verify which disk-move method works for the installed version before pulling images.
- The other two developers' PCs are unchecked (Q-24); the same `.wslconfig` advice may not fit.
- Whether "free tiers only" allows a small domain fee.
- ARM compatibility: every image (Node, Postgres, proxy, ModSecurity, headless browser) must have an ARM64 build for Oracle A1; check per image.

## 7. Impact on other streams

- **RS-B (isolation, orchestration):** the orchestrator must talk to the instance host through one stable interface (Docker Engine API or a small agent), because the host will move between laptop, Oracle VM and paid server. Egress blocking and one-network-per-instance matter more if instances run on a public VM. Per-instance memory budget (about 400 MB) limits how heavy the sidecar and bot may be.
- **RS-D (platform stack, contracts):** FastAPI with WebSockets must run on an always-on host; dashboards can be static or Next.js on Vercel. API URL, instance-host URL, DB URL and Redis URL must all be config values. Neon wakes from suspend, so the API needs retry on first connection.
- **RS-G (shop stack):** the Node/Express shop, its database and any headless-browser bot define capacity. Prefer a light database; the bot (Chromium) should be shared or started on demand rather than one per instance.
- **RS-H (privacy):** online data (candidate results) sits in Neon/Upstash, in US or EU regions, which affects the DPDP processor story; the vulnerable instances should hold no real personal data.
- **RS-C (scoring):** time-taken needs a clock that survives laptop sleep and tunnel drops; instance cold-start time (spike 3) should not count against the candidate.
