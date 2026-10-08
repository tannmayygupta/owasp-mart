# RS-H — Privacy and data lifecycle (retention, consent, audit log, DPDP)
Status: DRAFT research, NOT confirmed by the user · Date: 2026-10-08

This is research, not legal advice. Points that need a lawyer are marked **[LAWYER]**.

How I read the sources: I could not open the official Gazette PDF in a readable form (the PIB PDF came back as compressed binary). DPDP text below comes from web reproductions of the Rules (dpdpa.com) and law-firm notes, so I mark DPDP claims **UNVERIFIED** unless two sources agree on near-verbatim text, and I say so. Before the report is written, someone must read the official G.S.R. 846(E) PDF.

## 1. Questions answered

### Q1. What do assessment vendors say about retention?

| Vendor | What they state | Status |
|---|---|---|
| HackerRank | Privacy policy gives **no fixed period**. For candidates, data is kept "as long as permitted by our agreement with the Employer". Employer = controller, HackerRank = processor. Candidate deletion requests go to the employer; HackerRank follows the employer's instruction. Response: 1 month (GDPR), 45 days (CCPA). | VERIFIED (read the page) |
| Codility | Support article (search snippet, page itself returned 403): account admin can ask Codility to set **recurring anonymization** after the employer's own period, e.g. 180 days. Clock starts at test completion, or invitation date if never completed. It anonymizes, it does not delete. | UNVERIFIED |
| CodeSignal | Support FAQ (snippet; page returned 403): data kept for the length of the customer's subscription by default; customizable; one-off deletion by email to privacy@. PII encrypted in transit and at rest. | UNVERIFIED |
| HackerEarth | Help centre: candidate data is stored "until it's deleted". No fixed period. HackerEarth is processor; the hiring company must request deletion; anonymization within 30 days of the request (snippet). A candidate cannot delete their own data directly. | VERIFIED for "until deleted"; UNVERIFIED for the 30 days |
| Immersive Labs | Candidate retention period **not found**. An FAQ snippet says "retention policy is 12 months following the closure of [...]" (cut off, unclear scope). | UNVERIFIED |
| Hack The Box | Retention period **not found**. Enterprise deletion is by written request under the DPA; the timeframe is in the DPA (not read). | UNVERIFIED |

**Pattern:** no vendor publishes a hard default. All push the choice to the employer (controller) and offer deletion or anonymization on request. This supports D-12: configurable per assessment with a safe default.

**GDPR and recruiting norms**
- Storage limitation: data kept identifiable "for no longer than is necessary" (Art. 5(1)(e)). Minimisation: "limited to what is necessary" (Art. 5(1)(c)). VERIFIED (gdpr-info.eu, a reproduction of the regulation text).
- UK ICO: no fixed period. Keep records only as long as a claim could be brought; consider subject access requests, appeals, legal proceedings. Talent-pool use needs a new lawful basis and prior notice. Example: a law firm keeps top scorers for 6 months. VERIFIED (ICO page).
- Practitioners commonly say 6 months, and warn 12 months is likely excessive. UNVERIFIED (law-firm guide). One source says the UK discrimination-claim window may extend from 3 to 6 months from October 2026; **I did not verify this**, so a 6-month default might be too short in the UK. [LAWYER]

**Proposed defaults (decision candidates in section 4)**

| Data class | Default | Recruiter-configurable range | Why |
|---|---|---|---|
| Candidate assessment record (answers, scores, evidence, timings) | **180 days** after the attempt ends (or after the invite date if never started) | 30 to 365 days | Matches Codility's example and the 6-month recruiting norm. Over 365 days is hard to justify under storage limitation. |
| Candidate invite and consent record | Same clock as the assessment; the consent record is kept in a minimal form (see section 5) | not configurable | Proof that consent was given. |
| Learner practice data (progress, hints, attempts) | Kept while the account is active; delete **12 months after last login**, with a 30-day warning email | learner can delete at any time | We are the controller for this; no recruiter involved. |
| Learner captured requests and payload evidence | **30 days** after the instance is torn down | fixed | Short-lived debugging value only. |
| Instance contents (shop DB, container logs) | Destroyed at teardown; raw container logs at most 7 days | fixed | Nothing in them is needed after scoring. |
| Backups | Rolling 14 days, with crypto-shredding (see Q6) | fixed | Deletion reaches backups within the backup window. |

