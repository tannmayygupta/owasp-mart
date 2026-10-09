# initial.md — Source of Truth (v0.2)

> **Project:** VulnMart — a Containerized, Flag-Based Vulnerable Web Application for OWASP Top 10 Training and Automated Penetration Testing Assessment
> **Also pitched as:** "OWASP Vulnerable Practice-and-Hiring Platform"
> **Created:** 2026-10-08 · **Last updated:** 2026-10-08
> **Status:** Draft. Only items in the Decision Log (Section 15) are locked. Everything marked OPEN is not decided.

---

## 0. How to read this file

| Tag | Meaning |
|---|---|
| **STATED** | Said directly in a source. `[S]` = `VulnMart_Synopsis.docx`, `[P]` = pasted proposal text. |
| **DECIDED** | The user decided it (with research behind it). Full detail and sources are in Section 15 under the D-number. |
| **OPEN** | Not decided or not in the sources. Needs a question or research. **Never assume it.** |
| **NOTE** | My analysis, not a source fact. |

**Where this file fits in the plan**

```
initial.md  ->  research & lock decisions  ->  PRD  ->  architecture  ->  split into 3 independent dev work-streams
 (we are here)
```

**Working rules (from the user)**
1. Do not lock things directly. Research first, then use an industry-ready, proven solution.
2. Ask clarifying questions. Never assume.
3. Explain in plain language, only what is necessary, concisely.

**Recommendation guidance (user, 2026-10-08):** recommend the best industry practice. Do **not** limit it to the deadline or the team size, because the whole team builds with Claude Code. See D-13.

---

## 1. Decisions at a glance

