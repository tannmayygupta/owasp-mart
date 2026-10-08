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
| Q-19 | Default **retention period** for candidate data before auto-delete, and how it fits the one-year processing-log rule in India's DPDP Rules. | Needed to build auto-delete. Research item. |
| Q-21 | **Who writes the report**, and what do the 2 non-developing authors do (docs, testing, pilot users)? | Decides report ownership and pilot participants. |
| Q-22 | **Pilot and mock hiring round:** who are the participants (the synopsis says "where feasible")? | Phase 4 and 5 depend on people. |
| Q-23 | Is **"VulnMart"** the final product name? (The pitch used "OWASP Vulnerable Practice-and-Hiring Platform"; the GitHub repo is named `owasp-mart`.) | Naming across code, docs, report. |
| Q-24 | What are the **other two developers' PC specs** and are Docker/WSL set up on them? | Dev environment must work for all three. |
| Q-25 | **When** will the guide be informed of the scope changes? | The synopsis was approved as written. |
| Q-26 | The **college report template**: the user will share it. Then map `docs/report/README.md` to its chapters. | The documentation structure should match the report. |
| ~~Q-27~~ | ~~GitHub repo name and approval to create and push.~~ **ANSWERED (user, 2026-10-08):** the user created the private repo **`tannmayygupta/owasp-mart`** on the **personal** GitHub account and asked for **SSH** (personal key, not the work one). First commit pushed. See D-14. | Repo creation and pushing publish content to an external service. |
| Q-28 | Verify the commit hook **live** inside Claude Code (restart in the project folder, trust prompt, `/hooks`, try a code commit without docs). | The gate was only tested with simulated input. |

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
- **Caveats:** no official "docs before commit" recipe exists; the gate is our own design. Tested in scratch repos only (final run 13 of 13 scenarios; two bugs found and fixed), **not yet seen in a live Claude Code session** (Q-28). Hooks run with the developer's credentials, so each developer reviews the script. The gate checks that docs exist, not that they are good. The per-task log is our own synthesis (sources covered ADRs and changelogs, not per-task logs).

---

## 16. Next steps

1. **Clear the open questions** in Section 14.1.
2. **Research and lock** each unlocked item, one at a time, using proven industry solutions, and record it in Section 15:
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