### Q2. India's DPDP Act 2023 and DPDP Rules 2025

| Claim | Finding | Status |
|---|---|---|
| Notification date | Rules published as G.S.R. 846(E) on **13 Nov 2025**. A PIB item and some press say 14 Nov 2025 (probably the press-release date). Corrigendum G.S.R. 892(E), 10 Dec 2025, fixes wording in Rule 1. | CONFLICTING on 13 vs 14 Nov (most sources say 13) |
| Phased commencement (Rule 1) | Rules 1, 2, 17 to 21: on publication. **Rule 4** (consent managers): one year later, about 13 Nov 2026. **Rules 3, 5 to 16, 22, 23**: 18 months later, about **13 May 2027**. Two sources agree (dpdpa.com Rule 1 text; Hogan Lovells note). Exact day, 12 vs 13 May, differs across firms. | UNVERIFIED (two secondary sources agree) |
| So today (8 Oct 2026) | Notice, consent, security, breach, erasure, children and rights rules are **not yet in force**. They start after the November 2026 submission. We build to them anyway (D-12). | UNVERIFIED |
| Notice content (Rule 3) | Stands alone, plain language, enough for specific and informed consent. Must include an itemised list of the data, the specific purpose and the goods or services enabled, a link for withdrawing consent (as easy as giving it), exercising rights, and complaining to the Board. | UNVERIFIED |
| Erasure duty | Act s.8(7): erase when the purpose is served or consent is withdrawn, and make processors erase too, unless another law requires keeping it. | UNVERIFIED |
| 48-hour pre-erasure notice | Rule 8(2): at least 48 hours before an inactivity erasure, tell the person, and say that logging in stops it. **This only applies to the Third Schedule classes**: e-commerce with 2 crore or more registered users, online gaming with 50 lakh or more, social media with 2 crore or more, with a 3-year inactivity period. **VulnMart is not in those classes**, so the 48-hour rule does not bind it. D-12 should not call it a duty. We can still send a warning email as good practice. | UNVERIFIED (one summary plus dpdpa.com text; the "does not apply to us" conclusion needs a lawyer) [LAWYER] |
| One-year log rule | Two places carry a one-year figure. **Rule 8(3)**: a Data Fiduciary must keep personal data, traffic data and processing logs for at least one year from processing, "for the purposes in the Seventh Schedule" (which lists State uses), then erase unless other law requires longer. Commentary says the wording is ambiguous about whether the Seventh Schedule limits it. **Rule 6(1)(e)** (security safeguards): keep logs and personal data for one year to detect and investigate unauthorised access. Both bind the **Data Fiduciary** and extend to what its processors do; Rule 6(1)(f) requires a processor contract. | UNVERIFIED; ambiguous [LAWYER] |
| Children | Child = under 18 (Act s.2(f)). Verifiable parental consent before processing (s.9, Rule 10, via existing ID records or an authorised token such as DigiLocker). s.9(3) bans tracking, behavioural monitoring and targeted ads aimed at children, with Fourth Schedule exemptions. Rule 10 text itself does not define "child"; the age comes from the Act. | UNVERIFIED |
| Data principal rights | Rule 14: fiduciary must publish how to make a request and the identifier needed; grievance response time "not exceeding ninety days"; right to nominate another person. Access, correction and erasure rights come from the Act (ss.11 to 14). | UNVERIFIED |
| Breach (Rule 7) | Tell each affected person without delay (what happened, likely effects, mitigation, safety steps, contact). Tell the Board without delay, then a detailed report within **72 hours**. | UNVERIFIED |
| Is a small college project covered? | The Act has **no general small-organisation exemption**. s.17(3) lets the government exempt startups or classes, but it is a power, and I found no sign it was used. A student project that processes real people's data online is likely a Data Fiduciary or Processor. Whether the college, the students or an entity is the fiduciary is unclear. | UNVERIFIED [LAWYER] |

Roles under D-12: the recruiter's company decides why candidate data is processed, so it is the fiduciary (GDPR "controller"). VulnMart is the processor for candidates and the fiduciary for learners. A DPDP processor contract is needed (Rule 6(1)(f)). Whether a hiring-stage candidate's consent is needed is debated (D-12 already notes this); we ask for consent to be safe.

### Q3. Data inventory

Retention clocks: A = assessment clock, L = learner clock (section 1, Q1).

