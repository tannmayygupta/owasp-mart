# RS-F — Challenge design C07 to C11
Status: DRAFT research, NOT confirmed by the user · Date: 2026-10-08

## 1. Questions answered
1. What concrete bug, host feature, exploit path, flag location and capture signal should C07 to C11 have?
2. How can a **logging failure** (C09) be an interactive challenge that is detected automatically?
3. What internal service does the SSRF (C10) reach, and how does the sandbox contain it?
4. What does the official OWASP 2025 A10 say, and what fail-open designs fit the shop (C11)?
5. How do all 11 challenges depend on each other, use the six shop roles, and ramp in difficulty?

### Shop assumptions (RS-G and RS-E must confirm or correct)
- **A1** Attacker start state: a self-registered **customer** account, or a self-registered **seller owner** that is still "pending". Nothing else is given.
- **A2** A pending seller can create **draft** products (including "import image from URL") but cannot publish them or see payouts. If RS-G disagrees, C10 would need C11 first (see map).
- **A3** Seeded entities exist: stores, products, carts, orders (some `pending_payment`), payouts, refunds, reviews, disputes. Seeded orders are `delivered`/`refunded`, so forged events cannot disturb them.
- **A4** The platform monitor sees all HTTP through a reverse proxy, can read the shop DB read-only, can read sidecar logs, and can read a `security_events` table that the shop writes (for C09).
- **A5** Sidecar containers (mock payment gateway, mock KYC provider, internal service) live in the instance's private network. Per-instance flags are injected at start (D-02). Flag format is not defined here.
- **A6** Outbound internet from every instance container is **denied** by default (needed for C10 safety, and assumed to be RS-B's isolation design).
- **A7** Bots: only the support-agent bot (victim of stored XSS, owned by RS-E) exists. This stream adds no new bot.

### Design pattern used in C08, C09, C11: the "sentinel" flag
A flag is revealed **only when the vulnerable code path was really taken** (for example, the order is marked paid by an unsigned event). A second route to the same goal (price tampering, an admin approval, a stolen admin session) therefore **cannot** capture the flag. This is the main tool against "one exploit solves another challenge".

## 2. Options compared
Design alternatives considered for each challenge (chosen option in bold).

| Challenge | Option | Fit | Cost / complexity | Main risks | Evidence |
|---|---|---|---|---|---|
| C07 | **Weak password-reset code (4 digits, no attempt limit) on the finance account** | Realistic, one clear path, needs automation (Intruder/ffuf) | Low | Brute force load (about 10,000 requests) | WSTG 4.4.9 (VERIFIED) |
| C07 | Credential stuffing against a breach list | Realistic | Needs a wordlist we ship | Overlaps C09 | T1110.004 (VERIFIED name) |
| C07 | Session fixation / JWT `alg=none` | Classic | Medium | JWT overlaps C02 (crypto) | A07 CWE-384 (VERIFIED) |
| C08 | **Payment webhook accepted without valid signature (sandbox-mode bypass)** | Very common marketplace bug; no RCE | Medium (mock gateway sidecar) | Overlap with payment bugs (C04) | A08 CWE-345/347 (VERIFIED) |
| C08 | Unsafe deserialization of a cart cookie | Matches D-09 idea | Medium | **RCE would read every flag**, breaks isolation of challenges | A08 scenario 4 (VERIFIED) |
| C08 | Unsigned cookie holding role/price | Easy | Low | Overlaps C01 and C04 | CWE-565/784 (VERIFIED) |
| C09 | **Unlogged, unalerted legacy login route (brute force in the blind spot)** | Detectable by the monitor with no new infrastructure | Medium | Overlaps C07 theme (weak password) | A09 CWE-778/223 (VERIFIED) |
| C09 | Secrets written into logs (CWE-532) behind an admin log viewer | Literal A09 text | Needs a way to reach the log (overlaps C05) | Reaching the log needs another bug | A09 CWE-532 (VERIFIED) |
| C09 | Log forging (CRLF) into a log viewer | Teaches CWE-117 | Medium | Becomes XSS (C03) if the viewer renders HTML | A09 CWE-117 (VERIFIED) |
| C10 | **"Import product image from URL" with a weak blocklist, reaching an internal metadata-style service** | Matches D-09 and real CVEs | Medium (one sidecar) | Containment must be correct | CWE-918 (VERIFIED) |
| C10 | Blind SSRF with out-of-band callback | Realistic | Needs an attacker-controlled listener, which A6 forbids | Hard to host safely | not pursued |
| C11 | **Seller KYC check fails open on malformed input (auto-approval)** | Authentication/authorization flavoured, distinct from C04 and C08 | Medium (mock KYC sidecar) | Overlaps C01 admin approval | A10 CWE-636/755 (VERIFIED) |
| C11 | Payment fail-open (gateway error means "paid") | In D-09 ideas | Low | **Same outcome as C08** (free order) | A10 scenario 3 (VERIFIED) |
| C11 | Checkout stock reservation fails open (negative stock) | Realistic | Low | No natural flag, overlaps C04 | CWE-754 (VERIFIED) |
| C11 | Lockout counter store down means MFA/lockout skipped | Realistic | Attacker cannot cause the outage | Not exploitable by a player | CWE-636 (VERIFIED) |

## 3. Recommendation

### Official 2025 A10 text (VERIFIED, top10.owasp.org)
"Mishandling of Exceptional Conditions" is a 2025 category about software that fails to anticipate, detect or respond properly to abnormal situations. Failures happen at three points: the situation is not prevented, it is not recognized while it happens, or the response afterwards is poor or missing. Common causes: weak input validation, error handling far from the error, unexpected resource or network states, unhandled exceptions. It maps **24 CWEs**, among them CWE-209, CWE-234, CWE-248, CWE-252, CWE-390, CWE-391, CWE-396, CWE-476, CWE-550, CWE-636 "Not Failing Securely ('Failing Open')", CWE-703, CWE-754, CWE-755, CWE-756. Prevention: handle errors where they occur, use a global handler, **fail closed** (roll back a failed multi-step transaction), rate-limit, validate input strictly. Its three scenarios: resource exhaustion after failed uploads, sensitive data in verbose DB errors, and state corruption in an interrupted financial transfer.
Other 2025 facts checked on the official pages: A09 is titled "Security Logging & Alerting Failures" (CWE-117, 221, 223, 532, 778). A07 is "Authentication Failures" (36 CWEs). A08 is "Software or Data Integrity Failures" (14 CWEs). **SSRF CWE-918 is listed inside A01 Broken Access Control (40 CWEs)**, which confirms the D-06 mapping, though the A01 page says it as "notable CWE", not "folded in".

### Challenge cards

#### C07 Authentication Failures (2021 A07 Identification and Authentication Failures / 2025 A07 Authentication Failures)
- **Vulnerability and host:** the **password-reset flow** (`/auth/forgot`, `/auth/reset/confirm`). The reset code is **4 digits**, valid 15 minutes, has **no attempt limit or lockout**, and the form answers "no such account" differently from "code sent" (user enumeration). The target is the **finance** account. Its email is discoverable on seller payout statements. The real code goes to a sandbox mailbox the player cannot read.
- **Intended path:** enumerate the finance email, request a reset, brute-force the 10,000 codes (Burp Intruder or ffuf), set a new password, log in, open **Finance, Settlement settings**.
- **Difficulty 2.** Prerequisites: none beyond a customer account. Needs a script or Intruder.
- **Flag and detection:** flag is a "settlement reference" on the finance settings page, shown only to a finance session. **Signal:** the flag appears in a response (primary); backup: state change `finance.password_changed_via = reset_ui` plus more than 500 failed reset-confirm calls. No finance bot exists, so any response containing it is an exploit.
- **Tags:** CWE-307 Improper Restriction of Excessive Authentication Attempts; CWE-640 Weak Password Recovery Mechanism for Forgotten Password; CWE-521 Weak Password Requirements is *not* used. Optional: CWE-204 (user enumeration) is not in A07's list, so left out. ATT&CK T1110.001 Password Guessing; T1078 Valid Accounts. WSTG 4.4.9 Weak Password Change or Reset Functionalities (WSTG-ATHN-09); 4.4.3 Weak Lock Out Mechanism (ATHN-03). Tags 2021 A07, 2025 A07.
- **Hints:** (1) "Finance staff forget passwords too. How does the shop prove who you are when you do?" (2) "Look at how long the reset code is and what happens after many wrong tries." (3) "Request a reset for the finance mailbox, then send every possible code to the confirm step with a tool."
- **Fix:** 8+ digit or 128-bit random single-use token, hashed at rest, strict attempt limit per token and per account, generic responses, notify the owner, invalidate sessions after reset.
- **Auto-test:** a script requests a reset, reads the code from the **test-only** sandbox mailbox API (not exposed to players), then checks that the brute force loop finds it within N calls and that the flag page returns 200 with the flag only for the new session.
- **Unintended risks:** (a) the sandbox mailbox must be on the internal network only, otherwise it is a shortcut. (b) The finance page must hold **no other flag**. (c) Reset-confirm failures are logged normally, so this exploit does not look like C09's "silent" signal. (d) Brute force load stays inside the player's own instance.
- **Realism:** weak password-reset and missing lockout are standard findings in the OWASP Authentication Cheat Sheet and the WSTG pages above (UNVERIFIED for the cheat sheet, not opened). A07 page itself (VERIFIED).

#### C08 Software or Data Integrity Failures (2021 A08 / 2025 A08)
- **Vulnerability and host:** the **payment webhook** `POST /webhooks/payments`, documented on the public "Seller integration" help page and visible in the checkout JavaScript. The mock gateway sidecar sends HMAC-signed events. The handler verifies the signature **only when `X-Gateway-Mode` is not `sandbox`** (a "test mode" left on). It still checks that the amount equals the order total and that the order is `pending_payment`.
- **Intended path:** create an order and stop at "Pay"; read the webhook docs or JS; send a forged `payment.succeeded` event with `X-Gateway-Mode: sandbox`, the right order id and amount; the order turns paid and the response and order page show the reference.
- **Difficulty 3.** Prerequisites: customer account, one order in `pending_payment`.
- **Flag and detection:** sentinel flag: for events accepted in sandbox mode the app sets the order's `payment_ref` from the instance's C08 secret (a deliberate, simple release rule, to be reviewed by RS-G). **Signal:** flag in the webhook response or order page; backup: order became `paid` with **no matching entry in the gateway sidecar ledger** (the monitor reads the sidecar log). Honest checkout payment (C04-style price tampering) creates a ledger entry and never gets the flag.
- **Tags:** CWE-345 Insufficient Verification of Data Authenticity; CWE-347 Improper Verification of Cryptographic Signature; CWE-353 Missing Support for Integrity Check. ATT&CK T1190 Exploit Public-Facing Application; T1565.001 Stored Data Manipulation (order state). WSTG 4.10.3 Integrity Checks (BUSL-03), 4.10.2 Ability to Forge Requests (BUSL-02), 4.10.10 Payment Functionality (BUSL-10). Tags 2021 A08, 2025 A08.
- **Hints:** (1) "Who tells the shop that a payment succeeded? Is it the customer's browser?" (2) "Find the endpoint the payment provider calls, and check what it demands from the caller." (3) "Replay the provider's message yourself, and look for a header that changes how strictly it is checked."
- **Fix:** always verify the HMAC (constant-time compare, timestamp tolerance, event-id idempotency), remove test-mode bypass from production config, confirm the payment by calling the provider's API.
- **Auto-test:** create order, POST an unsigned sandbox event, assert `status=paid` and flag; POST the same without the header, assert 400 and unchanged state; assert a legit gateway flow yields no flag.
- **Unintended risks:** handler only moves `pending_payment` orders, so seeded orders are safe. Refund logic (RS-G) must not turn a forged-paid order into real simulated money, or C04/refund challenges leak. The sandbox header must not exist on any other route.
- **Realism:** verifying webhook signatures is a documented requirement of payment providers such as Stripe (UNVERIFIED, not opened). Unsigned update channels are in the A08 page scenarios (VERIFIED).

#### C09 Logging and Alerting Failures (2021 A09 Security Logging and Monitoring Failures / 2025 A09 Security Logging & Alerting Failures)
- **How it becomes interactive and automatic:** the shop has a real **security-event pipeline**: failed logins, lockouts, role changes and refund approvals are written to `security_events`, and rules raise alerts shown to **admin** (Security Alerts page). One route is missing from the pipeline. The player's job is to **abuse the blind spot**. The monitor, which is outside the shop, knows both the HTTP traffic and the event table, so it can prove "attack happened, nothing logged, nothing alerted".
- **Vulnerability and host:** the deprecated **mobile API login** `/m/api/v1/login`, advertised on the "Get the app" page and in the web JS. Unlike web login it writes **no security event, has no lockout and no rate limit**. The web login on the same account locks after 5 failures and alerts (the player can see the lockout message, which is the visible contrast). Target: a dormant **support agent** account (`s.iyer`, separate from the XSS bot account) with a weak password that sits in the common-password lists.
- **Intended path:** notice the web login locks quickly; find the mobile route; run a wordlist against `s.iyer`; use the returned bearer token on **Support, Case notes**.
- **Difficulty 3.** Prerequisites: customer account; a common-password wordlist (player brings it).
- **Flag and detection:** flag is a "break-glass reference" in support case notes. **Signal:** flag in a response to the token; **log-failure proof (primary automatic signal):** at least 20 failed and then one successful legacy login for one account within 10 minutes **and zero rows** in `security_events` for that account. The learner dashboard can show this as "Your attack was invisible to the shop's SOC".
- **Tags:** CWE-778 Insufficient Logging; CWE-223 Omission of Security-relevant Information; CWE-307 (the missing lockout). ATT&CK T1110.001 Password Guessing; T1078.003 Local Accounts is **not verified here** (only T1078 and its sub-names were checked: Default, Domain, Local, Cloud Accounts), so use T1078 Valid Accounts. Related for the log-tampering variant: T1070 Indicator Removal. WSTG 4.4.10 Weaker Authentication in Alternative Channel (ATHN-10); 4.4.3 (ATHN-03). WSTG has **no dedicated logging test** (not found in the index). Tags 2021 A09, 2025 A09.
- **Hints:** (1) "Try the web login a few times. What does the shop do to you? Is every door guarded the same way?" (2) "The shop also has a phone-app API. Compare what happens when you fail there." (3) "Guess the dormant support agent's password on the app route, then use the token on the web side."
- **Fix:** one shared auth service for all channels; log every authentication event with user, IP, route, result; alert on thresholds; test that every route emits events; retire legacy APIs.
- **Auto-test:** run 25 bad logins plus the right one on the legacy route; assert `security_events` count is 0 and no alert; run 6 bad logins on the web route and assert 1 alert and a lock. The two assertions prove the contrast.
- **Unintended risks:** (a) C07 and C09 both involve guessing, so C07's reset-confirm failures are **logged normally**, and C09 only counts legacy-login failures. (b) Learners may lock `s.iyer` via the web route; lock lasts 5 minutes and does not affect the legacy route. (c) The weak password must **not** also be accepted by the finance account. (d) Player must not be able to read or write `security_events` (no log viewer for non-admin). (e) Case notes hold no other flag.
- **Variant not built (optional):** CWE-532, the legacy login logs the request body, and an admin log viewer is reached via a different bug. Rejected as primary because reaching the log needs another challenge.
- **Realism:** the A09 page cites breaches that ran for years undetected, including one possibly since 2013 and a £20 million fine for an airline (VERIFIED, OWASP A09 page). Forgotten legacy API versions are a common OWASP API pattern (UNVERIFIED, not opened).

#### C10 Server-Side Request Forgery (2021 A10 / 2025 A01, folded into Broken Access Control)
- **Vulnerability and host:** seller product editor, **"Import image from URL"**. The shop fetches the URL server-side and shows a preview. Weak defence: a **string blocklist** rejects `localhost` and `127.0.0.1` and any URL not starting with `http`. If the response is not an image, the error message echoes the first 200 characters ("Not an image: ...") (a realistic verbose-error leak).
- **Internal service (`vm-meta`):** a small container on a private network with the alias `metadata.vulnmart.internal`, never published to the host. It imitates a cloud instance-metadata service (IMDSv1 style, no token) and an internal ops API. `/healthz` and `/rates` are called by the shop legitimately. `/latest/user-data` holds the startup script text and the **flag** (sentinel: only reached by the fetcher's user agent). No real cloud keys exist anywhere.
- **Intended path:** import an image URL, see the blocklist, learn that the shop can fetch internal hosts (alternate loopback forms such as `0.0.0.0` or decimal IP show the filter is a string match), discover the internal name (from the error text, from the "Powered by" footer, or by guessing the conventional metadata path), request `/latest/user-data` through the importer, read the flag in the error snippet.
- **Difficulty 4.** Prerequisites: seller owner account (pending is enough, A2) or customer if RS-G lets customers upload avatars; knowledge of internal-service names.
- **Flag and detection:** flag in the importer's response. **Signal:** `vm-meta` logs a request to `/latest/user-data` from the app container with the importer's user agent (bot-observed/service-observed event); backup: the flag in the response.
- **Tags:** CWE-918 Server-Side Request Forgery (SSRF). ATT&CK T1190 Exploit Public-Facing Application; T1552.005 Cloud Instance Metadata API (parent T1552 Unsecured Credentials); optional T1046 Network Service Discovery for internal probing. WSTG 4.7.19 Server-Side Request Forgery (INPV-19). Tags 2021 A10, 2025 A01.
- **Hints:** (1) "The shop is making a web request for you. From where is that request sent?" (2) "The shop tries to stop you from reaching itself. Is it checking text or checking where the address really goes?" (3) "Cloud servers often keep a private info service at a fixed address; ask the importer to fetch its startup data."
- **Fix:** allowlist of image hosts, resolve DNS then check the final IP against private ranges and re-check after redirects, deny link-local and internal ranges at the network layer, require a token (IMDSv2 style), return generic errors, do not return the body.
- **Auto-test:** call the importer with the bypass URL and assert the flag appears; call with an external URL and assert an immediate refusal (no egress); assert `file://` and `gopher://` are rejected.
- **Containment (all required):**
  1. Per-instance Docker network with `internal: true` and no default route. No egress to the internet (A6).
  2. `vm-meta` is reachable only from the shop container; no published ports; **not** `host.docker.internal`. On Docker Desktop the host alias and the WSL gateway must be blocked by firewall rules (spike).
  3. The fetcher is built to support **only http and https**. No `file://`, so the app's own files and environment (where other flags might sit) cannot be read.
  4. No flag of any other challenge is in the shop's environment variables or on its filesystem in plain form, so a later RCE or file read cannot loot them (the platform injects flags via the DB or secret store, RS-B).
  5. The platform control API and monitor live on a different network the shop container cannot route to.
  6. Fetch timeout, 1 MB size cap and a concurrency limit protect the instance.
- **Realism:** Capital One 2019, SSRF through a WAF to the instance metadata service, then stolen role credentials (UNVERIFIED, secondary: Wiz and Security Boulevard search results). Image-import SSRF bugs: OpenStack Glance advisory OSSA-2026-004 (cited in `initial.md` D-09), plus Canonical LXD and Incus image-import SSRF (UNVERIFIED, search summaries only, no CVE number checked).

#### C11 Mishandling of Exceptional Conditions (2021 none / 2025 A10)
- **Fail-open examples compared:** (1) **Authentication/authorization (chosen):** the seller KYC check. (2) Payment: gateway error treated as "paid". (3) Checkout: inventory service error accepted as "in stock". (2) is the same effect as C08, (3) has no natural flag, so (1) is the primary. (2) and (3) can be small extras on the same code style.
- **Vulnerability and host:** **seller onboarding** (`/sell/register`). The shop sends the tax ID to a mock KYC provider (`vm-kyc`). The verify call is wrapped in `try { ... } catch (e) { log.warn(e); return {status: 'verified'} }` with the comment "never block onboarding on a provider outage". Malformed input (for example `tax_id[]=a`, an over-long value, or non-ASCII characters) makes the provider reply 500, the handler fails open, and the store is **auto-approved** without the admin queue. Verbose errors (stack and upstream URL) leak on the first malformed attempt, which guides the player.
- **Intended path:** register as a seller with a normal tax ID (stays pending). Notice the verbose error on odd input. Submit a malformed value and observe instant approval. Open **Seller, Payouts**.
- **Difficulty 3.** Prerequisites: none (self-registration).
- **Flag and detection:** sentinel flag: the Payouts page shows the flag only when `stores.approved_by = 'system:kyc-fallback'`. A seller approved by a human admin or by another bug does not see it. **Signal:** state change `approved_by = system:kyc-fallback` (primary, no flag text needed) plus the flag in the response.
- **Tags:** CWE-636 Not Failing Securely ('Failing Open'); CWE-755 Improper Handling of Exceptional Conditions; CWE-396 Declaration of Catch for Generic Exception; CWE-209 Generation of Error Message Containing Sensitive Information; CWE-234 Failure to Handle Missing Parameter for the array variant. All are in the A10 list (VERIFIED names). ATT&CK T1190 Exploit Public-Facing Application; there is **no clean ATT&CK technique for "failing open"** (stated honestly). WSTG 4.8.1 Improper Error Handling (ERRH-01), 4.8.2 Stack Traces (ERRH-02), 4.10.6 Circumvention of Work Flows (BUSL-06). Tags 2021 none, 2025 A10.
- **Hints:** (1) "What does the shop do when it cannot understand your answer to a form question?" (2) "The error text names the service that checks sellers. What if that service is the one that breaks?" (3) "Send the tax ID in a shape the checker cannot read, and see whether the shop says no."
- **Fix:** fail closed (reject or queue for manual review), strict input validation before the call, narrow exception types, one global handler, generic user errors with details only in logs, alert on KYC provider errors.
- **Auto-test:** register with a valid ID, assert `pending`; register with `tax_id[]=x`, assert `approved_by=system:kyc-fallback` and flag on the payouts page; assert an admin-approved store does not show the flag.
- **Unintended risks:** admin approval (C01-style bypass) cannot give the flag because of the sentinel. The KYC mock may be crashed by oversized input, so it restarts under a supervisor and is per-instance only. C10 error echo style and C11 verbose errors must not share one handler, so one fix does not remove both.
- **Realism:** the A10 page scenarios (VERIFIED). Apple "goto fail", CVE-2014-1266, a skipped signature check after an error (UNVERIFIED, not opened).

### Dependency and order map (all 11)
C01 to C06 are assumed from names and tags only.

| Challenge | Hard prerequisite | Soft links (must not be required) | Shop roles used |
|---|---|---|---|
| C01 Broken Access Control | none | C11 (admin approval), C09 (support notes) | customer, seller, admin |
| C02 Cryptographic Failures | none | C07 (tokens) | customer, finance? |
| C03 Injection (XSS and SQLi) | none | C09 log viewer | customer, support agent (bot) |
| C04 Insecure Design | none | C08 (free order via other route) | customer |
| C05 Security Misconfiguration | none | C08 (docs page), C10 (internal names) | admin |
| C06 Supply chain | none | none | any |
| **C07 Auth failures** | none | none | customer, **finance** |
| **C08 Integrity** | none | C05 (finding docs), C04 | **customer**, seller (docs) |
| **C09 Logging** | none | C07 | **support agent**, admin (alerts page) |
| **C10 SSRF** | none (A2) | C11 | **seller owner / staff** |
| **C11 Exceptional conditions** | none | C01 | **seller owner**, admin (bypassed queue) |

All eleven are independently solvable. No challenge needs another to be solved first. This keeps hiring scores fair and makes per-challenge timing (R-11) meaningful. Role coverage from this stream: finance (C07), support agent (C09), customer (C08), seller owner or staff (C10, C11), admin (C09 alerts, C11 queue). Seller staff is only a secondary user here, so **RS-E must give seller staff and admin a main challenge**, or those roles are dropped by the rule in D-11.

### Difficulty ramp (suggested order of presentation)
C07 (2) > C11 (3) ~ C08 (3) ~ C09 (3) > C10 (4). Combined with RS-E: start with easy access control and injection (1 to 2), middle with C07, C11, C08, C09, C04, C05, then C10 and C06 or the hardest of C01 to C06. Scale 1 (single request) to 5 (chained, several tools).

**This design would be wrong if:** RS-G does not let pending sellers draft products (C10 then depends on C11, give customers an avatar-URL import instead); platform isolation cannot block egress and host aliases (C10 must then be dropped or reduced to a simulated SSRF); or the user wants all fail-open cases to be payment-based (then C08 must change).

## 4. Decision candidates for the user
1. **C07 target and weakness.** Options: (a) 4-digit reset code on the finance account, (b) credential stuffing, (c) JWT weakness. Recommend (a): single clear path, no overlap with C02.
2. **C08 mechanism.** Options: (a) unsigned payment webhook, (b) unsafe cart deserialization, (c) unsigned role cookie. Recommend (a): no code execution, so no cross-challenge looting.
3. **C09 interactive design.** Options: (a) legacy login route missing from logging and alerts, (b) secrets in an admin log viewer, (c) log forging. Recommend (a): the monitor can prove "not logged" automatically.
4. **C09 proof rule.** Options: (a) automatic "attack but zero events" check plus flag on the target page, (b) flag only, (c) learner must also paste a log excerpt. Recommend (a).
5. **C10 internal service.** Options: (a) mock metadata service with user-data flag, (b) internal admin API, (c) both. Recommend (a): matches real incidents and is easy to explain.
6. **C11 fail-open scenario.** Options: (a) seller KYC auto-approval, (b) payment error means paid, (c) checkout stock check. Recommend (a): avoids a clash with C08. This differs from the D-09 idea (payment), which was marked "ideas only".
7. **Sentinel flags.** Should a flag appear only when the vulnerable path was used? Options: (a) yes everywhere, (b) only where a second route exists. Recommend (a): simple, consistent rule.
8. **Mock services per instance.** Options: (a) three small sidecars (payment, KYC, metadata) in the instance, (b) one combined mock-services container. Recommend (b): fewer containers per user on a 15 GB laptop (spike to confirm memory).

## 5. Evidence
| URL | What it supports | Status |
|---|---|---|
| https://top10.owasp.org/2025/A10_2025-Mishandling_of_Exceptional_Conditions | A10 description, 24 CWEs, prevention, scenarios | VERIFIED |
| https://top10.owasp.org/2025/A09_2025-Security_Logging_and_Alerting_Failures | A09 title, CWE-117/221/223/532/778, scenarios | VERIFIED |
| https://top10.owasp.org/2025/A07_2025-Authentication_Failures | A07 title and 36 CWEs (CWE-307, 384, 640 etc.) | VERIFIED |
| https://top10.owasp.org/2025/A08_2025-Software_or_Data_Integrity_Failures | A08 title, 14 CWEs (345, 347 not listed, 353, 565, 784, 915) and scenarios | VERIFIED (note: CWE-347 is **not** on the A08 list; I checked its name on cwe.mitre.org only, so it is a related CWE) |
| https://top10.owasp.org/2025/A01_2025-Broken_Access_Control | CWE-918 listed in A01 (40 CWEs) | VERIFIED |
| https://cwe.mitre.org/data/definitions/918.html, /636.html, /347.html | Exact names of CWE-918, 636, 347 | VERIFIED |
| https://attack.mitre.org/techniques/T1110/ | T1110 Brute Force; .001 Password Guessing, .003 Password Spraying, .004 Credential Stuffing | VERIFIED |
| https://attack.mitre.org/techniques/T1078/ | T1078 Valid Accounts and sub-names | VERIFIED |
| https://attack.mitre.org/techniques/T1552/005/ | T1552.005 Cloud Instance Metadata API | VERIFIED |
| https://attack.mitre.org/techniques/T1565/001/ | T1565.001 Stored Data Manipulation | VERIFIED |
| https://attack.mitre.org/techniques/T1190/ | T1190 Exploit Public-Facing Application | VERIFIED |
| https://attack.mitre.org/techniques/T1046/, /T1070/, /T1195/, /T1556/, /T1212/ | Names of T1046, T1070 (Indicator Removal), T1195, T1556, T1212 | VERIFIED |
| https://attack.mitre.org/techniques/T1562/ | T1562 Impair Defenses; page fetch returned empty. Sub-technique T1562.002 Disable Windows Event Logging seen via search snippet | UNVERIFIED (not used in the cards) |
| https://wstg.owasp.org/latest/ | WSTG section numbers and titles (4.4.x, 4.6.x, 4.7.19, 4.8.x, 4.10.x). The page shows numbers, not the `WSTG-ATHN-09` style codes. Codes in this file are derived from the standard numbering | VERIFIED for titles, UNVERIFIED for derived codes |
| https://threats.wiz.io/all-incidents/capital-one-incident-march-2019 | Capital One SSRF to metadata service (search result only) | UNVERIFIED |
| https://security.openstack.org/ossa/OSSA-2026-004.html | OpenStack image-import SSRF (cited in D-09, not re-opened) | UNVERIFIED |
| Canonical LXD, Incus image-import SSRF (search summary, no URL opened) | Realism for C10 | UNVERIFIED |

## 6. Open questions and spikes to run later
- **Correction for the reader:** CWE-347 and CWE-345 for C08. CWE-345 is on the A08 list; CWE-347 is not (related only).
- **Spike S1:** can Docker Desktop on Windows 11 block `host.docker.internal` and the WSL gateway from an `internal: true` network? Required for C10.
- **Spike S2:** time for a 10,000-request reset brute force against the instance (C07), and the wordlist rank of the C09 password, so both are solvable in reasonable time.
- **Spike S3:** memory cost of mock-services sidecars per instance (decision 8).
- **Spike S4:** confirm the monitor can read `security_events` and sidecar logs read-only without affecting the shop (C08, C09).
- Which shop events RS-G will log, and the schema of `security_events` (C09 depends on it).
- D-09 listed payment fail-open for the Exceptional Conditions challenge. This design moves it to KYC. User must confirm.
- WSTG test codes should be re-checked against the repository checklist (the raw checklist URL returned 404).
- ATT&CK mapping for C11 is weak by nature (no "fail open" technique).

## 7. Impact on other streams
- **RS-E (C01 to C06):** C01 must not be able to approve sellers in a way that yields the C11 flag (sentinel rule handles this). C04 (price/coupon) must not release the C08 reference. C05 (misconfiguration) may expose the webhook docs but must not expose the sandbox header or the internal service names directly. C02 should not reuse the finance account's reset token. Please give **seller staff and admin** a main challenge.
- **RS-G (shop domain):** need pending-seller drafts with URL image import (A2), a finance account with a settings page, a dormant support agent, the `security_events` table and Security Alerts page, a `stores.approved_by` field, an order `payment_ref` field, a mobile API v1 route, and a refund rule that does not pay out forged-paid orders.
- **RS-B (isolation, monitor):** per-instance internal network with no egress, firewall for host aliases, flags injected via DB/secret store (not env files), monitor read access to the DB, sidecar logs and `security_events`, and event types: "flag in response", "ledger mismatch", "no events for attack".
- **RS-C (scoring):** C09's automatic signal is a *negative* observation (no events). The scoring engine needs a "condition over a time window" rule type, not only "flag seen".
- **RS-D (platform):** the learner dashboard should show the C09 contrast ("attack invisible to SOC") as evidence.

### Cross-challenge conflicts to check
1. C07 vs C09: both use guessing. Keep reset-confirm logged, keep legacy-login unlogged, keep passwords distinct.
2. C08 vs C04: any route that makes a free order must not release the C08 reference.
3. C08 vs RS-G refunds: a forged-paid order must not produce simulated money.
4. C10 vs C05: the internal service name must not be given away by the misconfiguration challenge.
5. C10 vs C11: verbose error handlers must be separate code.
6. C11 vs C01: admin approval bypass must not capture the C11 flag.
7. C09 vs C03: the admin Security Alerts page must encode all output, otherwise it becomes an extra XSS target for the bot.
8. C07 vs C02: reset-token weakness (C07) and token/crypto weakness (C02) must be different mechanisms.
9. C10 and RCE-class bugs from C03/C06: no other challenge may allow code execution or file read in the shop container, as it would reveal every flag. If C06 (outdated component) is an RCE, flags must be outside the container filesystem and environment.
10. Seller staff attacking C10: if staff may import images, they need a role boundary (C01) that does not leak.
