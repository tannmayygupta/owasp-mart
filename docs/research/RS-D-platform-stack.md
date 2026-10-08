# RS-D — Platform tech stack, API contracts, platform security, roles and lifecycles
Status: DRAFT research, NOT confirmed by the user · Date: 2026-10-08

Method note: the page-fetch tool was blocked for most sites (endoflife.date, resend.com, brevo.com, docs.github.com). Most facts below come from web-search summaries that quote the official pages. They are marked UNVERIFIED unless a primary page was actually read. Re-check every number before it goes into the PRD or report. Version numbers move fast; pin exact versions from PyPI, npm and the Docker registry on the day the repo is created.

## 1. Questions answered
1. Is the synopsis stack right, compared with real alternatives? (Section 2, 3)
2. What repo layout, tooling and contract-first workflow lets three developers work without blocking each other? (Section 3.2)
3. What security level should the platform itself meet, and what is the threat model? (Section 3.3)
4. Platform roles, permission matrix, company (tenant) model, lifecycles, and the separate-accounts question left open in D-05. (Section 3.4)
5. High-level API resource groups to split work. (Section 3.5)

## 2. Options compared

### 2.1 Stack parts

| Part | Option | Fit with our constraints | Free-tier / cost | Complexity | Main risks | Evidence |
|---|---|---|---|---|---|---|
| Backend | **FastAPI** (Python) | Fits: Docker SDK for Python, async, auto OpenAPI (key for contracts) | Free, open source | Low | Python 3.9 dropped; Pydantic v1 removed in 2025-26 releases (UNVERIFIED) | E1 |
| Backend | Django + DRF/Ninja | Batteries included (auth, admin, ORM, migrations) | Free | Medium | Heavier; OpenAPI is add-on; async is weaker | none read |
| Backend | NestJS (Node) | One language with frontend | Free | Medium | Docker orchestration libs weaker; team prefers Python per synopsis | none read |
| Frontend | **Next.js 16 (React 19.2)** | Matches synopsis; Active LTS | Free; hosting is RS-A | Medium | Next 15 maintenance ends 2026-10-21; Next has had frequent security releases | E2, E3 |
| Frontend | Vite + React SPA | Simpler, portable static files, no Node server | Free | Low | No server rendering (not needed behind login) | none read |
| Database | **PostgreSQL 18** | Industry default, JSONB for evidence, row-level security possible | Free; supported to 2030-11-14 (UNVERIFIED) | Low | None serious | E4 |
| Cache | **Valkey 8 or Redis 8** | Rate limits, pub/sub for live updates, queue broker | Free | Low | Redis 7.2 no longer has official patches; Redis 8 is AGPLv3 (also RSAL/SSPL options); Valkey is BSD, wire-compatible | E5 |
| Live updates | **SSE (Server-Sent Events)** | Dashboards only need server-to-browser push; plain HTTP, auto-reconnect, works through proxies | Free | Low | Browser limit of 6 connections per host on HTTP/1.1 (use HTTP/2) | known web standard, UNVERIFIED |
| Live updates | WebSockets (synopsis) | Two-way; works | Free | Medium | Needs sticky/auth handling, custom reconnect; no benefit here | UNVERIFIED |
| Live updates | Polling every 3-5 s | Simplest fallback | Free | Lowest | Slight delay, more load | none |
| Job queue (provisioning, teardown, email) | **Dramatiq on Valkey/Redis** | Simple API, retries with backoff built in, proven | Free | Low-Medium | Smaller community than Celery | E6 |
| Job queue | Celery | Most used, big ecosystem, Flower monitoring | Free | Medium | Heavy config, known foot-guns with acks | E6 |
| Job queue | Procrastinate (Postgres-native) | No extra broker, enqueue in same DB transaction | Free | Low | Smaller project; queue load on the DB | E6 |
| Job queue | Arq | Async-native, tiny | Free | Low | Said to be in maintenance-only mode (UNVERIFIED) | E6 |
| Job queue | Temporal | Best for long workflows with timers (instance lifecycle) | Free self-host | High | Extra cluster to run on a 15 GB laptop | none read |
| Job queue | Plain asyncio tasks | Zero infra | Free | Lowest | Jobs lost on restart; no retries; not for an orchestrator | none |
| ORM / migrations | **SQLAlchemy 2.x + Alembic** | The standard for FastAPI; async support | Free | Medium | Verbose | E7 |
| ORM | SQLModel | Less typing, Pydantic-native | Free | Low | Still pre-1.0; thin layer over SQLAlchemy (UNVERIFIED) | E7 |
| Auth | **Own thin layer: server-side sessions in an HttpOnly cookie** | Same-site browser app; instant revoke; fits ASVS | Free | Medium | We write ~300 lines; must be tested well | E8, E9 |
| Auth | JWT access + refresh tokens | Good for mobile or third-party APIs | Free | Medium | Cannot revoke before expiry without server state; XSS exposure if stored in JS | E8 |
| Auth | fastapi-users | Ready-made | Free | Low | In maintenance mode (security fixes only) (UNVERIFIED) | E10 |
| Auth | Authlib | Mature OAuth/OIDC client and server library | Free | Medium | Only needed for "Sign in with Google/GitHub" later | none read |
| Auth | Hosted (Auth0, Clerk, Keycloak) | Offloads MFA, SSO | Free tiers limited; Keycloak = extra service | Medium-High | Vendor lock-in; recruiter-approval logic still ours | none read |
| Password hash | **Argon2id** (`argon2-cffi`) | OWASP-recommended | Free | Low | Tune memory/time cost on the laptop | E11 |
| Email | **Resend** | Simple API; free 100/day, 3,000/month | Free (UNVERIFIED) | Low | Needs your own domain to send to outside addresses; free daily cap | E12 |
| Email | Brevo | Free 300/day, SMTP + API | Free (UNVERIFIED) | Low | Cap shared with marketing mail; stricter sender checks | E13 |
| Email | Mailpit (local) | Catches all dev email | Free | Lowest | Dev only | none read |
| Rate limiting | **App layer (`limits`/slowapi style, Redis counters) + proxy layer (Caddy or Cloudflare)** | Per-IP and per-account limits for login, signup, invites | Free | Low | Must key on the real client IP behind the proxy | none read |
| CI | **GitHub Actions** | Already chosen (D-14 repo) | 2,000 min/month and 500 MB storage on GitHub Free for private repos; Windows runners count 2x (UNVERIFIED) | Low | Minutes can run out; use Linux runners, path filters, caching | E14 |

