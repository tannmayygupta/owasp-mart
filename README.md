# VulnMart

**A hands-on hacking gym for the web.** VulnMart builds a realistic online shop that is broken on purpose, gives every learner a private copy of it, and lets them practise real attacks safely. Companies can use the same lab to test job candidates.

> New here? Read [What is VulnMart?](#what-is-vulnmart) first, then [Getting started](#getting-started). For a longer, friendly tour of how everything works, see the [Project Guide](docs/PROJECT-GUIDE.md).

---

## Contents

1. [What is VulnMart?](#what-is-vulnmart)
2. [The problem it solves](#the-problem-it-solves)
3. [Who uses it, and what they can do](#who-uses-it-and-what-they-can-do)
4. [The 11 challenges](#the-11-challenges)
5. [How it works](#how-it-works)
6. [What is inside this repository](#what-is-inside-this-repository)
7. [Getting started](#getting-started)
8. [Running the tests](#running-the-tests)
9. [Deploying it for real](#deploying-it-for-real)
10. [Configuration and secrets](#configuration-and-secrets)
11. [Documentation map](#documentation-map)
12. [How we work](#how-we-work)
13. [Safety and responsible use](#safety-and-responsible-use)
14. [Help, maintainers, licence](#help-maintainers-licence)

---

## What is VulnMart?

Imagine a driving school. Every student gets their own practice car, and the school can see how they drive.

VulnMart does the same for **web security**:

- It runs a **practice shop** (products, carts, orders, sellers, support tickets, gift cards) that has **11 security weaknesses planted in it**, one for each item of the well-known [OWASP Top 10](https://owasp.org/www-project-top-ten/) list.
- Every learner gets **their own private copy** of the shop, built in seconds. They attack it, find a hidden secret called a **flag** (it looks like `VM{...}`), paste it in, and earn points.
- Every flag is **different for every learner**, so answers cannot be copied or shared.
- A **platform** around the shop handles accounts, countdowns, scoring, hints, reports and live progress.

Nothing a learner does can hurt another learner, the platform, or anything else on the internet. The shop is dangerous on purpose; the sandbox around it is not.

## The problem it solves

| Problem | How VulnMart helps |
|---|---|
| Learning security from slides does not stick. | You attack a real, running shop and see what happens. |
| Practising on real websites is illegal and risky. | The target is a safe, private copy built to be broken. |
| Shared practice labs let people copy each other's answers. | Every learner gets their own copy and their own flags. |
| Hiring managers cannot easily check hands-on security skill. | A company invites a candidate, sets a time limit, and gets a scored, evidence-based report. |
| Running many throw-away labs by hand is slow and unsafe. | Labs are created, watched, reset and destroyed automatically in a sandbox. |

## Who uses it, and what they can do

| Role | What they do |
|---|---|
| **Learner** | Signs up, starts a private lab, works through the challenges one at a time with a countdown, uses hints, earns points (up to 1000 per run). |
| **Candidate** | Is invited by a company by email, gives consent, takes a timed assessment, and can withdraw. |
| **Recruiter** | Registers a company, creates assessment templates, invites candidates, watches progress live, reads reports and releases results. |
| **Admin** | Approves companies, sets limits and quotas, watches capacity and jobs, reads the audit log, and has audited emergency (break-glass) access. |

## The 11 challenges

Each challenge has a short brief, three hints (that cost points), a countdown (Easy 20, Medium 40, Hard 60 minutes) and a write-up of what was wrong and how to fix it.

| # | You will | OWASP area |
|---|---|---|
| C01 | Read a competitor's order | Broken Access Control |
| C02 | Forge a gift-card code | Cryptographic Failures |
| C03 | Inject SQL in the search box, and run a script in a support ticket | Injection |
| C04 | Make refunds add up to more than was paid | Insecure Design |
| C05 | Find a verbose error and an open operations console | Security Misconfiguration |
| C06 | Pollute the import service's objects | Software Supply Chain Failures |
| C07 | Brute-force a 4-digit password-reset code | Authentication Failures |
| C08 | Fake a "payment succeeded" message | Software or Data Integrity Failures |
| C09 | Guess a password on an old login nobody watches | Security Logging and Alerting Failures |
| C10 | Make the shop fetch its own cloud metadata | Server-Side Request Forgery |
| C11 | Crash a check so a seller is approved automatically | Mishandling of Exceptional Conditions |

The definitions live in [`challenges/catalog/`](challenges/catalog/) and the exploit tests in [`challenges/tests/`](challenges/tests/).

## How it works

```
 Browser                                  two servers (AWS EC2, Sydney)
    |
    |  https                 +-------------- vm-p  "platform" ---------------+
    +----------------------> | Caddy (front door, HTTPS)                     |
    |                        |   /api/*  -> API (accounts, scoring, rules)   |
    |                        |   pages   -> Dashboards (Next.js)             |
    |                        |   the rest-> Landing page + learner console   |
    |                        | Worker (background jobs, email via Brevo)     |
    |                        | PostgreSQL (data)   Valkey (queues, live)     |
    |                        +------------------------+----------------------+
    |                                                 | private, signed link
    |  https (one-time ticket)  +-------------- vm-i  "labs" -----------------+
    +-------------------------> | Edge + Gate (checks the ticket)           |
                                | Orchestrator (builds and destroys labs)   |
                                | one private LAB per learner:              |
                                |   sidecar -> shop  (+ import, mocks, bot) |
                                +-------------------------------------------+
```

In plain words:

1. **Two machines on purpose.** `vm-p` runs the real product (accounts, database, API). `vm-i` runs the dangerous practice shops. The shops can never reach the platform's data.
2. **A lab is built on demand.** When a learner presses *Start*, the platform tells the orchestrator to build a private network of small containers (the shop plus a few helpers). Each runs in a **gVisor** sandbox, with no outbound internet.
3. **Flags are personal.** Each flag is a keyed fingerprint of a secret key, the lab's id, the challenge and a counter that goes up on every reset. A reset gives new flags and old ones stop working.
4. **A watcher (sidecar)** sits in front of each shop, notices when a real flag appears in a response, and reports it, so progress is credited automatically.
5. **Everything is checked.** Contracts (OpenAPI) describe every interface, tests prove them, and CI blocks a merge when something breaks.

The full story, step by step, is in the [Project Guide](docs/PROJECT-GUIDE.md).

## What is inside this repository

| Folder | What it holds |
|---|---|
| [`apps/api`](apps/api) | The platform API and background worker (Python, FastAPI). |
| [`apps/web`](apps/web) | The dashboards for recruiter, candidate, admin and account pages (Next.js). |
| [`apps/lab-console`](apps/lab-console) | The landing page and the learner's lab console (plain HTML, CSS, JavaScript). |
| [`apps/orchestrator`](apps/orchestrator) | The service that builds, resets and destroys labs (Python). |
| [`apps/edge`](apps/edge) | The labs' front door and ticket gate (Node.js). |
| [`apps/shop`](apps/shop) | The practice shop with the 11 planted weaknesses (Node.js, Express, SQLite). |
| [`services/`](services) | Lab helpers: `sidecar` (watcher), `import-service`, `mock-services`, `bot` (support-agent browser). |
| [`packages/`](packages) | Shared libraries: scoring and attempt rules, generated models, a typed client. |
| [`contracts/`](contracts) | The agreed interfaces (OpenAPI and schemas) between the parts. |
| [`challenges/`](challenges) | The challenge catalogue and the exploit tests that prove each challenge works. |
| [`infra/`](infra) | Terraform for AWS, Docker Compose files, host setup scripts. |
| [`scripts/`](scripts) | Developer, deploy and verification commands. |
| [`tests/`](tests) | Browser tests (Playwright). |
| [`docs/`](docs) | Everything written down: guide, requirements, architecture, runbooks, decisions, dev-log. |

## Getting started

### What you need

| Tool | Version | Why |
|---|---|---|
| **Git** | any recent | Get the code. |
| **Node.js** | 24 (see `.node-version`) | Dashboards, shop, scripts. |
| **pnpm** | 12.10.1 (pinned in `package.json`) | JavaScript packages. |
| **uv** | recent (see CI) | Python packages and tests. Python 3.14 is installed by `uv`. |
| **Docker Desktop** | with Compose | Runs the databases, API and labs. Must be **running** for most commands. |

Windows, macOS and Linux work; the commands below are the same. (On Windows use PowerShell.)

### 1. Get the code and install

```bash
git clone <this repository>
cd <the folder git created>
git config core.hooksPath .githooks      # once per clone: enables the documentation check on commit
pnpm install                              # JavaScript dependencies
node scripts/dev.mjs doctor               # prints each tool's version with PASS or FAIL
```

If `doctor` shows a FAIL, fix that tool first (for example, start Docker Desktop).

### 2. Start the platform on your computer

```bash
node scripts/dev.mjs up platform web
```

The first run builds images and takes a few minutes. Then open:

| What | Address |
|---|---|
| Dashboards (sign up, sign in, recruiter and admin pages) | <http://127.0.0.1:3000> |
| API | <http://127.0.0.1:8000> (health: `/healthz`) |
| Fake inbox (**Mailpit**): every email the platform sends lands here | <http://127.0.0.1:8025> |

Try it:

1. Open <http://127.0.0.1:3000/signup> and create an account.
2. Open Mailpit (<http://127.0.0.1:8025>), find the confirmation email and click its link.
3. Sign in at <http://127.0.0.1:3000/login>.

To stop: `node scripts/dev.mjs down`. To also wipe the local database: `docker compose -f infra/compose/compose.yaml --profile platform --profile web down -v`.

### 3. Create an admin (optional)

Admins can only be created on the server side, never by sign-up. Follow [`docs/runbooks/seed-admin.md`](docs/runbooks/seed-admin.md): one command with a password you type yourself, then set up an authenticator app on the account page. After that `/admin` shows pending companies, settings and the audit log.

### 4. Try the practice shop on its own

This starts only the shop, with every weakness switched on, on your own computer:

```bash
node apps/shop/dev/serve-local.mjs        # listens on 127.0.0.1:3200 only
```

Open <http://127.0.0.1:3200>. Look at the challenge definitions in [`challenges/catalog/`](challenges/catalog/) for what each challenge expects, and its start accounts. Press `Ctrl+C` to stop.

### 5. See labs being built (local demo)

```bash
node scripts/dev.mjs demo
```

This runs the platform stack, the real orchestrator and a lab on your machine, checks each step, and cleans up. Details and options: [`docs/runbooks/local-demo.md`](docs/runbooks/local-demo.md). The full learner experience (landing page, console, live labs) is the deployed system; see [Deploying it for real](#deploying-it-for-real).

## Running the tests

| What | Command | Needs Docker? |
|---|---|---|
| Script tests | `node --test "scripts/*.test.mjs"` | No |
| API tests | `uv run --package vulnmart-api pytest apps/api` | No (a Postgres-backed subset runs in CI) |
| Shop tests | `cd apps/shop && node --test` | No |
| Challenge exploit tests (each challenge works in the vulnerable build and fails in the fixed one) | `node --test "challenges/tests/*/*.test.mjs"` | No |
| Contracts (interfaces) | `pnpm run contracts:check` | No |
| Challenge catalogue | `pnpm run catalog:check` | No |
| Learner console | `node --test scripts/lab-console.test.mjs` | No |
| End-to-end with real containers | `pnpm run test:e2e` | Yes |
| Browser tests of the dashboards | `pnpm --dir tests/web-e2e install --ignore-workspace` then `E2E_BROWSER_CHANNEL=chrome pnpm --dir tests/web-e2e exec playwright test` | No (uses your Chrome) |
| Browser walkthrough of the practice shop | in `tests/web-e2e`: `pnpm exec playwright test -c playwright.shop.config.mjs` | No |

Every pull request also runs these checks automatically on GitHub (see [`.github/workflows`](.github/workflows)).

## Deploying it for real

A real deployment is two small AWS EC2 servers (`vm-p` and `vm-i`) described in code. The short version:

1. **AWS account and servers.** Create the account and run Terraform in `infra/terraform/aws` ([`docs/runbooks/aws-account-and-vms.md`](docs/runbooks/aws-account-and-vms.md)).
2. **Names and HTTPS.** Free DuckDNS names and Let's Encrypt certificates ([`docs/runbooks/certificates.md`](docs/runbooks/certificates.md)).
3. **Secrets.** `node scripts/deploy-secrets.mjs --out <folder outside the repo> ...` creates keys and certificates. Add your email provider key (Brevo) to that folder yourself.
4. **Build and ship.** `node scripts/live-deploy.mjs build`, then `ship-i` and `ship-p`.
5. **Start.** `node scripts/live-deploy.mjs lab --secrets <folder> --zone <labs name>` and `node scripts/live-deploy.mjs platform --secrets <folder> --zone <labs name> --platform-host <platform name> --mail-sender <verified address>`.
6. **Check.** `node scripts/verify-deployed.mjs --base https://<platform name>`, and `node scripts/live-deploy.mjs data-counts` to see row counts before and after any change.

The complete, exact steps are in [`docs/runbooks/live-deploy.md`](docs/runbooks/live-deploy.md). Backups and restores: [`docs/runbooks/backup-and-restore.md`](docs/runbooks/backup-and-restore.md). The servers cost money while they run; the runbook shows how to stop the labs host.

## Configuration and secrets

- **Nothing secret is ever committed.** Keys, passwords, certificates, API keys and server addresses live in files outside the repository (for example `%USERPROFILE%\.vulnmart-deploy\prod`) and in git-ignored local files.
- Settings reach the services as environment variables or secret files; the deployed Compose files in [`infra/deploy`](infra/deploy) show which ones each service reads.
- Local development uses safe defaults and the Mailpit fake inbox, so you need no external account to start.

## Documentation map

| If you want... | Read |
|---|---|
| A plain-language tour of the whole project | [`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md) |
| All documents, grouped | [`docs/README.md`](docs/README.md) |
| What the system must do | [`docs/prd/PRD.md`](docs/prd/PRD.md) |
| How it is designed | [`docs/architecture/`](docs/architecture/README.md) |
| The 11 challenges in detail | [`docs/design/challenge-specs.md`](docs/design/challenge-specs.md) |
| Why a decision was made | [`docs/adr/`](docs/adr/README.md) |
| How to run, deploy and fix things | [`docs/runbooks/`](docs/runbooks/) |
| What was done, task by task | [`docs/dev-log/`](docs/dev-log/README.md) |
| Security checklist against ASVS | [`docs/security/asvs-checklist.md`](docs/security/asvs-checklist.md) |
| What changed over time | [`CHANGELOG.md`](CHANGELOG.md) |
| The source of truth for decisions and open questions | [`initial.md`](initial.md) |

## How we work

- **One branch and one pull request per piece of work.** Never commit to `main`. A pull request is merged only when all CI checks are green.
- **Contract first.** Interfaces are written down in [`contracts/`](contracts) and checked by tools; a change that would break users needs a version bump.
- **Documentation is part of the work.** Every change adds a dev-log entry, a changelog line and an updated traceability row; a commit hook checks this (`git config core.hooksPath .githooks` once per clone).
- **Tests prove it.** A task is done when its tests ran and passed, not when the code compiles.
- The project is built with [Claude Code](https://claude.com/claude-code) using the BMAD workflow skills in `.claude/` and `_bmad/`; the working rules are in [`CLAUDE.md`](CLAUDE.md). Do not update those skills without agreeing it first (`node scripts/verify-skills.mjs` checks they are unchanged).

## Safety and responsible use

VulnMart contains **deliberately vulnerable code**. Run it only on your own computer or on servers you own, never expose the practice shop directly to the internet outside its sandbox, and **only attack your own lab**. The weaknesses are for learning; using these techniques against anything else is illegal.

## Help, maintainers, licence

- **Something not working?** Check the troubleshooting parts of the runbooks in [`docs/runbooks/`](docs/runbooks/), then open an issue or ask the maintainer.
- **Maintainer:** Tanmay ([`@tannmayygupta`](https://github.com/tannmayygupta)).
- **Licence:** no open-source licence has been chosen yet. Until one is added, all rights stay with the authors.