| ID | Decision (short) |
|---|---|
| D-01 | Flag capture = **both**: automatic detection first, plus paste-the-flag as backup. |
| D-02 | Flags are **unique per instance**. |
| D-03 | Platform roles: **Learner** (open signup), **Candidate** (invited by a recruiter), **Recruiter**, **Admin**. |
| D-04 | Recruiter onboarding = **self-signup + email verification + admin approval**. |
| D-05 | **One account per person**, with a **privacy wall** between practice and assessment data. |
| D-06 | Build for **OWASP Top 10:2025**; tag every challenge with **both 2021 and 2025** IDs; **11 challenges**. |
| D-07 | "Technique used" = **three layers**: fixed tags + automatic detection + evidence capture. |
| D-08 | **Hints:** free and step-by-step for learners, off by default for candidates, never below zero score. |
| D-09 | Target app = an **online shop** (VulnMart) with login, checkout, admin panel. |
| D-10 | The shop is a **marketplace**: customers, sellers, admin. |
| D-11 | **Six shop roles:** customer, seller owner, seller staff, support agent, finance, admin. |
| D-12 | Candidate privacy = **privacy by design** (consent screen, minimum data, auto-delete, audit log). |
| D-13 | **Schedule and scope:** submit in the first week of November 2026; **full end-to-end scope**; no feature cutting; build with Claude Code. |
| D-14 | **Repo and documentation rule:** dedicated **private** GitHub repo; every task documented by Claude Code (dev-log, decision records, changelog, traceability); enforced by `CLAUDE.md` + a commit hook; college report template pending. |
| D-15 | **Hosting:** dashboards on Vercel free tier; API and all user instances on an **Oracle Always Free VM**; the laptop is for development and a demo fallback. The user confirmed a card is available. |
| D-16 | **Web address:** free route first (free domain or free dynamic-DNS name, automatic HTTPS); if none, the Oracle VM's public IP with a Let's Encrypt **IP certificate**. Never plain HTTP. |
| D-17 | **Live updates:** **SSE**, with event IDs and replay, heartbeats, no proxy buffering, HTTP/2, and a polling fallback, so everything is live in real time. |
| D-18 | **Stored XSS:** C03 Injection has **two parts**, SQL injection and stored XSS seen by the support-agent bot; bot design rules from research. |
| D-19 | **Platform roles:** recruiters belong to a company; admin approves the company once and the owner approves colleagues; Recruiter and Admin are separate accounts from Learner and Candidate; mandatory authenticator-app login for Admin; admin reads candidate answers only through logged break-glass. |
| D-20 | **C11** = the seller verification (KYC) check **fails open** on malformed input and auto-approves the store (CWE-636). |
| D-21 | **Platform stack:** FastAPI, Next.js 16, PostgreSQL 18, Python 3.14, Node 24 LTS everywhere, Dramatiq, SQLAlchemy 2 + Alembic, session cookies + Argon2id, Valkey, ASVS 5.0 level 2 (level 3 for orchestrator and admin), Resend or Brevo for email. |
| D-22 | **Scoring and anti-cheat:** fixed points in three tiers, three automatic milestones per challenge, hint cost as a percentage, time shown not scored, no pause, decoys and limits and checks, no proctoring, human review of suspicious captures, 120-minute sessions. Numbers are placeholders. |
| D-23 | **Isolation and orchestration:** own FastAPI orchestrator on the Docker SDK; internal networks with no route out **plus a host-side rule blocking instance-to-host traffic**; hardened containers; Coraza + CRS v4.30.0 detect-only sidecar; HMAC flags; fixed timing defaults. |
| D-24 | **Shop:** Node 24 + Express, SQLite per instance, server-rendered pages, about 20 tables and 7 state machines, seller bears refunds, snapshot plus flag injector, neutral marketplace look. |
| D-26 | **Challenge catalogue:** the 11 challenges as designed in RS-E and RS-F (with D-18 and D-20), all independently solvable, sentinel flags, one mock-services container per instance. |
| D-27 | **Role rule (D-11):** a shop role "carries" a challenge if it is the attacker's role, the victim, the target, or used in the exploit. |
| D-28 | **Design traps:** (1) same-origin through a Vercel rewrite (BFF), dashboards-on-VM fallback; (2) two separate DuckDNS names, platform and labs, one wildcard certificate for instances; (3) two internal networks per instance with the edge proxy and event collector attached into them; (4) self-hosted PostgreSQL and Valkey on the VM, encrypted backups to Oracle storage, Arm images built on the VM. |
| D-29 | **Lifecycle:** **BMAD**. Each developer creates one story at a time from their own task list, implements it, reviews it, tests it and follows the BMAD cycle. (The user chose this over the lead's recommendation of Scrum-lite + GSD loop.) |
| D-30 | **Trackers:** one tracker per developer as markdown files in the repo (BMAD ticket tree under `docs/bmad/`), **updated automatically by a Claude rule and the commit gate** when a task completes; plus **one complete Excel workbook that people update manually** (no script, no sync). |
| D-31 | **Tooling:** BMAD agents and skills are **installed in the repo** (23 skills at pinned commit `bda3c59`, after a source review); record in `docs/bmad/INSTALL.md`. |
| D-32 | **Challenge-spec decisions DC-1 to DC-15:** all agent-recommended options accepted (C03 scores by milestones across two parts and is rated 3; support bot limited to tickets and its profile; C04 via a separate quick-refund path; C10 starts as a seeded approved seller; C09 proof from shop-sent events; tiers 1-2 Easy, 3 Medium, 4-5 Hard). Detailed design: `docs/design/challenge-specs.md`. |
| D-33 | **Work split:** three streams by contract boundary: **P** platform and dashboards, **L** lab and assessment engine, **T** target shop and challenges. **Tanmay = L, Akshay = P, Sahil = T.** Ten written contracts, mocks, sprint zero, deadlock rules (`docs/architecture/07-repo-and-workstreams.md`). |
| D-34 | **Two Oracle VMs:** VM-P (platform, database, personal data) and VM-I (orchestrator, edge, hostile instances), 1 CPU and 6 GB each. **Amends D-15** ("an Oracle VM"). |
| D-35 | **Four refinements:** per-attempt encryption key (amends D-25); ASVS level 3 also for the key service and audit log (extends D-21); "never plain HTTP" applies to public addresses only, loopback allowed for dev and laptop (reading of D-16); the C03 read-only catalogue is a second read-only SQLite file, not a container. |
| D-25 | **Privacy defaults:** 180-day candidate retention (30 to 365), learner data 12 months after last login, 18+ only, 12-month pseudonymised audit log, JSON + CSV export, 14-day backups with key shredding, 7-day undo on withdrawal, guide or legal cell reviews once. D-12 gets a clarification note. |

**Constraints confirmed by the user (not research decisions)** — details in Section 11: 3 developers; deliverables = live demo + report + GitHub link; demo on the user's PC; online deployment is a must-have; free tiers only; architecture must scale later with no redesign; guide approved VulnMart.

---

## 2. The project in one paragraph

A deliberately vulnerable web app that looks like a real product (an online marketplace with login, checkout, seller and admin areas) and contains **11 vulnerability challenges** covering all OWASP Top 10 categories of both the 2021 and 2025 editions. Each user gets their **own private Docker copy** to attack freely. Unique hidden **flags** prove a successful hack, and a scoring engine detects this **automatically** (with paste-the-flag as backup). Results appear on two dashboards: a **learner** view (hints, progress) and a **recruiter** view (score, time taken, technique used, evidence). One platform serves two purposes: **practice for students** and a **ready-made technical hiring round** for interns and freshers. `[S][P]`, updated by D-06, D-09, D-10.

---

## 3. Problem (STATED)

- **Hiring side:** Companies can't verify real pentesting skill. Whiteboard questions test *describing* an attack. Certificates prove *studying a syllabus*. Neither proves the candidate can *find and exploit* a bug in a running app. `[S][P]`
- **Student side:** DVWA and WebGoat feel outdated and show each bug in isolation, like a checklist, in an interface that looks nothing like a real product. Practice there only partly transfers to real apps, where bugs must be *discovered*, not *selected from a menu*. `[S][P]`
- **Need:** One app that gives learners a realistic practice space **and** gives recruiters a standard, objective score. `[S]`

---

## 4. Objectives (from `[S]`, with amendments)

| ID | Objective |
|---|---|
| O1 | Build a web app vulnerable across **all OWASP Top 10 categories**, resembling a realistic product (working login, checkout flow, admin panel), not a bare bug list. *Amended: the synopsis said "all ten OWASP (2021) categories". Per D-06 it is now the 2025 edition with 2021 tags, 11 challenges. Per D-10 the product is a marketplace.* |
| O2 | Give each user an **isolated, containerized instance** (Docker) so exploits never affect another user's environment or results. |
| O3 | Embed a **unique flag in each vulnerability** and build an **automated detection and scoring engine** that confirms exploitation with no manual review. *(See D-01, D-02.)* |
| O4 | Produce **two role-based views** of the same results: learner (hints, progress) and recruiter (score, time taken, technique used). |
| O5 | The **same platform, unmodified**, works for self-paced learning and as a hiring assessment round. |
| O6 | Design the architecture so it can **later extend** to API security testing, mobile-app vulnerabilities, and a hosted multi-tenant SaaS. |

---

## 5. Platform roles (D-03, D-04, D-05)

These are the people who use **VulnMart the platform**. (The shop's own fictional users are in Section 6.)

| Role | How they get in | What they do | Status |
|---|---|---|---|
| **Learner** | Open signup, anyone can register | Practice on their own instance. Sees hints, progress, captured flags. `[S]` | DECIDED |
| **Candidate** | Invited by a recruiter | Takes the recruiter's assessment in a separate instance. Sees own results. Can be the same person as a learner (one account, privacy wall). | DECIDED |
| **Recruiter** | Self-signup with a work email, verifies the email, stays "pending" until an admin approves | Invites candidates. Sees per-candidate score, time per challenge, technique, evidence, hints used. `[S]` | DECIDED |
| **Admin** | Added by the user (not in the synopsis) | Approves recruiters and more. Full feature list **OPEN** (R-01). | Role DECIDED, features OPEN |

**Rule from the user:** research and define every role's features completely so the application is mature. The full permission matrix is research item **R-01**.
**NOTE (suggested, not decided):** keep Recruiter and Admin as separate accounts from normal user accounts. Settle in R-01.

---

## 6. The shop (target app) — theme and roles (D-09, D-10, D-11)

The shop is the app that players attack. Its users are **fictional users inside the app**, separate from the platform roles above.

- **Theme:** online shop **"VulnMart"**, a marketplace, with a working login, checkout flow, and admin panel (and seller areas).
- **Six shop roles:**

| Shop role | Job |
|---|---|
| Customer | Browse, buy, review, request refunds |
| Seller (owner) | Runs a store, lists products, sees payouts; starts "pending" until approved |
| Seller staff | Limited help inside one store |
| Support agent | Handles disputes and reported content; also does moderation; acts as a simulated victim (bot) that views user-written content |
| Finance | Scoped to commissions and payouts |
| Admin | Approves sellers and products, runs the shop |

- **Rule:** every shop role must carry at least one challenge, or it is dropped.
- **Link to the synopsis:** stored-XSS success is confirmed "inside another simulated user's session", so the shop needs simulated users (bots).
- **OPEN:** exact permissions per role, how the bots behave, refund mechanics (research gap), which challenge each role carries.

---

## 7. Scope

### 7.1 In scope (STATED, updated)
- The vulnerable shop (marketplace with login, checkout, seller and admin areas) with 11 challenges tagged with OWASP 2025 and 2021. `[S]` + D-06, D-09, D-10
- Per-user Docker isolation and automatic teardown/reset. `[S]`
- Flag detection and scoring backend. `[S]`
- Learner dashboard and recruiter dashboard. `[S]`
- Logging of every attempt and flag capture. `[S]`
- Recruiter approval, candidate invites, consent screen, auto-delete, audit log. (D-04, D-12)
- **Full scope, no cutting** (D-13).

### 7.2 Future scope — **not built now**, but architecture must not block it (STATED)
- OWASP **API Security** Top 10 coverage
- OWASP **Mobile** Top 10 coverage
- **Hosted multi-tenant SaaS** so companies run assessments without hosting anything `[S]`

---

## 8. How it works (STATED, plain language, from `[S]` "Methodology")

1. A user signs up / starts a session -> the platform spins up **their own set of Docker containers**.
2. The user attacks that private copy. Any damage (e.g. SQL injection, stored XSS) stays inside **their copy only**.
3. Each vulnerability hides a **unique flag** at the spot where it should be exploited. Examples given: a value shown only after an auth check is bypassed; a payload confirmed to have run inside **another simulated user's session**.
4. A **monitoring component** attached to each instance watches for flags being retrieved, or for state changes typical of a vulnerability class, and **records the result automatically**.
5. Results from all instances go into **one data model**, shown through the **two dashboards**.
6. The instance is **destroyed after the session ends or after inactivity**.

*Additions by decision:* the user can also paste the flag (D-01); flags are generated fresh per instance (D-02); the monitor also classifies the technique and stores the capturing request as evidence (D-07).

---

## 9. Functional requirements (from `[S]`, IDs added for traceability)

| ID | The system shall… | Amended by |
|---|---|---|
| F1 | Provision a new isolated Docker-based instance per user within a **short, bounded time** of registration or session start. | Numbers OPEN |
| F2 | Implement **all OWASP Top 10 categories** as **11 challenges tagged with OWASP 2025 and 2021**, each **fully exploitable end-to-end** in the deployed instance. *(Synopsis: "all ten OWASP (2021) categories".)* | D-06 |
| F3 | Embed a **unique flag per vulnerability, unique per instance**, and detect exploitation **automatically**, plus accept pasted flags. | D-01, D-02 |
| F4 | Provide a **learner dashboard**: per-vulnerability hints (free, three levels), live progress, captured flags, solution write-up after solving. | D-08 |
| F5 | Provide a separate **recruiter dashboard**: per candidate — total score, time per challenge, technique/category, tags, evidence, hints used (if enabled). | D-07, D-08 |
| F6 | **Tear down or reset** an instance after a **configurable inactivity period**. | Value OPEN |
| F7 | **Log every attempt and flag capture**; one user can **never see another user's** flags, progress, or score. | D-05 |
| F8 | Support **multiple concurrent isolated instances on a single host** with no manual provisioning or cleanup. | Numbers OPEN |
| F9 *(new)* | Recruiter signup with email verification and admin approval; candidate invites. | D-03, D-04 |
| F10 *(new)* | Candidate consent screen, configurable retention with auto-delete, candidate result export, audit log of who viewed candidate data. | D-12 |
| F11 *(new)* | Hints configurable per assessment by the recruiter (off by default); scores never below zero. | D-08 |

---

## 10. Technology stack (STATED in `[S]` — **not locked**; each item to be researched before locking)

| Layer | Stated choice | Role | Lock status |
|---|---|---|---|
| Backend | FastAPI (Python) | Orchestration API, scoring engine, dashboard backend | Unlocked |
| Containers | Docker | One isolated instance per user | Unlocked |
| Vulnerable app | Node.js/Express **"or an equivalent stack"** | The marketplace with embedded bugs | Unlocked (stack not even fixed) |
| Frontend | React / Next.js | Learner and recruiter dashboards | Unlocked |
| Database | PostgreSQL | Users, flags, attempts, scores | Unlocked |
| Cache / session | Redis | Active-container tracking, sessions, rate limiting | Unlocked |
| Real-time | WebSockets | Live progress/score pushes to dashboards | Unlocked |
| CI/CD | GitHub Actions | Build/deploy platform services and vulnerable-app images | Unlocked |
| Attack classifier | OWASP ModSecurity Core Rule Set (detect-only), planned in D-07 | Labels the attack type per request | Planned; tag names unverified |

---

## 11. Challenges to build: 11 themes, each tagged with BOTH OWASP editions (D-06)

The specific vulnerability, module, flag, and scoring rule for each is **OPEN**. Initial placement ideas are in D-09 (ideas only).

| # | Challenge theme | 2021 tag | 2025 tag | Concrete vuln in VulnMart | Module | Flag/score rule |
|---|---|---|---|---|---|---|
| 1 | Broken Access Control | A01 | A01 | OPEN | OPEN | OPEN |
| 2 | Cryptographic Failures | A02 | A04 | OPEN | OPEN | OPEN |
| 3 | Injection | A03 | A05 | OPEN | OPEN | OPEN |
| 4 | Insecure Design | A04 | A06 | OPEN | OPEN | OPEN |
| 5 | Security Misconfiguration | A05 | A02 | OPEN | OPEN | OPEN |
| 6 | Vulnerable/Outdated Components (2021) = Software Supply Chain Failures (2025) | A06 | A03 | OPEN | OPEN | OPEN |
| 7 | Authentication Failures | A07 | A07 | OPEN | OPEN | OPEN |
| 8 | Software or Data Integrity Failures | A08 | A08 | OPEN | OPEN | OPEN |
| 9 | Security Logging Failures (2025 name: Logging and **Alerting**) | A09 | A09 | OPEN | OPEN | OPEN |
| 10 | Server-Side Request Forgery (SSRF), kept as its own challenge | A10 | A01 (folded into Broken Access Control) | OPEN | OPEN | OPEN |
| 11 | Mishandling of Exceptional Conditions (new in 2025) | none (new) | A10 | OPEN | OPEN | OPEN |

Each challenge will also carry **CWE** and **MITRE ATT&CK** IDs (D-07), values OPEN.

**Caveats:** the 2025 list was confirmed from official OWASP pages for A07 and A08 and from secondary sources (GitLab, Fastly) for the rest. Re-verify the full list against [owasp.org/Top10/2025](https://owasp.org/Top10/2025/) before the PRD. Row 6 is broader in 2025 than in 2021, so its exact scope is a research item.

---

## 12. Project facts and constraints

**From the synopsis `[S]`**
- **Institution:** Shri Ramdeobaba College of Engineering & Management, Nagpur — B.Tech CSE (Cyber Security)
- **Guide:** Dr. R. Welekar
- **Synopsis date:** September 2026
- **Authors listed (5):** Aarya Bhangadia (Roll 1), Akshay Gupta (Roll 7), Paras Sharma (Roll 66), Sahil Roy (Roll 50), Tanmay Gupta (Roll 59)

**Confirmed by the user (2026-10-08)**
- **Developers (3):** Tanmay Gupta, Akshay Gupta, Sahil Roy. They do all development.
- **Non-developing authors (2):** Aarya Bhangadia, Paras Sharma. Any role for them (report, testing, pilot participants) is **OPEN**.
- **Direction:** VulnMart (option 3 of the pitch `[P]`) is **approved by the guide**.
- **Guide to be informed (user action, date OPEN)** of changes since the synopsis: OWASP 2025 edition with dual tags (D-06), marketplace with six shop roles (D-10, D-11), admin role and recruiter approval (D-03, D-04).
- **Submission:** first week of November 2026; **exact date not given**; no interim review dates mentioned. See D-13.
- **Deliverables:** live demo + report + GitHub link to the codebase. Who writes the report is **OPEN**.
- **Online deployment: MUST-HAVE.** Platform **OPEN** (Vercel, Railway, other; to be researched).
- **Hosting budget: free tiers only.** Free-tier limits are a research item.
- **Architecture rule:** run within free-tier limits now; moving to a paid server later must need **no architecture change**.
- **Demo:** one presenter (the user) in front of examiners. **Design goal:** many concurrent users and heavy load.
- **Build method:** the whole team builds end to end with Claude Code.
- **Repository (checked 2026-10-08):** `major-project` used to sit inside the home-folder git repo (`C:/Users/tanma`), whose remote is an unrelated project (`rbufullstack-1`). It now has its **own repo** (`main`), remote = **`git@github-personal:tannmayygupta/owasp-mart.git`** (private, personal GitHub account, SSH). See D-14.
- **College report template:** exists; **the user will share it later** (Q-26). Until then `docs/report/README.md` holds a provisional mapping.

**Demo machine (checked 2026-10-08):** the user's own PC, which is also the dev machine here.
- HP Victus 15-fb0xxx, Windows 11 Home; AMD Ryzen 5 5600H (6 cores / 12 threads); **15.3 GB RAM** (only ~2.7 GB free at check time); virtualization enabled in firmware.
- Disks: **C: 21.7 GB free of 231 GB** (tight); **D: 219 GB free of 244 GB**.
- Installed: Docker 29.6.2, Node 24.11.0, Python 3.12.4, Git 2.45.2.
- **Docker is installed but NOT running**, and **WSL shows no usable setup** (`wsl --list` fails). Docker Desktop on Windows Home needs WSL2, so this is a setup task. Not yet fixed.
- **NOTE:** Docker stores images on C: by default and C: has little free space. The other 2 developers' machines are **unchecked**.

---

## 13. Plan of work and evaluation (STATED, from `[S]`)

| Phase | What happens |
|---|---|
| 1. Requirement analysis | Study OWASP Top 10; review DVWA, WebGoat, PortSwigger Web Security Academy to find gaps; define vulnerabilities, flags, scoring rules. *(Edition now 2025 with 2021 tags, D-06.)* |
| 2. System design | Architecture: vulnerable app, per-user container model, flag/scoring engine, two dashboards. |
| 3. Development | Vulnerable app, Docker isolation layer, scoring backend, both dashboards. |
| 4. Testing & validation | Prove every vuln is exploitable and scoring is accurate/consistent; pilot with students; mock hiring round "where feasible". |
| 5. Evaluation | Measure against: **completion rate**, **time per vulnerability**, **accuracy of automated scoring**. |

**NOTE:** The synopsis gives no dates or durations for these phases.

---

## 14. Open items

### 14.1 Open questions
| ID | Question | Why it matters |
|---|---|---|
| Q-02 | **Exact submission date** (user said "first week of November"). Any interim review dates were not mentioned. | Sets the calendar for planning. |
| Q-13 | Is a **load test** required in the report? (Capacity itself is answered: whatever the free tier supports, with a scalable design.) | Decides whether we build load-test tooling. |
| ~~Q-19~~ | ~~Default retention period for candidate data.~~ **ANSWERED (user, 2026-10-08):** 180 days, recruiter range 30 to 365. See D-25. The one-year log rule is handled by the 12-month audit log. | |
| Q-21 | **Who writes the report**, and what do the 2 non-developing authors do (docs, testing, pilot users)? | Decides report ownership and pilot participants. |
| Q-22 | **Pilot and mock hiring round:** who are the participants (the synopsis says "where feasible")? | Phase 4 and 5 depend on people. |
| Q-23 | Is **"VulnMart"** the final product name? (The pitch used "OWASP Vulnerable Practice-and-Hiring Platform"; the GitHub repo is named `owasp-mart`.) | Naming across code, docs, report. |
| Q-24 | **PARTLY ANSWERED (user, 2026-10-08):** Tanmay = Windows 11; **Sahil = Windows**; **Akshay = macOS**. **Akshay's Mac is an Intel Mac (user, 2026-10-08), so all three developer machines are amd64.** **Akshay's Mac has 16 GB RAM, and Docker is installed on both Akshay's and Sahil's machines (user, 2026-10-08).** **Sahil has an Intel HP Victus, 16 GB RAM, Windows 11 (user, 2026-10-08).** **Still open:** macOS version, the exact Intel model on Sahil's laptop, and whether Docker actually runs on their machines (on Tanmay's PC it is installed but not running and WSL is not set up). | Dev environment must work for all three. Mixed OS (two Windows, one macOS) means scripts must be cross-platform. The only Arm machine is the **Oracle free VM (Ampere A1, arm64)**, so container images must be built for **both amd64 (developer machines) and arm64 (Oracle VM)**. |
| Q-25 | **When** will the guide be informed of the scope changes? | The synopsis was approved as written. |
| Q-26 | The **college report template**: the user will share it. Then map `docs/report/README.md` to its chapters. | The documentation structure should match the report. |
| ~~Q-27~~ | ~~GitHub repo name and approval to create and push.~~ **ANSWERED (user, 2026-10-08):** the user created the private repo **`tannmayygupta/owasp-mart`** on the **personal** GitHub account and asked for **SSH** (personal key, not the work one). First commit pushed. See D-14. | Repo creation and pushing publish content to an external service. |
| Q-28 | **PARTLY DONE (2026-10-08):** live check 1 showed the git backstop works, but the Claude Code hook never fired (matcher was `Bash`; Windows uses the `PowerShell` tool). Fixed to `Bash|PowerShell`. **Still open:** a second live check after another restart (`/hooks`, then a code commit without docs; expect the whole command to be denied). | The Claude Code layer is only verified with simulated input. |
| ~~Q-29~~ | ~~Does the user have a card Oracle will accept?~~ **ANSWERED (user, 2026-10-08): yes.** D-15 is final. | |
| Q-32 | **Which developer owns the Oracle account** (the card holder), how do the other two get access (OCI users, SSH keys), who sets the budget alert and who keeps the VM active so it is not reclaimed after 7 idle days? Also send the terms-of-service email to Oracle. | Account ownership and access are single points of failure. |
| Q-30 | **User action:** apply for the GitHub Student Developer Pack (college email) to see whether a free domain is available. Then verify what it really offers. | D-16 prefers a free domain. |
| Q-31 | **Spikes before relying on D-15 to D-18:** (a) real Let's Encrypt certificate for the Oracle VM (domain, sslip.io, IP), (b) SSE through the real path with heartbeat and replay, (c) headless-browser memory per instance, (d) the combined per-instance memory estimate, (e) host-access blocking on Docker Desktop and on the Oracle VM, including the host-side drop rule from D-23, (f) Coraza sidecar form (Caddy plugin versus a small Go program), (g) gVisor and rootless on WSL2 and the Arm VM. | Moves the estimates from UNVERIFIED to measured. |

### 14.2 Gaps and tensions (NOTE — my analysis)
1. **Two names for one idea:** "VulnMart" `[S]` vs "OWASP Vulnerable Practice-and-Hiring Platform" `[P]` (Q-23).
2. **"Time taken per vulnerability" is undefined:** start and stop moments are not defined (R-11).
3. **No scoring rules:** points per challenge and difficulty weighting are not specified. Hint rules are decided (D-08).
4. **No numbers anywhere:** "short bounded time", "multiple concurrent instances", "configurable inactivity period" have no target values (R-12).
5. **Safety of hosting vulnerable code:** isolation is promised, but nothing says how to stop an exploit (especially SSRF or a container escape) from reaching the host, other users, or the internet (R-03).
6. **Hiring-use integrity:** unique per-instance flags are decided (D-02). Still open: candidate identity checks and other cheating. *Idea from research:* TryHackMe withholds points if there was no real activity on the target machine.
7. **The platform's own security:** the platform (API, dashboards, orchestrator) must itself be secure while it manages intentionally vulnerable containers (R-14).
8. **Hosting fit is unverified:** the idea needs to start and stop a separate container per user. Platforms like Vercel (built for websites/serverless) and Railway (always-on services) may not support creating containers on demand. Research which parts can go on such platforms and which must stay on a machine we control (R-02).
9. **Free budget vs. high load:** free tiers have small limits and may sleep when idle. We separate *designing* for scale from *proving* it (answered in principle: free-tier capacity now, scalable design later).
10. **Time vs. scope risk:** about 4 weeks to submission for a large scope. The user has **accepted this and asked for no feature cutting** (D-13). Kept here so the risk stays visible.
11. **Pilot depends on people:** none identified (Q-22).

Resolved gaps: team size (3 developers), OWASP edition (D-06), flag capture (D-01), unique flags (D-02), technique used (D-07), product theme (D-09), candidate data privacy (D-12), hints (D-08).

### 14.3 Answered questions (index)
| ID | Question | Answer | See |
|---|---|---|---|
| Q-01 | Who are the 3 developers? | Tanmay, Akshay, Sahil | Section 12 |
| Q-02a | Deadline and deliverables? | First week of November 2026; live demo + report + GitHub link | D-13 |
| Q-03 | Where does it run, budget, demo load? | User's PC; online deployment must; free tiers only; one presenter | Section 12 |
| Q-04 | User submits flags or automatic? | Both | D-01 |
| Q-05 | Candidate vs learner; who creates accounts; admin? | Learner open signup; candidate invited; admin included | D-03 |
| Q-06 | Same or per-instance flags? | Unique per instance | D-02 |
| Q-07 | How is "technique used" determined? | Three layers | D-07 |
| Q-08 | Hints and points? | Free for learners; off for candidates by default | D-08 |
| Q-09 | OWASP edition? | 2025 with 2021 tags | D-06 |
| Q-10 | Product theme? | Online shop | D-09 |
| Q-11 | Guide approval? | Approved | Section 12 |
| Q-12 | Candidate privacy? | Privacy by design | D-12 |
| Q-13a | How much load? | Free-tier capacity; architecture scales later without redesign | Section 12 |
| Q-14 | Recruiter account creation? | Self-signup + admin approval | D-04 |
| Q-15 | Feature ranking (must-have vs stretch)? | No ranking; full scope | D-13 |
| Q-16 | One account for learner and candidate? | Yes, with a privacy wall | D-05 |
| Q-17 | Seller side? | Yes, marketplace | D-10 |
| Q-18 | Extra shop roles? | All six | D-11 |
| Q-20 | Does the guide know about the changes? | Not yet; the user will inform | Section 12, Q-25 |

---

## 15. Decision log (all research and sources)

### D-01 — Flag capture = BOTH
(a) The monitor detects flag retrieval automatically and credits instantly with a live dashboard update. (b) The user can also paste the flag as a backup/verification. **Decided by user 2026-10-08.**
- **Alternatives researched:** auto-only (PortSwigger-style); paste-only (HTB, CTFd-style).
- **Evidence:** [PortSwigger forum](https://forum.portswigger.net/thread/solved-labs-in-the-academy-are-not-shown-as-solved-f363d1c0), [HTB forum](https://forum.hackthebox.com/t/how-to-send-flags/524), [CTFd flags docs](https://docs.ctfd.io/docs/challenges/flags). Notes: HTB machine flags are dynamic (change per reset); unique per-team flags + submission logging + decoy flags caught flag-sharing at GPN CTF 2025 ([GZCTF](https://www.mintlify.com/GZTimeWalker/GZCTF/concepts/challenges), [rCTF](https://rctf.osec.io/providers/flags), [paper](https://ejurnal.methodist.ac.id/index.php/methomika/article/view/5759)).
- **Caveats:** PortSwigger's detection mechanism was **not confirmed** by the search. If build order ever matters, paste-only is the simpler first layer.

### D-02 — Flags are unique per instance
Generated fresh when each user's instance starts. **Decided by user 2026-10-08.** Evidence: same research as D-01 (HTB dynamic flags; GZCTF/rCTF per-team flags). Open detail for architecture: how flags are generated and stored (R-04).

### D-03 — Four platform roles
(1) **Learner** — open signup. (2) **Candidate** — invited by a recruiter. (3) **Recruiter** — invites candidates, sees their results. (4) **Admin** — added by the user. **Decided by user 2026-10-08.** Detailed features and permissions per role are **not decided**; they come from R-01.

### D-04 — Recruiter onboarding = self-signup, then admin approval
Flow: sign up with a work email (disposable addresses blocked; free-email handling decided in R-01) -> verify the email -> account stays "pending" -> an admin approves -> only then can the recruiter invite candidates. **Decided by user 2026-10-08.**
- **Alternatives researched:** open signup; admin-created accounts (Hack The Box style, sales-led).
- **Evidence:** [HTB enterprise registration](https://help.hackthebox.com/en/articles/5594203-enterprise-account-registration), [HackerEarth admin signup](https://help.hackerearth.com/hc/en-us/articles/360003089273-Becoming-an-admin), [Stytch on B2B email verification](https://stytch.com/blog/why-email-verification-is-crucial-for-b2b-apps/), [Vortex on domain joining](https://blog.vortexsoftware.com/domain-joining-that-drives-company-wide-saas-adoption).
- **Caveats:** sources are mostly vendor blogs; HackerRank and CodeSignal employer flows were not found; the "admin approves a domain-match request" step is partly inference.

### D-05 — One account per person, with a privacy wall
A learner who receives a recruiter invite gains the Candidate role on the same login. The recruiter sees only the results of the invited assessment, never the person's private practice history. The assessment runs as its own separate attempt and instance. **Decided by user 2026-10-08.**
- **Alternative researched:** separate accounts.
- **Evidence:** [HTB Account](https://www.hackthebox.com/blog/introducing-HTB-Account), [HTB linking guidance](https://enterprise-help.hackthebox.com/en/articles/14343451-linking-enterprise-to-htb-account), [HackerRank privacy policy](https://www.hackerrank.com/about-us/privacy), [Oso RBAC](https://www-webflow.osohq.com/learn/rbac-best-practices), [WorkOS RBAC](https://workos.com/blog/rbac-best-practices).
- **Caveat:** HackerRank's invite-link account behavior was not confirmed.

### D-06 — OWASP edition: build for 2025, dual-tag with 2021, 11 challenges
Section 11 has the table. **Decided by user 2026-10-08.**
- **Alternatives researched:** 2021 only (matches synopsis, most learning material); 2025 only.
- **Evidence:** [OWASP Top 10:2025](https://owasp.org/Top10/2025/), [A07](https://owasp.org/Top10/2025/A07_2025-Authentication_Failures/), [A08](https://top10.owasp.org/2025/A08_2025-Software_or_Data_Integrity_Failures/), [GitLab](https://about.gitlab.com/blog/2025-owasp-top-10-whats-changed-and-why-it-matters/), [Fastly](https://www.fastly.com/blog/new-2025-owasp-top-10-list-what-changed-what-you-need-to-know).
- **Consequence:** O1 and F2 are reworded (Sections 4 and 9). Dashboards show both tags per challenge. The guide must be told (Q-25).

### D-07 — "Technique used" = three layers
(1) **Fixed tags** on every challenge: OWASP 2021 + 2025 (D-06), plus CWE and MITRE ATT&CK IDs. (2) **Automatic technique detection** inside each instance, planned with the OWASP ModSecurity Core Rule Set in detect-only mode as the classifier. (3) **Evidence capture:** the exact request that captured each flag is stored for the recruiter to verify; optional short write-up per solved challenge. **Decided by user 2026-10-08.**
- **Alternatives researched:** category only; technique tagging only.
- **Evidence:** [OWASP CRS guide](https://owasp.org/www-project-developer-guide/draft/operations/modsecurity_core_rule_set), [HTB candidate assessment](https://help.hackthebox.com/en/articles/12928718-candidate-assessment-management), [Immersive Labs screening](https://immersivelabs.com/platform/candidate-screening), [Immersive Labs ATT&CK mapping](https://www.immersivelabs.com/wp-content/uploads/2020/07/immersive-labs-aligning-cyber-skills-to-mitre-attck-framework-1.pdf), [RangeForce Talent](https://rangeforce.com/blog/introducing-rangeforce-talent).
- **Caveats:** no sample recruiter report found from any vendor; sources are mostly vendor marketing; the CRS tag names (e.g. `attack-sqli`) are unverified and must be checked in the rule files; auto-classification can be wrong, which is why raw evidence is stored.
- **Open details:** the CWE/ATT&CK IDs per challenge; whether the write-up is optional or required.

### D-08 — Hints
(1) **Learner mode:** free, three-level hints (nudge, direction, near-solution); no hint ever reveals the flag itself; hint use is recorded but never penalized; optional "no hints" badge. (2) After a learner solves a challenge, the full solution write-up is shown. (3) **Candidate (hiring) mode:** hints OFF by default; the recruiter configures per assessment: off, or on with a point cost; if on, the recruiter sees hints used. (4) **Scores never go below zero.** **Decided by user 2026-10-08.**
- **Alternatives researched:** points-cost hints everywhere; free hints everywhere.
- **Evidence:** [CTFd hints docs](https://docs.ctfd.io/docs/challenges/hints), [K-12 CTF framework](https://arxiv.org/html/2602.16921v1), [cyber range lessons](https://link.springer.com/article/10.1007/s10758-025-09840-y), [Georgia Tech CTF rules](https://tc.gtisc.gatech.edu/cs6265/2025-summer/rules.html), [PatriotCTF 2023](https://jax.dev/blog/patriotctf-2023-introspective).
- **Caveats:** no controlled study compares hint policies; no hiring platform was found that documents hint settings, so the recruiter-configurable setting is our own design; the solution write-up after solving is a team suggestion inspired by PortSwigger.
- **Open details:** hint text per challenge; whether the solution write-up appears in hiring mode (likely hidden until the assessment ends).

### D-09 — Target app theme = online shop
"VulnMart" with a working login, checkout flow, and admin panel (as in the synopsis). **Decided by user 2026-10-08.**
- **Alternatives researched:** banking app (vuln-bank, Damn Vulnerable Bank), vehicle/API platform (crAPI); no healthcare app found.
- **Evidence:** [Juice Shop challenges](https://help.owasp-juice.shop/part1/challenges.html), [OWASP VWAD: OopsSec Store](https://vwad.owasp.org/app/oopssec-store/), [OWASP VWAD](https://owasp.org/www-project-vulnerable-web-applications-directory), [MindFort test targets](https://docs.mindfort.ai/guides/test-targets), [Intigriti price manipulation](https://www.intigriti.com/blog/news/top-5-price-manipulation-vulnerabilities-ecommerce), [OpenStack SSRF advisory](https://security.openstack.org/ossa/OSSA-2026-004.html).
- **Caveats:** the SSRF-via-image-import idea is an inference (real cases found were in other software); several logic-flaw sources were weak (AI skill registries).
- **Initial placement ideas, NOT decided** (to be researched in challenge design): Access Control = other customers' orders and admin pages; Crypto = weak password/card data handling; Injection = search (SQLi) and reviews (XSS); Insecure Design = coupon stacking, negative quantity, trusted price; Misconfiguration = exposed debug/admin, default creds; Supply Chain = known-vulnerable library; Authentication = weak reset, no login rate limit; Integrity = unsafe cart/session deserialization, untrusted script; Logging = admin actions/failed logins not logged; SSRF = "import product image from URL"; Exceptional Conditions = checkout fails open when payment errors.
- **Differentiator vs Juice Shop:** per-user instances, unique flags, recruiter scoring.

### D-10 — The shop is a marketplace
Three core shop-user types: **Customer, Seller, Admin** (fictional users *inside the target app*, separate from the platform roles in D-03). User said 2026-10-08: "Customers plus admin only + add sellers"; read as all three; confirmed when the user chose the recommended role set (D-11).
- **Research notes (not decisions):** mature marketplaces separate platform-wide staff (admin, finance, moderator, support) from seller-scoped roles (owner, staff); sellers start "pending" until approved; common features are seller onboarding/KYC (would be simulated), product approval queue, commission and split payments, payouts, disputes, refunds, review moderation, order routing to the right seller. Refund mechanics had **little source coverage**; research separately. Juice Shop uses customer, admin and an accounting role in its challenges (e.g. role set at registration, unlinked admin page); its full role list was **not confirmed**. Real marketplace flaw patterns found: one seller seeing another's orders, seller file uploads, payout/fee values trusted from the client, double refunds.
- **Sources:** [Ultra Commerce](https://ultracommerce.co/resources/blog/marketplace-security-guide-step-by-step-for-enterprises), [Melapress](https://melapress.com/multivendor-marketplace-security-tips-2025/), [Nautical roles](https://guide.nauticalcommerce.com/get-started/roles-responsibilities), [Nautical staff types](https://guide.nauticalcommerce.com/docs/users-guide/users/staff-members/staff-member-types), [CS-Cart product approval](https://docs.cs-cart.com/latest/user_guide/users/vendors/product_approval.html), [Bagisto rating moderation](https://marketplace-docs.bagisto.com/moderation/rating-management), [Stripe marketplace payments](https://stripe.com/resources/more/embedded-payments-for-online-marketplaces), [Juice Shop role write-up](https://infosecwriteups.com/hacking-owasp-juice-shop-part-5-privilege-escalation-via-manipulated-user-registration-4b1c5227aa81).

### D-11 — Six shop roles
(1) **Customer** — browse, buy, review, request refunds. (2) **Seller (owner)** — runs a store, lists products, sees payouts; starts "pending" until approved. (3) **Seller staff** — limited help inside one store. (4) **Support agent** — handles disputes and reported content; also does moderation (no separate moderator role); acts as a simulated victim (bot) that views user-written content. (5) **Finance** — scoped to commissions and payouts. (6) **Admin** — approves sellers/products, runs the shop. **Decided by user 2026-10-08.** Rule: every role must carry at least one challenge or it is dropped. Evidence: see D-10 sources. Open: exact permissions per role, bot behavior, refund mechanics, which challenge each role carries.

### D-12 — Candidate privacy = privacy by design
(1) Plain-language **consent screen** before a candidate starts, listing what is recorded (answers, attack requests, timing, hints), why, who sees it, how long it is kept, how to withdraw. (2) **Minimum data only:** only activity inside the assessment instance is recorded; no webcam or screen recording. (3) **Retention is configurable per assessment with auto-delete** (default period = Q-19); the recruiter's company can delete a candidate; candidates can request deletion. (4) Candidates can **see and export their own results**; the privacy wall (D-05) stays. (5) **Audit log** of who viewed which candidate's data. (6) **Roles in data terms:** VulnMart = processor, the recruiter's company = controller (HackerRank's pattern). **Decided by user 2026-10-08.**
- **Alternative:** minimal terms-and-conditions checkbox only.
- **Evidence:** [DPDP Rules 2025 (Mondaq)](https://www.mondaq.com/india/data-protection/1708164/digital-personal-data-protection-rules-2025-notified), [JSA](https://www.jsalaw.com/wp-content/uploads/2025/11/JSA-Prism-InfoTech-November-2025-DPDP-Rules.Final_.pdf), [SCC Online](https://www.scconline.com/blog/post/2025/12/26/digital-personal-data-protection-rules-2025-key-highlights/), [EY](https://www.ey.com/content/dam/ey-unified-site/ey-com/en-in/pdf/2025/11/dpdp-act-and-rules.pdf), [Mondaq on employment consent](https://webiis10.mondaq.com/india/data-protection/1755320/is-consent-required-to-process-employees-personal-data-under-the-dpdp-act), [Lakshmikumaran & Sridharan](https://lakshmisri.com/insights/articles/the-invisible-tightrope), [HackerRank GDPR FAQ](https://hackerrank-knowledge-base.help.usepylon.com/articles/2634495557-gdpr-faqs-for-hackerrank-for-work).
- **Facts to remember:** DPDP Rules notified 13 Nov 2025; notice/consent/erasure duties start about 13 May 2027 (after submission, but we build to it); notice must be plain-language; erasure after purpose ends with 48 hours' warning; processing logs kept at least one year; whether recruitment consent is needed for pre-hire candidates is debated, so we ask for consent to be safe.
- **Caveats:** secondary sources, **not legal advice**; the 90-day request deadline was unverified; HackerRank's retention period was not found.

### D-13 — Schedule and scope
**Submission:** first week of November 2026 (exact date not given; no interim review dates mentioned). **Scope:** the user said there is no need to take pressure on implementation and that the team will implement it **end to end using Claude Code**. So the full scope in this file stays; no minimum-version cutting or feature ranking is required at this stage. **Decided by user 2026-10-08.** Recommendations are not limited by time or team size. *Not research-backed: this is the user's own stance. The risk of about 4 weeks for a large scope is kept visible in gap 10.*

### D-14 — Repository and documentation rule
- **Repo:** a **dedicated private GitHub repo** for VulnMart (make it public at submission only if examiners need it). `major-project` sat inside the home-folder git repo whose remote is unrelated, so a separate local repo (`main`) was created. The user created **`tannmayygupta/owasp-mart`** (private, personal account) and chose **SSH with the personal key** (alias `github-personal` on Tanmay's PC, verified as `tannmayygupta`; the `github-work` alias is not used for this project). Private during development keeps challenge solutions and flag logic hidden, which matters for the hiring use.
- **Rule:** after every task, Claude Code writes a **dev-log entry**, a **decision record** when a decision was made, a **changelog** line, **traceability** updates and **evidence**; real results only; asks when unsure; never real flags, secrets or personal data. Written in `CLAUDE.md` (shared through git, so all three developers' Claude Code follow it).
- **Enforcement:** a Claude Code **PreToolUse hook** (`scripts/check-docs.mjs`) blocks a `git commit` when code changed without a dev-log entry and a `CHANGELOG.md` update; a **git commit-msg backstop** (`git config core.hooksPath .githooks`, once per clone) covers commits outside Claude; `[no-doc]` skips it for non-functional commits; needs Node.js; fails open on internal errors.
- **Doc set (full):** `docs/dev-log/`, `docs/adr/` (ADR 0001 added), `CHANGELOG.md`, `docs/traceability.md` (F1-F11, C01-C11), `docs/report/` (template pending), `docs/assets/`.
- **Decided by user 2026-10-08** (all recommended options). Alternatives researched: rule only (advice, may be skipped), rule plus warning only; dev-log only; public repo.
- **Evidence:** [Claude Code memory docs](https://code.claude.com/docs/en/memory), [Claude Code hooks docs](https://code.claude.com/docs/en/hooks), [ADR practice: AdAction](https://eng.adaction.com/architecture-decision-records/shared/0001-record-architecture-decisions/), [Shopware ADRs](https://developer.shopware.com/docs/v6.5/resources/references/adr/2020-06-25-implement-architecture-decision-records.html), [Changelog practice](https://userguiding.com/blog/changelog-best-practices), [Requirement traceability](https://testsigma.com/docs/test-management/reports/requirement-traceability-report/).
- **Caveats:** no official "docs before commit" recipe exists; the gate is our own design. Tested in scratch repos only (final run 13 of 13 scenarios; two bugs found and fixed), a live check on 2026-10-08 found the Claude Code hook **did not fire** (matcher `Bash` vs. the `PowerShell` tool on Windows; the git backstop did block the commit); fixed to `Bash|PowerShell`, re-check pending (Q-28). Hooks run with the developer's credentials, so each developer reviews the script. The gate checks that docs exist, not that they are good. The per-task log is our own synthesis (sources covered ADRs and changelogs, not per-task logs).

### D-15 — Hosting: Oracle free VM for API and instances
- **Decision (user, 2026-10-08, round 1):** dashboards on **Vercel's free tier**; the **platform API and all user instances run on an Oracle Always Free VM**; the **laptop is for development and a demo fallback**. Source: research note RS-A (T2 hybrid topology, instance host = Oracle VM).
- **User's condition:** "we are not thinking to pay for any service."
- **Free check (research, 2026-10-08):** the Always Free VM itself costs nothing: **2 OCPUs and 12 GB**, up to two Arm instances, 200 GB storage (**VERIFIED** on [Oracle's page](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)). **Sign-up needs a credit or debit card for identity verification** (a small temporary hold, reportedly about $1, released later; reports say virtual, prepaid and single-use cards are rejected; **UNVERIFIED**, forum and blog sources). Oracle reportedly does not upgrade or charge you unless you explicitly choose Pay As You Go. Budget-alert steps not confirmed.
- **Risks:** the VM can return "out of capacity"; idle VMs are reclaimed after **7 days** of low CPU, network and memory use (verified), so keep it active; the third-party reports about a mid-June 2026 quota cut are consistent with Oracle's page.
- **Terms of service:** no provider clearly allows or bans a deliberately vulnerable training lab. Action: email Oracle (and Cloudflare if used) and keep the reply for the report.
- **No-card fallback:** Azure for Students ($100 credit for 12 months, **no credit card**, burstable VMs for 12 months; VERIFIED on [Microsoft's page](https://azure.microsoft.com/en-us/free/students); the VM is disabled when the credit ends unless you pay), or the laptop as host.
- **Card question answered (user, 2026-10-08, round 2): yes**, the developers have an eligible card; any developer can set up the account. **D-15 is final.** Open details: which developer owns the Oracle account and how the other two get access (Q-32); the Azure for Students and laptop fallbacks stay available.

### D-16 — Web address (HTTPS)
- **Decision (user, 2026-10-08, round 1):** try the free route first (a free domain from the GitHub Student Pack, **unconfirmed**, or a free dynamic-DNS name), with automatic HTTPS on the VM. **If no domain is found, use the Oracle VM's public IP.**
- **Research on the IP fallback:** a Vercel-hosted dashboard is HTTPS, so the API must be HTTPS too (a browser blocks an insecure API call from a secure page). Let's Encrypt made **IP address certificates generally available on 15 January 2026**: they are short-lived (about 160 hours), only HTTP-01 or TLS-ALPN-01 validation works, and renewal must be automatic ([Let's Encrypt](https://letsencrypt.org/2025/07/01/issuing-our-first-ip-address-certificate.html), [Help Net Security](https://www.helpnetsecurity.com/2026/01/20/lets-encrypt-6-day-tls-certificates/)). **Caddy does not issue public IP certificates by default** (self-signed only) and one GitHub issue reports an error with the short-lived profile (**UNVERIFIED**); another ACME client may be needed. **sslip.io / nip.io** names (for example `1.2.3.4.sslip.io`) give a free hostname, but shared Let's Encrypt rate limits have caused failures (**UNVERIFIED** numbers).
- **Order of preference:** (1) free domain, (2) sslip.io-style name tested on Let's Encrypt staging, (3) IP certificate with a supporting client. **Never plain HTTP.** Cloudflare quick tunnels are rejected: no SSE, 200-request cap, no uptime guarantee, testing only ([Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), VERIFIED).
- **Spike:** get a real certificate for the Oracle VM on staging and then production before relying on it. User action: apply for the GitHub Student Pack (Q-30).

### D-17 — Live updates: SSE with real-time guarantees
- **Decision (user, 2026-10-08, round 1):** use **SSE**; "everything live and in real time, no user experience compromised"; research the industry-driven approach. Deviation from the synopsis (WebSockets): tell the guide (Q-25).
- **Design rules from research:** every dashboard change (flag captured, milestone, instance state, score) is pushed over SSE. Every event has an **ID**, and the server keeps a short **replay buffer** and honors `Last-Event-ID`, so a reconnect loses nothing. Send a **heartbeat comment about every 15 seconds** (shorter than the smallest proxy idle timeout). **Turn off proxy buffering** on the stream route (for nginx, `X-Accel-Buffering: no`). Serve over **HTTP/2** (avoids the six-connection browser limit). Keep a **snapshot endpoint** and fall back to **polling** if the stream keeps failing. Actions from the browser (submit a flag, start an instance) use normal HTTP requests. Fan-out from jobs and the monitor goes through the cache/queue layer to the SSE endpoints.
- **Evidence:** [WebSocket.org comparison](https://websocket.org/comparisons/sse/), [OneUptime SSE vs WebSockets](https://oneuptime.com/blog/post/2026-01-27-sse-vs-websockets/), [Svix glossary](https://www.svix.com/resources/glossary/server-sent-events/). **Caveat:** secondary blogs; the polling-fallback pattern is a general suggestion, not from a standard. Check the WHATWG spec for exact behavior.

### D-18 — Stored XSS lives in C03, with a support-agent bot
- **Decision (user, 2026-10-08, round 1):** **C03 Injection has two parts: SQL injection and stored XSS** seen by the support-agent bot. This differs from the stream's pick (SQLi only) and keeps the synopsis's "another simulated user's session" scenario, gives the support agent a real role, and maps to two scoring milestones. User asked for the industry-driven approach to the bot.
- **Bot design rules from research:** a **fresh browser context per visit** (no state leaks); the bot visits **only pages of its own instance** (never a general proxy); a **fixed visit time, then close**; run it **on demand**, only after content is posted, like PortSwigger's simulated victim (which views new content automatically; its isolation is not published, so that part is inference); **no network access except the shop** (RS-B's no-egress rule), with a per-instance collector inside the instance; **keep the browser sandbox and same-origin policy on**; many CTF bots weaken them on purpose, which is a challenge-design choice and not a best practice; rate-limit and cap concurrency. Verification: the exfiltrated value reaches the in-instance collector, which the monitor sees.
- **Cost:** a headless browser per instance, started only when needed; memory must be measured (spike). If too heavy, share one bot browser per host.
- **Evidence:** CTF write-ups for bot patterns ([GPN CTF 2024 write-up](https://emanuelduss.ch/posts/ctf-writeup-gpnctf2024/), [CTFtime write-ups](https://ctftime.org/writeup/32800)) and [PortSwigger XSS docs](https://portswigger.readthedocs.io/zh/latest/source/client/xss/cross-site-scripting.html). **Caveat:** write-ups only; no official design for PortSwigger's victim; the isolation points are my synthesis.

### D-19 — Platform roles bundle
- **Decision (user, 2026-10-08, round 2: "accept all five", plus "industry-driven approach"):** (1) recruiters belong to a **company (organization)** with several recruiters; (2) an **admin approves the company once** and the **company owner approves colleagues** (refines D-04; the admin gate stays, applied per company); (3) **Recruiter and Admin accounts cannot also be Learner or Candidate** (settles the suggestion left open in D-05); (4) **mandatory authenticator-app (TOTP) login for Admin**, optional for Recruiter; (5) **admins read candidate answers only through a logged "break-glass" step** with a reason.
- **Research (RS-D):** company model from HackerRank and HackerEarth only (HTB and Immersive roles not found). **Extra check (search summaries, UNVERIFIED primary text):** mandatory MFA for privileged accounts is a standard control (FedRAMP IA-2(1), phishing-resistant per current CISA guidance; NIST SP 800-63B AAL2 needs two independent factors; ASVS says to pick the level per NIST). Break-glass practice: named individual, written justification, time-boxed, real-time alert to security or managers, post-event review, no standing emergency privilege.
- **Implications:** TOTP is the **minimum** for Admin. TOTP can be phished, so **passkeys (WebAuthn)** are an upgrade candidate. Break-glass entries are named, justified, time-limited (duration to decide), alerted and reviewed. Candidates see company-level view history (RS-H).
- **Open details:** break-glass duration; whether Recruiter MFA is later made mandatory; the permission matrix (RS-D has a draft); read the exact NIST and ASVS 5.0 text before the report.

### D-20 — C11 Mishandling of Exceptional Conditions = seller KYC fails open
- **Decision (user, 2026-10-08, round 2):** the seller verification (KYC) check **fails open** on malformed input and **auto-approves the store**. This replaces the D-09 idea (payment error = paid), which overlapped C08 (unsigned payment webhook), per RS-F.
- **Evidence:** the official [OWASP Top 10:2025 A10](https://top10.owasp.org/2025/A10_2025-Mishandling_of_Exceptional_Conditions) (**VERIFIED**) lists **CWE-636 "Not Failing Securely ('Failing Open')"** among its 24 CWEs, and describes failing closed as the correct behavior. Primary tag: CWE-636; related CWE-754 and CWE-755.
- **Open details:** the exact KYC check and the sentinel-flag mechanism (RS-F card); roles used: seller owner (attacker) and admin (the approval that gets bypassed).

### D-21 — Platform technology stack
- **Decision (user, 2026-10-08, round 2: "accept the stack", plus "industry-driven approach"):** **FastAPI**; **Next.js 16**; **PostgreSQL 18**; **Python 3.14**; **Node 24 LTS for all JavaScript including the shop** (the shop note said Node 22); **Dramatiq** job queue; **SQLAlchemy 2 with Alembic**; **server-side session cookies with Argon2id** passwords; **Valkey** (not Redis 8); **OWASP ASVS 5.0 level 2**, level 3 for the orchestrator and admin; email through **Resend or Brevo**. Live updates use SSE (D-17).
- **Verified facts (2026-10-08):** via [endoflife.date](https://endoflife.date/api/python.json) (an aggregator of official dates): **Python 3.14** is supported until 2027-10-01 (security to 2030-10-31); **3.13's regular support ended 2026-10-01**, so 3.14 is the pick. **Node 24** is LTS now, goes into maintenance on **2026-10-20** and is supported to **2028-04-30**; **Node 26 becomes LTS on 2026-10-28** (EOL 2029-04-30). Decision: **Node 24 now**; revisit Node 26 after setup. **Node 22** (EOL 2027-04-30) rejected. **PostgreSQL 18** (released 2025-09-25) is supported to 2030-11-14, latest 18.6. **Next.js 16** is LTS, latest 16.4.0 (2026-10-06); Next.js 15 reaches end of life on 2026-10-21. **ASVS 5.0.0** is the latest (May 2025), per the [OWASP ASVS page](https://owasp.org/www-project-application-security-verification-standard/). **Redis 8** added AGPLv3 as a licensing option in May 2025 ([Redis blog](https://redis.io/blog/agplv3/)); **Valkey** is BSD-licensed and backed by the Linux Foundation ([valkey.io](https://valkey.io/)); both **VERIFIED**. **fastapi-users** README says "now in maintenance mode" ([GitHub](https://github.com/fastapi-users/fastapi-users)), so it is not used (**VERIFIED**). **Resend free plan:** 100 emails per day, 3,000 per month, 3 domains ([Resend pricing](https://resend.com/pricing), **VERIFIED**).
- **Unverified, re-check at setup:** Brevo's free limits (page unreadable); Resend needs a verified sender domain to email arbitrary recipients (so a domain, D-16, helps; otherwise Brevo's single-sender route); Dramatiq and SQLAlchemy release status and exact versions; FastAPI version; ASVS 5.0 level definitions (read the document before the report).
- **Deviations from the synopsis:** SSE instead of WebSockets (D-17), Valkey instead of Redis, plus the added Dramatiq and SQLAlchemy. Tell the guide (Q-25).

### D-22 — Scoring and anti-cheat
- **Decision (user, 2026-10-08, round 3: accept, plus "industry-driven approach"), from RS-C:**
  - **Hiring score:** fixed points per challenge in three difficulty tiers (placeholders 60/90/120). Three **automatic milestones** per challenge give 20, 40 and 100% credit. A **hint costs a percentage** of that challenge's points, never below zero. **Time is shown beside the score, not scored.** Headline time = wall-clock from "instance ready" to capture, plus an estimated active time (gaps over 5 minutes dropped). **No pause** in hiring mode. The server clock enforces the limit.
  - **Learner mode:** progress tracking, no hint penalty, **no global leaderboard** (optional private cohort board).
  - **Anti-cheat:** decoy flags, submission limits, activity-versus-capture check, timing anomalies, **single-use expiring hashed invite links**, similarity review; **no webcam or screen proctoring** (D-12). Suspicious captures are **held for a human**, never auto-zeroed. Wrong or decoy submissions carry no point penalty and are logged as integrity flags.
  - **Session:** 120-minute limit, 7-day invite expiry; at expiry **auto-submit, 15-minute freeze, then destroy**; **one attempt**, the recruiter can re-invite and the old attempt is kept; milestones survive an instance reset.
  - **Data used:** activity **metadata** (timestamps, counts, rule tags) without request bodies, reconciling RS-C with D-12 minimal data.
- **Evidence:** RS-C (CTFd, TryHackMe and HackerRank pages were read in full by the stream; HTB, Codility, CodeSignal and Immersive Labs only as search snippets).
- **Caveats:** **all numbers are placeholders**; they need milestones defined per challenge (RS-E, RS-F cards) and pilot data. All 11 challenges share one instance, so per-challenge "time" is really time into the assessment unless the D-07 classifier proves accurate (spike). The scoring formula and examples are in RS-C; the PRD will restate them.

### D-23 — Isolation and orchestration
- **Decision (user, 2026-10-08, round 3: accept, plus "industry-driven approach"), from RS-B:** own small **FastAPI orchestrator on the Docker Engine Python SDK** (no CTF platform adopted); each instance on its own **internal Docker network** (the SSRF challenge targets a fake metadata service inside the instance); containers **drop all capabilities, run non-root, read-only, resource-limited, with Docker's default seccomp profile**; extra hardening (user namespaces or rootless, gVisor) **only if the tests pass**; per-instance **sidecar proxy running Coraza with OWASP CRS v4.30.0 in detect-only mode**, sending **signed events** to the platform; **HMAC-derived flags** from a key that never enters an instance, new flags on reset; **learner instances 60 minutes inactivity and 4 hours maximum**, candidates for the assessment window; **cold start first**, warm pool if startup exceeds about 15 seconds. Platform database, flag key and Docker socket sit on networks an instance can never join; the public API never holds the Docker socket (D-21).
- **Verified in primary documentation (2026-10-08):** Docker `--internal` networks: "containers … may communicate between each other, but not with any other network" and "no default route is configured and firewall rules … drop all traffic to or from other networks" ([docker network create](https://docs.docker.com/reference/cli/docker/network/create/)). **But the same page says "communication with the gateway IP address (and thus appropriately configured host services) is possible" and "the host may communicate with any container IP directly".** Default seccomp profile is applied unless overridden and blocks about 44 of 300+ system calls ([Docker seccomp](https://docs.docker.com/engine/security/seccomp/)). `--cap-drop`, `--read-only`, `--pids-limit`, `--security-opt no-new-privileges=true`, `--memory`, `--cpus`, `--user`, `--tmpfs` exist as described ([docker run](https://docs.docker.com/reference/cli/docker/container/run/)). **Coraza** is written in Go, is "100% compatible with the OWASP Core Rule Set", supports Caddy, proxy-wasm and Traefik, and `SecRuleEngine DetectionOnly` processes rules without disruptive actions ([Coraza intro](https://coraza.io/docs/tutorials/introduction/), [directives](https://coraza.io/docs/seclang/directives/)). CRS **v4.30.0** is the latest release ([CRS releases](https://github.com/coreruleset/coreruleset/releases)).
- **Design rule added by this review:** because an internal network still lets a container reach the **gateway IP and host services**, add a **host-side firewall rule that drops traffic from instance subnets to the host**, and bind host services (SSH, orchestrator, Docker proxy) only to loopback or a management network, never to all interfaces. Test it on the Oracle VM and on Docker Desktop.
- **Caveats:** Coraza's **Caddy plugin is marked "needs a maintainer"** and the Traefik plugin is in preview; the proxy-wasm path is "stable, still in development", so the sidecar may be a small Go program embedding Coraza (decide after a spike). The rule set catches injection-style attacks only; logic and access-control challenges need events from the app itself, and flags leaked through hidden or encoded channels need the paste backup (D-01). **UNVERIFIED and to be tested:** blocking host access on WSL2 and Docker Desktop, gVisor or Kata on WSL2 and on the Oracle Arm VM, rootless limits, `DOCKER-USER` rules, AppArmor on WSL2, CRS rule tag names beyond `attack-sqli` and `attack-ssrf`, maintenance status of CTFd Whale and kCTF.

### D-24 — Shop (target app) technology and model
- **Decision (user, 2026-10-08, round 3: accept, plus "industry-driven approach"), from RS-G:** **Node 24 LTS with Express** (one Node version everywhere, D-21); **SQLite database per instance** (UNION-based SQL injection works in SQLite; stacked queries do not, so a challenge needing them would use PostgreSQL for that instance); **server-rendered pages with light JavaScript**; a bounded model of **about 20 tables and 7 state machines** (seller approval, product approval, checkout, fulfilment, refund, dispute, payout); **seller bears refunds and chargebacks** with commission reversed in proportion, ledger rows append-only (mirrors Stripe Connect); the **support-agent bot follows D-18**; data from a **CI-built snapshot plus a flag injector at start**; **neutral everyday marketplace look**.
- **Evidence:** RS-G. **Verified by the stream:** Stripe refunds and disputes page, Playwright Docker page. **Unverified:** comparisons with Medusa, Saleor, Vendure, Bagisto, Sylius, OpenCart, Juice Shop, Shopify and Amazon; all memory and size figures.
- **Spikes:** headless-browser memory per instance (share one bot browser per host if too heavy), shop cold-start time, combined per-instance memory (the earlier ~400 MB estimate assumed a database container, which SQLite removes, and a bot, which adds memory).

### D-25 — Privacy defaults (and a clarification of D-12)
- **Decision (user, 2026-10-08, round 3: accept, plus "industry-driven approach"), from RS-H:** candidate data kept **180 days** after the attempt (recruiter range **30 to 365**); learner data deleted **12 months after last login** with a 30-day warning; captured evidence deleted **30 days after the instance is destroyed**; recruiter's company is **controller** and VulnMart **processor** for candidates, VulnMart is controller for learners (a short data-processing terms page is accepted at recruiter approval); **audit log** pseudonymised, tamper-evident (hash-chained, append-only), kept **12 months**; **18+ only** (self-declared); candidates see **company-level** view history; **deletion requests go to the recruiter's company and VulnMart carries them out**; **JSON plus CSV** export; store the capturing request plus activity metadata; **IP and browser details** truncated or dropped after 90 days for learners and kept with the attempt for candidates; **14-day rolling backups plus per-assessment key shredding**; **7-day undo window** after withdrawing consent; per-assessment encryption keys; hashed invite tokens; Argon2id passwords; **action: ask the guide or the institute's legal cell to review the notice, retention and the 18+ rule once.**
- **D-12 clarification (2026-10-08):** automatic deletion, the 180-day default and the 7-day undo window are **our own product choices**, not legal requirements. Secondary sources (not the official Gazette) say the DPDP Rule 8(2) **48-hour pre-erasure notice applies to Third Schedule classes** (very large e-commerce and social media with 2 crore users or more, online gaming with 50 lakh or more) and that Rule 8(3) requires **every data fiduciary to keep logs for at least one year**; most duties start about **13 May 2027** (one source says it may be accelerated). VulnMart is probably outside the Third Schedule classes. **The official text of G.S.R. 846(E) was not read** by the stream or by me (PDF unreadable); the 90-day request deadline is unverified. Sources: [DPDP Rule 8 reproduction](https://dpdpa.com/dpdparules/rule8.html), [DPDP Wiki Rule 8](https://dpdp.myndsolution.com/wiki/rules/rule-8-time-period-for-specified-purpose-to-be-deemed-as-no-longer/), RS-H.
- **Caveats:** none of the hiring vendors publishes a hard default retention period (all leave it to the employer); the Act has no small-entity exemption, so a college platform may still be covered; **not legal advice**; read the Gazette text before the report.

### D-26 — Challenge catalogue (baseline)
- **Decision (user, 2026-10-08, round 4: accept, plus "industry-driven approach"), from RS-E and RS-F with D-18 and D-20:** (difficulty 1 to 5 in brackets; all exploit details and cards are in the two research notes)
  - **C01 Broken Access Control (2):** one store's order read through a sequential order number, using a seeded seller-staff login.
  - **C02 Cryptographic Failures (3):** gift-card codes are the first 12 hex characters of an unsalted MD5 of the card serial.
  - **C03 Injection (2):** UNION-based SQL injection in product search against a **separate read-only catalog database**, **plus stored XSS seen by the support-agent bot** (D-18).
  - **C04 Insecure Design (3):** refunds under an auto-approve limit have no cumulative cap, so two partial refunds exceed the amount paid (limits 1,500 and 2,500 are placeholders; depends on the D-24 refund model).
  - **C05 Security Misconfiguration (2):** an unauthenticated `/_ops/diagnostics` page found through a verbose error; shows a synthetic object, never real environment variables.
  - **C06 Vulnerable and Outdated Components (4):** **lodash 4.17.11 prototype pollution** (CVE-2019-10744, fixed in 4.17.12) inside an **isolated import service** with no network or database access, a fresh process per job. OWASP 2025 A03 is broader (supply chain); the stream notes the official page appears to contain a CWE typo (CWE-477 versus CWE-447).
  - **C07 Authentication Failures (2):** 4-digit password-reset code with no attempt limit, aimed at the finance account.
  - **C08 Software or Data Integrity Failures (3):** payment webhook accepts unsigned messages when a "sandbox" header is sent.
  - **C09 Logging (and Alerting) Failures (3):** a legacy mobile login route that is neither logged nor alerted, used to brute-force a dormant support-agent account; the monitor proves "attack happened, zero events recorded".
  - **C10 SSRF (4):** seller "import image from URL" with a weak blocklist, reaching a fake metadata service on an internal-only network; six containment rules in RS-F; plus the host-side rule from D-23.
  - **C11 Mishandling of Exceptional Conditions (3):** seller KYC fails open (D-20).
- **Rules:** all 11 are **independently solvable** with no hard prerequisites; a **sentinel flag** appears only if the intended vulnerable path was used; **one combined mock-services container** per instance (payment, KYC, metadata); detection by **both an event and the flag text** (D-01); no challenge may allow code execution or file read in the shop container (it would expose every flag); no exploit may reach the platform or host.
- **Evidence and caveats:** RS-E and RS-F. **Verified by the streams:** the lodash CVE (GitHub advisory), CWE and MITRE ATT&CK names, the OWASP 2025 A03 and A10 pages (A10 also checked by the lead: CWE-636 is listed). **Unverified:** WSTG IDs (derived from section order, because the pages print no IDs), the other candidate CVEs (ejs, qs, tough-cookie, lodash template), real-incident references (Capital One, LXD, Incus: search snippets), CWE-347 (related tag only), ATT&CK T1562 (page came back empty). **Not run:** the C06 pollution input on Node 24; C04 limits; all exploit-verification tests.
- **Cross-challenge conflicts still to check** are listed in both notes (10 items in RS-E; RS-F list); the architecture and test plan must resolve them.

### D-27 — What it means for a shop role to "carry" a challenge
- **Decision (user, 2026-10-08, round 4):** the D-11 rule counts a role if it is **the attacker's role, the victim, the target, or used in the exploit**. Coverage: customer (C04), seller owner (C01, C10, C11), seller staff (C01), support agent (C03 XSS victim, C09 dormant account), finance (C07 target), admin (C11 bypassed approver). No redesign needed. If a later review finds a role too thin, add a path then.

### D-28 — The four design traps
- **Decision (user, 2026-10-08):** accept all four fixes from RS-I. (1) **Same-origin through a Vercel rewrite** (backend-for-frontend, as IETF RFC 10017 recommends for apps with personal data); SSE passes through it and reconnects before Vercel's 120-second proxied-request limit; the same dashboards can run on the Oracle VM if a test shows buffering. (2) **Two separate DuckDNS names**, one for the platform and one for lab instances, with **one wildcard certificate** for instances (DNS-01 through Caddy's DuckDNS plugin); upgrade to two real domains if the GitHub Student Pack provides one; `sslip.io` and `nip.io` rejected (not on the Public Suffix List, shared global certificate limit). (3) **Two internal networks per instance** (`app` and `ctl`); the platform-side edge proxy and event collector are attached into `ctl`; Docker's `default-address-pools` raised (default allows about 31 networks). (4) **PostgreSQL and Valkey self-hosted on the VM**, encrypted backups to Oracle Object Storage, **Arm images built natively on the VM**.
- **Evidence:** `docs/research/RS-I-design-traps-and-lifecycle.md` (Vercel limits, RFC 10017, Public Suffix List check, Let's Encrypt limits, Docker docs, Oracle free resources, Caddy docs).
- **Spikes before relying on it:** SSE through the Vercel rewrite unbuffered; DuckDNS wildcard resolution and certificate; Caddyfile syntax for wildcard and Host routing; GitHub arm64 runner billing. Safari and Firefox cookie behavior is from secondary sources only.

### D-29 to D-31 — Lifecycle, trackers, tooling
- **D-29 (user, 2026-10-08):** the team follows **BMAD**. Each developer takes tasks from their own list, **creates one story at a time**, implements it, reviews it, tests it, and follows the BMAD cycle. The user chose this over the lead's recommendation (Scrum-lite cadence with a GSD-style loop), whose research is in RS-I. Not yet decided: sprint length, story size, and the Definition of Done details beyond "tests passed, docs written, tracker updated".
- **D-30 (user, 2026-10-08):** trackers are **markdown files in the repo, one folder per developer**, kept current **automatically by a Claude rule** (so a completed task is never left undocumented), plus **one complete Excel workbook updated manually by people**. Implementation plan: the `CLAUDE.md` workflow rule; the BMAD ticket tree (`docs/bmad/initiative-<slug>/`, story plan files hold the status); and, once initiatives exist, an extension of the commit gate so a code commit must also change a tracker file. The Excel workbook is created once from the task list and then maintained by hand.
- **D-31 (user, 2026-10-08):** BMAD's agents and skills are installed in the repo. **Done:** 23 skills from pinned commit `bda3c59` (version 6.13.0-next) after a source review; record, review findings, exclusions and rules in `docs/bmad/INSTALL.md`; verifier `scripts/verify-skills.mjs` (tested both ways); `uv` is a prerequisite (installed on Tanmay's PC only so far).

### D-32 — Challenge-spec decisions (DC-1 to DC-15)
- **Decision (user, 2026-10-08: "go with recommended option, research the industry practices"):** all 15 recommended options from `docs/design/challenge-specs.md` Section 12 are accepted.
  - **DC-1 (A):** C03 scores by milestones: M1 = found a weakness in either part (20%), M2 = one part fully exploited (40%), M3 = both flags (100%).
  - **DC-2 (A):** C03 is rated 3, Medium tier. **DC-6 (A):** tiers are 1-2 Easy (60), 3 Medium (90), 4-5 Hard (120). With the catalogue ratings this gives 3 Easy, 6 Medium, 2 Hard, a raw total of 960 (the dashboard rescales to 1000).
  - **DC-3 (A):** the XSS host field is the support ticket message. **DC-4 (A):** the collector lives in the mock-services container, with a player inbox page on the shop. **DC-5 (A):** the bot session is allow-listed to tickets and the agent-profile data only, so one XSS cannot read the C01 or C09 flags.
  - **DC-7 (A):** C04 is a separate "quick refund" path with its own limit and no cumulative check, inside an otherwise correct refund model. **DC-8 (C):** C10 starts from a seeded approved seller owner (no dependency on C11). **DC-9 (A):** the support order view hides the buyer note (keeps C01 intact). **DC-10 (A):** the finance email for C07 is on the public Contact page.
  - **DC-11 (A):** the shop sends `auth.attempt` and `shop.security_event_written` events so C09 can prove "attack happened, zero events recorded"; the platform never reads the shop database (FR-SHP-14). **Needs confirmation by the owner of the shop-to-platform contract once streams are assigned.**
  - **DC-12 (A):** player-given passwords are random per instance. **DC-13 (A):** C11 has two error classes. **DC-14 (A):** weak M1 signals for C01, C02, C04 are accepted as proxies. **DC-15 (A):** static non-secret proof markers for M2 (C02, C03 part A).
- **Resolves PRD open items:** OI-16 (tiers), OI-17 (milestone events, now defined per challenge in the spec, to be refined per story), OI-18 (C03 XSS design), OI-19 (C04 versus the refund model), OI-20 (C10 start state).
- **Industry evidence (2026-10-08):** PortSwigger's labs use three levels (Apprentice, Practitioner, Expert) and Hack The Box four (Easy, Medium, Hard, Insane); CTFs commonly use fixed points per difficulty tier ([hacking-lab scoring](https://hacking-lab.atlassian.net/wiki/spaces/HLSD/pages/785154059/Flag+Scoring+System), [Georgia Tech CTF](https://tc.gtisc.gatech.edu/cs6265/2025-spring/_sources/ctf.rst.txt)); assessment platforms award proportional credit for independently checkable parts ([iMocha](https://help.imocha.io/kb/article/312/partial-scoring-feature-for-maq), [Pear](https://docs.goguardian.com/products/pear-assessment/partial-credit-option)) and a community CTF gave each flag its own points with multi-step flags worth more ([NW3C scoring](https://nw3.ctfd.io/scoring)); PortSwigger says business logic flaws arise from "failing to anticipate unusual application states" and implicit assumptions ([logic flaws](https://portswigger.net/web-security/logic-flaws)); its SSRF teaching example is a shop's stock-check feature, with the blacklist-bypass families we imitate ([SSRF](https://portswigger.net/web-security/ssrf)); the official [OWASP A09:2025](https://top10.owasp.org/2025/A09_2025-Security_Logging_and_Alerting_Failures) lists missing or inconsistent logging of logins and failed logins, missing alert thresholds and CWE-778 "Insufficient Logging" (VERIFIED), which is what C09 teaches.
- **Caveats:** the 11 detailed cards were not individually approved by the user; they are the **baseline design**, to be refined in each story's acceptance criteria. The whole spec was skim-checked by the lead (sections, C03, C04, no flag values); WSTG IDs, the T1657 fit for C02 and C04, CRS XSS tag names and all spikes (Node 24 pollution, SQLite limits, host blocking, bot tagging) remain unverified. DC-1 gives one finished part 40% where strictly proportional credit would give 50%; this is a deliberate milestone design, not an error. Decoy flag locations are not yet placed.

### D-33 — Three work-streams and who takes them
- **Decision (user, 2026-10-08: accepted the recommended split, plus "industry-driven approach"; assignment "Tanmay L, Akshay P, Sahil T"):** split **by contract boundary**. **P** = platform and dashboards (76 PRD requirement IDs: accounts, companies, assessments, privacy, admin, notifications, the four dashboards, the SSE hub). **L** = lab and assessment engine (62 IDs: sessions, instances, flags, detection, scoring, time, anti-cheat, orchestrator, sidecar, edge, deployment of both VMs). **T** = target and challenges (32 IDs, heaviest per ID: the shop, its services, the 11 challenges with exploit tests and fixed builds). Rejected: by layer (busiest interface between two people building the same features), by vertical slice (shared parts have no owner), by component (about 109 IDs on one person).
- **How they stay independent:** ten written contracts IF-1 to IF-10 (platform API, lab API, domain events, instance events, orchestrator API, instance contract, challenge catalogue, error codes, internal ports, table ownership), each with one owner, a mock or stub and a conformance check; **sprint zero** builds contracts, mocks, a stub shop and a lab harness before feature coding; 11 deadlock rules (one owner per contract, mocks move with contracts, never wait on another stream's code, breaking changes need every consumer's approval with an expand-then-contract path, migrations need the table owner's approval). P and T have **no** direct interface; L is the hub. Full detail: `docs/architecture/07-repo-and-workstreams.md`, ADR 0013.
- **Assignment reasoning (agent's suggestion, accepted):** L needs Linux, Docker and network work plus the demo laptop and VM access (Tanmay, after the one-time WSL and Docker setup); P is web and Python on a Mac (Akshay); T is Node and security content that runs in containers on any OS (Sahil), and may take the sidecar and spikes S-6, S-7, S-9 if L is overloaded.
- **Industry evidence (secondary sources):** Team Topologies defines interaction modes (collaboration is costly and time-boxed; X-as-a-Service means one team consumes another's API, tool or product with minimal collaboration; other interactions are a sign of badly chosen boundaries), and Conway's law predicts that team interfaces show up in the software ([Team Topologies notes](https://openedx.atlassian.net/wiki/spaces/AC/pages/2547318841/Team+Topologies)); consumer-driven contract testing (Pact) makes such an interface enforceable: the consumer states what it needs, the provider verifies it in its own CI ([Pact overview](https://leapcell.io/blog/ensuring-microservice-compatibility-with-consumer-driven-contracts)). Rules of CODEOWNERS verified in [GitHub docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) (EF-30).
- **Caveats:** the Team Topologies and Pact sources are blogs and notes, not the book or Pact's own documentation. Whether branch protection with required code-owner review works on a private repository owned by a personal GitHub Free account is **unverified**: check the repository settings; if unavailable, a CI check `contract-approvals` and a pull-request checklist enforce the contracts instead. L is a hub and carries the hardest unknowns (spikes S-1 to S-4, S-6 to S-8, S-11, S-13 to S-17, S-22).

### D-34 — Two Oracle VMs (amends D-15)
- **Decision (user, 2026-10-08: recommended option, plus "industry-driven approach"):** run **two Oracle Arm VMs** inside the same free allowance. **VM-P** (platform zone): Caddy, API, ingest, SSE hub, workers, scheduler, PostgreSQL 18 with the keystore, Valkey, backups; holds personal data. **VM-I** (instance zone): orchestrator, Docker socket proxy, labs edge and gate, all hostile instances. The two talk over Oracle's private network with signed, mutually authenticated calls. **1 OCPU and 6 GB each.** Amends D-15 ("an Oracle VM") and PRD constraint K-2. A single-host layout stays available as configuration for the laptop fallback and for the case Oracle grants less (ADR 0007 option A).
- **Why:** a container escape on VM-I then reaches the orchestrator and other instances but not the candidate database, which also satisfies PRD NFR-ISO-06 ("instances not next to personal data"; PRD issue P-1).
- **Industry evidence:** NIST SP 800-190 recommends grouping containers on one host kernel only when they share the same purpose, sensitivity and threat posture, and warns about public-facing containers sharing hosts with sensitive data ([NIST](https://csrc.nist.gov/pubs/sp/800/190/final); wording from a secondary summary, full text not retrieved). Oracle's Always Free page reads "one or two OCI Ampere A1 Compute instances, 2 OCPUs total" with 1,500 OCPU-hours and 9,000 GB-hours a month, which is 6 GB per OCPU ([Oracle](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), VERIFIED).
- **Costs and risks:** only 1 CPU for the whole instance plane; **both VMs must stay active** against Oracle's 7-day idle reclaim (the instance VM is the one likely to sit idle between sessions: real use, such as pilots and scheduled honest checks, not fake load); more setup; the private link between the VMs is untested (spike S-17); the minimum memory per OCPU for the A1 shape was not found; 47 to 50 GB minimum boot volume each fits the 200 GB storage allowance.

### D-35 — Four architecture refinements
- **Decision (user, 2026-10-08: "accept all four"):** (1) **one encryption key per candidate attempt**, not per assessment, so one candidate can be deleted and shredded while others in the assessment stay (amends the wording of D-25 and FR-PRV-12; PRD issue P-9; ADR 0009). (2) **ASVS level 3 also for the key service and the audit-log subsystem**, in addition to the orchestrator and admin (extends D-21). (3) **"Never plain HTTP" (D-16) applies to public addresses only**: the laptop fallback and developer machines may use loopback names such as `*.localhost` over HTTP (ADR 0003; browser behavior to confirm in spike S-20). (4) **The C03 read-only catalogue is a second SQLite file opened read-only**, not a separate container, to save memory; sprint zero must confirm that SQL injection cannot reach other data (SQLite `ATTACH` and `load_extension` unavailable, one statement per call) (PRD issue P-18; changes the wording "own container" in `docs/design/challenge-specs.md`).
- **Evidence:** ADR 0003, 0008, 0009 and `docs/architecture/06-security.md`. **Caveats:** ASVS 5.0 level definitions were not read in a primary source (EF-29); the SQLite ATTACH and load_extension behavior is a spike.

### D-36 — Per-consumer flag files and an injector with no network
- **Decision (Tanmay, 2026-10-08, from IF-6 open points 16 and 29):** (1) the flag files that must exist only in the import service (C06) and in mock-services (C10) are delivered through two small **memory-backed volumes, one per consumer** (`/run/placement/import`, `/run/placement/mock`), written only by the injector and mounted read-only only by that consumer (chosen after research; delegated to the coordinator by the developer). (2) The **injector has `network_mode: none`**, which deviates from the architecture 02 drawing. Sahil confirms the consumer paths in the pull request review.
- **Evidence:** ADR 0016 (OWASP Secrets Management Cheat Sheet, CNCF whitepaper via a secondary source, Docker secrets guides; not all read in primary sources).

### D-37 — Pull request review is optional during initial development
- **Decision (Tanmay, 2026-10-08):** while the team is still building the first version, a pull request does not need a review; the author may merge once CI is green. Owners of a contract or another stream's folder are told in the team chat after a change. Applies to all three developers until the team decides otherwise. First use: pull request #2 (L-02) merged without Sahil's consumer approval; the contract's "to confirm" rows are still to be confirmed by Sahil and Akshay.
- **Amends:** the review rule in `CLAUDE.md`, `docs/dev/START-HERE.md` and the L-02 story ("stream T has approved"); the CODEOWNERS file is unchanged.
### D-38 — Instance event contract IF-4
- **Decision (Tanmay, 2026-10-08/09, three questions answered during story L-03):** (1) an event is identified by **`(instance_id, seq)` only** (the catalogue's `event_id` is dropped); (2) **`proxy.flag_seen`** carries `kind` (real, decoy or foreign), the `challenge_key` when it is this instance's, and the candidate's SHA-256; (3) **`source`** is fine-grained: sidecar, shop, import, mock, bot, orchestrator, platform. The signing form (HMAC-SHA256 over instance id, `seq` and body digest), the answers (202, 200, 409, 401, 413, 422) and all caps are proposals in `contracts/events/app-events.md`, to be confirmed by Akshay and Sahil in the team chat.
- **Supersedes:** the event descriptions in architecture 07 section 3.2 item 6, architecture 04 (events table `source`), and challenge specs section 10 (envelope). **Evidence:** ADR 0017. (D-37 is recorded on the `sprint-1-tanmay` branch.)

---

## 16. Next steps

1. **Clear the open questions** in Section 14.1.
   **Pipeline (agreed with the user, 2026-10-08):** research -> user confirms in short pick-one batches -> lock in Section 15 -> PRD -> architecture -> three independent work-streams with fixed interface contracts -> developers start. **Status (2026-10-08):** research streams RS-A to RS-H are done (see `docs/research/README.md`). The user has confirmed the decisions D-15 to D-27 in four pick-one rounds (many "accept the recommended bundle"). **Next: write the PRD from the locked decisions, then the architecture, then the three work-streams.** Items R-01 to R-14 below map to the streams; what remains of them is spikes and setup (Q-31), the exact permission matrices and state machines (drafts exist in RS-D and RS-G), and R-13 (dev environment setup).
2. **Research and lock** each unlocked item using proven industry solutions, and record it in Section 15:
   - **R-01 Roles and permissions** (user request): full feature list and permission matrix for the platform roles (Section 5) and the six shop roles (Section 6).
   - **R-02 Hosting:** what can run on free tiers (Vercel, Railway, others) given per-user containers; what must stay on our own machine.
   - **R-03 Isolation and safety** of intentionally vulnerable containers (network egress, SSRF, container escape).
   - **R-04 Flag generation and storage** (per-instance, tamper-resistant).
   - **R-05 Scoring model** (points, difficulty weighting).
   - **R-06 Challenge design** for all 11 challenges (concrete vuln, module, flag, CWE and ATT&CK IDs).
   - **R-07 Tech stack lock** (Section 10).
   - **R-08 Refund mechanics** in the shop.
   - **R-09 Retention default** (Q-19).
   - **R-10 Extra anti-cheat ideas** (e.g. activity check, decoy flags).
   - **R-11 Definition of "time taken"** per challenge.
   - **R-12 Capacity numbers** (provisioning time, concurrent instances, inactivity period).
   - **R-13 Dev environment setup** (Docker/WSL, disk space) for all three developers.
   - **R-14 Platform's own security.**
3. Write the **PRD** from locked decisions only.
4. Design the **architecture**.
5. Split into **3 independent work-streams**. The goal is **no deadlocks**, so streams meet only at written, agreed interfaces (contracts) fixed *before* coding starts.