### 2.2 Frontend data fetching and UI kit (short)
| Option | Note |
|---|---|
| **TanStack Query + generated typed client (`@hey-api/openapi-ts` or Orval)** | Types come from the backend contract; cache, retries, polling built in. Recommended. |
| SWR / plain fetch | Fewer features; hand-written types drift from the API. |
| **Tailwind + shadcn/ui (Radix)** | Accessible components you own as source code, no heavy dependency. Recommended. |
| MUI / Mantine | Fine, larger bundle and own style system. |
Evidence for these is general practice, none read in a primary source (UNVERIFIED).

## 3. Recommendation

### 3.1 Recommended stack (pending user confirmation)
- **Backend:** FastAPI on **Python 3.13 or 3.14** (3.14 released 2025-10-07, bugfix to 2027-10, security to 2030-10; 3.13 went security-only on 2026-10-01, end of life 2029-10; UNVERIFIED, E15). Pick 3.14 if every dependency has wheels; otherwise 3.13. The laptop has 3.12.4, so let `uv` install the pinned Python and do not rely on the system one.
- **Frontend:** Next.js 16 (React 19.2) on **Node 24 LTS** (LTS to about 2028-04; UNVERIFIED, E16). Browser talks to the API **on the same origin** through a reverse proxy, so no CORS is needed and cookies can be `SameSite=Lax`.
- **Data:** PostgreSQL 18; Valkey 8 (or Redis 8, see decision 4); SQLAlchemy 2 + Alembic; Pydantic v2 schemas.
- **Jobs:** Dramatiq workers. The **instance state lives in Postgres** (a state machine, Section 3.4.5) and a **reconciler loop** repairs drift (for example a container that died). The queue only triggers work. This avoids losing an instance when a job fails.
- **Live updates:** **SSE** over HTTP/2 from the API, fed by Valkey pub/sub. Reason: all live data (progress, score, instance status) flows server to browser only. If the user wants the synopsis wording kept, WebSockets also work, but give no extra benefit.
- **Auth:** server-side sessions (random 256-bit ID in an HttpOnly, Secure, SameSite=Lax cookie, record in Postgres with Valkey cache), Argon2id, TOTP MFA (mandatory for Admin, optional for Recruiter), breached-password check, email verification by one-time token (hashed in DB, 24 h expiry, single use). Do **not** adopt fastapi-users (maintenance mode). Add Authlib later only if social login is wanted.
- **Email:** Resend (needs a verified domain) with Brevo as fallback; Mailpit in dev. The free caps (100 or 300 per day) are enough for a demo and small pilot but **not** for a real launch: one mass invite batch can exceed them. Send through an outbox table plus a queue so a cap never loses mail.

