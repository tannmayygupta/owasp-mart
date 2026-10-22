# VulnMart: the project in plain language

A guide for the team to learn from and present. It describes only what is built and running today. Where a number is given, it was read from the code, the live system or a test run.

---

## 1. The idea in one minute

**VulnMart is a hands-on hacking gym for the web.**

Think of a driving school. Every student gets their own practice car, and the school can see how they drive. VulnMart does the same for web security:

- It builds a **real-looking online shop** that is **broken on purpose** (it has 11 planted security weaknesses, one per item of the OWASP Top 10 list).
- Every learner gets **their own private copy** of that shop, built in seconds. They attack it, find a hidden secret called a **flag** (looks like `VM{...}`), and paste it in to score points.
- **Companies** can use the same lab to **test job candidates**: invite them by email, give them a time limit, and get a scored report.

Nothing a learner does can hurt another learner, the platform, or anything on the internet.

### Who uses it

| Role | What they do |
|---|---|
| **Learner** | Practises on their own lab, one challenge at a time, earns points. |
| **Candidate** | A person invited by a company. Takes a timed assessment after giving consent. |
| **Recruiter** | Registers a company, creates assessments, invites candidates, reads reports. |
| **Admin** | Approves companies, sets limits, watches the system, has audited emergency access. |

---

## 2. What works today (end to end)

Everything below is built and was checked on the live site.

### Learner
- Sign up, confirm the email, sign in (optional authenticator-app second factor), forgot password.
- **Landing page** at `/` that explains the platform; **Sign in** and **Create account** pages.
- **Lab console**: start a private lab, open the shop in a new tab, copy a one-time link for Burp Suite, reset the shop (new flags), stop it.
- **11 challenges, one at a time.** Each has a countdown that starts when you press *Begin*: Easy 20, Medium 40, Hard 60 minutes. Each has a brief, three hints that cost points, and a write-up (what was wrong, how to fix it) after you finish.
- **Points**: up to 1000 per run. The account keeps the **best result per challenge** across runs.
- Run report, timeline of what happened, and the right to delete your data.

### The practice shop (the target)
A full marketplace with six roles (customer, seller owner, seller staff, support agent, finance, admin): browse and search, cart, checkout, orders, reviews, refunds, disputes, support tickets, gift cards, store registration, seller dashboard, bulk import, payouts. The 11 weaknesses are planted in it:

| # | Challenge | OWASP area |
|---|---|---|
| C01 | Read a competitor's order | Broken Access Control |
| C02 | Forge a gift-card code | Cryptographic Failures |
| C03 | SQL injection in search, and script in a support ticket | Injection |
| C04 | Refunds that add up to more than was paid | Insecure Design |
| C05 | Verbose error and an open ops console | Security Misconfiguration |
| C06 | Polluting the import service's objects | Software Supply Chain Failures |
| C07 | Brute-force a 4-digit password-reset code | Authentication Failures |
| C08 | Fake "payment succeeded" message | Software or Data Integrity Failures |
| C09 | Guess a password on an unwatched old login | Security Logging and Alerting Failures |
| C10 | Make the shop fetch its own cloud metadata | Server-Side Request Forgery |
| C11 | A crash that auto-approves a seller | Mishandling of Exceptional Conditions |

**Checked live:** an automated run played all 11 against real deployed labs. For every challenge the exploit worked, the flag came back, the platform credited it by itself, pasting it gave "correct", and the score reached 1000 of 1000 (58 of 58 checks). Another learner's flag is refused.

### Candidate and recruiter
- Recruiter signs up with a company name → confirms email → **waits for admin approval** → accepts data-processing terms.
- Creates **assessment templates**: time limit, hints on or off, when results are shown, reset limit.
- **Invites candidates by email** (one link, single use); resend, cancel, revoke, re-invite.
- Candidate opens the link, signs in or signs up, sees a **consent screen**, then starts. Can withdraw (with an undo window).
- Recruiter **watches progress live**, sees a scored **report** and a **cohort view**, can extend time, cancel, and **release** the results to the candidate.
- Candidates can ask the company to delete their data; the company decides.