| Item | Purpose | Sensitivity | Retention | Who can see it | Deletion method |
|---|---|---|---|---|---|
| Account: name, display name, role | Login, identity | Personal | Account life; learner 12 months after last login | Self; admin (support); recruiter sees name of invited candidate only | Row delete; replace related audit rows' ID with an opaque tombstone |
| Email | Login, invites, verification | Personal | Same as account | Self; admin; inviting recruiter (for their invite) | Row delete |
| Password hash | Login | Secret | Account life | Nobody (hash only) | Row delete |
| Invite token (hash) | Single-use invite | Secret | Until used or expired (default 7 days), then purge | Nobody | Purge job |
| Assessment answers and write-ups | Scoring, recruiter review | Personal, possibly sensitive | A | Candidate; the recruiter's company users on that assessment | Hard delete, then key shred (Q6) |
| Captured attack requests and payloads (flag-capturing request) | Evidence for the recruiter (D-07) | Potentially third-party personal data; may contain secrets | A (candidate) / 30 days after teardown (learner) | Candidate; recruiter (candidate case) | Hard delete, encrypted with a per-assessment key |
| Scores, timings, hints used | Scoring, dashboards | Personal (evaluation of a person) | A (candidate) / L (learner) | Candidate; recruiter; learner (own) | Hard delete |
| IP address and user agent | Security, anti-cheat (RS-C), abuse | Personal (online identifier) | Session records 90 days; candidate attempt IP kept with the assessment (A) | Admin; recruiter only if RS-C decides to show it | Truncate at 90 days (learner), delete with the attempt (candidate) |
| Consent records | Proof of consent | Personal | Assessment retention plus 12 months (legal-defence value) [LAWYER] | Candidate; admin; recruiter (that consent was given) | Delete; keep only a hash and version after expiry |
| Audit log | Accountability, tamper evidence | Personal (who viewed whom) | 12 months, then purge (section 5) | Admin; candidate (their own view history, see section 5) | Pseudonymise on candidate deletion; purge at 12 months |
| Security and system logs (auth, errors) | Detect misuse (Rule 6(1)(e)) | Personal (IP, account ID) | 12 months | Admin only | Purge job |
| Flags (per-instance) | Prove exploitation | Secret (not personal) | Instance life, then derived value discarded | Platform monitor only; never shown to the recruiter in plaintext | Destroyed with the instance |
| Learner solutions and progress | Learner dashboard | Personal | L | Self only (privacy wall D-05) | Hard delete |
| Backups | Recovery | All of the above | Rolling 14 days | Operator only | Expire; crypto-shred keys for removed items |

### Q4. Consent screen, schema, withdrawal, export, delete

**Plain-language consent draft (candidate).** English; a Hindi version is worth considering because DPDP lets people ask for notice in languages listed in the Constitution (not verified here).