**This would be wrong if:** the team wants mobile or third-party API clients (then add JWT or OAuth); the dashboards need browser-to-server messages (then WebSockets); Redis licensing matters to the college (then Valkey); or the team is already expert in Django (then Django removes the custom auth work).

### 3.2 Repo and tooling for three independent developers
**Layout (one monorepo, matches the existing `owasp-mart` repo):**
```
apps/api            FastAPI platform API (+ workers as a second entrypoint)
apps/web            Next.js dashboards
apps/orchestrator   instance controller (talks to Docker; see 3.3.4)   [could start as a package inside api]
apps/shop           the vulnerable marketplace (RS-G decides its stack)
services/monitor    per-instance flag/traffic monitor (RS-B)
packages/contracts  openapi.json, event JSON Schemas, error codes   <- THE shared interface
infra/              docker-compose, proxy config, CI helpers
docs/               existing documentation system
```
- **Package managers:** `uv` workspace for Python (lockfile, installs pinned Python, fast); `pnpm` workspace for JS. Both are current industry choices (UNVERIFIED, general practice).
- **Quality gates:** Python: `ruff` (lint + format), `pyright` or `mypy`, `pytest`. JS: ESLint or Biome, `tsc`, Vitest, Playwright for end-to-end. `pre-commit` runs them locally. Add `gitleaks` for secrets and `pip-audit` / `pnpm audit` for dependencies.
- **Contract-first without waiting (recommended flow):**
  1. Before coding, the three developers agree the resource groups (3.5) and write **Pydantic models + stub FastAPI routes** that return example data.
  2. CI exports `packages/contracts/openapi.json` and **fails if the file is out of date** (so the spec is always committed and reviewable).
  3. Frontend generates a **typed TypeScript client** from that file, and runs against a **mock server (Prism)** until the real route exists.
  4. **Schemathesis** (property-based tests that read the spec) runs against the real API in CI to catch drift. **`oasdiff`** flags breaking changes in pull requests.
  5. Events (monitor to API, orchestrator to API) get JSON Schemas in the same folder, validated on both sides.
  Prism, Schemathesis, oasdiff and openapi-ts are named from general practice; none was read in a primary source (UNVERIFIED).
- **Database ownership:** the platform DB is owned **only by `apps/api`**. Other components never touch it; they call the API or send signed events. The shop instance has its own private DB inside its containers (not the platform DB). One Alembic history, linear. Rules: one migration per PR, CI runs `alembic heads` and fails on more than one head, CI applies migrations to an empty DB and also upgrades from the previous release, and each table group has a named owner in `CODEOWNERS`. Migrations must be backward compatible for one release (expand, then contract).
- **CI on GitHub Actions:** Linux runners only (Windows minutes count double, UNVERIFIED), path filters so a docs change runs nothing, dependency caches, a nightly job for slow tests (Playwright, Schemathesis, image build). Budget about 2,000 minutes per month across three developers; track usage. Never run untrusted pull-request code with secrets; keep the repo private.

### 3.3 Platform security baseline (R-14)

**3.3.1 Level: OWASP ASVS 5.0 Level 2** (ASVS 5.0.0 was released May 2025; levels L1, L2, L3 nest; E17, UNVERIFIED secondary). Why L2: the platform stores hiring data about identifiable people, has a privileged tier (recruiters, admins), and controls Docker. L1 is "minimum for any app" and too light for this. L3 is for high-stakes systems (health, finance) and too costly. **Apply Level 3 selectively** to the orchestrator and admin functions (Section 3.3.4).
Chapters to track in `docs/traceability.md` (names from memory of ASVS 5.0; confirm numbering at asvs.dev): authentication, session management, authorization, self-contained tokens, OAuth, cryptography, configuration, data protection, logging and error handling, API, business logic, file handling, communication security, frontend security. Treat the ASVS checklist as a table: requirement ID, how met, test, result.

