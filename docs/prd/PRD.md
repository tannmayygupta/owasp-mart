# VulnMart — Product Requirements Document (PRD)

| | |
|---|---|
| **Version** | 0.1 (draft for the user's review) |
| **Date** | 2026-10-08 |
| **Product** | VulnMart, a containerized, flag-based vulnerable web application for OWASP Top 10 training and automated penetration-test assessment (also pitched as the "OWASP Vulnerable Practice-and-Hiring Platform"; final name is OPEN, see OI-5) |
| **Team** | Tanmay Gupta, Akshay Gupta, Sahil Roy (developers, building with Claude Code) |
| **Inputs** | `initial.md` (source of truth, decisions D-01 to D-27 are LOCKED), research notes RS-A to RS-H in `docs/research/`, the September 2026 synopsis (summarised in `initial.md`) |
| **Next document** | Architecture document, then three independent work-streams |

## How to read this PRD

- **Status values.** Every requirement has exactly one status.
  - **Locked**: fixed by a locked decision (D-number) or by a synopsis fact, or derived directly from one. Where a research note adds a detail that no decision fixed, the detail is written in the requirement and marked "(detail from RS-x)" or "placeholder, to be tuned". It does not change the decision.
  - **OPEN**: something needed is not decided. The requirement says "OPEN (see OI-n)" and the question is in Section 11.
  - **Spike-dependent**: a measured result is needed before the target number is fixed. The spike is named.
- **Priority.** Full scope was chosen (D-13), so there is no cutting and no time-based priority. Every requirement is **Must** unless it says **Spike-dependent**.
- **Placeholders.** A number marked "placeholder, to be tuned" is a starting value taken from research. It becomes final only after the named spike or pilot.
- **Sources.** D-nn = decision in `initial.md` Section 15. F1 to F11 and O1 to O6 = synopsis requirements and objectives as listed in `initial.md`. RS-x = research note.
- **Secrets.** No real flag values, keys or personal data appear in this document.
- **Not legal advice.** Privacy requirements follow the research notes and are not a legal opinion (see OI-33).

---

# 1. Overview

## 1.1 Purpose

VulnMart is one platform with two uses. Students practise hacking on a realistic online marketplace. Companies use the same platform, unchanged, as a technical hiring round for interns and freshers. Each person gets a private copy of the marketplace to attack. Hidden flags prove a successful attack. The platform detects this automatically and shows results on dashboards.

## 1.2 Problem

**Hiring side.** Companies cannot verify real pentesting skill. Whiteboard questions test describing an attack. Certificates prove studying a syllabus. Neither proves the person can find and exploit a bug in a running application.

**Student side.** DVWA and WebGoat feel outdated. They show each bug alone, like a checklist, in an interface that looks nothing like a real product. Practice there only partly transfers to real applications, where a bug must be discovered, not picked from a menu.

**Need.** One application that gives learners a realistic practice space and gives recruiters a standard, objective score.

## 1.3 Vision

A believable online marketplace (customers, sellers, support, finance, admin) that hides 11 realistic vulnerabilities covering all OWASP Top 10 categories of both the 2021 and 2025 editions. Every user attacks a private, isolated copy. The platform scores the result fairly, protects the privacy of the people it assesses, and can later grow into API security, mobile security and a hosted multi-tenant service.

## 1.4 Goals

| ID | Goal | Link |
|---|---|---|
| G-1 | Provide a realistic marketplace vulnerable across all OWASP Top 10 categories, with 11 challenges tagged with OWASP 2025 and 2021. | O1, F2, D-06, D-09, D-10 |
| G-2 | Give every user an isolated, containerized instance so exploits never affect other users or the host. | O2, F1, F7, F8, D-23 |
| G-3 | Detect exploitation automatically with a unique flag per instance, and accept a pasted flag as backup. | O3, F3, D-01, D-02 |
| G-4 | Show two role-based views of the same results: learner (hints, progress) and recruiter (score, time, technique, evidence). | O4, F4, F5 |
| G-5 | Run self-paced learning and hiring assessments on the same platform without modification. | O5, D-03, D-05 |
| G-6 | Keep the design extensible to API security, mobile security and hosted multi-tenant SaaS. | O6, D-19 |
| G-7 | Treat candidate privacy as a design requirement (consent, minimum data, auto-delete, audit log). | F10, D-12, D-25 |
| G-8 | Be fair and explainable in hiring mode: score correctness, show time separately, never auto-reject a person. | D-22 |
| G-9 | Run online within free tiers now and move to a paid server later with no architecture change. | D-15, D-16, constraints in `initial.md` Section 12 |

## 1.5 Non-goals

- Webcam, microphone, screen recording or ID-photo proctoring (D-12, D-22).
- A global public leaderboard (D-22).
- Speed-weighted scoring, dynamic point decay, or a pause button in hiring mode (D-22).
- Automatic rejection or automatic zero score for a suspected cheater (D-22).
- Real payments, real KYC documents, real cloud credentials, real personal data anywhere in the shop (D-24, RS-G, RS-H).
- Users under 18 (D-25).
- API-security and mobile-security challenges, and a hosted multi-tenant SaaS, in this release (future scope, Section 3.3).
- Enterprise single sign-on, SCIM or custom roles (RS-D option C, not chosen).
- Any paid service (free tiers only).

## 1.6 Success measures

The synopsis evaluation names three measures. The research adds more. All targets are OPEN or placeholders until a pilot exists (OI-3, OI-4).

| ID | Measure | How it is measured | Target |
|---|---|---|---|
| SM-1 | **Completion rate** (synopsis) | Share of pilot participants who reach each milestone and capture each flag, per challenge | OPEN (pilot, OI-4) |
| SM-2 | **Time per vulnerability** (synopsis) | Median wall-clock time to capture, and estimated active time, per challenge, from the event log | OPEN (pilot, OI-4) |
| SM-3 | **Accuracy of automated scoring** (synopsis) | Agreement between automatic credit and a manual check of the same attempts; zero credit given without a real exploit; zero real exploits missed | OPEN (pilot, OI-4) |
| SM-4 | Exploit verification | For each of the 11 challenges, the automated test succeeds on the vulnerable build and fails on the fixed build (RS-E, RS-F) | All 11 pass (proves F2) |
| SM-5 | Instance time-to-ready | Time from request to "ready" for a cold start | Spike-dependent (RS-B proposes under 15 s cold; a guess, not measured) |
| SM-6 | Classifier accuracy | Share of captures where the automatic technique label matches the true technique | Spike-dependent (S-6) |
| SM-7 | Integrity-review quality | Share of held captures that a human confirms as suspicious (false-positive rate) | OPEN (pilot) |
| SM-8 | Retention jobs on time | Share of due deletions completed on schedule | 100 percent (derived from D-25) |

---

# 2. Users and roles

## 2.1 Platform roles (D-03, D-04, D-05, D-19)

These are the real people who use the VulnMart platform. The shop's own fictional users are in 2.3.

| Role | How they get in | What they can do | Cannot do |
|---|---|---|---|
| **Learner** | Open signup (18 or over), verified email | Start and reset practice instances; use free three-level hints; see own progress and captured flags; read the write-up after solving; export or delete own data | See anyone else's data; use the recruiter or admin area |
| **Candidate** | Invited by a recruiter; may be the same person and same login as a Learner (D-05) | Read the consent notice; start the assessment instance once; submit; see and export own results; request deletion; withdraw consent; see company-level view history | Practise inside the assessment; pause; reattempt alone |
| **Recruiter** | Self-signup with a work email, verify email, belongs to a company (organization); the company is approved once by an Admin (D-19) | Create assessments; invite candidates; watch attempts live; review score, time, technique, evidence and hints used; review held captures; delete the company's candidates' data | See a candidate's private practice history; see other companies' data |
| **Org owner** | The first recruiter of a company | Everything a Recruiter can, plus approve colleagues who ask to join, manage members and company settings | Approve a company (Admin only) |
| **Admin** | Created by another Admin or a seed command, never by signup (RS-D, D-19) | Approve companies; suspend or reinstate users and companies; operate the platform (capacity, quotas, settings, force-stop instances); read the audit log; use break-glass | Read candidate answers without a logged break-glass step; hold Learner or Candidate roles |

## 2.2 Account and approval rules

| Rule | Source |
|---|---|
| One account per person for Learner and Candidate. An invited Learner gains the Candidate role on the same login. The recruiter sees only the invited assessment, never practice history (privacy wall). The assessment runs as a separate attempt in a separate instance. | D-05 |
| Recruiter and Admin accounts are separate account types. They cannot also hold Learner or Candidate roles. A person who is both a student and a recruiter needs two emails. | D-19, RS-D 3.4.3 |
| Recruiter onboarding: sign up with a work email, verify the email, stay "pending" until approved. Disposable addresses are blocked. | D-04 |
| Company model: a recruiter belongs to a company. An Admin approves the company once. The company owner approves colleagues. Only an active recruiter in an approved company can invite candidates. | D-19 |
| Admin login needs an authenticator app (TOTP). It is optional for Recruiters. | D-19 |
| Admins read candidate answers only through a logged "break-glass" step with a written reason. | D-19 |
| Players must be 18 or over (self-declared). | D-25 |

## 2.3 Shop roles (D-11, D-27)

The marketplace has six fictional roles. Rule from D-11: every role must carry at least one challenge. D-27: a role "carries" a challenge if it is the attacker's role, the victim, the target, or used in the exploit.

| Shop role | What it can do in the shop (summary of the RS-G matrix) | Carries |
|---|---|---|
| Customer | Browse, search, cart, pay (simulated), view own orders, review purchased items, request refunds, open disputes, create tickets | C04 (attacker), C02, C07 and C08 (start state) |
| Seller owner | Runs one store; creates and edits products; sees own store's orders and payouts; approves refunds under a limit; manages staff; starts "pending" until an Admin approves | C01, C10, C11 |
| Seller staff | Limited help in one store: create and edit products, update fulfilment, see own store's orders; no delete, no price change, no payouts by default | C01 (attacker's start account) |
| Support agent | Reads any order; handles tickets and disputes; moderates reported reviews; the simulated victim (bot) that views user-written content | C03 stored XSS (victim), C09 (dormant account is the target) |
| Finance | Sees commissions and payouts; approves payouts; sees order amounts but no personal data | C07 (target) |
| Admin | Approves sellers and products; manages users; resolves escalated disputes; sees the audit log and security alerts | C11 (bypassed approver), C09 (alerts page) |

---

# 3. Scope

## 3.1 In scope

- The vulnerable marketplace with login, checkout, seller, support, finance and admin areas, and 11 challenges tagged with OWASP 2025 and 2021 (D-06, D-09, D-10, D-26).
- Per-user Docker isolation, automatic teardown and reset (O2, F1, F6, F8).
- Flag detection and scoring backend (O3, F3).
- Learner, recruiter, candidate and admin dashboards with live updates (O4, F4, F5, D-17).
- Logging of every attempt and flag capture (F7).
- Recruiter and company approval, candidate invites, consent screen, auto-delete, audit log (F9, F10, D-04, D-12, D-19, D-25).
- Hints, scoring, anti-cheat and assessment sessions (D-08, D-22).
- Online deployment on free tiers (D-15, D-16).
- Full scope with no feature cutting (D-13).
- Documentation system with dev-log, decision records, changelog and traceability (D-14).

## 3.2 Out of scope now

Everything in the non-goals list (1.5), plus: paid hosting, a paid domain, proctoring, real-money flows, challenges for API or mobile security, and a multi-tenant SaaS offering to outside companies.

## 3.3 Future scope and the extensibility requirements it creates (O6)

| Future item | Requirement that keeps the door open |
|---|---|
| OWASP API Security Top 10 | NFR-EXT-02 (challenge catalogue is data, instance template is per target app), NFR-EXT-03 (shop exposes a JSON API next to its HTML pages) |
| OWASP Mobile Top 10 | NFR-EXT-02 (a new target type can be added without changing the orchestrator contract) |
| Hosted multi-tenant SaaS | NFR-EXT-01 (organization identifier on every recruiter-owned record, filtered in one central place), NFR-POR-01 (move to paid servers by configuration), NFR-EXT-04 (instance host is a configuration value) |

---

# 4. User journeys

## 4.1 Learner

1. Opens the site and signs up with email and password. Declares they are 18 or over. Verifies the email.
2. Sees the challenge catalogue with both OWASP tags, difficulty and a progress view.
3. Starts a practice instance. Waits for "ready" and sees live status.
4. Attacks the private shop. The monitor records requests and milestones.
5. Needs help: opens hint level 1, 2 or 3. Hints are free, never reveal the flag, and are recorded.
6. Captures the flag. The platform detects it automatically and credits it at once. If the flag was found in a way the monitor cannot see, the learner pastes it instead.
7. Reads the post-solve write-up (vulnerable line, fix, tags). Sees stars, solved tick and an optional "no hints" badge.
8. Resets the instance when needed (new flags, milestones kept). The instance stops after 60 minutes of inactivity or 4 hours at most.
9. Later: exports or deletes own data. Data is deleted 12 months after last login, with a 30-day warning.

## 4.2 Candidate

1. Receives an email invite from a recruiter (single-use link, expires in 7 days by default).
2. Opens the link, logs in or registers (18 or over), and verifies the email.
3. Reads the plain-language consent screen: what is recorded, why, who sees it, how long it is kept, how to withdraw. Accepts (not pre-ticked) or declines.
4. Sees the assessment rules: time limit (120 minutes default), hints off or on with cost, one attempt, no pause.
5. Starts. The platform creates a separate instance. The clock follows the rules in FR-SES-01.
6. Attacks. Warnings appear before the end. Milestones and captures are credited automatically.
7. Submits, or the time limit hits and the attempt is auto-submitted. The instance is frozen for 15 minutes, then destroyed.
8. Sees own results when the recruiter's setting allows (OI-15), exports them (JSON and CSV), sees which company viewed them, and may request deletion or withdraw consent (7-day undo).

## 4.3 Recruiter

1. Signs up with a work email, verifies it, and creates or asks to join a company. A new company waits for Admin approval. A colleague waits for the owner's approval.
2. Accepts the data-processing terms (the company is the controller of candidate data).
3. Creates an assessment: challenge set, time limit, hints policy, retention (30 to 365 days, default 180), invite expiry.
4. Invites candidates by email. Can resend, revoke, or re-invite after a fault (the old attempt is kept).
5. Watches attempts live: state, milestones, captures, hints used.
6. Reviews results: total score out of 1000, per-challenge score, time to capture and estimated active time, technique label, tags, evidence (the capturing request), hints used, integrity flags.
7. Handles held captures: reviews the evidence and accepts or rejects the capture with a note. The platform never auto-zeroes.
8. Deletes a candidate's data when asked, or lets retention delete it. Every view and export by the recruiter is logged and visible to the candidate at company level.

## 4.4 Admin

1. Logs in with password plus authenticator code.
2. Reviews the company approval queue and approves, rejects (with reason) or suspends companies.
3. Operates the platform: sees capacity and running instances, force-stops an instance, sets quotas and retention defaults, checks that deletion and backup jobs ran.
4. Needs to read a candidate's answers (for example for a support case): starts break-glass, writes a reason, gets time-boxed access. An alert goes out and the use is reviewed afterwards.
5. Audits: reads the tamper-evident audit log, including the log of admin reads.

---

# 5. Functional requirements

Format of each requirement: ID and title, priority and status, one testable sentence, acceptance criteria (AC) a tester can check, then the source.

## 5.1 Accounts and onboarding (ACC)

**FR-ACC-01 · Learner signup** — Must · Locked
The system shall let any person aged 18 or over register as a Learner with an email address and password.
- AC: signup works with no invite; the form requires an "I am 18 or over" declaration and refuses to continue without it.
- AC: a Learner cannot reach recruiter or admin screens.
- Source: D-03, D-25; synopsis (learner open signup).

**FR-ACC-02 · Email verification** — Must · Locked
The system shall require email verification before an account can start an instance, accept an invite or (for recruiters) enter the approval queue.
- AC: the verification link is single-use and stored only as a hash; using it twice fails.
- AC: an unverified account cannot start an instance.
- AC: the link expires after 24 hours (placeholder, to be tuned; detail from RS-D); an expired link can be re-sent.
- Source: D-04, D-21; RS-D 3.1, 3.4.5.

**FR-ACC-03 · Login and sessions** — Must · Locked
The system shall authenticate users with server-side sessions in an HttpOnly, Secure cookie and passwords hashed with Argon2id.
- AC: logging out ends the session on the server at once; a stolen old cookie no longer works.
- AC: the session ID changes at login and at any privilege change.
- AC: passwords are never stored or logged in readable form.
- Source: D-21; RS-D 3.3.2.

**FR-ACC-04 · Session timeouts** — Must · Locked
The system shall end idle and long-running sessions, with a shorter idle limit for Admin.
- AC: idle timeout 30 minutes, Admin 15 minutes, absolute 12 hours (all placeholders, to be tuned; detail from RS-D, see OI-25).
- AC: a user can list and revoke their own sessions and log out everywhere.
- Source: D-21 (ASVS level 2); RS-D 3.3.2.

**FR-ACC-05 · Account types and separation** — Must · Locked
The system shall use one login system with three account types (Participant, Recruiter, Admin) and shall refuse to give a Recruiter or Admin account the Learner or Candidate role.
- AC: trying to accept a candidate invite with a Recruiter account fails with a clear message.
- AC: a Participant account can hold both Learner and Candidate roles.
- AC: role changes can only be made by an Admin and are written to the audit log.
- Source: D-05, D-19; RS-D 3.4.3.

**FR-ACC-06 · Candidate role on the same login** — Must · Locked
The system shall add the Candidate role to an existing Learner's account when they accept an invite, without exposing practice data to the recruiter.
- AC: after accepting, the same login can open both practice and assessment.
- AC: the recruiter's view of that person shows only the invited attempt.
- AC: deleting a candidate attempt does not delete the learner's practice data.
- Source: D-05; RS-H Q4 step 6.