### Admin
- Approve, reject, suspend or delete a company; set invite caps per company.
- Search accounts; lock, unlock or delete; force-stop a lab.
- Change settings and instance quotas; see capacity and scheduled jobs.
- **Audit log** of important actions, and **break-glass**: read a candidate's answers only with a written reason, a time limit and a review afterwards.
- Admin accounts exist only through a server command, and always need an authenticator app.

---

## 3. Where it runs (the servers)

### The short version
We rent **two small virtual computers** from **Amazon Web Services (AWS)** in **Sydney** on an AWS free-plan account. A virtual computer is called an **EC2 instance**. We call them:

| Name | Meaning | Size | Job |
|---|---|---|---|
| **vm-p** | **p**latform machine | 2 CPU, 2 GB memory | Runs the "real" product: accounts, database, API, dashboards, email sending. |
| **vm-i** | **i**nstances machine (the labs) | 2 CPU, 8 GB memory | Builds and runs every learner's private shop. |

("VM" just means virtual machine.)

### Why two machines?
**Safety.** The shops are *meant* to be attacked. If they ran on the same machine as the accounts and the database, a clever attacker could reach real data. So the dangerous part lives alone on **vm-i**, and the important part is on **vm-p**. The two machines talk only through a small, locked, authenticated channel. A lab can never start a conversation with the platform.

### Addresses and HTTPS
- Free names from **DuckDNS** (one for the platform, one wildcard for the labs).
- Free HTTPS certificates from **Let's Encrypt**, issued and renewed automatically by a tool called **lego**.
- The whole network (firewalls, subnets, the two machines) is described in code with **Terraform**, so it can be rebuilt.

### What runs on each machine
Everything runs in **Docker containers** (small, sealed boxes, each with one job).

**vm-p (platform)**

| Container | Job |
|---|---|
| **caddy** | The front door. Handles HTTPS and sends each request to the right place. |
| **api** | The brain: accounts, assessments, scoring, rules. |
| **worker** | Does background jobs, such as sending email and building labs. |
| **web** | The dashboards (recruiter, candidate, admin, account pages). |
| **postgres** | The main database. |
| **valkey** | A fast memory store for queues, rate limits and live updates. |
| **migrate** | Runs once at each deploy to update the database layout. |

**vm-i (labs)**

| Container | Job |
|---|---|
| **orchestrator** | The lab builder: creates, resets and destroys each learner's shop. |
| **edge-caddy and edge-gate** | The labs' front door. Checks a one-time ticket before letting anyone into a lab. |
| **docker-proxy** | Lets the orchestrator use Docker, but only for allowed actions. |
| **local registry** | A private store of the lab images. |

**Inside every lab (one set per learner)**: `shop`, `sidecar`, `import-service`, `mock-services`, `bot-controller`, a one-shot `injector`, and a `volume-keeper`.

---

## 4. Technology used

| Part | Technology | Why, in simple words |
|---|---|---|
| Platform API | **Python 3.14, FastAPI** | Fast, clear web framework with built-in validation. |
| Database | **PostgreSQL 18** | Reliable database for all permanent data. |
| Database changes | **SQLAlchemy and Alembic** | Describe tables in code; migrate safely. |
| Queue, cache, live stream | **Valkey** (Redis-compatible) + **Dramatiq** | Background jobs, rate limits, live updates. |
| Passwords and secrets | **Argon2id, AES-GCM** (cryptography) | Passwords are hashed, never stored; sensitive data is encrypted. |
| Dashboards | **Next.js 16, React 19, TypeScript** | Modern web pages for each role. |
| Learner console and landing page | Plain **HTML, CSS, JavaScript** (no build step) | Light, fast, and easy to serve. |
| The practice shop | **Node.js 24, Express, Nunjucks, SQLite** | Small and easy to make vulnerable on purpose. |
| Lab builder | **Python (FastAPI) + Docker** | Starts and stops containers on demand. |
| Lab sandbox | **gVisor** (runsc) | Each lab runs on a pretend operating system, not the real one. |
| Traffic watcher | **Node.js sidecar + Coraza WAF (detect only)** | Notices flags and attacks in the traffic, without blocking the learner. |
| Front doors | **Caddy** | Simple reverse proxy that also handles HTTPS. |
| Email | **Brevo** (transactional email API) | Sends the verification and invite emails. |
| Servers | **AWS EC2, Terraform** | Rented computers, built from code. |
| Quality | **GitHub Actions, pytest, Node test runner, Playwright** | Every change is tested before it can be merged. |