**3.3.2 Controls (short list)**
| Area | Baseline |
|---|---|
| Sessions | Opaque ID, HttpOnly, Secure, SameSite=Lax, `__Host-` prefix; idle timeout 30 min (Admin 15), absolute 12 h; rotate ID at login and privilege change; "log out everywhere"; list and revoke sessions |
| CSRF | SameSite cookie **plus** a CSRF token (double-submit or synchronizer) on all state-changing calls; require `Origin` check; JSON-only content type |
| CORS | Same-origin through the proxy, so **no CORS** in production. If needed, an exact allowlist, never `*` with credentials |
| Headers | Strict CSP (nonce-based, no inline script), HSTS, `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'`, Referrer-Policy, Permissions-Policy, `Cache-Control: no-store` on authenticated pages |
| Input/output | Pydantic validation on every endpoint, parameterized SQL only, output encoding by React, file uploads avoided on the platform |
| Passwords | Argon2id, breached-password check, generic error messages, per-account and per-IP throttling, lockout with backoff (not permanent) |
| Secrets | `.env` never committed; Docker/Compose secrets or the host's secret store; gitleaks in CI; separate secrets for dev and prod; **flag values and HMAC keys never in logs, API responses to other users, or the shop container's reach** (RS-B owns flag generation) |
| Audit log | Append-only table: who, what, target, time, IP, result; covers login, role change, approval, invite, candidate data view and export (D-12), instance create/destroy, admin actions. No secrets or passwords in it. Retention and export rules come from RS-H |
| Errors | No stack traces to clients; request ID in every response and log line |
| Dependencies | Lockfiles, Dependabot or Renovate, weekly audit; Next.js ships security releases often (UNVERIFIED, E3), so patch fast |
| Transport | TLS everywhere via the reverse proxy; internal services on a private network |

**3.3.3 Anti-abuse**
Signup and invite endpoints are free-tier email bombs. Per-IP and per-email rate limits, a CAPTCHA (Cloudflare Turnstile is free; not read, UNVERIFIED) on learner signup, disposable-email blocking for recruiters (D-04), and a hard daily cap on outgoing invites per organization.

**3.3.4 Protecting the orchestrator (privilege risk)**
Anything that can talk to the Docker socket can become root on the host (OWASP Docker Security Cheat Sheet, Rule 1: do not expose the Docker daemon socket; E18, search summary of the primary page).
- **The public API must not hold the socket.** Only a small **orchestrator** service does, and it is reachable only from the job queue or an internal network, never from the internet.
- Put a **socket proxy** (Tecnativa `docker-socket-proxy` or equivalent) in front of the socket with only the needed API sections on; or run **rootless Docker / a separate VM** (final choice is RS-B and RS-A territory). E19.
- The orchestrator accepts **instance IDs only**, never an image name, volume, command, port or network from a request. Images come from a fixed allowlist, pinned by digest; every container gets fixed CPU, memory, PID and time limits, no `--privileged`, no host mounts, dropped capabilities, read-only filesystem where possible.
- Vulnerable containers sit on **per-instance networks with no route** to the platform DB, Valkey, the orchestrator or other instances, and with controlled egress (RS-B).
- Every orchestrator action is written to the audit log and rate-limited; Level 3 review and tests for this one service.

**3.3.5 STRIDE threat model of the platform (short)**
| Threat | Example | Main controls |
|---|---|---|
| Spoofing | Fake recruiter using a free mail address; stolen session | Work-email check, admin approval, MFA for admin, session rotation, rate limits |
| Tampering | Candidate edits score or flag state; forged monitor event | Scores computed server-side; monitor events signed (HMAC per instance); flags checked server-side; instance can only post to its own ID |
| Repudiation | Recruiter denies viewing a candidate; admin denies approving | Append-only audit log with actor, time, IP |
| Information disclosure | One learner reads another's results; recruiter sees practice history; flag leak from logs | Object-level authorization on every query (tenant and owner filters), privacy wall (D-05), no secrets in logs, tests for IDOR on the platform itself |
| Denial of service | Mass instance creation exhausts the laptop; signup floods | Per-user and per-org instance quotas, global instance cap, queue back-pressure, rate limits |
| Elevation of privilege | Escape from vulnerable container to host; abuse of orchestrator; role change via API | Isolation (RS-B), socket proxy, no public socket access, role changes only by Admin and audited, server-side role checks |
Special risk: **the platform is next to code built to be hacked**. Keep the vulnerable apps off the platform's network, on a separate Docker network or host, and assume any shop container is fully compromised.