**FR-ACC-07 · Multi-factor login** — Must · Locked
The system shall require an authenticator-app (TOTP) code for every Admin login and shall let Recruiters enable it optionally.
- AC: an Admin account without TOTP set up cannot reach any admin function.
- AC: a Recruiter can turn TOTP on and off with a re-login.
- AC: whether Recruiter MFA becomes mandatory later, and whether passkeys replace TOTP, is OPEN (see OI-13); TOTP is the minimum.
- Source: D-19; RS-D 3.1.

**FR-ACC-08 · Password reset and password quality** — Must · Locked
The system shall let users reset a forgotten password by email and shall reject passwords that appear in known breach lists.
- AC: reset links are single-use, hashed at rest and expire (placeholder: 24 hours, to be tuned).
- AC: error messages do not reveal whether an email has an account.
- AC: repeated failures lead to throttling with back-off, never a permanent lockout.
- Source: D-21 (ASVS level 2); RS-D 3.3.2.

**FR-ACC-09 · Self-service account management** — Must · Locked
The system shall let each user view and update their profile, change password and MFA, and delete their account.
- AC: a Learner who deletes the account has all practice data removed (with the 7-day undo window of FR-PRV-09).
- AC: a Candidate account deletion removes the person's attempts only through the deletion workflow of FR-PRV-08.
- Source: D-25; RS-D 3.4.1.

**FR-ACC-10 · Signup abuse protection** — Must · Locked (CAPTCHA: OPEN)
The system shall rate-limit signup, login, password reset and invite endpoints per IP address and per email, and shall block disposable email addresses for Recruiters.
- AC: a request above the configured limit receives HTTP 429 (limit values are placeholders, to be tuned).
- AC: a disposable-domain email cannot start a recruiter signup.
- AC: whether Learner signup also needs a CAPTCHA (research suggests Cloudflare Turnstile, not read) is OPEN (see OI-29).
- Source: D-04; RS-D 3.3.3.

**FR-ACC-11 · Admin account creation** — Must · Locked
The system shall create Admin accounts only through another Admin or a seed command, never through signup.
- AC: no public screen or API route creates an Admin.
- AC: creating an Admin writes an audit log entry.
- Source: D-19 ("admin added by the user"); RS-D 3.4.3.

## 5.2 Companies and approval (ORG)

**FR-ORG-01 · Recruiter signup** — Must · Locked
The system shall let a person sign up as a Recruiter with a work email, verify the email, and then hold the account as "pending approval".
- AC: states follow the recruiter state machine (unverified email, pending approval, active, rejected, suspended, deleted).
- AC: only an "active" recruiter in an approved company can invite candidates.
- Source: D-04, D-19; F9; RS-D 3.4.5.

**FR-ORG-02 · Company approval by Admin** — Must · Locked
The system shall create a company (organization) when the first recruiter signs up for it and shall require one Admin approval before the company becomes active.
- AC: the Admin approval queue lists pending companies with the owner's name and email domain.
- AC: approving the company activates its owner; no further Admin step is needed per colleague.
- AC: rejection needs a written reason that is shown to the applicant.
- Source: D-19, D-04; F9; RS-D 3.4.2 option B.

**FR-ORG-03 · Colleagues join through the owner** — Must · Locked
The system shall let recruiters with a matching company email domain request to join a company, and shall let only the company owner approve or reject them.
- AC: a join request from a different domain is refused or flagged for Admin review.
- AC: the owner sees the pending list and decides; the decision is audited.
- AC: the owner can remove a member; removed members lose access at once.
- Source: D-19; RS-D 3.4.2.

**FR-ORG-04 · Free-email addresses for recruiters** — Must · OPEN (see OI-10)
The system shall apply a rule for recruiters who sign up with a free email address (for example a public webmail address).
- AC: the rule is decided and written in OI-10 before this is built.
- AC: whatever the rule, disposable addresses stay blocked (FR-ACC-10).
- Source: D-04 (left to R-01, not decided).

**FR-ORG-05 · Admin controls over companies and recruiters** — Must · Locked
The system shall let an Admin reject, suspend and reinstate companies and recruiters, and delete them with data removal following retention rules.
- AC: a suspended recruiter cannot log in to the recruiter area or send invites; reinstating restores access.
- AC: a rejected applicant may re-apply after a waiting period (length is OPEN, see OI-11).
- AC: each action needs a reason and is audited.
- Source: D-04, D-19; RS-D 3.4.5.

**FR-ORG-06 · Company scoping of data** — Must · Locked
The system shall store an organization identifier on every recruiter-owned record and shall filter by it in one central place.
- AC: a recruiter from company A cannot read, change or guess the identifiers of company B's assessments, invites or candidates (tested on the platform itself).
- AC: a missing organization filter fails a test, not silently returns data.
- Source: D-19, O6; RS-D 3.4.2, 3.3.5.

**FR-ORG-07 · Data-processing terms** — Must · Locked
The system shall show a short data-processing terms page to the company owner at approval and record the acceptance.
- AC: a company cannot invite candidates before the terms are accepted.
- AC: the record holds company, user, version and time.
- Source: D-25 (company = controller, VulnMart = processor for candidates); RS-H.

**FR-ORG-08 · Invite caps per company** — Must · Locked
The system shall cap the number of invites a company can send per day.
- AC: the cap is configurable by an Admin; the default is a placeholder, to be tuned against email limits (NFR-CST-02).
- AC: reaching the cap shows a clear message and does not lose the pending invite list.
- Source: RS-D 3.3.3 (detail); D-21 (email limits).

## 5.3 Assessments and invites (ASM)

**FR-ASM-01 · Assessment template** — Must · Locked (some parameters OPEN)
The system shall let a recruiter create and edit an assessment template inside their company.
- AC: the template holds title; the challenge set (any of the 11); time limit (default 120 minutes; allowed range placeholder 30 to 480, see OI-25); hints setting (off by default, or on with a cost percentage); instance resets allowed (placeholder limit 3); submission limits; invite expiry (default 7 days); retention (default 180 days, range 30 to 365); whether a write-up is required or optional (OPEN, see OI-14); when the candidate sees results (OPEN, see OI-15).
- AC: per-instance flags, evidence capture, audit log and the consent screen cannot be switched off.
- AC: a template used by started attempts cannot change the rules those attempts already run under.
- Source: D-08, D-12, D-22, D-25; F11; RS-C 3.6.

**FR-ASM-02 · Create and send invites** — Must · Locked
The system shall let an active recruiter invite a candidate by email to an assessment.
- AC: each invite has a random single-use token (at least 128 bits), stored only as a hash, bound to one email address.
- AC: the invite is delivered through the email outbox (FR-NTF-02); it expires after the template's expiry (default 7 days; range placeholder 1 to 30).
- AC: the token never appears in logs.
- Source: D-22 (single-use expiring hashed links, 7-day expiry); F9; RS-C 3.5, RS-D 3.4.4, RS-H Q6. Token size differs between notes: see OI-25.

**FR-ASM-03 · Invite lifecycle** — Must · Locked
The system shall track each invite through created, sent, opened, consented, started, expired, cancelled, declined and revoked.
- AC: a recruiter can resend (new token, old token dead) and revoke.
- AC: expired, declined or revoked invites stay closed; a re-issue creates a new invite.
- AC: each state change is logged with time.
- Source: D-22; RS-C 3.6, RS-D 3.4.5.

**FR-ASM-04 · Accepting an invite** — Must · Locked
The system shall let the invited person log in or register, shall check that the verified email matches the invite, and shall show the consent screen before anything starts.
- AC: a different verified email cannot use the link (or it is bound only after the candidate confirms; see RS-D 3.4.4).
- AC: declining the consent ends the invite as "declined" and no data beyond the decline record is kept.
- AC: accepting adds the Candidate role (FR-ACC-06).
- Source: D-05, D-12; RS-D 3.4.4.

**FR-ASM-05 · Re-invite after a fault** — Must · Locked
The system shall let a recruiter grant a re-invite, which creates a new attempt, a new instance and new flags, and keeps the old attempt marked "superseded".
- AC: the candidate cannot start a second attempt on their own.
- AC: the old attempt's results stay visible to the recruiter until retention ends.
- Source: D-22; RS-C 3.6.

**FR-ASM-06 · Bulk invite handling** — Must · Locked
The system shall send invites through a queue so that a daily email cap delays mail but never loses it.
- AC: inviting 200 candidates when the daily cap is lower results in all invites sent over time, in order, with status visible.
- Source: D-21; RS-D 3.1.

## 5.4 Session lifecycle (SES)

An "attempt" is one candidate's run of one assessment.

**FR-SES-01 · Start of an attempt** — Must · OPEN (see OI-22)
The system shall start an attempt only after consent, email verification and a ready instance, and shall start the assessment clock at a defined moment.
- AC: the clock-start moment is decided in OI-22 (candidate presses Start, or the instance becomes ready). RS-A and RS-C favour "instance ready" so boot time does not count against the candidate.
- AC: the headline time (FR-TIM-01) starts from "instance ready".
- Source: D-22 (120-minute session; time from "instance ready"); RS-C 3.4, RS-A 7.

**FR-SES-02 · Server-side clock** — Must · Locked
The system shall enforce the time limit with the server clock only; the browser timer is cosmetic.
- AC: changing the browser clock or closing the tab does not extend the deadline.
- AC: requests after the deadline are refused, with a short grace for submissions already in flight (placeholder 60 seconds, to be tuned).
- Source: D-22; RS-C 3.6.

**FR-SES-03 · Time warnings** — Must · Locked
The system shall warn the candidate before the deadline.
- AC: warnings appear at 15 minutes and 5 minutes left (placeholders, to be tuned) and are recorded as events.
- Source: D-22 (session rules); RS-C 3.6 (warning times are detail from RS-C).

**FR-SES-04 · Expiry: auto-submit, freeze, destroy** — Must · Locked
The system shall, when the time limit is reached, mark the attempt expired, auto-submit it with everything captured so far, freeze the instance for 15 minutes, and then destroy the instance.
- AC: during the 15-minute freeze the candidate cannot send requests to the shop, and the platform finishes writing milestones and evidence.
- AC: after the freeze the instance is destroyed; evidence is kept under retention, the instance is not.
- Source: D-22; RS-C 3.6.

**FR-SES-05 · Manual submit** — Must · Locked
The system shall let a candidate submit early after a confirmation.
- AC: the same freeze and destroy steps as FR-SES-04 follow.
- AC: a submitted attempt cannot be reopened by the candidate.
- Source: D-22; RS-C 3.6.

**FR-SES-06 · No pause, one attempt** — Must · Locked
The system shall give each invite one attempt and shall not allow pausing in hiring mode.
- AC: there is no pause control anywhere in the candidate interface.
- AC: a lost connection does not stop the clock; the candidate can reconnect to the same instance.
- Source: D-22.

**FR-SES-07 · Cancel an attempt** — Must · Locked
The system shall let a recruiter (own company) or an Admin cancel an attempt that is ready or running.
- AC: cancelling destroys the instance and records who cancelled and why.
- Source: RS-C 3.6, RS-D 3.4.5 (state machine); D-22.