---

## 5. The big picture

```
                         INTERNET
                            |
        +-------------------+--------------------+
        |                                        |
  https://platform...                     https://<lab-id>.labs...
        |                                        |
 +------v--------- vm-p (platform) ---+   +------v----- vm-i (labs) -------+
 |  CADDY  (front door, HTTPS)         |   |  EDGE (HTTPS) + GATE (ticket)  |
 |    |-- /api/*  --> API  ---+        |   |        |                       |
 |    |-- pages   --> WEB     |        |   |   +----v-------------------+   |
 |    '-- the rest --> console |        |   |   | one private LAB each:  |   |
 |                    +--------v------+ |   |   |  sidecar -> shop       |   |
 |  WORKER <--queue-- | VALKEY        | |   |   |  import, mocks, bot    |   |
 |    |               +---------------+ |   |   +------------------------+   |
 |    v                                  |   |        ^                       |
 |  POSTGRES   (accounts, attempts, ...) |   |  ORCHESTRATOR (builds labs)    |
 +----------------|----------------------+   +--------^-----------------------+
                  |   signed, locked private link     |
                  '-----------------------------------'
                  Brevo (email) is called from the WORKER
```

A few things worth saying out loud:
- **Not one giant program.** The platform API is **one codebase run as a few processes** (API and worker). Around it are **separate small services**, each with one job: orchestrator, gate, sidecar, shop, import service, mock services, bot. That is our "microservice" style.
- **Browsers never reach the database or the API directly.** Only the front door (Caddy) does, and it adds a secret header so the API accepts only requests that came through it.
- **Labs never call the platform.** Only the platform calls the orchestrator, and the sidecars send signed reports upward through the labs' front door.

---

## 6. How things work

### 6.1 Creating an account (learner)
1. **Browser:** the person fills the form at `/signup` (name, email, password of 12 or more characters, "I am 18 or over").
2. **Request:** the page sends `POST /api/v1/accounts`. Caddy checks it comes from our own site and forwards it to the API.
3. **API:** checks the data, stores the account with the password as an **Argon2id hash** (never the password itself), makes a random one-time **verification token** and stores **only its hash**.
4. **Same moment, same database transaction:** it writes a row in an **outbox** table saying "send this email". Because it is the same transaction, an email is never lost and never sent for an account that was not saved.
5. **Answer:** always "accepted", even if the email already exists, so nobody can use the form to find out who has an account.
6. **Worker:** picks the outbox row and calls **Brevo's API** with the verification link `.../verify-email?token=...`. If Brevo is down it retries.
7. **The person clicks the link.** The page calls `POST /api/v1/accounts/verify-email`; the API checks the token (known, unused, not expired), marks the email verified and burns the token.

### 6.2 Signing in
1. `POST /api/v1/session` with email and password.
2. The API compares the password with the stored hash and applies rate limits (kept in Valkey). An unverified email is refused.
3. On success it creates a **session** (a row in the database) and sets a **session cookie**, plus a **CSRF token** the page must send with every change. Requests from other websites are rejected (origin check).
4. If the account has an **authenticator app** (always true for admins): the answer is "second factor needed". The person then sends the 6-digit code (or a one-time recovery code), and only then gets the session.
5. After sign-in a learner goes to the **lab console**; a recruiter or admin goes to the **dashboards**.

### 6.3 Forgot password
Same pattern as email verification: `/forgot-password` → `POST /password-reset/request` (always answers "accepted") → email with a link `.../reset-password?token=...` → `POST /password-reset/confirm`. The token is single use and expires.