> **Before you start: how your data is used**
> **[Company X]** invited you to this security assessment. **[Company X] decides how your results are used.** VulnMart runs the test for them.
> **We record:** your name and email; your answers and write-ups; the web requests you send to the practice shop that capture a flag; times; hints you use; your IP address and browser type.
> **We do not record:** your screen, webcam, microphone, or anything outside the test shop.
> **Please do not** use real passwords or other people's real personal data in the test. Everything in the shop is fake.
> **Why:** to score you and let [Company X] review your work. **Who sees it:** you, and people at [Company X] you are assessed by. Each view is logged and you can see the log.
> **How long:** [180] days after you finish, then it is deleted automatically.
> **Your choices:** see and download your results; ask [Company X] to delete them; withdraw consent at any time (the assessment stops and your data is deleted unless [Company X] must keep it by law). Contact: [privacy email]. Complaints: [grievance link and the Board's link].
> [ ] I have read this notice and agree. (Not pre-ticked.)  [Start] [Decline]

Rule 3 says the notice should stand alone and withdrawal must be as easy as giving consent (UNVERIFIED). A separate screen, not buried in terms, satisfies both.

**Consent record schema (one row per grant or withdrawal; append-only)**

| Field | Notes |
|---|---|
| `consent_id`, `user_id`, `assessment_id` | Link to the person and the assessment |
| `notice_version` | e.g. `candidate-notice@2026-10-08-v1` |
| `notice_text_sha256` and `notice_text_snapshot` | The exact text shown, plus the language |
| `retention_days_shown`, `controller_name_shown`, `purposes_shown` | Values filled in at display time |
| `action` | `granted`, `withdrawn`, `declined` |
| `timestamp_utc`, `ip_hash`, `user_agent_hash` | Proof of event; hashes limit extra personal data |
| `method` | `checkbox` or `withdrawal_button`; withdrawal is one click |
| `prev_hash` | Link into the audit chain (section 5) |

**Withdrawal flow:** a "Withdraw consent" button in the candidate dashboard → confirm → assessment locks; running instance torn down; a `withdrawn` row is written; the recruiter is told; assessment data scheduled for deletion in 7 days (grace for mistakes), consent row kept in minimal form. Withdrawal does not undo past lawful processing.

**Export format:** JSON as the main format (GDPR Art. 20 asks for "structured, commonly used and machine-readable", VERIFIED), plus CSV for the flat tables, zipped. A one-page human-readable PDF summary is optional. Contents: profile, consent history, results, timings, hints, the evidence requests, and the list of who viewed the data. Never include other users' data or flag values.

**Delete-request workflow (D-12 roles)**
1. Candidate clicks "Request deletion" (or emails the privacy address).
2. System opens a request and **routes it to the recruiter's company** (controller). HackerRank and HackerEarth work this way (VERIFIED). Candidate sees status.
3. Controller approves or rejects (with a reason, e.g. legal hold) within 14 days. No answer by day 14 triggers a reminder, then an admin escalation.
4. VulnMart (processor) runs the deletion within 30 days of approval, confirms it to the controller and the candidate. HackerEarth's 30 days is the nearest sourced figure (UNVERIFIED). Rule 14's 90-day ceiling is for the grievance system (UNVERIFIED).
5. The controller can also delete a candidate directly at any time.
6. **Privacy wall (D-05):** deletion of a candidate attempt never touches the person's learner data; deleting the whole account removes both.
7. Learner requests go to VulnMart directly (we are the controller) and run at once, with a 7-day undo window.

### Q5. Audit log design

**Events:** login success and failure; recruiter approval; invite created, sent, accepted; consent granted, withdrawn; any recruiter or admin **view** or **export** of candidate data; assessment started, submitted, torn down; deletion requested, approved, executed; retention changed; role change; admin access to any user's data; log-read events; failed access attempts.

**Tamper evidence (options)**

| Option | Notes |
|---|---|
| Hash chain in Postgres, append-only DB role (no UPDATE or DELETE) | Each row stores `sha256(prev_hash + row)`. Chain break is detectable. Recommended. |
| Hash chain plus periodic head-hash anchor outside the database (a signed daily line stored in a separate bucket or a repo) | Detects whole-chain rewrite. Cheap addition. Recommended. |
| Managed immutable storage / ledger DB | Stronger, but cost and lock-in; not needed now. |

OWASP's logging guidance supports tamper detection, read-only copies, restricted log access, recorded log-reads, and keeping passwords, tokens and keys out of logs (VERIFIED).

**Who can read:** admin reads everything (and admin reads are logged). A recruiter sees only audit rows for their own company. **Candidates can see who viewed their data** at company level with time and action (for example "Company X, recruiter view, 3 Nov 14:02"). Showing individual recruiter names is a decision candidate, because it exposes staff data (see section 4).

**Retention and the one-year rule vs candidate deletion**
- The audit log holds only an opaque `subject_id`, an actor ID, an event type and a time, never content, so most of it is not meaningful personal data on its own.
- When a candidate is deleted: delete the identity mapping (`subject_id` to email or name) and keep the log rows. The remaining rows then identify nobody. This is pseudonymisation that becomes effectively anonymous once the mapping is gone (the ICO warns that pseudonymised data is still personal data, so the mapping delete matters; VERIFIED).
- Keep the audit and security logs for **12 months**, matching the one-year figure in Rules 6(1)(e) and 8(3), then purge. Candidate deletion removes content and identity; it does not shorten the 12-month log, because Rule 8(3) says logs are kept "regardless" of other erasure (UNVERIFIED reading). 
- The exact reach of "who it applies to" is unclear. It binds the fiduciary and, through contract, its processors, but the Seventh Schedule link makes it uncertain for a private recruiting platform. **[LAWYER]** Our design (pseudonymised 12-month log) satisfies both readings, so the legal outcome should not change the build.

### Q6. Secrets, flags, passwords, tokens, third-party data

- **Passwords:** Argon2id, at least m=19456 KiB, t=2, p=1 (OWASP minimum, VERIFIED), benchmarked on the server; optional pepper kept in a secret store. bcrypt only if Argon2id is unavailable.
- **Invite tokens:** 256-bit random, store only `sha256(token)` (high entropy, so a fast hash is fine), single use, bound to the invited email, 7-day default expiry (our design), never written to logs, sent in the URL and invalidated on first use. Engineering judgment; no source read.
- **Flags:** derive each flag as `HMAC(master_secret, instance_id + challenge_id)` so the platform keeps no flag table; compare in constant time; never write flags to docs, logs, dashboards or the recruiter view. Detail belongs to RS-B (R-04). Flag values are secrets, not personal data.
- **Encryption at rest:** use the host's disk or volume encryption as baseline (free-tier support is not verified) plus **application-level encryption** (AES-256-GCM) for evidence payloads and answers with a **per-assessment key**. Deleting the key erases the data in live data and backups at once (crypto-shredding). This is a common pattern, not a sourced one; a spike should test it.
- **Captured attack payloads with third-party data:** a candidate could paste real emails, tokens or card numbers. Controls: (1) seed data is fully synthetic (RS-G); (2) the consent screen forbids real data; (3) store only the **flag-capturing request**, not full traffic, body capped at 8 KB (D-07 matches this); (4) redact `Authorization`, `Cookie` and the user's own password fields before storage; (5) encrypt with the per-assessment key; (6) same retention as the assessment; (7) recruiters see evidence only through the dashboard, which is logged. Full raw logs stay in the instance and die with it.

## 2. Options compared

| Option | Fit with our constraints | Free-tier / cost | Complexity | Main risks | Evidence |
|---|---|---|---|---|---|
| Retention: fixed default, recruiter range 30 to 365 days (recommended) | Meets D-12; works for any recruiter | None | Low (one scheduled job) | Default may not suit a recruiter's legal duty | HackerRank, Codility, ICO |
| Retention: "until deleted" (HackerEarth style) | Simple | None | Lowest | Breaks storage limitation; hard to defend | HackerEarth help centre |
| Retention: anonymize, not delete (Codility style) | Keeps scores for statistics | None | Medium (real anonymization is hard) | Re-identification risk; ICO says pseudonymised data is still personal | Codility snippet, ICO |
| Audit log: hash chain with anchor (recommended) | Plain Postgres, portable | None | Medium | Chain bugs; anchor needs a second store | OWASP logging |
| Audit log: plain append-only table | Easiest | None | Low | Admin or DBA can silently edit | OWASP logging |
| Audit log: managed ledger | Strongest | Paid or limited free | High | Lock-in; breaks portability goal | not researched |
| Backups: crypto-shredding with 14-day rolling | Fits portability | None | Medium | Key management mistakes | engineering judgment (UNVERIFIED) |
| Backups: ignore, document window | Easiest | None | Low | Deleted data lives on in backups | engineering judgment |

## 3. Recommendation

1. **Candidate default 180 days (range 30 to 365); learner data 12 months after last login (30-day warning), evidence 30 days after teardown.**
2. **Roles:** controller = recruiter's company, processor = VulnMart for candidates; VulnMart is controller for learners. Sign a short data-processing terms page with every recruiter at approval time (D-04 flow).
3. **12-month pseudonymised audit and security log**, hash-chained, append-only, anchored daily; candidate deletion removes the identity mapping but not the log rows.
4. **18+ only** at signup (a checkbox declaration) to avoid verifiable parental consent for now. Students under 18 cannot join. This is a product rule that avoids the DPDP children rules; **[LAWYER]** whether a self-declaration is enough.
5. Per-assessment encryption keys, Argon2id passwords, hashed invite tokens, HMAC-derived flags.
6. Candidates see company-level view history; JSON plus CSV export.

**This would be wrong if:** a lawyer says Rule 8(3) or 6(1)(e) requires keeping identifiable personal data for a full year (then candidate deletion must be delayed or legal-hold flagged); a recruiter's own law needs longer than 365 days (raise the cap per contract); the UK six-month limit extension makes 180 days too short for UK users; or the college confirms the project is exempt or a research use and wants minimal data.

## 4. Decision candidates for the user

1. **Default candidate retention.** Options: (a) 90 days; (b) **180 days**; (c) 365 days. Recommend (b): matches Codility's example and the 6-month norm, and keeps defensibility.
2. **Recruiter range.** Options: (a) 30 to 365 days; (b) 7 to 730 days; (c) fixed, no choice. Recommend (a): ranges above a year are hard to defend under storage limitation.
3. **Learner data retention.** Options: (a) until the user deletes; (b) **delete 12 months after last login with a 30-day warning**; (c) 24 months. Recommend (b): limits data held for people who left.
4. **Minimum age.** Options: (a) **18+ only by declaration**; (b) allow under 18 with parental consent flow; (c) no rule. Recommend (a): avoids the verifiable parental consent burden and the child tracking ban.
5. **Audit log retention.** Options: (a) 6 months; (b) **12 months**; (c) keep forever. Recommend (b): matches the one-year rules and still expires.
6. **Candidate sees who viewed.** Options: (a) **company level only**; (b) individual recruiter names; (c) not at all. Recommend (a): transparency without exposing staff.
7. **Candidate deletion routing.** Options: (a) **request goes to the recruiter's company, VulnMart executes**; (b) VulnMart deletes at once on candidate request; (c) recruiter only. Recommend (a): matches the controller role and HackerRank and HackerEarth practice.
8. **Export format.** Options: (a) **JSON plus CSV zip**; (b) PDF only; (c) JSON only. Recommend (a): JSON is machine-readable, CSV is easy to open.
9. **What attack data to store.** Options: (a) **flag-capturing request only plus tags**; (b) all requests for 30 days; (c) all requests for the assessment retention period. Recommend (a): minimum data, and lowest third-party data risk.
10. **IP address and user agent.** Options: (a) **store, truncate or drop after 90 days for learners, keep with the attempt for candidates**; (b) never store; (c) store forever. Recommend (a): needed for anti-cheat and security, limited in time.
11. **Backup deletion.** Options: (a) **14-day rolling backups plus per-assessment key shredding**; (b) rolling backups only, documented window; (c) no backups of candidate data. Recommend (a): deletion works even inside backups.
12. **Consent withdrawal side effect.** Options: (a) **lock the attempt, delete data after a 7-day undo window**; (b) delete at once; (c) keep until the retention date. Recommend (a): guards against mistaken clicks.
13. **Legal review.** Options: (a) **ask the college guide or institute legal cell to review the notice, retention and 18+ rule once**; (b) go without review; (c) hire outside counsel. Recommend (a): cheap and creates a record for the report.

## 5. Evidence

| URL | What it supports | Status |
|---|---|---|
| https://www.hackerrank.com/about-us/privacy | No fixed period; employer = controller, HackerRank = processor; deletion via employer; 1 month / 45 days | VERIFIED |
| https://support.codility.com/hc/en-us/articles/1500009792201-I-would-like-to-have-candidates-personal-data-deleted-regularly-How-do-I-do-that | Recurring anonymization, 180-day example, clock rule | UNVERIFIED (403 on fetch; search snippet) |
| https://support.codesignal.com/hc/en-us/articles/4418060342039-CodeSignal-data-privacy-and-storage-FAQs | Retention follows subscription, customizable, deletion by email, encryption | UNVERIFIED (403 on fetch; search snippet) |
| https://help.hackerearth.com/hc/en-us/articles/360005043053-For-how-long-is-candidate-data-stored-on-HackerEarth-s-servers- | Data stored "until it's deleted" | VERIFIED |
| https://help.hackerearth.com/hc/en-us/articles/360004967513-how-do-i-request-for-candidate-data-to-be-updated-or-deleted- | Controller must request; 30-day anonymization | UNVERIFIED (snippet) |
| https://www.immersivelabs.com/legal-documents/candidate-privacy-notice | Candidate notice exists; retention text not retrieved | UNVERIFIED |
| https://www.hackthebox.com/legal | HTB DPA and candidate notice exist; periods not read | UNVERIFIED |
| https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/recruitment-and-selection/keeping-recruitment-records/ | No fixed period; factors; talent pool; pseudonymised still personal | VERIFIED |
| https://gdpr-info.eu/art-5-gdpr/ | Art. 5(1)(c) and (e) | VERIFIED |
| https://gdpr-info.eu/art-20-gdpr/ | "structured, commonly used and machine-readable" | VERIFIED |
| https://www.mylawyer.co.uk/retention-of-recruitment-records-a-A76018D77869 | 6-month practice; 12 months excessive; possible UK limit change | UNVERIFIED (search snippet) |
| https://dpdpa.com/dpdparules/rule1.html | Rule 1 commencement text | UNVERIFIED (secondary reproduction) |
| https://www.hlc.com/en/publications/indias-digital-personal-data-protection-act-2023-brought-into-force- | 13 Nov 2025 notice; 13 Nov 2026 and 13 May 2027 phases | UNVERIFIED (law-firm note) |
| https://dpdpa.com/dpdparules/rule3.html | Notice content | UNVERIFIED |
| https://dpdpa.com/dpdparules/rule6.html | Security safeguards; one-year logs (clause e); processor contract (clause f) | UNVERIFIED |
| https://dpdpa.com/dpdparules/rule7.html | Breach notice; 72 hours | UNVERIFIED |
| https://dpdpa.com/dpdparules/rule8.html | Erasure, 48-hour notice, one-year retention | UNVERIFIED |
| https://dpdpa.com/dpdparules/rule10.html | Parental consent; adult = 18 | UNVERIFIED |
| https://dpdpa.com/dpdparules/rule14.html | Rights process; 90-day ceiling; nomination | UNVERIFIED |
| https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf | Official PIB backgrounder; not readable by my tool | not read |
| https://www.indiacode.nic.in/handle/123456789/22037 | Act No. 22 of 2023 listing on India Code; text not read | UNVERIFIED |
| https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html | Tamper detection, read-only copies, no secrets in logs, log access control | VERIFIED |
| https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html | Argon2id minimums (19 MiB, t=2, p=1), pepper, bcrypt limits | VERIFIED |
| https://www.mondaq.com/data-retention-and-deletion-under-the-dpdp-act-how-long-can-businesses-retain-personal-data-in-india/1844062 | Law-firm commentary that the one-year rule is not a blanket licence | UNVERIFIED (snippet only) |

## 6. Open questions and spikes to run later

- **Read the official G.S.R. 846(E)** (MeitY or egazette) and confirm: Rule 1 dates, Rule 6(1)(e), Rule 8(1) to 8(3), Third and Seventh Schedules, Fourth Schedule. Also confirm the Act commencement notification and any s.17(3) startup notice.
- Fetch Codility, CodeSignal, Immersive Labs candidate notice and HTB DPA directly (some returned 403 or truncated text) and fill the retention gaps. If none state a period, say so in the report.
- Who is the "fiduciary" for a college project: the college, the students, or a registered entity? [LAWYER]
- Does GDPR also apply (EU or UK candidates)? Then SCCs, Art. 28 terms and an EU representative questions arise. Not researched.
- Is a one-year retention duty compatible with erasing a candidate on request? [LAWYER]
- Spike: test crypto-shredding with per-assessment keys on Postgres and one backup restore.
- Spike: audit hash chain, concurrent writes, and the daily anchor job.
- Spike: payload redaction rules on real intercepted traffic from RS-B's monitor.
- Confirm whether the UK discrimination limit changed in October 2026.
- Decide whether a Hindi notice is needed.

## 7. Impact on other streams

- **RS-A:** needs encrypted volumes or object storage for backups, a scheduler for retention jobs, and a second location for audit anchors.
- **RS-B:** the monitor must store only the flag-capturing request, apply redaction before saving, and respect the per-assessment key. Flags derived by HMAC need the master secret outside the instance.
- **RS-C:** decides whether IP and user agent anti-cheat signals are shown to recruiters; any new signal (typing speed, tab changes) needs a line in the consent notice and the inventory. D-12 forbids screen and webcam capture.
- **RS-D:** needs tables for consent, audit, deletion requests, retention settings; roles for "viewer of candidate data"; a processor-terms acceptance step at recruiter approval; a signup age declaration.
- **RS-E / RS-F:** challenges should not require real third-party data; Cryptographic Failures and Logging challenges must use fake data only.
- **RS-G:** seed data fully synthetic, with no real names, emails or card numbers.
- **initial.md:** D-12 says "48 hours' warning" is a DPDP fact; research suggests the 48-hour rule only binds Third Schedule classes (UNVERIFIED). Also, D-12's "90-day deadline unverified" is now partly sourced (a ceiling for the grievance system). Raise this with the user, not changed here.