**FR-SES-08 · Attempt state machine** — Must · Locked
The system shall move each attempt through invited, consent, ready, running, submitted, reported (and withdrawn, expired, cancelled, deleted) without skipping states.
- AC: the allowed transitions are the ones in RS-C 3.6 without the "paused" state, which is removed because of D-22.
- AC: any state moves to deleted when retention ends or a deletion is executed.
- Source: D-22, D-25; RS-C 3.6; RS-D 3.4.5. (RS-D's paused state conflicts with D-22; see contradiction C-1.)

**FR-SES-09 · Reset during an assessment** — Must · Locked
The system shall let a candidate reset the instance within the assessment rules, generate new flags, and keep milestones already earned.
- AC: after a reset, earlier milestones still count and the time clock keeps running.
- AC: the number of resets is limited by the template (placeholder 3).
- AC: the recruiter cannot choose "reset loses progress" (see contradiction C-2).
- Source: D-22, D-02; RS-C 3.2, 3.6.

**FR-SES-10 · Withdrawal during an assessment** — Must · Locked
The system shall, when a candidate withdraws consent, lock the attempt, destroy any running instance, notify the recruiter, and schedule data deletion after a 7-day undo window.
- AC: within 7 days the candidate can undo the withdrawal; after 7 days data is deleted.
- AC: a minimal consent record is kept as proof (FR-PRV-02).
- Source: D-25, D-12; RS-H Q4.

**FR-SES-11 · One active browser session per candidate** — Must · Locked
The system shall bind an attempt and its instance address to one account and one active browser session.
- AC: a new login invalidates the older browser session for that attempt.
- AC: the instance address does not work for another account.
- Source: D-22 (invite and session checks); RS-C 3.5.

## 5.5 Instance lifecycle (INS)

An "instance" is the private set of containers one user attacks.

**FR-INS-01 · Provision on request** — Must · Spike-dependent
The system shall create a new isolated instance for a user within a short, bounded time after they request it.
- AC: the user sees live status (requested, provisioning, ready).
- AC: the target time is fixed after spike S-4. Starting value from RS-B: ready in under 15 seconds cold, under 3 seconds from a warm pool (placeholders, unmeasured).
- Source: F1; D-23; RS-B 8.

**FR-INS-02 · What an instance contains** — Must · Locked
The system shall build each instance from the same set of parts: the marketplace application with its own SQLite database, a separate read-only catalog data store, an isolated import service, one combined mock-services container (payment, KYC, metadata), a Coraza detect-only sidecar, and an on-demand bot browser.
- AC: all parts of one instance share one internal network and nothing else.
- AC: the import service has no network and no database access (CHL-07).
- AC: images contain no flags.
- Source: D-23, D-24, D-26, D-18; RS-B 3.1, RS-E C03/C06, RS-F.

**FR-INS-03 · Timing defaults** — Must · OPEN in part (see OI-23)
The system shall stop a learner instance after 60 minutes of inactivity or 4 hours in total, and shall keep a candidate instance for the assessment window.
- AC: learner timing is exactly 60 minutes inactivity and 4 hours maximum.
- AC: inactivity counts the last proxied request plus the platform session heartbeat.
- AC: whether an idle candidate instance may be stopped and restored inside the window is OPEN (RS-C suggests it; D-23 says the window); the clock never stops either way.
- Source: D-23, F6; RS-B 8; RS-C 3.6.

**FR-INS-04 · Reset** — Must · Locked
The system shall reset an instance by destroying it and creating a new one with new flags and a fresh seed, after a confirmation.
- AC: old flags stop working; a reset is logged.
- AC: a learner may reset at any time; candidate resets follow FR-SES-09.
- Source: D-23, D-02; RS-B 8, RS-C 3.6.

**FR-INS-05 · Teardown and clean-up** — Must · Locked
The system shall destroy instances automatically at expiry, inactivity limit, session end, withdrawal or admin force-stop, and shall leave no orphan containers or networks.
- AC: after killing the orchestrator and restarting it, a reconciler finds and removes leftovers within about one minute (placeholder).
- AC: containers carry labels so the true state can be rebuilt from Docker if the database is lost.
- Source: F6, F8; D-23; RS-B 8, RS-D 3.4.5.

**FR-INS-06 · Concurrency without manual work** — Must · Spike-dependent
The system shall run many instances at the same time on one host with no manual provisioning or clean-up.
- AC: per-user and per-company instance quotas and a global cap exist and are set by an Admin; values are fixed after spikes S-4 and S-5 (OI-21).
- AC: when the cap is reached, new requests queue or are refused with a clear message.
- Starting estimates (not measured): laptop about 10 to 20 idle and 4 to 8 under attack; Oracle 2 OCPU / 12 GB about 20 to 30 idle and 6 to 10 under attack (RS-A).
- Source: F8; D-15; RS-A 1.3.

**FR-INS-07 · Instance state machine** — Must · Locked
The system shall record each instance in the platform database as requested, provisioning, starting, ready, active, idle, stopping, destroyed, plus failed and resetting.
- AC: only the orchestrator writes instance state.
- AC: a reconciler compares database state with real containers about every minute and repairs differences.
- Source: D-23, D-21; RS-B 8, RS-D 3.4.5.

**FR-INS-08 · Start failure handling** — Must · OPEN (see OI-24)
The system shall retry a failed start a bounded number of times and then report the failure and clean up.
- AC: the number of retries (RS-B says once, RS-D says up to 2) is decided in OI-24.
- AC: the user sees a clear failure message; leftovers are removed.
- Source: RS-B 8; RS-D 3.4.5.

**FR-INS-09 · Warm pool only if needed** — Must · Spike-dependent
The system shall start with cold starts and add a warm pool of pre-started instances only if the measured cold start exceeds about 15 seconds.
- AC: if a warm pool is built, flags are injected at assignment, not at pre-start.
- Source: D-23; RS-B 4.

**FR-INS-10 · Instance access** — Must · Locked
The system shall expose each instance only through the platform's edge reverse proxy over HTTPS.
- AC: no instance container publishes a port on the host.
- AC: access is allowed only to the account that owns the instance.
- Source: D-16, D-23; RS-B 3.1.

**FR-INS-11 · Shop health and late flag injection** — Must · Locked
The system shall wait for the shop's health check and for flag injection to finish before showing "ready".
- AC: an instance without injected flags is never shown as ready.
- Source: D-23, D-24; RS-B 8, RS-G 1.5.

## 5.6 The 11 challenges (CHL)

### 5.6.1 Catalogue overview (D-06, D-26; cards in RS-E and RS-F)

Difficulty is 1 (one obvious step) to 5 (chained, expert). All details below are the baseline from D-26. CWE and ATT&CK IDs come from the cards and are to be re-verified (OI-35).

| # | Theme | 2021 / 2025 tag | Hosting feature in the shop | Flag and detection signal | Diff. | Main tags |
|---|---|---|---|---|---|---|
| C01 | Broken Access Control | A01 / A01 | Seller order detail page; sequential order numbers; no store-ownership check | Flag in the buyer note of one seeded order of another store; seen in a response to a non-owner store session, plus an app event "cross-store order read" | 2 | CWE-639; T1190, T1078 |
| C02 | Cryptographic Failures | A02 / A04 | Gift cards; code = prefix plus first 12 hex characters of an unsalted MD5 of the card serial | Flag in the message of seeded gift card serial 1, returned only on redeem; state change (card redeemed by a player) plus flag in response; credit is not spendable | 3 | CWE-328; T1657 |
| C03 | Injection | A03 / A05 | Part 1: product search with UNION SQL injection against a separate read-only catalog database. Part 2: stored XSS seen by the support-agent bot (D-18) | Part 1: flag in a row of a catalog notes table, seen in the search response. Part 2: OPEN (OI-18); verified by a per-instance token reaching the in-instance collector from the bot's session | 2 (part 1) | CWE-89; T1190 |
| C04 | Insecure Design | A04 / A06 | Customer refund request; auto-approve limit per request; no cumulative cap | Flag in a "goodwill adjustment" line created only when total refunds exceed the amount paid; state change plus flag in the refund statement. Limits 1,500 and 2,500 are placeholders | 3 | CWE-840; T1657 |
| C05 | Security Misconfiguration | A05 / A02 | Unauthenticated `/_ops/diagnostics` found through a verbose error | Flag is one value in a synthetic diagnostics object, seen in the response to a non-internal client | 2 | CWE-489, CWE-209; T1190 |
| C06 | Vulnerable and Outdated Components (2021) / Software Supply Chain Failures (2025) | A06 / A03 | Seller bulk catalog import preview in an isolated import service using lodash 4.17.11 (prototype pollution, CVE-2019-10744, fixed in 4.17.12); notices page and SBOM list the version | Flag is the `auditToken` value in the preview response, seen in a response from the import service | 4 | CWE-1395, CWE-1321; T1190 |
| C07 | Authentication Failures | A07 / A07 | Password reset: 4-digit code, valid 15 minutes, no attempt limit, user enumeration; target is the finance account | Flag is a settlement reference on the finance settings page, shown only to a finance session; seen in a response (backup: state change plus more than 500 failed confirms) | 2 | CWE-307, CWE-640; T1110.001 |
| C08 | Software or Data Integrity Failures | A08 / A08 | Payment webhook skips signature check when a "sandbox" header is sent | Sentinel flag released only when an unsigned sandbox event is accepted; backup: order paid with no matching entry in the gateway ledger | 3 | CWE-345; T1190, T1565.001 |
| C09 | Security Logging (and Alerting) Failures | A09 / A09 | Legacy mobile login route that is neither logged nor alerted; target is a dormant support-agent account | Flag is a reference in support case notes. Automatic proof: at least 20 failed logins then one success within 10 minutes for one account with zero security events recorded | 3 | CWE-778, CWE-223; T1110.001, T1078 |
| C10 | Server-Side Request Forgery | A10 / A01 (folded into Broken Access Control) | Seller "import image from URL" with a weak string blocklist; reaches a fake metadata service on the internal network | Sentinel flag in the fake metadata service's user-data; seen in the importer's response; the service logs the request | 4 | CWE-918; T1190, T1552.005 |
| C11 | Mishandling of Exceptional Conditions | none / A10 | Seller registration: the KYC check fails open on malformed input and auto-approves the store (D-20) | Flag on the seller Payouts page only when the store was approved by the KYC fallback; state change is the primary signal | 3 | CWE-636; T1190 (ATT&CK has no clean "fail open" technique) |

### 5.6.2 Hints, draft text (three levels; D-08; drafts from RS-E and RS-F, final text OPEN until review)

| # | Level 1 (nudge) | Level 2 (direction) | Level 3 (near-solution) |
|---|---|---|---|
| C01 | Your order list shows only your store; look at how one order is identified | Order numbers run in sequence; does the server check the store? | Ask for an order number not in your list; read a competitor order's buyer note |
| C02 | Do your two gift card codes look random? | The code is a fingerprint of something on the receipt; which common hash makes 32 hex characters? | Hash the oldest card's serial the same way, use the first 12 characters with the prefix |
| C03 | What happens with a single quote in the search? | Your text lands in a database query; UNION can append rows if the column count matches | The query has four columns; read the tables of the catalog database. Stored XSS hints: OPEN (OI-18) |
| C04 | Refund your delivered order; see what is still refundable | The auto-approve rule looks at each request; does anything add them up? | Refund below the limit twice so the sum exceeds what you paid |
| C05 | Break something on purpose and read the error | The error shows a path; an internal tools area is near it | Request the diagnostics page with no login and read the config values |
| C06 | Which parts of the import service look old? | One library has an advisory about merging objects with a special key | Put a `constructor` key with a `prototype` object in the import options and run the preview again |
| C07 | How does the shop prove who you are when you forget a password? | Look at the code length and what happens after many wrong tries | Request a reset for the finance mailbox, then send every possible code with a tool |
| C08 | Who tells the shop a payment succeeded? | Find the endpoint the payment provider calls and what it demands | Replay the provider's message yourself; look for a header that changes strictness |
| C09 | Try the web login a few times; is every door guarded the same? | The shop also has a phone-app API; compare failures there | Guess the dormant support agent's password on the app route, use the token on the web side |
| C10 | The shop makes a web request for you; from where? | Is it checking text or where the address really goes? | Cloud servers keep a private info service at a fixed address; fetch its startup data |
| C11 | What does the shop do when it cannot understand an answer? | The error names the checking service; what if that service breaks? | Send the tax ID in a shape the checker cannot read |

### 5.6.3 Challenge requirements

**FR-CHL-01 · Catalogue and tags** — Must · Locked
The system shall offer exactly the 11 challenges of 5.6.1, each tagged with its OWASP 2021 and 2025 category and with CWE and MITRE ATT&CK IDs.
- AC: every challenge page and dashboard row shows both OWASP tags (C11 shows "2021: none (new in 2025)"; C10 shows "2025: A01").
- AC: the CWE and ATT&CK values match the cards and have been re-checked on cwe.mitre.org and attack.mitre.org (OI-35).
- AC: no challenge page shows a real flag value.
- Source: D-06, D-07, D-26; F2, O1; RS-E, RS-F.

**FR-CHL-02 · C01 Broken Access Control** — Must · Locked
The system shall provide C01 so that a seller-staff player can read another store's order by changing the order number and so capture the flag.
- AC: starting state is a seeded seller-staff login given in the brief; no seller onboarding is needed.
- AC: the flag is only in the competitor order's buyer note; seeded orders hold no passwords, tokens or other flags.
- AC: on the fixed build the same request returns 403 or 404.
- Source: D-26, D-27 (seller owner and staff carry it); RS-E C01.

**FR-CHL-03 · C02 Cryptographic Failures** — Must · Locked
The system shall provide C02 so that a customer who works out the gift-card code pattern can redeem seeded card serial 1 and capture the flag.
- AC: the redeemed credit goes to a non-spendable ledger and cannot buy products.
- AC: all shop user passwords use a strong adaptive hash; no MD5 password hashes exist anywhere.
- AC: a platform throttle (placeholder 60 redeem calls per minute) protects the instance without blocking the intended path.
- Source: D-26; RS-E C02.

**FR-CHL-04 · C03 Injection (SQL injection and stored XSS)** — Must · Locked (OI-18 resolved by D-32; design in `docs/design/challenge-specs.md` Section 3; rated 3)
The system shall provide C03 with two independently credited parts: UNION-based SQL injection in product search, and stored XSS executed in the support-agent bot's session.
- AC (SQL part): the search connects to a separate read-only catalog store with no users, tokens, orders or other flags; one statement per call; a statement timeout of about 2 seconds (detail from RS-E).
- AC (XSS part): a payload stored by the player is viewed by the support-agent bot, runs in the bot's session, and sends a per-instance token to the in-instance collector, which the monitor credits.
- AC: the XSS part's host feature (which user-written field the bot views), milestones and CWE tag have no research card yet and are decided in OI-18.
- Source: D-18, D-26, D-27; RS-E C03; RS-G 1.4.

**FR-CHL-05 · C04 Insecure Design** — Must · Locked (OI-19 resolved by D-32: separate "quick refund" path; spec Section 4)
The system shall provide C04 so that two auto-approved partial refunds can exceed the amount paid and release the flag.
- AC: refunds up to the auto-approve limit need no review; the auto-approve check has no cumulative cap on that path; limits 1,500 and 2,500 are placeholders (detail from RS-E).
- AC: refund money goes to a non-spendable refund ledger.
- AC: how this deliberate gap fits the otherwise correct refund model (FR-SHP-10) is decided in OI-19.
- Source: D-26; RS-E C04; RS-G 1.3.

**FR-CHL-06 · C05 Security Misconfiguration** — Must · Locked
The system shall provide C05 so that a malformed request reveals a path to an unauthenticated diagnostics page that holds the flag.
- AC: the diagnostics page shows only a hand-built synthetic object, never environment variables, database URLs, secrets or dependency versions.
- AC: C05 shares no error-handler code with C10 or C11.
- Source: D-26; RS-E C05.

**FR-CHL-07 · C06 Vulnerable and Outdated Components** — Must · Locked
The system shall provide C06 so that a seller who finds the outdated library on the notices page or SBOM can pollute the import service's defaults and read the audit token.
- AC: the import service runs preview only, with no network, no database access, a read-only filesystem, limits, about a 5-second timeout, and a fresh process per job.
- AC: lodash 4.17.11 exists only in the import service; the pinned copy is vendored in the repository and built offline.
- AC: the exact pollution input is confirmed on Node 24 before release (spike S-9).
- Source: D-26, D-21 (Node 24); RS-E C06.

**FR-CHL-08 · C07 Authentication Failures** — Must · Locked
The system shall provide C07 so that a player can take over the finance account by brute-forcing the 4-digit reset code and read the flag on its settings page.
- AC: the reset code goes to a sandbox mailbox that the player cannot read; the mailbox sits on the internal network only.
- AC: reset-confirm failures are logged normally, so C07 does not look like C09's silent signal.
- AC: the finance page holds no other flag.
- Source: D-26, D-27 (finance is the target); RS-F C07.

**FR-CHL-09 · C08 Software or Data Integrity Failures** — Must · Locked
The system shall provide C08 so that a forged unsigned payment event sent with the sandbox header marks an order paid and releases the sentinel flag.
- AC: only `pending_payment` orders can be changed by the webhook.
- AC: an honest checkout, or a price-tampering route from C04, never releases the C08 flag.
- AC: a forged-paid order must not turn into simulated refundable money.
- Source: D-26; RS-F C08.

**FR-CHL-10 · C09 Logging and Alerting Failures** — Must · Locked
The system shall provide C09 so that a player can brute-force a dormant support-agent account through an unlogged legacy login route, and the monitor can prove "attack happened, nothing logged, nothing alerted".
- AC: the web login on the same account locks after 5 failures and raises an alert, giving the visible contrast.
- AC: the automatic proof rule (at least 20 failures then one success within 10 minutes with zero security events for that account) is evaluated by the monitor.
- AC: the admin Security Alerts page encodes all output so it is not an extra XSS target for the bot.
- Source: D-26, D-27 (support agent is the target); RS-F C09.

**FR-CHL-11 · C10 Server-Side Request Forgery** — Must · Locked (OI-20 resolved by D-32: the player starts as a seeded approved seller owner; spec Section 5)
The system shall provide C10 so that a seller can make the shop fetch an internal fake metadata service through the image importer and read the sentinel flag.
- AC: the fetcher supports only http and https, has a timeout, a 1 MB size cap and a concurrency limit; no real egress exists.
- AC: the fake metadata service is reachable only from the shop container, has no published port and is not reachable through `host.docker.internal` or the host gateway (NFR-ISO-02).
- AC: whether a still-pending seller can create draft products with image import is decided in OI-20.
- Source: D-26, D-23; RS-F C10.

**FR-CHL-12 · C11 Mishandling of Exceptional Conditions** — Must · Locked
The system shall provide C11 so that malformed input to the KYC check auto-approves a seller store and shows the sentinel flag on the Payouts page.
- AC: a store approved by a human Admin or by another bug never shows the flag.
- AC: the KYC mock restarts under a supervisor if oversized input crashes it, and is per instance only.
- AC: C11's verbose-error code is separate from C10's.
- Source: D-20, D-26, D-27 (seller owner attacks; Admin is the bypassed approver); RS-F C11.

**FR-CHL-13 · Independence and sentinel rule** — Must · Locked
The system shall make all 11 challenges independently solvable, with no hard prerequisite between them, and shall release sentinel flags only when the intended vulnerable path was used.
- AC: solving any one challenge does not capture another challenge's flag (checked against the cross-challenge conflict lists in RS-E and RS-F).
- AC: no challenge allows code execution or file read in the shop container, because that would expose every flag.
- AC: no exploit can reach the platform or the host.
- Source: D-26; RS-E 6, RS-F 3.

**FR-CHL-14 · Post-solve write-up** — Must · OPEN in part (see OI-14)
The system shall show a Learner the full solution write-up (vulnerable code, fix, tags) after they solve a challenge.
- AC: the write-up is not visible before the challenge is solved.
- AC: whether and when a Candidate sees write-ups (research suggests hidden until the recruiter closes the assessment) is decided in OI-14.
- Source: D-08; F4; RS-E, RS-F fix sections.

**FR-CHL-15 · Player brief and start state** — Must · Locked
The system shall give each player a short brief per challenge that names the starting account and avoids revealing the vulnerability.
- AC: seeded logins needed by a challenge (for example seller staff for C01) appear in the brief and work in a fresh instance.
- AC: the brief never contains a flag.
- Source: D-26; RS-E A-3, RS-F A1.

**FR-CHL-16 · Automated exploit verification** — Must · Locked
The system shall include, for each challenge, an automated test that succeeds on the vulnerable build and fails on a fixed build.
- AC: 11 test scripts exist and run in CI.
- AC: a challenge whose test fails blocks release.
- Source: F2; RS-E and RS-F "Automated verification test" sections; SM-4.

**FR-CHL-17 · Difficulty tiers** — Must · Locked (OI-16 resolved by D-32: 1-2 Easy, 3 Medium, 4-5 Hard)
The system shall assign each challenge to one of three scoring tiers (Easy, Medium, Hard).
- AC: the mapping from the difficulty ratings (1 to 5) to the tiers is decided in OI-16.
- Source: D-22, D-26.

## 5.7 Flags (FLG)

**FR-FLG-01 · Unique flags per instance** — Must · Locked
The system shall generate fresh flags when each instance starts, so no two instances share a flag.
- AC: two instances of the same challenge hold different flags.
- AC: a reset creates new flags and the old ones stop working.
- Source: D-02, D-23; F3.

**FR-FLG-02 · Derived and verifiable flags** — Must · Locked
The system shall derive each flag with an HMAC from a platform key that never enters an instance or an image, and shall verify a submitted flag by recomputing it.
- AC: the key is versioned so it can be rotated.
- AC: flag comparison is constant-time; no flag table exists to leak.
- AC: the flag format is fixed and recognisable (proposal from RS-B: `VM{...}` with a high-entropy tail; format is a placeholder, to be tuned).
- Source: D-23; RS-B 7.

**FR-FLG-03 · Injection at runtime** — Must · Locked
The system shall inject flags when the instance starts, into the database seed or a read-only root-owned file, and use environment variables only where a challenge's intended path needs them.
- AC: a CI check scans image layers and finds no flag pattern.
- AC: flags never appear in orchestrator or container logs (hashes may).
- AC: no other challenge's flag is in the shop's environment or plain filesystem.
- Source: D-23, D-26; RS-B 7, RS-F C10 containment.

**FR-FLG-04 · Automatic capture** — Must · Locked
The system shall detect flag retrieval automatically and credit it at once, by matching the flag format in responses at the sidecar and checking validity, and by app events for state-change challenges.
- AC: a valid flag in a response to the owning player credits the milestone within the live-update target (NFR-PRF-03).
- AC: a flag from another instance or a decoy does not credit.
- AC: the platform, not the sidecar, decides credit.
- Source: D-01, D-23; RS-B 6.

**FR-FLG-05 · Paste submission** — Must · Locked
The system shall let a user paste a flag as a backup or verification.
- AC: a correct pasted flag credits the challenge; a wrong or decoy flag gives no credit and no point penalty and is logged as an integrity signal.
- AC: pasted flags credit only if the activity check passes (FR-ACH-02); otherwise the capture is held for review.
- AC: the pasted value is not stored (only the result and challenge).
- Source: D-01, D-22; RS-C 3.4.

**FR-FLG-06 · Flags that leave by hidden channels** — Must · Locked
The system shall rely on paste submission for flags that leave through channels the sidecar cannot read (encoded or blind techniques).
- AC: the challenge page explains that pasting is available.
- Source: D-01, D-23 (caveat); RS-B 6.

**FR-FLG-07 · Decoy flags** — Must · Locked
The system shall place decoy flags in places a legitimate solver should not reach, and shall record any decoy submission as an integrity signal.
- AC: each instance gets decoys generated like real flags but never credited.
- AC: a decoy submission shows the recruiter an integrity flag, not an automatic fail.
- Source: D-22; RS-C 2.3.

**FR-FLG-08 · Flag secrecy** — Must · Locked
The system shall never show a flag value in documents, logs, dashboards, the recruiter view or hints.
- AC: search of logs, API responses to other users and dashboard payloads finds no flag value.
- AC: a hint never reveals the flag itself.
- Source: D-08, D-12; CLAUDE.md; RS-H Q6.

**FR-FLG-09 · Sharing signal** — Must · Locked
The system shall log a flag that is valid for another instance (right key, wrong instance) as a sharing signal for human review.
- AC: the log entry names both instances without storing the flag.
- Source: D-01 (evidence), D-22; RS-B 7.

## 5.8 Technique detection and evidence (DET)

**FR-DET-01 · Layer 1: fixed tags** — Must · Locked
The system shall store fixed tags on every challenge: OWASP 2021 and 2025, CWE and MITRE ATT&CK IDs.
- AC: tags come from the challenge catalogue and are shown to learners and recruiters.
- Source: D-07; F5.

**FR-DET-02 · Layer 2: automatic technique detection** — Must · Spike-dependent
The system shall classify attack requests inside each instance with OWASP Coraza and OWASP Core Rule Set v4.30.0 in detect-only mode, and shall add app-side events for logic classes that the rule set cannot see.
- AC: the engine never blocks traffic (`SecRuleEngine DetectionOnly`).
- AC: spike S-6 confirms rule tag names (only `attack-sqli` and `attack-ssrf` are verified), false positives and added latency.
- AC: access-control and business-logic challenges use app events, not rule hits.
- Source: D-07, D-23; RS-B 6.

**FR-DET-03 · Layer 3: evidence capture** — Must · OPEN in part (see OI-14)
The system shall store the exact request that captured each flag, with activity metadata, for the recruiter to verify.
- AC: the stored request body is capped (placeholder 8 KB) and `Authorization`, cookie and password fields are redacted before storage.
- AC: evidence is encrypted with the assessment's own key (FR-PRV-12).
- AC: all other request bodies are not stored (see contradiction C-3).
- AC: whether a short write-up per solved challenge is optional or required is decided in OI-14.
- Source: D-07, D-22, D-25; RS-H Q6.

**FR-DET-04 · Signed events** — Must · Locked
The system shall let the sidecar and the shop send events to the platform signed with a per-instance key, idempotent by event ID, buffered if the platform is down.
- AC: a forged or replayed event is rejected.
- AC: an instance can only post events for its own instance ID.
- AC: event types include request summary, rule match, flag seen and state change.
- Source: D-23; RS-B 6, RS-D 3.3.5.

**FR-DET-05 · Milestones** — Must · Locked (OI-17 resolved by D-32: M1 and M2 events defined per challenge in `docs/design/challenge-specs.md`, refined in each story)
The system shall detect three milestones per challenge automatically, never self-declared: M1 "found the weakness" (20 percent), M2 "working exploit evidence" (40 percent), M3 "flag captured" (100 percent).
- AC: milestones are defined by outcome (for example "read another store's order"), not by technique, so any valid path counts.
- AC: the concrete M1 and M2 events for each challenge are decided in OI-17.
- AC: milestones survive an instance reset.
- Source: D-22; RS-C 3.2.

**FR-DET-06 · Negative-observation rules** — Must · Locked
The system shall support rules that check a condition over a time window (for example "attack seen, zero events recorded"), not only "flag seen".
- AC: the C09 rule of FR-CHL-10 works end to end.
- Source: D-26 (C09 detection); RS-F 7 (impact on RS-C).

**FR-DET-07 · Label honesty** — Must · Spike-dependent
The system shall show the automatic technique label as a label, with the raw evidence available, and shall report per-challenge active time as an estimate unless the classifier proves accurate.
- AC: dashboards say "estimated" where attribution relies on the classifier.
- AC: if spike S-6 shows poor accuracy, active time is reported at assessment level only.
- Source: D-07 (caveat), D-22; RS-C 3.4, 6.

**FR-DET-08 · Activity metadata** — Must · Locked
The system shall record activity metadata (timestamps, counts, rule tags) without request bodies, to support timing, scoring and anti-cheat.
- AC: the event list of FR-TIM-04 is recorded with UTC timestamps and IDs only.
- Source: D-22 (data used), D-12.

**FR-DET-09 · Bot visit evidence** — Must · Locked
The system shall record each bot visit (bot user, page, time) and credit a stored-XSS capture when the collector receives the per-instance token from the bot's session.
- AC: the bot's own views are never counted as player captures.
- Source: D-18; RS-G 1.4.

## 5.9 Scoring (SCR)

All numbers in this section are placeholders, to be tuned by the pilot (OI-4) and the challenge milestone work (OI-17). Worked examples are in Appendix A.

**FR-SCR-01 · Hiring-mode score formula** — Must · Locked (numbers placeholder)
The system shall score a hiring attempt from fixed points per challenge in three difficulty tiers (placeholders 60, 90, 120).
- AC: `raw_c = W_c x (highest milestone share reached)`; `net_c = max(0, raw_c - hint_cost_c)`; `score = sum(net_c)`; shown score = `round(1000 x score / sum(W_c))`.
- AC: capturing all 11 with no hints shows 1000.
- AC: points do not change because other people solved a challenge (no decay).
- Source: D-22; RS-C 3.1, 3.2.

**FR-SCR-02 · Milestone credit** — Must · Locked
The system shall give 20, 40 and 100 percent of a challenge's points at milestones M1, M2 and M3.
- AC: the best milestone reached on any valid path counts once.
- AC: a technique label never changes points.
- Source: D-22; RS-C 3.2.

**FR-SCR-03 · Hint cost in the score** — Must · Locked (numbers placeholder)
The system shall subtract hint cost, as a percentage of that challenge's points, only from that challenge, never below zero.
- AC: placeholder percentages per hint level are 10, 20 and 30.
- AC: hints used before any progress do not make the total negative (floor per challenge).
- Source: D-08, D-22; RS-C 3.2.

**FR-SCR-04 · Time is shown, not scored** — Must · Locked
The system shall show time beside the score and shall not include time in the points.
- AC: two attempts with equal captures but different times have equal scores.
- Source: D-22.

**FR-SCR-05 · No penalty for wrong or decoy submissions** — Must · Locked
The system shall not subtract points for wrong or decoy submissions.
- AC: such submissions are logged as integrity signals only.
- Source: D-22.

**FR-SCR-06 · Learner-mode progress** — Must · Locked
The system shall track Learner progress by milestones (stars), a solved tick and an optional "no hints" badge per challenge, with no hint penalty.
- AC: using a hint never lowers a learner's progress.
- AC: the badge is awarded only for a challenge solved with zero hints.
- Source: D-08, D-22; F4; RS-C 3.3.

**FR-SCR-07 · No global leaderboard** — Must · OPEN in part (see OI-26)
The system shall not offer a global public leaderboard.
- AC: no public ranking page exists.
- AC: whether the optional private cohort board (D-22 says "optional") is built is decided in OI-26.
- Source: D-22; RS-C 3.3.

**FR-SCR-08 · Ranking aid** — Must · OPEN (see OI-26)
The system shall show recruiters a suggested tie-break order as a ranking aid only.
- AC: the research order is: more fully captured challenges, lower total hint cost, lower active time, earlier last capture; whether to adopt it is decided in OI-26.
- AC: the recruiter makes the decision; nothing auto-ranks out a person.
- Source: RS-C 3.2 (not in D-22).

**FR-SCR-09 · Server-side scoring** — Must · Locked
The system shall compute every score on the server from signed events and verified flags.
- AC: a candidate cannot change a score or milestone from the browser.
- Source: D-22; RS-D 3.3.5.

**FR-SCR-10 · Held captures excluded until reviewed** — Must · Locked
The system shall hold a suspicious capture out of the score until a human decides, and shall recompute the score from the decision.
- AC: the decision, reviewer and note are audited.
- AC: a held capture is never auto-zeroed.
- Source: D-22; RS-C 3.5.

## 5.10 Time taken (TIM)

**FR-TIM-01 · Headline time to capture** — Must · Locked
The system shall show for each captured challenge the wall-clock time from "instance ready" to the capture event.
- AC: the same start moment applies to every challenge of an attempt.
- AC: the dashboard labels it "time into the assessment" because all 11 challenges share one instance.
- Source: D-22; RS-C 3.4.

**FR-TIM-02 · Estimated active time** — Must · Spike-dependent
The system shall report an estimated active time by summing gaps between a user's requests and platform events that are shorter than 5 minutes (placeholder, to be tuned).
- AC: gaps over 5 minutes count as zero.
- AC: it is reported at assessment level and, as an estimate, per challenge only if the classifier is accurate (FR-DET-07).
- Source: D-22; RS-C 3.4.

**FR-TIM-03 · Resets and retries** — Must · Locked
The system shall keep all attempts as separate events and shall not restart the time clock on a retry or reset.
- Source: D-22; RS-C 3.4.

**FR-TIM-04 · Event log** — Must · Locked
The system shall log, with UTC timestamps, attempt ID and instance ID: invite created, opened, consent given, session started, instance requested, instance ready, request seen (summary), milestone reached, flag auto-detected, flag submitted (result only), hint unlocked (level, cost), instance reset, time warning sent, session expired, session submitted, instance destroyed, recruiter viewed report.
- AC: no raw personal data beyond IDs appears in these events.
- Source: D-22, D-25; F7; RS-C 3.4.

**FR-TIM-05 · Robust clock** — Must · Locked
The system shall base all timing on the server clock so that laptop sleep, tunnel drops or slow starts do not distort it.
- AC: instance cold-start time does not count against the candidate.
- Source: D-22; RS-A 7.

## 5.11 Hints (HNT)

**FR-HNT-01 · Learner hints** — Must · Locked
The system shall give Learners three free hint levels per challenge (nudge, direction, near-solution).
- AC: no hint reveals the flag.
- AC: hint use is recorded and never penalised.
- AC: hint text per challenge is final after review (drafts in 5.6.2).
- Source: D-08; F4.

**FR-HNT-02 · Candidate hints off by default** — Must · Locked
The system shall keep hints off for Candidates unless the recruiter turns them on in the assessment, with a point cost.
- AC: with hints off, no hint control appears.
- AC: with hints on, the cost per level is shown before the candidate confirms the unlock.
- Source: D-08, D-22; F11.

**FR-HNT-03 · Recruiter sees hints used** — Must · Locked
The system shall show the recruiter which hints a candidate used, and their cost, when hints were on.
- Source: D-08; F5.

## 5.12 Anti-cheat (ACH)

**FR-ACH-01 · Submission limits** — Must · Locked (numbers placeholder)
The system shall limit pasted-flag submissions per challenge.
- AC: placeholder limit 5 wrong submissions per challenge per 10 minutes, then a 10-minute lock, and a hard cap of 30 per challenge per assessment.
- AC: hitting a limit is logged.
- Source: D-22; RS-C 3.5.

**FR-ACH-02 · Activity-versus-capture check** — Must · Spike-dependent
The system shall compare each capture with the instance activity log and mark a capture "consistent" only if the expected pre-steps appear.
- AC: an inconsistent capture is held for review, not zeroed.
- AC: if the pilot shows the check is noisy, it moves from "hold" to "flag only" (RS-C 3.7).
- Source: D-22; RS-C 3.5.

**FR-ACH-03 · Timing anomalies** — Must · Spike-dependent
The system shall flag a capture that comes sooner than a minimum plausible time, or comes instantly after a long idle period.
- AC: the minimum plausible time is set from pilot data.
- Source: D-22; RS-C 3.5.

**FR-ACH-04 · Write-up similarity review** — Must · Locked
The system shall compare optional write-ups within one assessment and flag high similarity for human review only.
- Source: D-22; RS-C 3.5.

**FR-ACH-05 · No proctoring** — Must · Locked
The system shall not capture webcam, microphone, screen, ID photos, tab switches or paste events.
- AC: the consent screen states this.
- Source: D-12, D-22.

**FR-ACH-06 · Integrity signals are evidence for a human** — Must · Locked
The system shall present integrity signals (decoy, sharing, timing, activity, similarity) to the recruiter as evidence and shall never auto-reject, auto-zero or auto-fail a candidate.
- AC: every integrity flag has a plain-language explanation and the recruiter can record a decision.
- Source: D-22.

**FR-ACH-07 · Review of held captures** — Must · OPEN in part (see OI-38)
The system shall let a named reviewer open the evidence of a held capture and accept or reject it with a note.
- AC: the reviewer, decision and time are audited.
- AC: who may review (recruiter only, or Admin too) and any deadline are decided in OI-38.
- Source: D-22; RS-C 6.

## 5.13 Dashboards (DSH)

**FR-DSH-01 · Learner dashboard** — Must · Locked
The system shall give each Learner a dashboard with the challenge catalogue, per-challenge stars, solved status, both OWASP tags, difficulty, hints used, captured flags, the post-solve write-up, overall progress, and controls to start, reset and stop the instance.
- AC: a Learner sees only their own data.
- AC: instance status (requested, provisioning, ready, idle, stopping) updates live.
- AC: after a solve, the write-up is available on the same page.
- Source: O4, F4, D-06, D-08.

**FR-DSH-02 · Recruiter dashboard** — Must · Locked
The system shall give each Recruiter a dashboard of the company's assessments and candidates with, per candidate: total score out of 1000, per-challenge score, time to capture, estimated active time, technique label and tags, evidence (the capturing request), hints used (if on), and integrity flags.
- AC: a recruiter sees only their company's assessments.
- AC: every view of a candidate report is written to the audit log.
- AC: the recruiter never sees the person's practice history.
- Source: O4, F5, D-05, D-07, D-12, D-22.

**FR-DSH-03 · Recruiter live monitor** — Must · Locked
The system shall show a Recruiter, in real time, each invited candidate's state (invited, consented, running, submitted), milestones reached and captures.
- AC: a milestone reached by a candidate appears on the recruiter's screen without refreshing.
- AC: the screen shows the countdown of the candidate's time limit.
- Source: D-17, D-22; O4.

**FR-DSH-04 · Candidate dashboard** — Must · OPEN in part (see OI-15)
The system shall give each Candidate a view of their invitations, assessment status, own results, export, withdrawal and deletion request, and the company-level history of who viewed their data.
- AC: results appear when the template's rule says so; the timing options (after submit, or after the recruiter closes) are decided in OI-15.
- AC: the view history shows company, action and time, not individual recruiter names.
- Source: D-12, D-25; RS-H Q5.

**FR-DSH-05 · Admin dashboard** — Must · Locked
The system shall give each Admin a dashboard with the approval queue, running instances and capacity, quotas, settings, user management, audit log, break-glass and retention-job status.
- AC: every admin read of personal data is itself logged.
- Source: D-19, F8; RS-D 3.4.1.

**FR-DSH-06 · Privacy wall in every view** — Must · Locked
The system shall ensure no dashboard or API response shows a Learner's practice data to a Recruiter, or one user's flags, progress or score to another user.
- AC: automated tests try to read other users' and other companies' data with each role and all fail.
- Source: F7, D-05; RS-D 3.3.5.

## 5.14 Live updates (LIV)

**FR-LIV-01 · SSE streams** — Must · Locked
The system shall push every dashboard change (flag captured, milestone, instance state, score) to the browser with Server-Sent Events.
- AC: each event has an ID; the server keeps a short replay buffer and honours `Last-Event-ID`, so a reconnect loses nothing.
- AC: browser actions (submit a flag, start an instance) use normal HTTP requests.
- Source: D-17; RS-D 3.1.

**FR-LIV-02 · Heartbeat and no buffering** — Must · Locked
The system shall send a heartbeat comment about every 15 seconds and shall switch off proxy buffering on the stream route.
- AC: a stream stays open through the real proxy path for longer than the smallest idle timeout in that path.
- AC: the response carries the no-buffering header the proxy needs (for nginx, `X-Accel-Buffering: no`).
- Source: D-17.

**FR-LIV-03 · HTTP/2** — Must · Spike-dependent
The system shall serve streams over HTTP/2 to avoid the six-connection browser limit.
- AC: confirmed on the real path in spike S-2.
- Source: D-17.

**FR-LIV-04 · Snapshot and polling fallback** — Must · Locked
The system shall offer a snapshot endpoint and shall fall back to polling if the stream keeps failing.
- AC: with streams blocked, a dashboard still updates by polling.
- Source: D-17.

**FR-LIV-05 · Stream authorisation** — Must · Locked
The system shall send each stream only the events the signed-in user is allowed to see.
- AC: a Learner cannot subscribe to another user's events; a Recruiter only to the company's attempts.
- Source: F7, D-05, D-17.

**FR-LIV-06 · Fan-out path** — Must · Locked
The system shall route events from jobs and the monitor to the stream endpoints through the Valkey layer.
- AC: killing one API worker does not lose events stored in the replay buffer.
- Source: D-17, D-21.

## 5.15 Results export (EXP)

**FR-EXP-01 · Candidate export** — Must · Locked
The system shall let a Candidate export their own data as a zip of JSON and CSV.
- AC: contents are profile, consent history, results, timings, hints, evidence requests and the list of who viewed the data.
- AC: no other user's data and no flag values are included.
- Source: D-12, D-25; RS-H Q4.

**FR-EXP-02 · Learner export** — Must · Locked
The system shall let a Learner export their own progress and data in the same format.
- Source: D-25.

**FR-EXP-03 · Recruiter export of results** — Must · OPEN (see OI-27)
The system shall let a Recruiter export assessment results in a defined format.
- AC: format, scope and whether evidence is included are decided in OI-27.
- AC: every export is audit-logged.
- Source: F5 (dashboard only is stated); not decided.

**FR-EXP-04 · Exports are audited** — Must · Locked
The system shall write every export by any role to the audit log.
- Source: D-12; RS-H Q5.

## 5.16 Privacy and compliance (PRV)

**FR-PRV-01 · Consent screen** — Must · Locked
The system shall show a stand-alone, plain-language consent screen before an assessment starts.
- AC: it lists what is recorded (name and email; answers and write-ups; the requests that capture a flag; times; hints; IP address and browser type), what is not recorded (screen, webcam, microphone, anything outside the test shop), why, who sees it, how long it is kept, and the choices (see, download, request deletion, withdraw).
- AC: it asks the candidate not to use real passwords or real personal data.
- AC: the agree box is not pre-ticked; the buttons are Start and Decline.
- AC: it names the company as the party that decides how results are used.
- Source: D-12, D-25; F10; RS-H Q4 (draft text).

**FR-PRV-02 · Consent record** — Must · OPEN in part (see OI-37)
The system shall write an append-only consent record for every grant, decline and withdrawal.
- AC: each record holds notice version, a snapshot and hash of the shown text, the retention days and company shown, action, time, hashed IP and browser, method, and a link into the audit chain.
- AC: withdrawal needs one click.
- AC: how long the minimal consent record is kept (RS-H proposes assessment retention plus 12 months) is decided in OI-37.
- Source: D-12; RS-H Q4.

**FR-PRV-03 · Minimum data** — Must · Locked
The system shall record only activity inside the assessment instance and shall not record anything outside it.
- AC: the data inventory (Section 9) matches what is stored.
- Source: D-12.

**FR-PRV-04 · Candidate retention and auto-delete** — Must · Locked
The system shall delete a candidate's assessment record 180 days after the attempt ends by default, with a recruiter-chosen range of 30 to 365 days.
- AC: if the candidate never started, the clock runs from the invite date.
- AC: a scheduled job deletes due records and the Admin dashboard shows the last run.
- AC: the company can delete a candidate earlier.
- Source: D-12, D-25; F10; RS-H Q1.

**FR-PRV-05 · Learner retention** — Must · Locked
The system shall delete Learner data 12 months after last login, with a warning email 30 days before.
- AC: logging in before the date cancels the deletion.
- AC: a Learner can delete their data at any time.
- Source: D-25; RS-H Q1.

**FR-PRV-06 · Evidence and instance data** — Must · Locked
The system shall delete a Learner's captured evidence 30 days after the instance is destroyed, and destroy instance contents at teardown, keeping raw container logs at most 7 days.
- Source: D-25; RS-H Q1.

**FR-PRV-07 · Controller and processor roles** — Must · Locked
The system shall treat the recruiter's company as controller and VulnMart as processor for candidate data, and VulnMart as controller for learner data.
- AC: the data-processing terms (FR-ORG-07) state this.
- Source: D-12, D-25; RS-H.

**FR-PRV-08 · Deletion workflow** — Must · Locked (numbers placeholder)
The system shall route a Candidate's deletion request to the recruiter's company, and VulnMart shall carry out the deletion once approved.
- AC: the candidate sees the request status.
- AC: the company is asked to decide within 14 days, with a reminder and then Admin escalation (placeholder, from RS-H).
- AC: VulnMart executes within 30 days of approval and confirms to both parties (placeholder, from RS-H).
- AC: the company can also delete a candidate directly at any time.
- AC: Learner requests go to VulnMart and run at once, with the undo window of FR-PRV-09.
- Source: D-25; RS-H Q4.

**FR-PRV-09 · Seven-day undo window** — Must · Locked
The system shall hold deletion for 7 days after a consent withdrawal or a learner deletion request so the user can undo it.
- AC: undo within 7 days restores access; after 7 days deletion runs.
- Source: D-25.

**FR-PRV-10 · Audit log** — Must · OPEN in part (see OI-28)
The system shall keep a pseudonymised, tamper-evident (hash-chained), append-only audit log for 12 months.
- AC: it records logins, approvals, invites, consent changes, every view and export of candidate data, assessment start, submit and teardown, deletion steps, retention changes, role changes, admin access, log reads and failed access attempts.
- AC: when a candidate is deleted, the identity mapping is deleted and the rows stay, so they identify nobody.
- AC: no secrets, passwords or tokens are written to it.
- AC: whether a daily head-hash anchor is stored outside the database and where is decided in OI-28.
- Source: D-12, D-25; F10; RS-H Q5.

**FR-PRV-11 · Candidate sees who viewed** — Must · Locked
The system shall let a Candidate see company-level view history (company, action, time).
- Source: D-25; RS-H Q5.

**FR-PRV-12 · Encryption and backups** — Must · Locked
The system shall encrypt evidence and answers with a per-assessment key, keep rolling backups for 14 days, and delete a key when the data is deleted so backups cannot restore it.
- AC: after key deletion, a restore test shows the data unreadable.
- AC: invite tokens are stored as hashes; passwords as Argon2id.
- Source: D-25; RS-H Q6. (The key-shredding test is spike S-10.)

**FR-PRV-13 · 18 and over** — Must · Locked
The system shall allow only people who declare they are 18 or over to register.
- AC: the declaration is recorded at signup.
- AC: whether a self-declaration is enough legally is part of OI-33.
- Source: D-25; RS-H.

**FR-PRV-14 · IP address and browser details** — Must · Locked
The system shall truncate or drop IP and browser details after 90 days for Learners, and keep them with the attempt for Candidates.
- Source: D-25; RS-H Q3.

**FR-PRV-15 · Security and system logs** — Must · Locked
The system shall keep security and system logs for 12 months, visible to Admins only, then purge them.
- Source: D-25; RS-H Q3.

**FR-PRV-16 · D-12 clarification** — Must · Locked
The system shall present automatic deletion, the 180-day default and the 7-day undo window as product choices, not as legal requirements, and shall not describe a 48-hour pre-erasure notice as a legal duty for VulnMart.
- AC: the notice and help pages do not claim a legal duty that research does not support.
- AC: the 30-day learner warning email is good practice, not a claimed duty.
- Source: D-25 (clarification of D-12); RS-H Q2.

**FR-PRV-17 · Synthetic data only** — Must · Locked
The system shall seed the shop with fully synthetic data and shall tell players not to use real personal data.
- AC: seed files contain no real names, emails, card numbers or secrets.
- Source: D-12; RS-G 1.5, RS-H 7.

**FR-PRV-18 · Retention scheduler** — Must · Locked
The system shall run scheduled jobs for retention, warning emails, invite purge and log purge, and report failures to Admins.
- Source: D-25; RS-H.

**FR-PRV-19 · Legal review action** — Must · OPEN (see OI-33)
The system's notice, retention and 18+ rule shall be reviewed once by the guide or the institute's legal cell.
- AC: the review outcome is recorded in `docs/`; changes become new requirements.
- Source: D-25.

**FR-PRV-20 · Breach and incident handling** — Must · OPEN (see OI-34)
The system shall support an incident procedure to identify and tell affected people.
- AC: the procedure, who decides, and timing (RS-H cites a DPDP 72-hour report, unverified) are decided in OI-34.
- Source: RS-H Q2 (research only).

## 5.17 Admin and operations (ADM)

**FR-ADM-01 · Approval queue** — Must · Locked
The system shall give Admins a queue to approve, reject (with reason) and suspend companies and recruiters.
- Source: D-04, D-19; F9.

**FR-ADM-02 · User management** — Must · Locked
The system shall let an Admin lock, reset and delete user accounts, with every action audited.
- AC: an Admin cannot give an account both a Participant role and a Recruiter or Admin type (FR-ACC-05).
- Source: D-19; RS-D 3.4.1.

**FR-ADM-03 · Break-glass access** — Must · OPEN in part (see OI-12)
The system shall let an Admin read a candidate's answers only through a break-glass step with a written reason, time-boxed, with a real-time alert and a later review.
- AC: no standing access exists; without break-glass the data is unreadable to Admin.
- AC: each use records the named admin, reason, start, end and what was read.
- AC: the duration and who receives the alert are decided in OI-12.
- Source: D-19, D-12; RS-D 3.4.1.

**FR-ADM-04 · Force-stop** — Must · Locked
The system shall let an Admin force-stop any instance.
- AC: the action is audited and the owner is notified.
- Source: RS-D 3.4.1; F6.

**FR-ADM-05 · Settings and quotas** — Must · Locked
The system shall let an Admin set instance quotas, the global cap, retention defaults and the invite cap.
- AC: setting changes are audited.
- AC: a candidate retention default outside 30 to 365 days is refused.
- Source: D-25; RS-D 3.4.1; F8.

**FR-ADM-06 · Capacity view** — Must · Locked
The system shall show Admins the running instances, memory and CPU use, queue depth and failures.
- Source: F8; RS-D 3.4.1.

**FR-ADM-07 · Audit access** — Must · Locked
The system shall let Admins read the full audit log, and shall log each of their own reads.
- Source: D-25; RS-H Q5.

**FR-ADM-08 · Admin cannot read candidate answers by default** — Must · Locked
The system shall hide candidate answers, write-ups and evidence from Admins outside break-glass.
- AC: the admin dashboard shows counts and statuses but not content.
- Source: D-19.

## 5.18 Notifications and email (NTF)

**FR-NTF-01 · Email types** — Must · Locked
The system shall send emails for account verification, password reset, recruiter approval outcome, candidate invite, consent withdrawal (to the recruiter), deletion requests and confirmations, and the 30-day learner retention warning.
- AC: each email names the sender (company or VulnMart) and contains no flag, password or token other than its own single-use link.
- Source: D-04, D-12, D-25; RS-D 3.1.

**FR-NTF-02 · Outbox and queue** — Must · Locked
The system shall send mail through an outbox table and a queue so that a daily cap never loses a message.
- AC: a failed send is retried with back-off and visible to Admins.
- Source: D-21; RS-D 3.1.

**FR-NTF-03 · Email provider** — Must · OPEN (see OI-32)
The system shall use Resend or Brevo for email (D-21).
- AC: the provider is confirmed once the sender-domain situation is known (OI-9, OI-32). Resend free is 100 emails a day and 3,000 a month and needs a verified sender domain to reach arbitrary recipients; Brevo's limits are unverified.
- Source: D-21; RS-D, `initial.md` D-21.

**FR-NTF-04 · In-app warnings** — Must · Locked
The system shall show candidate time warnings in the page and recruiter alerts through live updates.
- Source: D-17, D-22.

## 5.19 The shop application (SHP)

The shop is the target the players attack. This section states it at product level and refers to RS-G for details.

**FR-SHP-01 · Marketplace identity** — Must · Locked
The system shall provide an online marketplace called VulnMart with login, checkout, seller, support, finance and admin areas, in a neutral everyday look.
- AC: pages are server-rendered with light JavaScript.
- AC: the visual style is neutral (product grid, seller badges, order timeline), not a hacker theme.
- AC: the shop runs on Node 24 LTS with Express and one SQLite database per instance.
- Source: D-09, D-10, D-21, D-24.

**FR-SHP-02 · Entities** — Must · Locked
The system shall model the shop with about 20 tables: users and addresses; stores, categories, products, reviews; carts, cart items, coupons, orders, order items, payments; commissions and payouts; refunds, disputes, tickets, ticket messages, notifications; uploads; and an audit log (kept thin on purpose, for C09).
- AC: real KYC documents, shipping carriers, tax, multi-currency, variants, reservations and wishlists are out.
- AC: a security-events table and an alerts page exist for C09.
- Source: D-24; RS-G 1.1; RS-F C09.

**FR-SHP-03 · Six roles and permissions** — Must · Locked
The system shall give each of the six shop roles the permissions of the RS-G matrix, scoped by store for seller roles.
- AC: customers see only their own orders; seller roles only their store's items; finance sees amounts without personal data; support agents can read any order.
- AC: gaps that challenges rely on (for example a missing store check in C01) are deliberate and listed in the challenge cards.
- Source: D-11, D-24, D-27; RS-G 1.2.

**FR-SHP-04 · Seven state machines** — Must · Locked
The system shall implement seven state machines.
- AC: seller approval: pending, approved or rejected; approved and suspended can swap; only the Admin moves it.
- AC: product: draft, pending review, published or rejected, then unlisted; editing a published title or price returns it to pending review (detail from RS-G).
- AC: checkout: cart, address, payment pending, paid or payment failed.
- AC: fulfilment (per order item): paid, processing, shipped, delivered, completed; paid or processing may be cancelled.
- AC: refund: requested, approved or rejected, processed. Dispute: open, under review, resolved for customer, resolved for seller, or escalated. Payout: accrued, ready, approved by finance, paid or held.
- Source: D-24; RS-G 1.1.

**FR-SHP-05 · Customer flows** — Must · Locked
The system shall let a customer browse, search, fill a cart, check out with simulated payment, track orders, review purchased items, request a refund, open a dispute and create a ticket.
- AC: payment is simulated by the mock gateway; no real card data exists.
- Source: D-09, D-10; RS-G 1.1.

**FR-SHP-06 · Seller flows** — Must · OPEN in part (see OI-20)
The system shall let a seller register a store (pending until approved), create and edit products, see and fulfil own store's orders, manage staff, view payouts, run a bulk catalog import preview and import product images by URL.
- AC: a pending seller can edit the profile and cannot publish.
- AC: whether a pending seller may create draft products with image import (needed by C10) is decided in OI-20.
- Source: D-10, D-11, D-20, D-26; RS-G, RS-F A2.

**FR-SHP-07 · Support, finance and admin flows** — Must · Locked
The system shall let the support agent handle tickets, disputes and review moderation, finance approve payouts and see commissions, and the Admin approve sellers and products, resolve escalated disputes, manage users and read the audit log and security alerts.
- Source: D-11; RS-G 1.2.

**FR-SHP-08 · Seeded accounts** — Must · Locked
The system shall seed each instance with the accounts the challenges need: a seller-staff login and a customer login for the player, a finance account, a dormant support-agent account, an admin, a support-agent bot account, other stores and customers no human uses.
- AC: no seeded account password is reused across challenges (C07 and C09 passwords differ).
- Source: D-26; RS-E A-3, RS-F.

**FR-SHP-09 · Strong hashing in the shop** — Must · Locked
The system shall hash all shop user passwords with a strong adaptive hash.
- AC: no MD5 or unsalted password hashes exist anywhere in the shop, so no leak can cross-solve C02.
- Source: D-26; RS-E C02.

**FR-SHP-10 · Refunds, disputes and payouts** — Must · OPEN in part (see OI-19)
The system shall make the seller bear refunds and chargebacks, reverse commission in proportion, and keep ledger rows append-only.
- AC: a partial refund reverses commission in proportion to the amount refunded (for example, a 40 percent refund returns 40 percent of the commission).
- AC: payout net = item prices minus commissions minus refunds plus commission reversals minus dispute fees.
- AC: refunds carry an idempotency key.
- AC: the model enforces "refunded total not above amount paid" everywhere except the deliberate C04 path; how is decided in OI-19.
- AC: a simulated bank chargeback can be injected by seed or Admin; the seller is liable unless support marks a platform error.
- Source: D-24; RS-G 1.3.

**FR-SHP-11 · Support-agent bot** — Must · Spike-dependent
The system shall run the support-agent bot as an on-demand headless browser per instance that views user-written content after it is posted.
- AC: each visit uses a fresh browser context, visits only pages of its own instance, runs for a fixed time, then closes.
- AC: the bot has no network access except the shop and the in-instance collector, keeps the browser sandbox and same-origin policy on, runs non-root, and is rate-limited with capped concurrency.
- AC: the bot's cookie is a normal session for a seeded account and never holds a platform secret.
- AC: spike S-5 measures memory; if too heavy, one shared bot browser per host with strict fresh contexts replaces it.
- Source: D-18, D-24; RS-G 1.4.

**FR-SHP-12 · Seeding** — Must · Locked
The system shall build each instance's data from a deterministic seeded world (a CI-built snapshot) plus a flag injector at start.
- AC: the world is the same in every instance; only flags and secrets differ.
- AC: spike S-4 measures shop cold start (RS-G target under 10 seconds is a proposal).
- Source: D-24; RS-G 1.5.

**FR-SHP-13 · Mock services** — Must · Locked
The system shall provide one combined mock-services container per instance for the payment gateway, the KYC provider and the fake metadata service.
- AC: all three are reachable only inside the instance network.
- Source: D-26; RS-F 4.

**FR-SHP-14 · Shop boundaries** — Must · Locked
The system shall let the shop communicate with the platform only through signed events and environment values, never through the platform database.
- AC: the shop has no route to the platform database, Valkey, orchestrator or other instances.
- AC: the shop's own audit log is separate from the platform audit log.
- Source: D-23; RS-D 3.2, RS-G 7.

**FR-SHP-15 · Health and runtime profile** — Must · Locked
The system shall make the shop expose a health endpoint, run non-root with a read-only filesystem, and accept late flag injection.
- Source: D-23; RS-B 10, RS-G 7.

---

# 6. Non-functional requirements

## 6.1 Security (SEC)

**NFR-SEC-01 · ASVS level 2 for the platform** — Must · Locked
The platform (API, dashboards, workers) shall meet OWASP ASVS 5.0 level 2.
- AC: a checklist table (requirement ID, how met, test, result) is kept in `docs/traceability.md`.
- AC: the ASVS 5.0 text is read from the official source before the report (research used secondary summaries).
- Source: D-21; RS-D 3.3.1.

**NFR-SEC-02 · ASVS level 3 for the orchestrator and admin** — Must · Locked
The orchestrator and the admin functions shall meet ASVS level 3.
- AC: both get a dedicated review and tests in the checklist.
- Source: D-21; RS-D 3.3.4.

**NFR-SEC-03 · Web security controls** — Must · Locked
The platform shall use CSRF protection (SameSite cookie plus token and origin check), same-origin access through the proxy (no open CORS), a strict content security policy, HSTS and the other standard security headers, and no stack traces to clients.
- AC: a cross-site form post to a state-changing route fails.
- AC: an error response shows only a generic message and a request ID.
- Source: D-21 (ASVS level 2); RS-D 3.3.2.

**NFR-SEC-04 · Orchestrator privilege** — Must · Locked
The public API shall never hold the Docker socket. Only a small orchestrator service shall, reachable only from the job queue or an internal network.
- AC: the orchestrator accepts instance IDs only, never an image name, volume, command, port or network from a request.
- AC: images come from a fixed allowlist pinned by digest; no container is privileged or mounts the host.
- AC: every orchestrator action is audit-logged and rate-limited.
- AC: a socket proxy or rootless Docker (final choice from spike S-3 and S-8) limits what the socket can do.
- Source: D-23, D-21; RS-D 3.3.4.

**NFR-SEC-05 · Secrets handling** — Must · Locked
The platform shall keep secrets out of the repository, logs, documents and responses.
- AC: a secret scanner runs in CI; dev and production secrets differ.
- AC: the flag master key, event-signing keys and the Docker socket sit on networks an instance can never join.
- Source: D-23, D-14; RS-D 3.3.2, RS-H Q6.

**NFR-SEC-06 · HTTPS everywhere** — Must · Spike-dependent
The system shall serve every public address over HTTPS, never plain HTTP.
- AC: the web address route (D-16) is chosen in this order: free domain, then a free dynamic-DNS name tested on Let's Encrypt staging, then the Oracle VM's public IP with a Let's Encrypt IP certificate (short-lived, about 160 hours, automatic renewal).
- AC: spike S-1 obtains a real certificate before the route is relied on.
- AC: Cloudflare quick tunnels are not used (no SSE, 200-request cap, no uptime guarantee).
- AC: which route is used is OPEN until OI-9 is answered.
- Source: D-16, D-17.

**NFR-SEC-07 · Dependency hygiene** — Must · Locked
The platform shall use lockfiles and automated dependency and secret scanning.
- AC: Dependabot or Renovate and weekly audits run; security releases of Next.js are applied promptly.
- AC: the intentionally outdated library in C06 is documented as intentional and excluded from failing the build.
- Source: D-21; RS-D 3.2, RS-E C06.

**NFR-SEC-08 · Threat model controls** — Must · Locked
The platform shall include the STRIDE controls of RS-D 3.3.5: server-side scores, signed monitor events, object-level authorisation on every query, append-only audit, quotas, and role changes by Admin only.
- AC: tests attempt cross-user and cross-company reads on the platform itself and all fail.
- Source: D-21, D-19; RS-D 3.3.5.

## 6.2 Isolation (ISO), from D-23

**NFR-ISO-01 · One internal network per instance** — Must · Locked
Each instance shall run on its own Docker internal network with no route out.
- AC: from inside an instance, the internet, the LAN, cloud metadata (169.254.169.254), other instances and the platform are unreachable.
- Source: D-23; RS-B 3.1.

**NFR-ISO-02 · Host-side rule** — Must · Spike-dependent
The host shall drop traffic from instance networks to the host itself, and host services (SSH, orchestrator, Docker proxy) shall listen only on loopback or a management network.
- AC: from inside an instance, the gateway IP, host services and `host.docker.internal` are unreachable.
- AC: tested on the Oracle VM (Linux firewall `DOCKER-USER` chain) and on Docker Desktop (spike S-3). Docker's own docs say the gateway IP stays reachable on an internal network, so this rule is required.
- Source: D-23 (design rule added by review); RS-B 3.1, RS-F C10 containment.

**NFR-ISO-03 · Hardened containers** — Must · Locked
Every instance container shall drop all capabilities, run non-root with a read-only root filesystem and tmpfs, set no-new-privileges, use Docker's default seccomp profile, and have memory, CPU and process limits.
- AC: none is privileged, mounts the Docker socket or host paths, or uses host networking.
- Source: D-23; RS-B 3.1.

**NFR-ISO-04 · Platform networks are separate** — Must · Locked
The platform database, Valkey, flag key and Docker socket shall sit on networks no instance can join. The only path from an instance to the platform is the sidecar's signed event call.
- Source: D-23; RS-B 3.1.

**NFR-ISO-05 · Extra hardening only if proven** — Must · Spike-dependent
The system shall add user namespaces or rootless Docker and gVisor only where tests show the stack still works.
- AC: the stack is safe without them; they are configuration, not architecture.
- AC: results of spike S-8 on WSL2 and the Arm VM are recorded.
- Source: D-23; RS-B 3.2.

**NFR-ISO-06 · Dedicated host environment** — Must · Locked
The orchestrator and instances shall run in a dedicated Linux VM or WSL distro, not next to personal data.
- Source: D-23, D-15; RS-B 3.1.

**NFR-ISO-07 · No egress for any part** — Must · Locked
No instance container, including the bot and the import service, shall have outbound access beyond its own network, apart from the sidecar's event call.
- Source: D-18, D-23, D-26; RS-B 3.1, RS-F C10.

## 6.3 Privacy (PRI)

**NFR-PRI-01 · Build to the data-protection duties** — Must · Locked
The product shall be built to the plain-language notice, consent, erasure and rights duties of India's DPDP Rules 2025, which start about 13 May 2027, although they are not yet in force at submission.
- AC: the notice, withdrawal, export, deletion and audit features of 5.16 exist.
- AC: this PRD does not claim legal compliance; see OI-33.
- Source: D-12, D-25; RS-H Q2.

**NFR-PRI-02 · Personal data kept out of logs and docs** — Must · Locked
Logs, documents and dev-log entries shall contain no real flag, secret, key or personal data.
- Source: CLAUDE.md, D-14; RS-D 3.3.2.

## 6.4 Performance and capacity (PRF)

All numbers are estimates until the named spike measures them.

**NFR-PRF-01 · Provisioning time** — Must · Spike-dependent
A cold-start instance shall be ready within a bounded time set after spike S-4 (proposal: under 15 seconds cold, under 3 seconds warm).
- Source: F1; RS-B 8.

**NFR-PRF-02 · Concurrent instances** — Must · Spike-dependent
The platform shall support the number of concurrent instances the host allows, with a measured memory budget per instance.
- AC: the earlier estimate of about 400 MB per instance is replaced by a measured figure that includes the Coraza sidecar, mock-services container, import service and the on-demand bot (the estimate assumed a database container, which SQLite removes, and no bot).
- AC: laptop estimate about 10 to 20 idle and 4 to 8 attacked; Oracle 2 OCPU / 12 GB about 20 to 30 idle and 6 to 10 attacked (not measured).
- Source: F8; D-24; RS-A 1.3.

**NFR-PRF-03 · Live-update latency** — Must · Spike-dependent
A milestone or capture shall appear on a connected dashboard in real time ("everything live, no user experience compromised").
- AC: the numeric target (seconds from event to screen) is fixed after spike S-2.
- Source: D-17.

**NFR-PRF-04 · Password hashing cost** — Must · Spike-dependent
Argon2id shall be tuned so one hash takes about 0.2 to 0.5 seconds on the server (placeholder; OWASP minimum is 19 MiB memory, 2 iterations, 1 lane).
- AC: parameters are set after spike S-12.
- Source: D-21; RS-D 2.1, RS-H Q6.

**NFR-PRF-05 · Demo load** — Must · Locked
The platform shall run a live demo with one presenter and one to three instances comfortably.
- Source: `initial.md` Section 12; RS-A 1.3.

**NFR-PRF-06 · Load test** — Must · OPEN (see OI-2)
The project shall state whether a formal load test is required for the report.
- AC: if required, the tooling and target are decided in OI-2.
- Source: Q-13.

## 6.5 Availability and fallback (AVL)

**NFR-AVL-01 · Oracle keep-alive** — Must · Locked
The team shall keep the Oracle VM active with real use so it is not reclaimed after 7 days of low use (CPU, network and memory all under 20 percent over 7 days).
- AC: an owner is named (OI-8).
- Source: D-15; RS-A 1.1.

**NFR-AVL-02 · Laptop fallback** — Must · Locked
The same system shall run on the demo laptop as a fallback with only configuration changes.
- AC: a documented, tested start procedure exists for the laptop.
- Source: D-15; RS-A 3.

**NFR-AVL-03 · Capacity or card fallback** — Must · Locked
If Oracle returns "out of capacity" or refuses the account, the team shall fall back to the laptop as host, or to Azure for Students (USD 100 credit for 12 months, no credit card).
- Source: D-15.

**NFR-AVL-04 · Self-healing** — Must · Locked
The platform shall recover from an orchestrator or worker restart without losing instances or attempts.
- AC: spike S-13 kills the orchestrator mid-provision and the reconciler repairs state.
- Source: D-21, D-23; RS-D 3.1, RS-B 9.

**NFR-AVL-05 · Backups** — Must · Locked
The platform shall keep 14-day rolling backups and shall test a restore.
- AC: the backup destination is decided in OI-28.
- Source: D-25.

## 6.6 Portability (POR)

**NFR-POR-01 · Move to a paid server without architecture change** — Must · Locked
The system shall move from the free tier to a paid server (or several) by changing configuration only.
- AC: API URL, instance-host URL, database URL and Valkey URL are all configuration values.
- AC: the orchestrator talks to an "instance host" through one stable interface, so laptop, Oracle VM and paid server differ only in configuration.
- Source: `initial.md` Section 12, D-15; RS-A 1.2.

**NFR-POR-02 · Multi-architecture images** — Must · Locked
Every image shall be built for amd64 and arm64.
- AC: reasons: Oracle's free Arm VM is arm64; all three developer machines are amd64 (Tanmay: AMD Ryzen 5 on Windows 11; Akshay: Intel Mac, 16 GB; Sahil: Intel HP Victus, 16 GB, Windows 11), as confirmed by the user on 2026-10-08.
- AC: each base image (Node, proxy, headless browser, Coraza build) is checked for an arm64 build.
- Source: Q-24; RS-A 6.

**NFR-POR-03 · Cross-platform developer scripts** — Must · Locked
Developer scripts and setup steps shall work on Windows and macOS.
- AC: a setup guide exists per OS; Docker status on Akshay's and Sahil's machines is confirmed (OI-6).
- Source: Q-24; CLAUDE.md.

## 6.7 Observability (OBS)

**NFR-OBS-01 · Request IDs and structured logs** — Must · Locked
Every response and log line shall carry a request ID, and logs shall be structured and free of secrets.
- Source: D-21 (ASVS level 2); RS-D 3.3.2.

**NFR-OBS-02 · Health and metrics** — Must · Locked
Each service shall expose health, readiness and version endpoints, and the orchestrator shall expose instance counts, reaper results and failure counts.
- AC: the Admin capacity view (FR-ADM-06) uses them.
- Source: F8; RS-D 3.5.

## 6.8 Maintainability and documentation (MNT)

**NFR-MNT-01 · Documentation rule** — Must · Locked
After every task, before commit, the developer and Claude Code shall write a dev-log entry, a decision record when a significant decision was made, a changelog line, traceability updates and evidence, using real results only.
- AC: the commit hook blocks code commits without a dev-log entry and a changelog update; `[no-doc]` is for non-functional commits only.
- AC: no flag, secret or personal data appears in any doc.
- Source: D-14; `CLAUDE.md`.

**NFR-MNT-02 · Contract-first interfaces** — Must · Locked
The three work-streams shall meet only at written interface contracts agreed before coding: an OpenAPI file and JSON Schemas for events and error codes.
- AC: CI fails if the committed OpenAPI file is out of date, and flags breaking changes.
- AC: the platform database is owned only by the API; the shop and monitor never touch it.
- Source: `initial.md` Section 16; D-21; RS-D 3.2.

**NFR-MNT-03 · Pinned versions** — Must · Locked
The project shall use Python 3.14, Node 24 LTS for all JavaScript including the shop, PostgreSQL 18, Next.js 16, FastAPI, SQLAlchemy 2 with Alembic, Dramatiq and Valkey, with exact versions pinned from the registries on repository setup.
- AC: Node 26 is revisited after setup (it becomes LTS on 2026-10-28).
- AC: Next.js 15 reaches end of life on 2026-10-21 and is not used.
- Source: D-21.

**NFR-MNT-04 · CI and quality gates** — Must · Locked
The repository shall run GitHub Actions CI on Linux runners with path filters and caching, plus lint, type, unit and end-to-end tests.
- AC: private repo budget about 2,000 minutes a month across the team; usage is tracked (unverified figure from RS-D).
- AC: untrusted pull-request code never runs with secrets.
- Source: D-14, D-21; RS-D 3.2 (tool choices are detail from RS-D).

**NFR-MNT-05 · Migrations** — Must · Locked
Database migrations shall use one linear Alembic history, one migration per pull request, CI check for a single head, and backward-compatible changes for one release.
- Source: D-21; RS-D 3.2.

**NFR-MNT-06 · Repo and remote rules** — Must · Locked
The code shall live in the private GitHub repo `owasp-mart` on the personal account, reached by SSH only, with pushes only when the developer asks.
- Source: D-14; `CLAUDE.md`.

## 6.9 Browser support and accessibility (UX)

**NFR-UX-01 · Browser support** — Must · OPEN (see OI-30)
The dashboards and the shop shall work in a stated list of browsers.
- AC: the list is decided in OI-30 (proposal: current and previous major versions of Chrome, Edge, Firefox and Safari).
- Source: not decided.

**NFR-UX-02 · Accessibility** — Must · OPEN (see OI-30)
The dashboards shall meet a stated accessibility level.
- AC: the level is decided in OI-30 (proposal: WCAG 2.2 level AA for the platform dashboards; the shop is intentionally vulnerable and need not meet it).
- Source: not decided; RS-D 2.2 (accessible UI kit, unverified).

**NFR-UX-03 · Plain language** — Must · Locked
Consent notices, errors and help text shall be in plain language.
- Source: D-12; RS-H Q4.

**NFR-UX-04 · Notice languages** — Must · OPEN (see OI-31)
The system shall state which languages the consent notice is offered in.
- AC: English is the baseline; a Hindi version is decided in OI-31.
- Source: RS-H Q4.

## 6.10 Cost (CST)

**NFR-CST-01 · Free tiers only** — Must · Locked
The project shall use only free tiers and free services.
- AC: no step requires a paid plan; a card is used only for Oracle identity verification (small temporary hold) and the account never moves to Pay As You Go.
- AC: an Oracle budget alert is set (steps unconfirmed; owner in OI-8).
- Source: D-15, `initial.md` Section 12.

**NFR-CST-02 · Free-tier limits respected** — Must · Locked
The design shall stay inside free limits: Oracle 2 OCPU / 12 GB / 200 GB, Vercel Hobby limits, email caps and GitHub Actions minutes.
- AC: the invite cap and the outbox (FR-ORG-08, FR-NTF-02) keep email within the daily cap.
- AC: Vercel Hobby carries the dashboards only (it is non-commercial and does not permit penetration testing on Hobby).
- Source: D-15; RS-A 1.1.

## 6.11 Extensibility (EXT), from O6

**NFR-EXT-01 · Organization identifier everywhere** — Must · Locked
Every recruiter-owned record shall carry an organization identifier filtered centrally (see FR-ORG-06).
- Source: O6, D-19; RS-D 3.4.2.

**NFR-EXT-02 · Catalogue and instance template as data** — Must · Locked
The challenge catalogue and the per-instance container recipe shall be data, so a new target app or challenge set can be added without changing the orchestrator contract.
- Source: O6; RS-D 3.5.

**NFR-EXT-03 · JSON API beside HTML** — Must · Locked
The shop shall expose a JSON API next to its server-rendered pages.
- Source: O6; RS-G 1.6.

**NFR-EXT-04 · Instance host as configuration** — Must · Locked
The instance host (laptop, Oracle VM, paid server, later a cluster) shall be a configuration value behind one interface (see NFR-POR-01).
- Source: O6, D-15; RS-A 1.2.

---

# 7. Constraints and assumptions

| # | Constraint or assumption | Source |
|---|---|---|
| K-1 | Free tiers only. A card is available for Oracle identity verification (user confirmed). | D-15 |
| K-2 | Hosting: dashboards on Vercel free tier; platform API and all user instances on an Oracle Always Free VM; the laptop is for development and a demo fallback. | D-15 |
| K-3 | Web address: free route first (free domain or free dynamic-DNS name, automatic HTTPS); else the VM's public IP with a Let's Encrypt IP certificate. Never plain HTTP. | D-16 |
| K-4 | Versions: FastAPI, Next.js 16, PostgreSQL 18, Python 3.14, Node 24 LTS everywhere, Dramatiq, SQLAlchemy 2 + Alembic, Argon2id session cookies, Valkey, ASVS 5.0 level 2 (level 3 for orchestrator and admin), Resend or Brevo. | D-21 |
| K-5 | Deadline: first week of November 2026 (exact date OPEN, OI-1). Full scope, no feature cutting, schedule risk accepted by the user. | D-13 |
| K-6 | Team: three developers (Tanmay Gupta on Windows 11 with an AMD Ryzen 5 and 15.3 GB; Akshay Gupta on an Intel Mac with 16 GB; Sahil Roy on an Intel HP Victus with 16 GB on Windows 11) build with Claude Code. Aarya Bhangadia and Paras Sharma are authors with roles OPEN (OI-3). | `initial.md` Section 12, Q-24 |
| K-7 | Deliverables: live demo (on the user's PC), report and GitHub link. | D-13 |
| K-8 | Repository: private `tannmayygupta/owasp-mart`, SSH only (alias `github-personal` on Tanmay's PC), push only when asked. | D-14, CLAUDE.md |
| K-9 | Documentation rule enforced by `CLAUDE.md` and a commit hook; college report template pending. | D-14, Q-26 |
| K-10 | Demo machine: HP Victus, Ryzen 5 5600H, 15.3 GB RAM, Docker installed but not running, WSL not set up, C: tight (21.7 GB free), D: roomy. | `initial.md` Section 12 |
| K-11 | Guide approved VulnMart. The guide has not yet been told about the changes since the synopsis (OI-7). | Section 12 |
| K-12 | Assumption: Oracle grants the 2 OCPU / 12 GB Arm shape (the earlier 4 OCPU / 24 GB may be cut; third-party reports disagree). | RS-A; OI-36 |
| K-13 | Assumption: all challenge and number placeholders are tuned by a pilot whose participants are not yet identified. | OI-4 |

---

# 8. External dependencies

| Dependency | Used for | Risk or note |
|---|---|---|
| **Vercel (Hobby)** | Dashboards (Next.js) | Hobby is non-commercial; pentest page says not permitted for Hobby; hosting only dashboards avoids the issue. Acceptable-use for vulnerable labs not found. |
| **Oracle Cloud Always Free VM** | API, orchestrator, workers, database, all instances | Out-of-capacity errors; 7-day idle reclaim; quota cut reported; card needed for sign-up; terms silent on vulnerable training labs (email Oracle and keep the reply). |
| **Let's Encrypt, and a DNS or dynamic-DNS provider** | Free HTTPS for the web address | IP certificates are new (generally available 15 January 2026); Caddy may need another ACME client for IP certificates; sslip.io rate-limit risk (unverified). |
| **Email service (Resend or Brevo)** | Verification, invites, warnings | Resend free: 100 a day, 3,000 a month, needs a verified domain; Brevo limits unverified. |
| **GitHub** | Repository, GitHub Actions CI, Student Developer Pack (possible free domain, unconfirmed) | Private repo; about 2,000 CI minutes a month (unverified). |
| **Docker Engine and Docker Desktop** | Instances (Oracle VM: Engine; laptop: Desktop with WSL2) | Docker Desktop on Windows Home needs WSL2, not yet set up. |
| **OWASP Coraza and Core Rule Set v4.30.0** | Detect-only classifier | Coraza's Caddy plugin is marked "needs a maintainer"; sidecar form to be decided (spike S-7). |
| **Azure for Students (fallback)** | Only if Oracle fails | USD 100 for 12 months, no card; VM disabled when credit ends. |
| **Cloudflare** | Not used for tunnels (D-16). Possibly Turnstile for CAPTCHA (OI-29, unverified). | Quick tunnels have no SSE and a 200-request cap. |

---

# 9. Data requirements

Summary of the data inventory in RS-H Q3 with the values of D-25. Clock A is the assessment clock (180 days default, 30 to 365). Clock L is the learner clock (12 months after last login). No flag, key or secret value is written in documents.

| Item | Purpose | Retention | Who can see it | Deletion method |
|---|---|---|---|---|
| Account: name, display name, role | Login, identity | Account life; learner 12 months after last login | Self; Admin (support); recruiter sees the invited candidate's name only | Row delete; audit rows keep an opaque ID |
| Email | Login, invites, verification | Same as account | Self; Admin; inviting recruiter (for own invite) | Row delete |
| Password hash (Argon2id) | Login | Account life | Nobody | Row delete |
| Invite token (hash) | Single-use invite | Until used or expired (default 7 days), then purge | Nobody | Purge job |
| Assessment answers and write-ups | Scoring, review | A | Candidate; the company's users on that assessment | Hard delete, key shredded |
| Captured flag-capturing request and payload | Evidence (D-07) | A (candidate); 30 days after instance teardown (learner) | Candidate; recruiter (candidate case) | Hard delete; encrypted with per-assessment key |
| Scores, timings, hints used, integrity flags | Scoring, dashboards, anti-cheat | A (candidate); L (learner) | Candidate; recruiter; learner (own) | Hard delete |
| IP address and browser details | Security, anti-cheat | Session records 90 days; candidate attempt value kept with the attempt | Admin; recruiter only if decided | Truncate at 90 days (learner); delete with the attempt (candidate) |
| Consent records | Proof of consent | Assessment retention plus 12 months (research proposal, OI-37); minimal form after | Candidate; Admin; recruiter (that consent was given) | Delete; keep only hash and version after expiry |
| Audit log (pseudonymised, hash-chained) | Accountability | 12 months, then purge | Admin; candidate sees own view history at company level; recruiter sees own company's rows | Pseudonymise on candidate deletion; purge at 12 months |
| Security and system logs | Detect misuse | 12 months | Admin only | Purge job |
| Flags (per instance) | Prove exploitation | Instance life; derived value discarded | Platform monitor only; never shown to recruiters | Destroyed with the instance |
| Learner solutions and progress | Learner dashboard | L | Self only | Hard delete |
| Instance contents and raw container logs | Running the instance | Destroyed at teardown; raw logs at most 7 days | Nobody after teardown | Instance destruction |
| Backups | Recovery | Rolling 14 days with key shredding | Operator only | Expire; crypto-shred keys |

---

# 10. Risks and mitigations

## 10.1 Risk register

| ID | Risk | Mitigation | Related |
|---|---|---|---|
| R-1 | **Oracle capacity.** The VM request may return "out of host capacity"; the free shape was reported cut from 4 OCPU / 24 GB to 2 OCPU / 12 GB (third-party reports disagree on enforcement). | Request early; fall back to the laptop or Azure for Students; size the design for 2 OCPU / 12 GB; spike S-11. | D-15, OI-36, NFR-AVL-03 |
| R-2 | **7-day idle reclaim.** Oracle reclaims a VM whose CPU, network and memory stay under 20 percent for 7 days. | Keep real use; name an owner; a fake cron load would not be honest use; monitor. | NFR-AVL-01, OI-8 |
| R-3 | **Host access through the gateway IP.** Docker says an internal network still lets a container reach the gateway IP and host services. On Docker Desktop, dropping that traffic is hard and untested. | Host-side drop rule on the VM; services bound to loopback; spike S-3; the laptop holds no secrets and is not exposed publicly without HTTPS and authentication. | D-23, NFR-ISO-02 |
| R-4 | **Provider terms of service.** No provider read clearly allows or bans a deliberately vulnerable training lab (Oracle's pages were not readable). A host could suspend after an abuse report. | Email Oracle and keep the reply for the report; keep vulnerable code only on the VM we control; Vercel carries dashboards only. | D-15, OI-8 |
| R-5 | **Memory per instance and the bot.** A headless Chromium may use 150 to 600 MB (sources differ); the 400 MB estimate is out of date (SQLite removes a database container; the sidecar, mock services and bot add memory). | Start the bot on demand; spikes S-4 and S-5; share one bot browser per host if too heavy. | NFR-PRF-02, FR-SHP-11 |
| R-6 | **Coraza Caddy plugin maintenance.** The plugin is marked "needs a maintainer"; the Traefik plugin is in preview. | Decide in spike S-7 between the Caddy plugin and a small Go program embedding Coraza (Coraza itself is actively released). | D-23, FR-DET-02 |
| R-7 | **DPDP uncertainty.** The official text of G.S.R. 846(E) was not read; all DPDP statements come from secondary sources; the college's status as fiduciary is unclear. | Build to the strictest reading; legal review by the guide or legal cell; read the Gazette before the report. | D-25, OI-33 |
| R-8 | **Unverified items.** Examples: Let's Encrypt IP certificate with Caddy, Resend without a verified domain, Brevo limits, CRS tag names beyond two, gVisor on WSL2, GitHub Student Pack domain, CWE-1035/1329/1357 names, WSTG IDs. | Spikes S-1 to S-13; re-check each on setup day; record real results in the dev-log. | Q-31 |
| R-9 | **Schedule risk.** About 4 weeks to submission for a large scope with no cutting. | Accepted by the user (D-13); no mitigation by cutting. Contract-first work-streams reduce blocking. | D-13 |
| R-10 | **Single points of failure.** One Oracle account owner; a laptop demo that depends on Wi-Fi; a campus network that may block ports. | Name an owner and give the others access (OI-8); test on campus; keep the laptop fallback. | OI-8 |
| R-11 | **Classifier accuracy.** Rules catch only injection-style attacks; per-challenge time may really be "time into the assessment". | Three layers (D-07); app events for logic bugs; raw evidence; "estimated" labels. | FR-DET-07 |
| R-12 | **Cross-challenge leaks.** One exploit could solve another challenge or give code execution that exposes all flags (10 conflicts listed in RS-E, more in RS-F). | Sentinel flags; separate catalog store; isolated import service; synthetic diagnostics object; tests per challenge. | FR-CHL-13 |
| R-13 | **Email caps.** Free caps (Resend 100 a day) can be exceeded by one batch of invites. | Outbox and queue; invite caps; Brevo fallback. | FR-ASM-06 |
| R-14 | **The platform sits next to code built to be hacked.** | Separate networks; no Docker socket in the API; ASVS level 3 for the orchestrator; assume any shop container is compromised. | NFR-SEC-04 |
| R-15 | **Free-tier changes.** Limits and prices move (Oracle already cut once). | Re-check each vendor page on the day of use. | NFR-CST-02 |
| R-16 | **Dev environment.** Docker Desktop on Windows Home needs WSL2 (not set up); C: has little space; two developers' machines unchecked. | Move WSL and Docker data to D:; set `.wslconfig` limits; confirm other machines (OI-6). | K-10 |
| R-17 | **Integrity without proctoring.** No camera or screen capture means cheating risk is accepted. | Layered signals reviewed by a human; recruiter follow-up interview as the best use of evidence. | D-22 |
| R-18 | **Legal exposure from real candidates' data.** | Consent, minimum data, deletion, legal review, 18+ only. | D-12, D-25 |

## 10.2 Spike register

Spikes are experiments to run later. They turn estimates into measurements.

| ID | Spike | Fixes |
|---|---|---|
| S-1 | Real Let's Encrypt certificate for the Oracle VM (domain, sslip.io-style name, IP), staging then production | NFR-SEC-06, OI-9 |
| S-2 | SSE through the real path with heartbeat, replay and HTTP/2 | FR-LIV-02, FR-LIV-03, NFR-PRF-03 |
| S-3 | Host-access blocking on Docker Desktop and on the Oracle VM, including the host-side drop rule; socket proxy versus rootless | NFR-ISO-02, NFR-SEC-04 |
| S-4 | Instance start time and combined per-instance memory; shop cold start | FR-INS-01, NFR-PRF-01, NFR-PRF-02 |
| S-5 | Headless-browser memory per instance and concurrent bot visits | FR-SHP-11 |
| S-6 | Coraza with CRS v4.30.0 in detect-only: tag names, false positives, latency, classifier accuracy | FR-DET-02, FR-DET-07 |
| S-7 | Coraza sidecar form: Caddy plugin or small Go program | R-6 |
| S-8 | gVisor and rootless Docker on WSL2 and the Arm VM | NFR-ISO-05 |
| S-9 | C06 pollution input on Node 24; read-only catalog store limits; flag matcher with JSON escaping and gzip | FR-CHL-07, FR-CHL-04 |
| S-10 | Crypto-shredding with per-assessment keys and a backup restore; audit hash chain with concurrent writes | FR-PRV-12, FR-PRV-10 |
| S-11 | Oracle: shape granted, time to capacity, idle reclaim behaviour | R-1, R-2 |
| S-12 | Argon2id parameters on the server | NFR-PRF-04 |
| S-13 | Orchestrator crash recovery and reaper correctness | NFR-AVL-04 |

---

# 11. Open items register

## 11.1 Open items

> **Update 2026-10-08:** OI-16, OI-17, OI-18, OI-19 and OI-20 are resolved by decision D-32 (design in `docs/design/challenge-specs.md`). Their rows below are kept as written for the record.

| ID | Question for the user | Why it matters | Options if known | Depends |
|---|---|---|---|---|
| OI-1 | What is the exact submission date, and are there interim review dates? (Q-02) | Sets the calendar | none given | K-5 |
| OI-2 | Is a load test required in the report? (Q-13) | Decides whether load-test tooling is built | yes with a target / no | NFR-PRF-06 |
| OI-3 | Who writes the report, and what do Aarya Bhangadia and Paras Sharma do (docs, testing, pilot users)? (Q-21) | Report ownership; pilot people | docs / testing / pilot | SM-1 to SM-3 |
| OI-4 | Who are the pilot and mock-hiring-round participants? (Q-22) | Success measures and placeholder tuning need real people | students of the college; the five authors | SM-1 to SM-3, K-13, FR-ACH-03 |
| OI-5 | Is "VulnMart" the final product name? (Q-23) | Naming in code, docs, report | VulnMart / OWASP Vulnerable Practice-and-Hiring Platform | all |
| OI-6 | **Mostly answered (2026-10-08):** Akshay's Mac is an Intel Mac with 16 GB RAM; Sahil has an Intel HP Victus with 16 GB on Windows 11; Docker is installed on both (user). **Still open:** macOS version, Sahil's exact CPU, and whether Docker actually runs on their machines. (Q-24) | Dev environment setup | check by running a test container | NFR-POR-02, NFR-POR-03 |
| OI-7 | When will the guide be told about the changes since the synopsis (OWASP 2025 with dual tags, marketplace with six roles, admin role and approval, SSE, Valkey, Dramatiq and SQLAlchemy)? (Q-25) | The synopsis was approved as written | a date | Section 12 |
| OI-8 | Which developer owns the Oracle account; how do the other two get access; who sets the budget alert; who keeps the VM active; who emails Oracle about terms? (Q-32) | Single points of failure | named owner | NFR-AVL-01, NFR-CST-01 |
| OI-9 | Which web-address route will be used: free domain (GitHub Student Pack, unconfirmed), a free dynamic-DNS name, or the VM's IP certificate? (Q-30) | HTTPS for the dashboards-to-API call; email sender domain | per D-16 order | NFR-SEC-06, FR-NTF-03 |
| OI-10 | How are free-email addresses (public webmail) handled in recruiter signup? D-04 said this would be settled in R-01 but it was not. | Fake-recruiter risk versus blocking small firms | block / allow with extra admin check / allow | FR-ORG-04 |
| OI-11 | After a rejection, how many days before a recruiter may re-apply, and is company-name verification needed beyond the email domain? | Abuse control | N days (not set) | FR-ORG-05 |
| OI-12 | What is the break-glass duration and who gets the real-time alert and does the review? | D-19 left them open | e.g. a short fixed window; alert to other admins | FR-ADM-03 |
| OI-13 | Will Recruiter MFA become mandatory, and will passkeys replace or add to TOTP? | Security level of the privileged tier | stay optional / mandatory later; TOTP minimum | FR-ACC-07 |
| OI-14 | Is the candidate's short write-up per solved challenge optional or required (D-07)? Is the solution write-up shown in hiring mode, and when (D-08)? | Affects evidence, similarity review and fairness | write-up hidden until the recruiter closes the assessment (RS-C recommendation) | FR-DET-03, FR-CHL-14, FR-ASM-01, FR-ACH-04 |
| OI-15 | When does a Candidate see their own results: right after submit, or after the recruiter closes or releases them? Is it a recruiter setting? | D-12 says candidates can see results; timing not fixed | after submit (RS-C) / recruiter setting | FR-DSH-04, FR-ASM-01 |
| OI-16 | How do the difficulty ratings 1 to 5 in D-26 map to the three scoring tiers (60, 90, 120 are placeholders)? | Needed for the score formula | for example 1 to 2 Easy, 3 Medium, 4 to 5 Hard (my suggestion, not research) | FR-CHL-17, FR-SCR-01, Appendix A |
| OI-17 | What are the concrete M1 ("found the weakness") and M2 ("working exploit evidence") events for each of the 11 challenges? | The 20/40/100 split cannot work without them | The cards define capture signals, not M1 and M2 | FR-DET-05, FR-SCR-02 |
| OI-18 | C03's stored-XSS part has no challenge card (RS-E dropped it; RS-F says RS-E owns it): which user-written field does the support bot view, how is it triggered, what are the milestones, and which CWE tag applies? | D-18 and D-26 require it; the design is missing | reviews, tickets or reported reviews (RS-G lists them) | FR-CHL-04, FR-DET-09, FR-SHP-11 |
| OI-19 | How does C04's missing cumulative refund cap fit the shop's refund model? RS-G's model checks "refunded total not above amount paid" and refunds per order item; RS-E's C04 refunds per order with no cap and auto-approves with no review (RS-G has the seller owner approve under a limit). | The refund model and the challenge contradict each other | C04 path skips the cap on purpose and every other path enforces it | FR-CHL-05, FR-SHP-10 |
| OI-20 | May a pending (not yet approved) seller create draft products with "import image from URL"? RS-F needs it for C10; RS-G only says pending sellers cannot publish. | C10 may otherwise depend on C11 | allow drafts / give customers an avatar-URL import | FR-CHL-11, FR-SHP-06 |
| OI-21 | What are the per-user, per-company and global instance quotas? | Capacity and abuse limits | set after spikes S-4, S-5 | FR-INS-06, FR-ADM-05 |
| OI-22 | Does the 120-minute clock start when the candidate presses Start or when the instance is ready? | Fairness; D-22 states time is measured from instance ready | instance ready (RS-A, RS-C favour it) | FR-SES-01 |
| OI-23 | May an idle candidate instance be stopped and restored inside the assessment window (RS-C), or is it kept for the whole window (D-23)? | Capacity versus simplicity | keep the whole window / stop and restore (needs a state-saving spike) | FR-INS-03 |
| OI-24 | How many times is a failed instance start retried: once (RS-B) or up to 2 (RS-D)? | Failure behaviour | 1 or 2 | FR-INS-08 |
| OI-25 | Confirm or tune the research numbers that no locked decision fixed: session idle 30 min, Admin 15, absolute 12 h; email and reset token expiry 24 h; invite token size (RS-C says 128 bits, RS-H says 256 bits); time warnings at 15 and 5 minutes; 60-second submit grace; reset limit 3; time-limit range 30 to 480 minutes; invite expiry range 1 to 30 days; submission limits (5 per 10 min, 10-min lock, cap 30); idle gap 5 minutes; evidence cap 8 KB; hint cost 10, 20, 30 percent; flag format; gift-card and refund limits; request rate limits. | They appear in requirements as placeholders | accept as placeholders and tune in the pilot | FR-ACC-02, ACC-04, ASM-01, ASM-02, SES-02, SES-03, SES-09, ACH-01, TIM-02, DET-03, SCR-03, FLG-02 |
| OI-26 | Is the optional private cohort leaderboard (D-22 "optional") built? Are the research tie-break rules adopted? | Scope and fairness | build for the pilot only / not build | FR-SCR-07, FR-SCR-08 |
| OI-27 | What can a Recruiter export (format, scope, evidence included)? | The synopsis states dashboards only; export is a required area | CSV and JSON of scores; PDF summary (optional in RS-H) | FR-EXP-03 |
| OI-28 | Where do the platform PostgreSQL and Valkey run (Oracle VM or free managed tiers such as Neon and Upstash)? Where do 14-day backups and the daily audit-log anchor live? | Availability, privacy story, restore tests | self-hosted on the VM (RS-A suggests it when the API is on the same machine) / managed free tiers | FR-PRV-10, NFR-AVL-05 |
| OI-29 | Does Learner signup need a CAPTCHA (research suggests Cloudflare Turnstile, not read)? | Email-bomb and bot signups on free email caps | CAPTCHA / rate limits only | FR-ACC-10 |
| OI-30 | Which browsers and accessibility level are supported? | Not decided anywhere | Chrome, Edge, Firefox, Safari (current and previous major); WCAG 2.2 AA for the platform | NFR-UX-01, NFR-UX-02 |
| OI-31 | Is a Hindi version of the consent notice needed? | DPDP lets people ask for notice in Constitution languages (unverified) | English only / English and Hindi | NFR-UX-04 |
| OI-32 | Resend or Brevo? | Resend needs a verified domain; Brevo limits unverified | Resend with domain / Brevo single-sender | FR-NTF-03 |
| OI-33 | Legal review: the notice, retention periods, 18+ self-declaration, who is the data fiduciary for a college project, GDPR for any EU or UK candidates, whether a one-year log rule conflicts with erasure; read the official Gazette text. | Not legal advice; DPDP statements are from secondary sources | review by the guide or the institute's legal cell (D-25 action) | FR-PRV-13, FR-PRV-19, NFR-PRI-01 |
| OI-34 | What is the breach and incident procedure, and who tells whom and when? | DPDP research mentions a 72-hour report (unverified); nothing is decided | write a short procedure | FR-PRV-20 |
| OI-35 | Re-verify CWE, ATT&CK and WSTG IDs per challenge; choose a CWE for the XSS part; confirm CRS tag names beyond `attack-sqli` and `attack-ssrf`; note the apparent CWE-477 versus CWE-447 typo on OWASP's A03 page. | D-07 left the IDs open | check on cwe.mitre.org, attack.mitre.org, rule files | FR-CHL-01, FR-DET-02 |
| OI-36 | Which Oracle shape will the team actually get (2 OCPU / 12 GB or 4 OCPU / 24 GB), and does pay-as-you-go change it? | Capacity numbers | measured in spike S-11 | R-1, K-12 |
| OI-37 | How long is the minimal consent record kept after the assessment record is deleted? D-25 is silent; RS-H proposes assessment retention plus 12 months [LAWYER]. | Proof of consent versus minimum data | 12 months after / shorter | FR-PRV-02 |
| OI-38 | Who may review held captures (the recruiter only, or an Admin as well), and within what time? | A held capture blocks the final score | recruiter reviews (RS-C) | FR-ACH-07, FR-SCR-10 |

## 11.2 Contradictions found between locked decisions and the research notes

The locked decision wins in every case. Items that still need a user answer have an OI number.

| ID | Research note says | Locked decision or source says | Resolution |
|---|---|---|---|
| C-1 | RS-D: an inactive attempt may move to PAUSED | D-22: no pause in hiring mode | D-22 wins; no paused state (FR-SES-06, FR-SES-08) |
| C-2 | RS-C decision candidate: recruiter may choose "reset loses progress" | D-22: milestones survive an instance reset | D-22 wins (FR-SES-09) |
| C-3 | RS-B event contract carries a request-body snippet on every request; RS-H and RS-B store bodies as evidence | D-22: activity metadata without request bodies; D-25: store the capturing request plus metadata | D-22 and D-25 win: only the flag-capturing request body is kept (FR-DET-03, FR-DET-08) |
| C-4 | RS-G: Node 22 | D-21: Node 24 LTS everywhere including the shop | D-21 wins |
| C-5 | RS-A: Cloudflare tunnel (including quick tunnels), Neon and Upstash, WebSockets (also `initial.md` Section 10 synopsis stack) | D-15, D-16, D-17, D-21: Oracle VM, own HTTPS address, no quick tunnels, SSE, Valkey | Locked decisions win; where the database runs is OI-28 |
| C-6 | RS-E: C03 is SQL injection only | D-18: C03 has two parts including stored XSS | D-18 wins; the XSS card is missing (OI-18) |
| C-7 | D-09 idea and RS-E: C11 as payment fail-open | D-20: C11 is seller KYC fail-open | D-20 wins |
| C-8 | RS-B and RS-A: a database container per instance, about 400 MB per instance | D-24: SQLite per instance; D-26: more containers and a bot | D-24 wins; memory re-measured (NFR-PRF-02) |
| C-9 | D-12 text presents the 48-hour pre-erasure warning as a DPDP fact | D-25 clarification and RS-H: it applies only to Third Schedule classes (secondary sources) | D-25 wins (FR-PRV-16) |
| C-10 | RS-G: refunds are capped at the amount paid, per order item, approved by the seller owner under a limit | D-26: C04 has no cumulative cap; RS-E: per order, auto-approved | Needs a user answer (OI-19) |
| C-11 | RS-C: invite token 128 bits; RS-H: 256 bits | none | Needs a user answer (OI-25); this PRD says at least 128 bits |
| C-12 | RS-B: retry a failed start once; RS-D: up to 2 | none | OI-24 |
| C-13 | RS-C: an idle hiring instance may be stopped and restored | D-23: candidates keep the assessment window | OI-23 |
| C-14 | RS-D: admin approves every recruiter (literal D-04) | D-19: admin approves the company once; owner approves colleagues | D-19 wins (RS-D itself recommends this) |
| C-15 | RS-F A1 and RS-E A-3: different player start states (self-registered customer or pending seller, versus seeded staff login) | D-26 lists challenges only | Each challenge states its own start state (FR-CHL-15) |
| C-16 | RS-G: a seeded refund approval by seller owner; RS-E: "no review" for C04 auto-approve | D-26 | Part of OI-19 |

---

# 12. Traceability

## 12.1 Locked decisions to requirements

| Decision | Implemented by |
|---|---|
| D-01 Flag capture both | FR-FLG-04, FR-FLG-05, FR-FLG-06, FR-DET-04 |
| D-02 Unique per-instance flags | FR-FLG-01, FR-FLG-02, FR-FLG-03, FR-INS-04, FR-SES-09 |
| D-03 Four platform roles | FR-ACC-01, FR-ACC-05, FR-ORG-01, Section 2.1 |
| D-04 Recruiter self-signup, verification, approval | FR-ACC-02, FR-ACC-10, FR-ORG-01, FR-ORG-02, FR-ORG-04, FR-ORG-05, FR-ADM-01 |
| D-05 One account, privacy wall | FR-ACC-05, FR-ACC-06, FR-ASM-04, FR-DSH-02, FR-DSH-06, FR-LIV-05 |
| D-06 OWASP 2025 with 2021 tags, 11 challenges | FR-CHL-01, FR-DET-01, FR-DSH-01 |
| D-07 Three-layer technique detection | FR-DET-01 to FR-DET-09, FR-ASM-01 |
| D-08 Hints | FR-HNT-01 to FR-HNT-03, FR-SCR-03, FR-SCR-06, FR-CHL-14 |
| D-09 Online shop | FR-SHP-01, FR-SHP-05 |
| D-10 Marketplace | FR-SHP-01, FR-SHP-06 |
| D-11 Six shop roles | Section 2.3, FR-SHP-03, FR-SHP-07, FR-SHP-08 |
| D-12 Privacy by design | FR-PRV-01 to FR-PRV-04, FR-PRV-10, FR-PRV-11, FR-PRV-16, FR-PRV-17, FR-ACH-05, FR-EXP-01, NFR-PRI-01 |
| D-13 Schedule and full scope | Section 3 (no cutting), K-5, R-9, all requirements marked Must |
| D-14 Repo and documentation rule | NFR-MNT-01, NFR-MNT-06, K-8, K-9 |
| D-15 Hosting | FR-INS-06, NFR-AVL-01 to NFR-AVL-03, NFR-CST-01, NFR-CST-02, NFR-POR-01, K-2 |
| D-16 Web address, HTTPS | NFR-SEC-06, K-3 |
| D-17 SSE live updates | FR-LIV-01 to FR-LIV-06, FR-DSH-03, NFR-PRF-03 |
| D-18 Stored XSS with bot | FR-CHL-04, FR-DET-09, FR-SHP-11, NFR-ISO-07 |
| D-19 Platform roles bundle | FR-ACC-05, FR-ACC-07, FR-ACC-11, FR-ORG-01 to FR-ORG-03, FR-ORG-06, FR-ADM-03, FR-ADM-08 |
| D-20 C11 KYC fails open | FR-CHL-12 |
| D-21 Platform stack | FR-ACC-03, FR-NTF-02, FR-NTF-03, NFR-SEC-01, NFR-SEC-02, NFR-MNT-03 to NFR-MNT-05 |
| D-22 Scoring and anti-cheat | FR-SES-01 to FR-SES-11, FR-SCR-01 to FR-SCR-10, FR-TIM-01 to FR-TIM-05, FR-ACH-01 to FR-ACH-07, FR-HNT-02, FR-FLG-07, FR-DET-05, FR-DET-08 |
| D-23 Isolation and orchestration | FR-INS-02 to FR-INS-10, FR-FLG-02, FR-FLG-03, FR-DET-02, FR-DET-04, NFR-ISO-01 to NFR-ISO-07, NFR-SEC-04, NFR-SEC-05 |
| D-24 Shop model | FR-SHP-01 to FR-SHP-04, FR-SHP-10, FR-SHP-12, FR-SHP-15 |
| D-25 Privacy defaults | FR-PRV-04 to FR-PRV-16, FR-PRV-18, FR-SES-10, FR-ORG-07, FR-EXP-01, FR-EXP-02, NFR-AVL-05 |
| D-26 Challenge catalogue | FR-CHL-01 to FR-CHL-13, FR-CHL-16, FR-SHP-08, FR-SHP-13 |
| D-27 "Carries" rule | Section 2.3, FR-CHL-04, FR-CHL-08, FR-CHL-10, FR-CHL-12 |

## 12.2 Synopsis objectives and requirements to this PRD

| Synopsis item | Implemented by |
|---|---|
| O1 Vulnerable realistic app across all OWASP categories | FR-CHL-01 to FR-CHL-17, FR-SHP-01 to FR-SHP-15 |
| O2 Isolated containerized instance per user | FR-INS-01 to FR-INS-11, NFR-ISO-01 to NFR-ISO-07 |
| O3 Unique flag and automated detection and scoring | FR-FLG-01 to FR-FLG-09, FR-DET-01 to FR-DET-09, FR-SCR-01 to FR-SCR-10 |
| O4 Two role-based views | FR-DSH-01 to FR-DSH-06, FR-LIV-01 to FR-LIV-06 |
| O5 Same platform for learning and hiring | FR-ACC-05, FR-ACC-06, FR-SCR-01, FR-SCR-06, FR-HNT-01, FR-HNT-02, FR-ASM-01 |
| O6 Extensible architecture | NFR-EXT-01 to NFR-EXT-04, NFR-POR-01, FR-ORG-06 |
| F1 Provision within a bounded time | FR-INS-01, FR-INS-09, NFR-PRF-01 |
| F2 All categories as 11 challenges, exploitable end to end | FR-CHL-01 to FR-CHL-17, FR-SHP-01 to FR-SHP-15 |
| F3 Unique flag, automatic detection, paste | FR-FLG-01 to FR-FLG-09, FR-DET-04, FR-DET-05 |
| F4 Learner dashboard with hints, progress, write-up | FR-DSH-01, FR-HNT-01, FR-CHL-14, FR-SCR-06 |
| F5 Recruiter dashboard | FR-DSH-02, FR-DSH-03, FR-DET-03, FR-TIM-01, FR-TIM-02, FR-HNT-03 |
| F6 Teardown or reset after inactivity | FR-INS-03, FR-INS-04, FR-INS-05, FR-ADM-04 |
| F7 Log every attempt; no cross-user visibility | FR-TIM-04, FR-DSH-06, FR-LIV-05, FR-PRV-10, NFR-SEC-08 |
| F8 Concurrent instances on one host | FR-INS-06, FR-INS-07, NFR-PRF-02, FR-ADM-06 |
| F9 Recruiter signup, approval, invites | FR-ORG-01 to FR-ORG-08, FR-ASM-02 to FR-ASM-06, FR-ADM-01 |
| F10 Consent, retention, export, audit log | FR-PRV-01, FR-PRV-04, FR-PRV-10, FR-PRV-11, FR-EXP-01 |
| F11 Hints configurable per assessment, never below zero | FR-HNT-02, FR-ASM-01, FR-SCR-03 |

---

# 13. Glossary

| Term | Meaning |
|---|---|
| **18+** | Minimum age to register; self-declared (D-25). |
| **Admin** | Platform operator who approves companies and runs the system. |
| **ADR** | Architecture decision record, a short document explaining one technical decision (`docs/adr/`). |
| **Argon2id** | A password-hashing method recommended by OWASP. |
| **ASVS** | OWASP Application Security Verification Standard, a checklist for application security; levels 1 to 3. |
| **Attempt** | One candidate's run of one assessment. |
| **ATT&CK (MITRE)** | A catalogue of attacker techniques with IDs such as T1190. |
| **Audit log** | A tamper-evident record of who did what. |
| **Bot** | A simulated user (here a headless browser acting as the support agent) that views content in the shop. |
| **BOLA / IDOR** | Reading another user's object by changing an identifier in a request. |
| **Break-glass** | A logged, justified, time-limited emergency access step. |
| **Candidate** | A person invited by a recruiter to take an assessment. |
| **Catalog store** | The separate read-only product data used by the C03 search. |
| **Company (organization)** | The recruiters' employer account; the controller of candidate data. |
| **Controller / processor** | The party that decides why personal data is used / the party that handles it on the controller's behalf. DPDP uses "data fiduciary". |
| **Coraza** | An open-source web application firewall engine written in Go. |
| **CRS** | OWASP Core Rule Set, a rule collection for web attack detection. |
| **Crypto-shredding** | Deleting an encryption key so the encrypted data can no longer be read, including in backups. |
| **CWE** | Common Weakness Enumeration, an ID list of software weakness types. |
| **Decoy flag** | A fake flag placed to catch guessing or sharing. |
| **Detect-only** | Coraza mode that records matches but never blocks traffic. |
| **DPDP** | India's Digital Personal Data Protection Act 2023 and Rules 2025. |
| **Dramatiq** | The Python job-queue library chosen for background jobs. |
| **Evidence** | The exact request that captured a flag, kept for the recruiter. |
| **Flag** | A hidden value that proves an exploit succeeded. |
| **Freeze** | The 15-minute period after expiry when the candidate can no longer act but evidence is finished. |
| **gVisor** | A sandbox that adds a stronger boundary around containers. |
| **HMAC** | A keyed hash used to derive and verify flags and sign events. |
| **Instance** | A user's private set of containers. |
| **Internal network** | A Docker network with no route out. |
| **KYC** | Know Your Customer, a seller identity check (simulated here). |
| **Learner** | A person practising on their own instance. |
| **Milestone** | One of three automatic progress points per challenge (20, 40, 100 percent). |
| **MFA / TOTP** | Multi-factor login / one-time codes from an authenticator app. |
| **Orchestrator** | The service that creates and destroys instances through Docker. |
| **Outbox** | A table of emails waiting to be sent, so none are lost. |
| **Placeholder** | A starting number that a spike or pilot will fix. |
| **Privacy wall** | The rule that practice data and assessment data never mix. |
| **Pseudonymised** | Personal identifiers replaced by opaque IDs. |
| **Reconciler** | A loop that compares recorded state with real containers and repairs differences. |
| **Recruiter** | A company user who creates assessments and reviews candidates. |
| **SBOM** | Software bill of materials, a list of components and versions. |
| **Sentinel flag** | A flag released only if the intended vulnerable path was taken. |
| **Sidecar** | A helper container beside the shop that proxies traffic, detects flags and sends signed events. |
| **Spike** | A short experiment that measures something before a number is fixed. |
| **SQLi / XSS / SSRF** | SQL injection / cross-site scripting / server-side request forgery. |
| **SSE** | Server-Sent Events, one-way live updates from server to browser over HTTP. |
| **Valkey** | An open-source (BSD) in-memory data store compatible with Redis, used for queues, limits and live updates. |
| **Warm pool** | Pre-started instances kept ready to cut waiting time. |
| **WSTG** | OWASP Web Security Testing Guide, with test IDs such as WSTG-ATHN-09. |

---

# Appendix A. Scoring worked examples (placeholders)

All weights and percentages are placeholders, to be tuned by the pilot (OI-4) and the tier mapping (OI-16). Source: RS-C 3.2.

**Formula.** For each challenge `c` with weight `W_c`:
`raw_c = W_c x (highest milestone share reached on any valid path)`
`net_c = max(0, raw_c - hint_cost_c)`
`score = sum(net_c)`, and `shown score = round(1000 x score / sum(W_c))`.

**Placeholders.** Tiers: Easy 60, Medium 90, Hard 120. Milestones: M1 20 percent, M2 40 percent, M3 100 percent. Hint cost per level (when hints are on): 10, 20, 30 percent of `W_c`.

| Case | Calculation | Result |
|---|---|---|
| Full capture of a Medium, no hints | 90 x 100% | 90 |
| Medium: exploit evidence but no flag | 90 x 40% | 36 |
| Hard: flag captured, two hints used (10% + 20%) | 120 - 0.30 x 120 = 84 | 84 |
| Easy: only found the weakness (20%), then 1 hint (10%) | 60 x 0.20 = 12, minus 6 | 6 |
| Easy: found the weakness (20%), then 3 hints (60%) | 12 - 36, floored at zero | 0 (not -24) |
| All 11 captured with no hints | sum(W_c) | 1000 shown |

**Rules shown by the examples.**
- Hint cost is taken from that challenge only, so a hint cannot erase points from another challenge.
- Two exploit paths that reach the same milestone count once.
- A wrong or decoy submission changes no points.
- Time never changes points. Time to capture and estimated active time are shown beside the score.
- Suggested tie-break order, as a ranking aid only and OPEN (OI-26): more fully captured challenges, lower total hint cost, lower active time, earlier last capture.
- Learner mode uses the same milestones as stars and a solved tick, with no hint penalty and an optional "no hints" badge.

---

# Appendix B. Research-note index

| Note | Topic | File | Used in this PRD for |
|---|---|---|---|
| RS-A | Hosting on free tiers, topology, capacity | `docs/research/RS-A-hosting-capacity.md` | Hosting, capacity estimates, fallbacks, Docker Desktop and WSL notes, risks R-1 to R-5 |
| RS-B | Isolation, orchestration, flags, traffic monitor | `docs/research/RS-B-isolation-orchestration.md` | Instance lifecycle, isolation, flags, Coraza and CRS, event contract |
| RS-C | Scoring, time taken, anti-cheat, assessment sessions | `docs/research/RS-C-scoring-integrity.md` | Scoring, time definitions, anti-cheat, session states, Appendix A |
| RS-D | Platform stack, contracts, security, roles, lifecycles | `docs/research/RS-D-platform-stack.md` | Roles and permissions, company model, state machines, security controls, stack |
| RS-E | Challenges C01 to C06 | `docs/research/RS-E-challenges-01-06.md` | Challenge cards, tags, hints, containment rules |
| RS-F | Challenges C07 to C11 | `docs/research/RS-F-challenges-07-11.md` | Challenge cards, sentinel flag rule, mock services, dependency map |
| RS-G | Shop domain, roles, refunds, bots, seeding | `docs/research/RS-G-shop-domain.md` | Shop entities, permission matrix, state machines, refunds, bot, seeding |
| RS-H | Privacy and data lifecycle | `docs/research/RS-H-privacy-lifecycle.md` | Retention, consent text, audit log, data inventory, DPDP notes |
| Brief and README | Shared rules, review log, conflicts between streams | `docs/research/_BRIEF.md`, `docs/research/README.md` | Contradiction list |