### 6.4 Recruiter and company approval
1. The recruiter signs up as a company (`POST /recruiters`) and confirms the email.
2. The company is **pending**. An admin sees it in the admin screen and clicks **Approve** or **Reject** (`POST /admin/companies/{id}/decision`). The recruiter gets an email with the outcome.
3. The recruiter accepts the **data-processing terms**; only then can they invite anyone.
4. They create a template and invite candidates (`POST /company/invites`). Each invite is one email with a single-use link; only a hash of the token is stored.

### 6.5 A candidate takes an assessment
1. The candidate opens the invite link (`POST /invites/open`), signs in or signs up, and the email must match the invite.
2. A **consent screen** shows what is recorded and who sees it. Consent is saved in an **append-only record**. Declining ends it there.
3. The platform creates the attempt and builds the lab in the background; the candidate presses **Start**, and the **server's clock** runs the timer.
4. They attack, submit (or time runs out). The lab is then frozen and destroyed.
5. The recruiter sees live progress, a report and the cohort view, and chooses when to **release** results to the candidate.

### 6.6 How a lab is created (and the sandbox)
1. The learner presses **Start my lab** → `POST /api/v1/instances`.
2. The API checks quotas and capacity, saves an **attempt** and an **instance** ("requested") and queues a job.
3. The **worker** creates the **flags** (see 6.7) and sends them, with the order to build, to the **orchestrator** over a private, mutually authenticated (mTLS) channel.
4. The orchestrator builds a **private network** and the lab's containers on vm-i. A one-shot **injector** writes the flags into the shop's database and exits. The orchestrator waits until the shop is healthy, then opens the **gate**.
5. The platform marks the instance **ready** and the console shows it.
6. To open the shop, the learner gets a **one-time ticket URL** (`POST /instances/{id}/open`). The gate checks the ticket, sets a cookie, and from then on forwards requests through the **sidecar** to the shop.

**How the sandbox protects everyone (layers):**
1. **Separate machine** (vm-i): labs share nothing with the platform's data.
2. **gVisor**: each container sees a fake, user-space operating system, so a hacked shop cannot reach the real one.
3. **Private networks** per lab, no ports published to the internet; the only way in is the gate with a valid ticket.
4. **No outbound internet** for labs, and firewall rules that block the cloud metadata address and private ranges (18 of 18 forbidden targets are blocked in the isolation probe).
5. **Limits and cleanup**: memory and process limits per lab; labs are destroyed on stop, on expiry, or after 60 minutes without activity.
6. **Docker is guarded**: the orchestrator uses Docker only through a proxy that allows listed actions.
7. **AWS firewalls**: security groups and network ACLs only allow what is needed.

### 6.7 Personal flags (why nobody can share an answer)
- Each flag is computed as a **keyed hash (HMAC)** of: a secret key that only the platform has + **the lab's id** + **the challenge** + **the epoch** (a counter that goes up on every reset).
- So **every lab has different flags**, and a **reset gives new flags**; the old ones stop working.
- When someone pastes a flag, the platform **recomputes** the expected flag for that lab and compares it safely. The pasted text is not stored.
- The platform tells apart: correct, an older (stale) flag, a decoy flag (planted fakes, flagged for a human to review), and a flag that belongs to someone else's lab (which is refused). The live test confirmed another learner's flag is rejected.
- The **sidecar** also notices when a real flag shows up in a response (it compares hashes, it never sees the secret key) and reports it, so progress is credited by itself.

### 6.8 Scoring and live updates
- Each challenge has **milestones** M1, M2, M3 that earn a growing share of its points; M3 is the flag. Hints cost points. A run shows up to **1000**.
- Events travel: sidecar → labs' front door → platform → queue → scoring worker → database → **live stream** (Server-Sent Events) to the recruiter's screen. A browser that reconnects catches up from where it stopped.

### 6.9 The email service
- **Provider:** Brevo, using its API, with one verified sender address; its key lives in a secret file, not in the code.
- **Outbox pattern:** the email is a database row first, then a worker sends it. If Brevo fails, it retries; mails are delayed, never lost.
- **Emails sent today:** account verification, password reset, email-change confirmation, recruiter approval outcome, candidate invites.
- **Links** are built from the platform's own address and contain a one-time token. Only the token's hash is stored.
- In development and tests a fake inbox (**Mailpit**) replaces Brevo.