### 3.4 Platform roles and lifecycles

**3.4.1 Permission matrix** (C = create, R = read, U = update, D = delete; "own" = own records only; "org" = own organization's records)

| Resource | Learner | Candidate | Recruiter | Org owner (a Recruiter) | Admin |
|---|---|---|---|---|---|
| Own profile, password, MFA, sessions | CRUD own | CRUD own | CRUD own | CRUD own | CRUD own |
| Challenge catalog, hints, own progress (practice) | R, use hints | none (hidden) | none | none | R |
| Practice instance | C, R, destroy own | none | none | none | R, force-stop |
| Assessment instance | none | start/resume own, destroy own after finish | none | none | R, force-stop |
| Assessment (template: challenges, time, hints, retention) | none | R own invite's summary | C, R, U org's own; D draft | C, R, U, D all in org | R all |
| Invites | none | accept/decline own | C, R, resend, revoke (org) | same + see all org | R, revoke any |
| Candidate results, evidence, time per challenge | none | R, export own | R (org's assessments only; every view logged) | R all in org | R only through logged "break-glass" access |
| Candidate data deletion | request own | request own | delete org's candidates | same | R, D any |
| Organization settings, members | none | none | R | U, invite/remove recruiters | R, U, suspend |
| Recruiter approval queue | none | none | none | approve same-domain join requests (option B) | C, R, U (approve/reject/suspend) |
| User management (lock, reset, delete) | none | none | none | none | RU all |
| Audit log | R own activity | R "who viewed my data" | R org's activity | R org's activity | R all |
| System settings (quotas, retention defaults, flags on/off) | none | none | none | none | RU |
| Instance monitoring, capacity | none | none | none | none | R, force-stop |

Notes: a person can be Learner and Candidate at once (D-05). The Recruiter never sees practice history. Admin has **no default access to candidate answers**; use a logged break-glass action with a reason, as a privacy by design measure (D-12).

**3.4.2 Company (tenant) model.** How the platforms do it:
- **HackerRank for Work:** one company account; four roles (Company Admin, Developer, Interviewer, Recruiter); admins invite users by email, link or CSV and pick role and teams; Team Admins manage team members; admins can cap role counts per team. (E20, search summary of the help center.)
- **HackerEarth:** teams and admins inside a company; Super Admin adds admins; new admins get "Test admin" access first; per-test access (All / Questions only / Reports only); admin requests are approved by a Super Admin. (E21.)
- **Hack The Box Enterprise:** organization-wide user management with teams and roles; **role names and permissions not found** in sources I could read. (E22.) D-04's own sources also say HTB accounts are sales-led.
- **Immersive Labs:** not found.

| Option | What it means | Pro | Con |
|---|---|---|---|
| A. No tenant | Each recruiter is alone | Simplest | Colleagues cannot share assessments; blocks future SaaS goal (O6) |
| **B. Organization with members (recommended)** | Recruiter belongs to one Organization; first recruiter becomes Org owner; same-domain colleagues request to join and the owner approves; Admin approves new organizations and can suspend any | Matches HackerRank and HackerEarth; keeps D-04 (admin approval at the entry point); ready for multi-tenant SaaS | A few more tables |
| C. Full B2B with SSO, SCIM, custom roles | Enterprise grade | Future SaaS | Far too much now |
Design in B: add `organization_id` to every recruiter-owned resource from day one, and filter by it in one central place. That makes later SaaS a data change, not a redesign.

**3.4.3 Separate accounts for Recruiter and Admin? (D-05 left this open)**
Recommendation: **keep one `user` table and one login system, but give each account a type: Participant (Learner and/or Candidate), Recruiter, or Admin. A Recruiter or Admin account cannot also hold Learner or Candidate roles.** Reasons: (1) the privacy wall is simpler to prove, since a recruiter identity can never reach participant data by role mixing; (2) Recruiter and Admin need work-email, stronger MFA and shorter sessions; (3) it avoids a recruiter practising on the same account that reviews others. An Admin should be added by another Admin or a seed command, never by signup. Cost: a person who is both a student and a recruiter needs two emails; accept that. This does not contradict D-05 (which concerns learner and candidate).

**3.4.4 Invite lifecycle.** Recruiter creates invite for an email address on an assessment. System emails a single-use link containing a random token (stored hashed; expires in 7 days by default). Candidate opens link, logs in or registers (verified email must match the invite email, or the invite is bound after the candidate confirms), sees the **consent screen** (D-12), accepts, and the Candidate role is added to their account. Candidate can start within a window. Recruiter can resend (new token, old one dead) or revoke. Rate limit: invites per recruiter per day.

**3.4.5 State machines (text)**

Recruiter approval:
```
(signup) -> UNVERIFIED_EMAIL --verify link--> PENDING_APPROVAL --admin approves--> ACTIVE
UNVERIFIED_EMAIL --token expires (24h)--> EXPIRED --resend--> UNVERIFIED_EMAIL
PENDING_APPROVAL --admin rejects (reason)--> REJECTED  (may re-apply after N days)
ACTIVE --admin suspends--> SUSPENDED --admin reinstates--> ACTIVE
ACTIVE/SUSPENDED --delete--> DELETED (data removed per retention rules)
Only ACTIVE can invite candidates.
```

Invite:
```
DRAFT -> SENT --candidate opens + consents--> ACCEPTED --starts assessment--> STARTED --> COMPLETED
SENT --7 days--> EXPIRED ;  SENT --recruiter revokes--> REVOKED
SENT --candidate declines--> DECLINED
EXPIRED/DECLINED --recruiter reissues--> new invite (old one stays closed)
```

Assessment (the candidate's attempt):
```
NOT_STARTED -> IN_PROGRESS --all done or candidate submits--> SUBMITTED -> SCORED -> RESULTS_VISIBLE
IN_PROGRESS --time limit reached--> AUTO_SUBMITTED -> SCORED
IN_PROGRESS --inactive too long--> PAUSED (policy is RS-C) --resume--> IN_PROGRESS
Any state --recruiter/admin cancels--> CANCELLED
RESULTS_VISIBLE --retention period ends or deletion request--> DELETED
```

Instance (container set):
```
REQUESTED -> PROVISIONING --healthy + flags seeded--> RUNNING
PROVISIONING --error / timeout--> FAILED --retry (max 2)--> PROVISIONING
RUNNING --user reset--> RESETTING -> PROVISIONING
RUNNING --inactivity / session end / quota--> STOPPING -> DESTROYED
RUNNING --admin force-stop--> STOPPING -> DESTROYED
FAILED --retries used up--> DESTROYED (reconciler cleans leftovers)
A reconciler compares DB state with real containers every minute and fixes mismatches (orphans, zombies).
```

### 3.5 High-level API resource groups (split suggestion)
| Group | Examples | Suggested owner (can be swapped) |
|---|---|---|
| Auth and accounts | signup, login, logout, verify-email, password reset, MFA, sessions, profile | Dev 1 (platform core) |
| Organizations and recruiters | organizations, members, join requests, approval queue (admin) | Dev 1 |
| Invites and assessments | assessment templates, invites, consent, attempts | Dev 1 or 2 |
| Challenges and hints | catalog, hint levels, solution write-ups, tags (2021/2025, CWE, ATT&CK) | Dev 2 |
| Instances | create, status, reset, destroy, connection info; internal orchestrator API | Dev 2 (with RS-B) |
| Events and scoring | internal signed endpoint for monitor events, flag submit, attempts, scores, time per challenge, evidence | Dev 2 (with RS-C) |
| Dashboards and live | learner progress, recruiter reports, export, SSE streams | Dev 3 |
| Admin and audit | users, quotas, settings, audit log, break-glass access, capacity | Dev 3 |
| Privacy | consent records, export, delete request, retention jobs | Dev 3 (with RS-H) |
| Platform ops | health, readiness, metrics, version | any |
Internal endpoints (monitor to API, orchestrator to API) are separate from browser endpoints and use signed requests, not cookies.

## 4. Decision candidates for the user
1. **Live updates:** (a) SSE, (b) WebSockets as in the synopsis, (c) polling. Recommend **(a)**: all pushes are one-way and SSE is simpler and proxy-friendly.
2. **Job queue:** (a) Dramatiq on Valkey/Redis, (b) Celery, (c) Procrastinate on Postgres. Recommend **(a)** with instance state kept in Postgres; (b) if the team wants the biggest community.
3. **Login method:** (a) server-side session cookies, (b) JWT tokens, (c) hosted auth service. Recommend **(a)**: instant revoke and safer for a browser-only app.
4. **Redis or Valkey:** (a) Valkey (BSD licence), (b) Redis 8 (AGPLv3). Recommend **(a)**: no licence questions; same protocol.
5. **ASVS level for the platform:** (a) L1, (b) L2, (c) L3 everywhere. Recommend **(b)** with L3 only for orchestrator and admin.
6. **Company model:** (a) none, (b) organization with members and owner approval of colleagues, (c) full enterprise. Recommend **(b)**.
7. **Recruiter approval scope:** (a) admin approves every recruiter, (b) admin approves the organization once and the org owner approves colleagues. Recommend **(b)**; (a) is the literal D-04 and is fine for a demo.
8. **Separate accounts:** (a) fully separate login systems, (b) one login system with account types where Recruiter and Admin cannot also be Learner/Candidate, (c) any role on any account. Recommend **(b)**.
9. **Admin security:** (a) password only, (b) mandatory TOTP MFA for Admin, optional for Recruiter, (c) mandatory for both. Recommend **(b)**.
10. **Admin access to candidate answers:** (a) full by default, (b) only through logged break-glass with a reason. Recommend **(b)**.
11. **ORM:** (a) SQLAlchemy 2 + Alembic, (b) SQLModel. Recommend **(a)**: SQLModel is pre-1.0 and adds little.
12. **Frontend shell:** (a) Next.js 16 as in the synopsis, (b) Vite React SPA. Recommend **(a)** to match the synopsis, unless RS-A shows hosting trouble.
13. **Python version:** (a) 3.14, (b) 3.13. Recommend **(a)** if all dependencies install; else (b).
14. **Email service:** (a) Resend, (b) Brevo. Recommend **(a)** for developer experience; **(b)** if no domain is available (check sender rules first).

## 5. Evidence
| ID | URL | What it supports | Status |
|---|---|---|---|
| E1 | https://tech-insider.org/fastapi-tutorial-rest-api-python-2026/ | FastAPI 0.13x line, Python 3.9 dropped, Pydantic v1 removed (search summary only; version numbers disagree across sources) | UNVERIFIED |
| E2 | https://nextjs.org/support-policy | Next.js Active/Maintenance LTS policy, 2 years maintenance (seen in search results, not fetched) | UNVERIFIED |
| E3 | https://www.herodevs.com/blog-posts/nextjs-eol-dates-version-support-timeline | Next 15 EOL 2026-10-21, Next 14 EOL 2025-10-26, frequent security releases | UNVERIFIED |
| E4 | https://isitpatched.com/eol/postgresql , https://stack.watch/product/postgresql/postgresql/ | PostgreSQL 18 EOL 2030-11-14 | UNVERIFIED |
| E5 | https://www.theregister.com/2025/05/01/redis_returns_to_open_source/ ; https://phoronix.com/news/Linux-Foundation-Valkey ; https://redis.io/docs/latest/operate/rs/installing-upgrading/product-lifecycle/ | Redis 8 AGPLv3 option; Valkey BSD fork of 7.2.4; Redis Software 7.2 EOL 2026-02-28 | UNVERIFIED (CONFLICTING on open-source 7.2 EOL date; none found officially) |
| E6 | https://procrastinate.readthedocs.io/en/stable/discussions.html ; https://oneuptime.com/blog/post/2026-01-24-python-task-queues-dramatiq/view | Queue comparison; Arq maintenance-only claim came from an index of its repo | UNVERIFIED |
| E7 | https://github.com/Randroids-Dojo/typescript-and-python-bootstrap/pull/79 | Alembic/Pydantic versions seen; SQLModel version not reliably found | UNVERIFIED |
| E8 | https://oneuptime.com/blog/post/2026-02-20-jwt-vs-session-authentication/view | Sessions vs JWT trade-offs (revocation, state) | UNVERIFIED |
| E9 | https://owasp.org/www-project-application-security-verification-standard/ | ASVS has session and token chapters (not fetched) | UNVERIFIED |
| E10 | https://pypi.org/project/fastapi-users/ (README via mirror sites) | fastapi-users in maintenance mode | UNVERIFIED |
| E11 | https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html | Argon2id as first choice (from my own knowledge; not fetched) | UNVERIFIED |
| E12 | https://resend.com/docs/knowledge-base/account-quotas-and-limits | Free: 100 emails/day, 3,000/month, reset at UTC midnight (search summary quoting official docs) | UNVERIFIED |
| E13 | https://www.sendinblue.com/free-smtp-server/ and reviews | Brevo free 300/day, shared by marketing and transactional | UNVERIFIED |
| E14 | https://docs.github.com/en/billing/concepts/product-billing/github-actions | GitHub Free: 2,000 min/month, 500 MB; Windows 2x from a third-party calculator (depot.dev) | UNVERIFIED |
| E15 | https://endoflife.date/python (search snapshots; mirror https://endoflife.ai) | Python 3.13/3.14 support dates | UNVERIFIED (snapshots differed on patch numbers) |
| E16 | https://nodesource.com/blog/nodejs-24-becomes-lts ; https://endoflife.ai/article-nodejs-eol.html | Node 24 LTS to 2028-04 | CONFLICTING (one table labelled it "Current") |
| E17 | https://softwaremill.com/whats-new-in-asvs-5-0/ | ASVS 5.0.0, May 2025, levels L1-L3 | UNVERIFIED |
| E18 | https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html | Rule 1: do not expose the Docker socket | UNVERIFIED (search summary of primary page) |
| E19 | https://github.com/Tecnativa/docker-socket-proxy (via https://hub.docker.com/r/tecnativa/docker-socket-proxy/) | Socket proxy blocks API sections by setting | UNVERIFIED |
| E20 | https://hackerrank-knowledge-base.help.usepylon.com/articles/9603546665 ; https://hackerrank-knowledge-base.help.usepylon.com/articles/9482219268 | HackerRank roles and invite options | UNVERIFIED |
| E21 | https://help.hackerearth.com/hc/en-us/articles/360003388274-creating-teams-and-adding-admins ; https://help.hackerearth.com/hc/en-us/articles/360003089573-Accepting-admin-requests | HackerEarth teams, Super Admin, admin requests | UNVERIFIED |
| E22 | https://hackthebox.com/blog/user-management | HTB org-wide user management; roles not found | UNVERIFIED |

## 6. Open questions and spikes to run later
- **Verify all UNVERIFIED rows** on the official pages (the fetch tool was blocked here); especially Resend/Brevo limits, Actions minutes and the Windows multiplier, Python and Node end-of-life dates.
- **Spike:** Dramatiq vs Procrastinate with a fake provisioning job that is killed mid-way; check the reconciler repairs it.
- **Spike:** SSE through the chosen free-tier proxy/tunnel (Cloudflare Tunnel, Vercel, others) with HTTP/2; confirm it does not buffer or time out. Depends on RS-A.
- **Spike:** Argon2id cost parameters on the Ryzen laptop (target about 0.2-0.5 s per hash).
- **Spike:** whether Resend free works without a verified domain for demo recipients; whether the team owns a domain.
- **Spike:** socket proxy versus rootless Docker on Docker Desktop/WSL2 (Windows differs from Linux servers; the demo laptop is not the final host).
- Immersive Labs and HTB enterprise role models: not found; no claim made.
- Does a recruiter's organization need a company name verification beyond domain? Needs RS-H and user input.
- Hint, scoring, and "paused" policy details belong to RS-C.
- ASVS 5.0 chapter numbers and L2 requirement list must be read from asvs.dev when building the checklist.
- Possible tension with D-04: it says "admin approves recruiter"; decision 7 refines it to organization-level approval. Left for the user.

## 7. Impact on other streams
- **RS-A (hosting):** needs HTTP/2 + SSE support, a reverse proxy in front of API and web on the same origin, outbound email, and a place for workers and the orchestrator that can reach Docker. Free-tier web hosts cannot run the orchestrator.
- **RS-B (isolation):** must supply the orchestrator design, socket-proxy or rootless choice, signed monitor events, and network separation. The platform assumes instance IDs only cross the orchestrator boundary.
- **RS-C (scoring):** scoring is computed server-side from signed events; the assessment and instance state machines here need their pause/timeout rules.
- **RS-E/F (challenges):** challenge catalog fields (tags, hints, write-up) are an API resource; they must not store real flag values.
- **RS-G (shop):** the shop is a separate product with its own users and DB; it must call only the monitor/event contract, never the platform DB.
- **RS-H (privacy):** audit log, consent records, retention jobs and break-glass access are specified here as hooks; retention values and DPDP details come from RS-H.