### 6.10 Privacy and protection of data
- Consent is **append-only**: a consent record can be added but never edited or deleted.
- The **audit log** is write-only for the application and records who did what; reading someone's answers needs **break-glass**.
- Candidate evidence is **encrypted**; the encryption keys live in a separate database.
- A **scheduler** runs retention and clean-up jobs; people can ask for deletion and see **who viewed their data**.

---

## 7. The API: design and endpoints

### How it is designed
- **REST over HTTPS, JSON**, all under `/api/v1/`.
- **Contract first:** the API is described in an OpenAPI file (`contracts/api`). The tests check that the code and the file agree, and a tool (**oasdiff**) refuses a change that would break existing users without a version bump. The platform API has **106 operations** (a deployed check confirms every one of them exists on the live site).
- **Same-origin:** the browser talks only to our own site; **Caddy** is the gateway that forwards `/api/*` to the API and adds the secret header.
- **Errors** are uniform JSON documents with a code (for example `AUTH-EMAIL-NOT-VERIFIED`) and a request id, so a problem can be traced.
- **Safety rules on every request:** session cookie, CSRF token on changes, origin check, rate limits (HTTP 429), roles checked on the server, admin routes need a second factor.

### The front door (our "API gateway")
Caddy on vm-p does four things: **HTTPS** (with security headers: HSTS, no-sniff, no framing), **routing** (`/api/*` to the API, dashboard pages to the web app, everything else to the static console and landing page), **adds the origin secret** so only it can reach the API, and **removes cookies from its logs**. The labs have their own front door (edge + gate) that checks tickets.

### Endpoints by area
| Area | Examples | Count |
|---|---|---|
| Health | `GET /health` | 1 |
| Accounts | `POST /accounts` (sign up), `/accounts/verify-email`, `/accounts/verify-email/resend`, `/accounts/confirm-email-change` | 4 |
| Session | `POST /session` (log in), `GET /session`, `DELETE /session`, `POST /session/mfa` | 4 |
| Me | profile, change password, change email, my sessions, turn on the authenticator (`/me/mfa`, `/me/mfa/confirm`) | 10 |
| Password reset | `POST /password-reset/request`, `/password-reset/confirm` | 2 |
| Consent and privacy | `GET /consent/notice`, `POST /consent`, deletion requests, "who viewed my data" | 7 |
| Invites | `POST /invites/open`, `/invites/accept`, `GET /me/invites` | 3 |
| Company (recruiter) | `POST /recruiters`, terms, templates (create, read, replace, delete), invites and their actions, members, join requests, deletion decisions, cohort view | 21 |
| Exports | `POST /me/exports`, `POST /company/exports` | 2 |
| Admin | companies (pending, decision, invite cap), users and their actions, settings, quotas, capacity, jobs, audit log, break-glass, force-stop | 22 |
| Catalogue | `GET /challenges`, `GET /challenges/{key}` | 2 |
| Attempts | list, state and clock, start, submit, release, cancel, extend, withdraw and undo | 9 |
| Instances (labs) | `POST /instances` (start a lab), state, `/open` (one-time URL), `/reset`, `/stop` | 5 |
| Challenges and results | begin a challenge, progress, score, my points, report, timeline, evidence, integrity flags | 9 |
| Flags | `POST /attempts/{id}/flags` (paste a flag) | 1 |
| Hints | list the three levels, unlock a level | 2 |
| Live | `GET /live` (stream), `GET /live/snapshot` | 2 |

(Paths are all under `/api/v1`.)

### The labs' internal contracts
Separate, small, documented interfaces connect the parts: platform ↔ orchestrator (build, reset, stop, with signed requests), orchestrator ↔ gate (who may enter), sidecar → platform (signed events), and the shop's instance contract. They are checked by tests the same way as the public API.

---

## 8. Data: what is stored where

| Store | What it holds |
|---|---|
| **PostgreSQL** (`vulnmart`, 43 tables, 18 migrations) | Accounts and sessions, roles, authenticator secrets (encrypted), consent records, companies and members, templates, invites, attempts, instances, challenge opens, events, scores, hints, integrity flags, reviews, audit log, deletion requests, the email outbox, scheduled-job runs, settings and quotas. |
| **PostgreSQL** (`vm_keystore`) | Encryption keys, kept apart from the main data. |
| **Valkey** | Temporary things only: job queues, rate-limit counters, live-update streams. |
| **Each lab's SQLite file** | The shop's own fake data (products, users, orders), with that lab's flags. It is destroyed with the lab. |

**Backups:** a nightly database dump on vm-p, a copy pulled off the machine, and a tested restore into a scratch database (43 of 43 tables matched). A live data check after every deploy compares row counts and found no data lost.

---

## 9. Security in layers (summary)

1. **Network:** AWS firewalls, separate machines, no open ports except the two front doors.
2. **Transport:** HTTPS everywhere, strict browser security headers.
3. **Accounts:** Argon2id hashes, email verification, optional second factor (required for admins), rate limits, same answer for known and unknown emails.
4. **Sessions:** server-side sessions, CSRF tokens, origin checks.
5. **Labs:** gVisor, private networks, no internet, tickets, one-time links, limits and cleanup.
6. **Data:** consent records, encryption of evidence, audit log, break-glass, retention jobs, deletion on request.
7. **Secrets:** kept in files outside the code, never printed or stored in the repository.

---

## 10. How we build and check it

- **One repository**, one branch and pull request per piece of work. A change is merged only when automated checks pass: API tests (about 3,000), script tests (about 1,000), app tests, contract rules, exploit tests for every challenge, a shop harness, Terraform checks and image builds.
- **Browser tests** drive the dashboards (20 tests, including accessibility checks) and the practice shop (12 tests, one per challenge).
- **Deploys** are one command (`live-deploy`) that builds the images, copies them to the servers, and starts them; afterwards a script checks the live site (70 checks) and the data.
- **Documentation rule:** every piece of work leaves a dev-log entry, a changelog line and an updated traceability table.

---

## 11. Likely questions, short answers

**Why two servers?** So the part that is attacked on purpose can never touch the real data.

**How do you stop learners sharing flags?** Every lab has its own flags made from a secret key plus the lab id; a reset changes them; another lab's flag is refused.

**What is a sidecar?** A helper container placed in front of each shop that watches the traffic and sends signed reports (for example "a real flag appeared in a response").

**What is gVisor?** A security layer that gives each lab container a pretend operating system, so even a fully hacked shop does not touch the real machine.

**Why an outbox table for emails?** So an email is saved in the same step as the change that needs it. If the email service is down, it is retried and not lost.

**How do you know the challenges can be solved?** An automated run plays all 11 against real deployed labs and checks the flag, the automatic credit, the paste check and the score. All 58 checks passed.

**What if a learner crashes the shop?** They press reset; a new lab with new flags is built. Labs are also cleaned up automatically.

**Which email service do you use?** Brevo, through its API, with one verified sender.

**What is an OWASP Top 10?** A well-known list of the most common web security mistakes. Each of our challenges teaches one of them.

---

## 12. Glossary

| Word | Meaning |
|---|---|
| **Flag** | A secret text `VM{...}` hidden in a lab; finding it proves you exploited the weakness. |
| **Lab / instance** | One learner's private copy of the shop. |
| **Epoch** | A counter for a lab; it goes up on every reset so flags change. |
| **Sidecar** | The watcher container in front of a shop. |
| **Gate / edge** | The labs' front door that checks a ticket. |
| **Orchestrator** | The service that builds and destroys labs. |
| **Container** | A small sealed box that runs one program. |
| **Outbox** | A table of "things to send", written together with the change that needs them. |
| **Break-glass** | Emergency, audited access to a candidate's answers, with a reason and a review. |
| **MFA / TOTP** | A second login step: a 6-digit code from an authenticator app. |
| **CSRF** | An attack where another website tricks your browser into acting; the token prevents it. |
| **HMAC** | A keyed fingerprint: the same input and key always give the same result, and nobody without the key can make it. |
