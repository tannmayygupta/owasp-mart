# RS-E — Challenge design C01 to C06
Status: DRAFT research, NOT confirmed by the user · Date: 2026-10-08

Scope: concrete design of C01 Broken Access Control, C02 Cryptographic Failures, C03 Injection, C04 Insecure Design, C05 Security Misconfiguration, C06 Software Supply Chain Failures. Stream RS-F designs C07 to C11, RS-G designs the shop domain. Nothing here is decided; every choice is a candidate (see Section 4).

## 1. Questions answered

1. What is a concrete, realistic bug for each of C01 to C06, in which page or feature, with one intended exploit path?
2. How is each solve detected automatically (flag in a response, a state change, or a bot event)?
3. Which CWE, MITRE ATT&CK and OWASP WSTG IDs fit (names checked on the official sites)?
4. What does the official OWASP 2025 page say about the scope of A03 Supply Chain Failures, and how can we include a known-vulnerable dependency safely?
5. How do we stop one exploit from solving another challenge, breaking the app, or reaching the host?

### Shop assumptions used (RS-G must confirm or replace)
- A-1. Web app is Node.js/Express with a SQL database (D-06 stack is still unlocked; any stack works if the same seams exist). SQLite or PostgreSQL both fit.
- A-2. Six shop roles per D-11. Entities: store, product, cart, order (with order lines per store), payment (simulated), payout, refund, review, dispute, gift card, wallet or credit ledger.
- A-3. Every new instance is seeded with: a few stores, one seeded **seller staff** login given to the player in the challenge brief ("you are staff at Harbor Crafts"), one seeded **customer** login, one delivered customer order for the player, and "other" stores and customers that no human logs into.
- A-4. Payments are simulated. No real payment gateway.
- A-5. Per-instance flags (D-02) are injected at instance start (environment or seed step), never stored in source. In this file a flag is written as `<FLAG_Cnn>`.
- A-6. A monitor sidecar can (a) match flag strings in HTTP responses at the reverse proxy, with the session and route, and (b) receive signed events from the app (for state-change captures). Bots (for example the support agent) are tagged so their own views do not count as captures.
- A-7. The app has one primary database for the shop and **a separate, restricted "catalog" database or schema** (needed for C03, see there).
- A-8. Difficulty scale used here: 1 = one obvious step; 2 = a few steps, standard technique; 3 = needs reasoning about how the feature works; 4 = needs research on a library or protocol; 5 = chained, expert.

## 2. Options compared

For each challenge I compared candidate designs. The chosen one is marked **(chosen)**.

| Challenge | Option | Fit | Complexity | Main risk | Evidence |
|---|---|---|---|---|---|
| C01 | **Seller reads another store's order (BOLA/IDOR) (chosen)** | Carries seller staff role; marketplace-specific (D-10 notes this pattern) | Low | Seeded orders must not hold other secrets | D-10 notes; Optus case |
| C01 | Customer reads other customers' orders | Classic, but any beginner shop has it; carries only customer | Low | none | D-09 idea |
| C01 | Vertical escalation by editing a role field at registration | Overlaps C07 (identity) | Low | Overlap | Juice Shop write-up in D-10 |
| C02 | **Gift-card codes derived from an unsalted hash of a counter (chosen)** | Self-contained, no overlap, no secrets leaked | Medium | Credit must not be spendable | Tesco/Hotels.com 2020; retail cards 2017 |
| C02 | Cracking unsalted MD5 password hashes | Very classic, but needs a hash dump, which comes from C03 or C05 (cross-solve) | Medium | Breaks challenge independence | n/a |
| C02 | Hard-coded AES key in the front-end bundle | Realistic, but discovery is just "read JS" and overlaps C05 | Low | Overlap | n/a |
| C03 | **SQL injection in product search, UNION-based (chosen)** | Iconic, easy to auto-verify | Low | Must be contained (see C03) | TalkTalk 2015 |
| C03 | Stored XSS in reviews/disputes viewed by support bot | Carries support agent role, needs bot | High | Bot reliability, session handling | Synopsis wording on XSS |
| C04 | **Refunds with no cumulative cap, per-request auto-approve (chosen)** | Marketplace-specific, a design gap not a coding slip | Medium | Depends on RS-G refund model | Clover and Mercado Pago caps |
| C04 | Coupon stacking / negative quantity | Fine, but already common in other labs and touches the cart | Low | Cart overlap | D-09 idea |
| C04 | Race condition double-refund | Timing-flaky for automatic verification | High | Flaky tests | n/a |
| C05 | **Unauthenticated debug/ops endpoint found through a verbose error (chosen)** | Realistic, self-contained | Low | Dump must be synthetic | Wiz and Trend Micro on Spring actuator |
| C05 | Default admin credentials | Counts as Authentication Failures (C07) | Low | Overlap with C07 | n/a |
| C05 | Directory listing / backup file | Valid but trivial | Low | none | WSTG-CONF-04 |
| C06 | **lodash 4.17.11 deep-merge prototype pollution in an isolated import service (chosen)** | Real CVE, no code execution, containable | Medium | Gadget must be self-built | GHSA-jf85-cpcp-j695 |
| C06 | ejs 3.1.6 template injection (CVE-2022-29078) | Real RCE, too hard to contain | Low | Code execution in a container | search result only |
| C06 | lodash template (CVE-2021-23337) | Needs attacker-controlled template, high privilege | Medium | Code execution | search result only |
| C06 | qs/Express DoS (CVE-2022-24999) | Crashes the app | Low | Breaks app for the player | search result only |

## 3. Recommendation

Each challenge below follows the same card. Payload examples are short and illustrative.

---

### C01 — Broken Access Control (2025 A01 / 2021 A01)

**Vulnerability and host.** Seller dashboard, "Orders" detail page. `GET /api/seller/orders/{orderNo}` checks that the caller is a seller owner or staff, but does not check that the order contains items from the caller's store. Order numbers are sequential (`VM-100245`). This is object-level access control failure (BOLA/IDOR). Role carried: **seller staff** (and seller owner). A real marketplace pattern named in D-10.

**Intended exploit path (one).**
1. Log in as the seeded staff of Harbor Crafts. Open the order list; note your orders have numbers like `VM-1002xx`.
2. Open one order and see the URL or API call with the order number.
3. Change the number to one that is not in your list. The server returns it.
4. Walk nearby numbers until an order from the competitor store "Northwind Tea Co" is found. Its buyer note holds the flag.

**Difficulty 2.** Prerequisite: the seeded staff login only (A-3).

**Flag and detection.** Flag lives in the "buyer note" field of one seeded order belonging to Northwind Tea Co (seed step writes it). Detection signal: **flag in a response** to a `/api/seller/orders/{id}` request whose session store is not Northwind. Also emit an app event "cross-store order read" for evidence. Seeded bots never request it, so any hit is a player.

**Tags.**
- CWE-639 Authorization Bypass Through User-Controlled Key (primary); CWE-862 Missing Authorization; CWE-863 Incorrect Authorization. (all names VERIFIED on cwe.mitre.org)
- ATT&CK T1190 Exploit Public-Facing Application (VERIFIED); T1078 Valid Accounts (VERIFIED; the player uses a given account).
- WSTG: WSTG-ATHZ-04 Testing for Insecure Direct Object References; WSTG-ATHZ-02 Testing for Bypassing Authorization Schema (titles verified on the v4.2 page; ID by section order).
- OWASP: 2025 A01 Broken Access Control / 2021 A01 (D-06).

**Hints.**
1. Nudge: "Your order list shows only your store's orders. Look at how one order is identified when you open it."
2. Direction: "Order numbers run in sequence. Does the server check which store an order belongs to?"
3. Near-solution: "Ask for an order number that is not in your list, then read the buyer note of a competitor store's order."

**Fix (write-up).** Check ownership on the server for every object: `WHERE order_no = ? AND store_id = :callerStore`, or a policy layer that denies by default. Use unguessable IDs as defence in depth, not as the fix. Add an automated test per endpoint that a second tenant gets 403 or 404.

**Automated verification test.** Log in as staff of store A, request the seeded Northwind order number, assert 200 and that the body contains the flag. Then assert the same request as the fixed build returns 403 or 404 (regression test for the fix).

**Unintended-exploit risks and prevention.**
- Enumeration shows other seeded orders: seed them with fake buyers only; no passwords, tokens, or other flags in any order field.
- The same endpoint must not leak the C04 victim data (the player's own orders are theirs).
- Sequential numbers allow scanning: fine, but add a modest platform rate limit so a scan cannot slow the instance.
- Nothing reaches the host: read-only data lookup.

**Realism references.** Optus 2022: ACMA alleges a coding error in access controls of an internet-facing API exposed data of about 9.5 million customers (UNVERIFIED, press coverage: techrepublic.com, csoonline.com, cpomagazine.com). Marketplace pattern "one seller sees another seller's orders" from D-10 sources (Ultra Commerce, Melapress).

---

### C02 — Cryptographic Failures (2025 A04 / 2021 A02)

**Vulnerability and host.** "Gift cards" in the customer wallet. The code printed on a card is `VM-` plus the first 12 hex characters of an **unsalted MD5 of the card's sequential serial number**. The receipt shows "Card no. 1043". Redeem endpoint: `POST /api/wallet/redeem`. This is a weak, unkeyed hash used as a secret, so the code is predictable. Role carried: **customer** (secondary role overlap with C04, see conflicts).

**Intended exploit path (one).**
1. As a customer, buy two cheap gift cards (simulated payment).
2. Compare codes with card numbers. The hex part looks like a hash; a hash identifier or trying `md5("1043")` confirms the match.
3. Compute the code for serial `1` (the seeded "staff test card"), which is not sold to anyone.
4. Redeem it. The redemption message contains the flag.

**Difficulty 3.** Prerequisite: customer login; ability to buy a gift card.

**Flag and detection.** Flag is in the "message" field of seeded gift card serial 1, returned only in the redeem response. Detection: **state change** (card 1 marked redeemed by a player account, app event) plus **flag in the response**. Redeeming gives only "promotional credit" that is **not spendable** on seller products (see risks).

**Tags.**
- CWE-328 Use of Weak Hash; CWE-330 Use of Insufficiently Random Values; CWE-338 Use of Cryptographically Weak PRNG; CWE-799 Improper Control of Interaction Frequency (no limit on guessing). (all VERIFIED)
- ATT&CK T1657 Financial Theft (VERIFIED name; fit is approximate because ATT&CK has no exact "guess a voucher" technique).
- OWASP Automated Threats: OAT-002 Token Cracking (title seen in search result; UNVERIFIED page content).
- WSTG: WSTG-CRYP-04 Testing for Weak Encryption (closest; WSTG has no PRNG-specific test; ID by section order).
- OWASP: 2025 A04 Cryptographic Failures / 2021 A02.

**Hints.**
1. "Look at your two gift card codes. Do they look random?"
2. "The code part is a fingerprint of something you can see on the receipt. Which common hash makes 32 hex characters?"
3. "Hash the serial number of the oldest card (number 1) the same way and redeem the first 12 characters, prefixed as on your cards."

**Fix.** Generate codes with a cryptographically secure random source and enough length (for example 128 bits from `crypto.randomBytes`), store only a keyed hash of the code, make codes single-use, rate-limit and lock redemption attempts, and log failures. If a hash is used for integrity, use HMAC with a secret key, not a bare hash.

**Automated verification test.** Script buys two cards, derives the pattern, computes md5 of `1`, redeems, asserts flag in response. Fixed-build test asserts the same code is rejected.

**Unintended-exploit risks and prevention.**
- Credit must not buy anything (it would bypass C04 and the cart): store it in a separate non-spendable ledger.
- Hashing is the only weak crypto in the shop. All user passwords must use a strong adaptive hash (argon2 or bcrypt), and no MD5 password hashes anywhere, or C03 or C05 could leak crackable data and cross-solve this.
- Platform-safety throttling (for example 60 redeem calls per minute) so a brute-force loop cannot hurt the instance; it does not stop the intended path.
- Nothing reaches the host.

**Realism references.** Tesco Clubcard / Hotels.com voucher codes had a fixed prefix and predictable segment, about four million possibilities, 2020 (UNVERIFIED, infosecurity-magazine.com, theregister.com). Retail gift-card numbers with mostly sequential digits, 2017 (UNVERIFIED, pymnts.com). Standard remedy list from the same search: CSPRNG codes, attempt limits.

---

### C03 — Injection (2025 A05 / 2021 A03)

**Vulnerability and host.** Public product search: `GET /api/products/search?q=...`. The server builds SQL by string concatenation:
`SELECT id,name,price,store FROM catalog_products WHERE status='published' AND name LIKE '%<q>%'`.
Role carried: anonymous visitor and customer.

**Intended exploit path (one).** Type `'` and see an error or odd result. Find the column count with `' ORDER BY 4--`. Use `' UNION SELECT 1,body,3,4 FROM ops_notes--` (table names found from the database's own schema table). The row for the "merchandising note" holds the flag.

**Difficulty 2.** Prerequisite: none.

**Flag and detection.** Flag lives in a row of table `ops_notes` in the **catalog database**. Detection: **flag in a response** to the search route. The CRS rule hit (D-07) supplies the technique label but is not used for the capture decision.

**Tags.**
- CWE-89 SQL Injection (VERIFIED exact name above in the table notes: "Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')").
- ATT&CK T1190 Exploit Public-Facing Application (VERIFIED).
- WSTG-INPV-05 Testing for SQL Injection (VERIFIED).
- OWASP: 2025 A05 Injection / 2021 A03.

**Hints.**
1. "What happens when your search text contains a single quote?"
2. "Your text ends up inside a database query. You can append rows from another table with UNION if the column count matches."
3. "The product query has four columns. Read the tables of the catalog database; one holds merchandising notes."

**Fix.** Parameterized queries or an ORM; allow-list for sort fields; least-privilege database account; generic error messages. Show the vulnerable and fixed line side by side.

**Automated verification test.** Send `' UNION SELECT 1,body,3,4 FROM ops_notes--` (column count adapted to the final schema), assert the flag appears in the JSON. Fixed-build test: the same input returns zero rows and no error.

**Unintended-exploit risks and prevention (important).**
- Cross-solving: the search must connect to a **separate catalog database or schema** that holds only products, reviews and `ops_notes`. It must not hold users, password hashes, tokens, orders or other flags. Otherwise a UNION dumps credentials and solves C07 or C01.
- Breaking the app: use a **read-only** connection (SQLite `query_only` and read-only open; PostgreSQL role with SELECT only), a driver that allows **one statement per call** (no stacked queries), and a statement timeout of about 2 seconds so `pg_sleep` loops or cartesian joins cannot freeze the instance.
- Reaching the host: non-superuser database role, no `COPY ... PROGRAM` or file functions, no SQLite `load_extension`.
- Spike: confirm these settings with the chosen driver.

**Realism references.** TalkTalk 2015: SQL injection on legacy pages, ICO fine of 400,000 pounds in October 2016, about 157,000 customers (UNVERIFIED, siliconrepublic.com, collascrill.com). MOVEit Transfer CVE-2023-34362 is also a well-known SQLi (not checked in this research; UNVERIFIED).

**Open point.** Stored XSS also belongs to A05 Injection in 2025. Who carries it, and the support-agent bot, must be settled (Decision 1).

---

### C04 — Insecure Design (2025 A06 / 2021 A04)

**Vulnerability and host.** Customer "Order detail → Request refund". `POST /api/orders/{id}/refunds {amount, reason}`. Design rules: (a) a refund up to 1,500 is **auto-approved** with no support review, (b) the check is per request, with **no cumulative cap** against the amount paid and **no count limit**. The code is "correct" for the design; the design is missing a threat model for repeated partial refunds. Role carried: **customer** (with effects visible to seller, finance, support).

**Intended exploit path (one).** The player's seeded delivered order totals 2,500. Request a refund of 1,500 (auto-approved). Request 1,500 again (also auto-approved). Total refunded is 3,000, more than the 2,500 paid. The refund ledger then shows a "goodwill adjustment" line whose reference is the flag.

**Difficulty 3.** Prerequisite: customer login with the seeded delivered order. Server validates `amount` as a positive integer, so negative-amount tricks do not exist (avoids a second path).

**Flag and detection.** Flag lives in the "goodwill adjustment reference" line created only when `sum(refunds) > amount_paid` (state change). Detection: **state change** (app event when the invariant breaks for a player order), plus flag visible in the order's refund statement.

**Tags.**
- CWE-840 Business Logic Errors; CWE-841 Improper Enforcement of Behavioral Workflow; CWE-799 Improper Control of Interaction Frequency. (VERIFIED)
- ATT&CK T1657 Financial Theft (VERIFIED).
- WSTG-BUSL-05 Test Number of Times a Function Can Be Used Limits (primary); WSTG-BUSL-01 Test Business Logic Data Validation (titles verified, IDs by section order in v4.2).
- OWASP: 2025 A06 Insecure Design / 2021 A04.

**Hints.**
1. "Refund your delivered order. Then look at what the shop says is still refundable."
2. "The auto-approve rule looks at each request. Does anything add up all the requests?"
3. "Ask for a refund below the auto-approve limit twice, so the sum is above what you paid."

**Fix.** Keep a refundable balance per order (`paid - sum(approved refunds)`), enforce it inside a database transaction with a row lock, apply the auto-approve threshold to the cumulative total, cap refund count, and use idempotency keys. The deeper lesson: run an abuse-case review at design time ("what if the same action is repeated?").

**Automated verification test.** API script: create refund 1,500 twice, assert both 2xx and refund statement contains the flag. Fixed-build test: second request returns 4xx.

**Unintended-exploit risks and prevention.**
- Refund money must go to a non-spendable refund ledger, not a spendable wallet (no free shopping, no overlap with C02).
- The simulated seller payout debit must be isolated per instance and must not feed any other challenge's flag or state.
- No race: the intended path is sequential, so do not rely on timing.
- Depends on RS-G refund model: refund must carry `amount` and `order paid total` (see conflicts).

**Realism references.** Payment APIs enforce this cap: Clover returns "this refund would make the order's total refunded amount greater than the original order's amount"; Mercado Pago has a "max_refunds_exceeded" error (UNVERIFIED, found via search summary). Nearest CWE mapping practice: CWE-840 parent, CWE-841 for workflow flaws. No public disclosure of this exact flaw was found; say so in the report, and use these as evidence that platforms treat the control as necessary.

---

### C05 — Security Misconfiguration (2025 A02 / 2021 A05)

**Vulnerability and host.** The app ships with an operations console left on in production: `/_ops/diagnostics` needs no login. A verbose error handler returns a stack trace for a malformed request (for example invalid JSON to `POST /api/cart`), and the trace names the route file. Role carried: none of the six (anonymous); it is a deployment flaw. (Decision 4 on role rule.)

**Intended exploit path (one).** Send broken JSON to a JSON endpoint, read the stack trace, see the `_ops` route path, request `/_ops/diagnostics`. The JSON includes a config block with an entry named like a support-bridge token, whose value is the flag.

**Difficulty 2.** Prerequisite: none.

**Flag and detection.** Flag is the value of one entry in a **synthetic** diagnostics object built at start-up. Detection: **flag in a response** to `/_ops/diagnostics` from a non-internal client.

**Tags.**
- CWE-489 Active Debug Code; CWE-209 Generation of Error Message Containing Sensitive Information; CWE-497 Exposure of Sensitive System Information to an Unauthorized Control Sphere; CWE-1188 Initialization of a Resource with an Insecure Default. (all VERIFIED)
- ATT&CK T1190 Exploit Public-Facing Application; T1552 Unsecured Credentials (parent only, the sub-techniques are file/registry/etc., none fits an HTTP config dump); T1595.003 Wordlist Scanning, if the player finds the path by scanning instead. (all names VERIFIED)
- WSTG-CONF-05 Enumerate Infrastructure and Application Admin Interfaces; WSTG-CONF-02 Test Application Platform Configuration; WSTG-ERRH-02 Testing for Stack Traces (IDs by v4.2 section order).
- OWASP: 2025 A02 Security Misconfiguration / 2021 A05.

**Hints.**
1. "Break something on purpose and read the error closely."
2. "The error shows a file path. An internal tools area is mounted somewhere near it."
3. "Request the diagnostics page of the operations area, with no login, and read the config values."

**Fix.** Do not ship debug routes; mount management endpoints on a separate port or localhost only; return generic errors with a correlation ID; keep secrets out of config dumps and in a secrets manager; add a hardening checklist to the release process.

**Automated verification test.** Send a malformed body, assert the response contains `_ops`; request `/_ops/diagnostics`, assert flag. Fixed-build: 404 and generic error.

**Unintended-exploit risks and prevention.**
- The dump must be a hand-built object. Never `process.env`, database URL, JWT or session secret (would solve C07), instance token, or platform credentials. This is the main host-safety rule.
- No dependency versions in the dump (C06 discovery stays separate).
- Stack traces must show only app paths, not connection strings or tokens.
- C11 (exceptional conditions) must use a different failure (fail-open logic), not this error handler.

**Realism references.** Wiz study of Spring Boot Actuator exposure (misconfigurations in about one in four environments with exposed actuators; heapdump endpoint public by default before version 1.5, 2017) and Trend Micro incident report where `/env` leaked credentials (UNVERIFIED, search summaries of wiz.io and trendmicro.com).

---

### C06 — Vulnerable and Outdated Components / Software Supply Chain Failures (2025 A03 / 2021 A06)

**2025 scope (VERIFIED, top10.owasp.org/2025/A03_2025-Software_Supply_Chain_Failures).** Title: "A03:2025 Software Supply Chain Failures". It covers breakdowns in how software is built, distributed or updated, caused by vulnerable or malicious third-party code, tools or dependencies, **including nested (transitive) ones**. It is broader than known-vulnerable components: untracked versions, unsupported software, infrequent scanning and patching, missing change management and separation of duties, unhardened build systems, CI/CD and repositories, and components from untrusted sources. Mapped CWEs (as listed by OWASP): CWE-447 Use of Obsolete Function, CWE-1035, CWE-1104 Use of Unmaintained Third Party Components, CWE-1329, CWE-1357, CWE-1395 Dependency on Vulnerable Third-Party Component. Note: the page text elsewhere says "CWE-477", which looks like a typo for 447. I verified the names of 1104 and 1395 on cwe.mitre.org; the others are as OWASP lists them.

**What we can safely reproduce.** Only the "known-vulnerable dependency, found by inventory and scanning" part. We cannot (and should not) include a real malicious package or a compromised pipeline. We cover the rest as write-up content (Shai-Hulud and chalk/debug, 2025).

**Vulnerability and host.** Seller "Bulk catalog import" (preview mode) runs in a **separate small service** (`catalog-import`). It merges the seller's "import options" JSON into defaults with `_.defaultsDeep` from **lodash 4.17.11**, which is vulnerable to prototype pollution (CVE-2019-10744, fixed in 4.17.12). Validation of allowed keys happens after the merge, a realistic mistake. Hosts: the import page, plus a public "Open-source notices" page (`/legal/open-source`) and a CycloneDX SBOM file listing components and versions. Role carried: **seller owner or staff**.

**Intended exploit path (one).**
1. Read the notices page or SBOM; note lodash 4.17.11 in the import service.
2. Look up the version in an advisory database (or run an SCA scanner such as npm audit, OSV-Scanner or Trivy on the SBOM). Learn: `defaultsDeep` pollution, key `constructor.prototype`.
3. Send import options such as `{"constructor":{"prototype":{"internalAudit":true}}}` with a small CSV.
4. The preview result normally has `"auditToken": null`. After the pollution, the service's own check `if (ctx.flags.internalAudit)` (reading a plain object that the user never controls directly) becomes true, and the response includes the audit token, which is the flag.

Setting `internalAudit` directly as an option does nothing (the flags object is built by the server), so the vulnerable library is required.

**Difficulty 4.** Prerequisite: seeded seller login; recognise the library issue. API docs for the import service state that `auditToken` is only issued for internal audit runs (gives the gadget name).

**Flag and detection.** Flag is the value of `auditToken` in the preview response. Detection: **flag in a response** from the import service, session tagged as a player.

**Candidate CVEs checked**

| CVE | Package and affected versions | Exploitable in a Node.js app? | Containment verdict |
|---|---|---|---|
| CVE-2019-10744 | lodash before 4.17.12 (`defaultsDeep`); also lodash-es before 4.17.14, lodash.defaultsdeep before 4.6.1; GHSA rates Critical (CVSS 9.1); CWE-1321, CWE-20 (VERIFIED, GHSA-jf85-cpcp-j695) | Yes, if untrusted JSON reaches `defaultsDeep`. Impact is a property added to all objects in that process | **Chosen.** No code execution by itself; contained to one process |
| CVE-2021-23337 | lodash before 4.17.21, `_.template` command injection; NVD 7.2, privileges required high; standalone `lodash.template` package has no fixed version (UNVERIFIED, search summaries) | Only if an attacker controls the template string | Rejected: leads to code execution |
| CVE-2022-29078 | ejs 3.1.6 (fixed 3.1.7), template injection through `settings[view options]` when request data is passed to render; CVSS 9.8 per Tenable (UNVERIFIED, search summaries) | Yes, but only with `res.render(view, req.query)`-style code | Rejected as default: RCE |
| CVE-2022-24999 | qs before 6.10.3 (backports 6.9.7, 6.8.3, ...), Express before 4.17.3; denial of service via `__proto__` (UNVERIFIED) | Yes, crashes the process | Rejected: breaks the app |
| CVE-2023-26136 | tough-cookie before 4.1.3, prototype pollution with `rejectPublicSuffixes=false`; NVD 9.8 vs Snyk 6.5 (CONFLICTING) | Needs a client-side cookie jar in an unusual mode | Rejected: unnatural in a shop server |

**Tags.**
- CWE-1395 Dependency on Vulnerable Third-Party Component (VERIFIED); CWE-1321 Improperly Controlled Modification of Object Prototype Attributes ('Prototype Pollution') (VERIFIED).
- ATT&CK T1190 Exploit Public-Facing Application; T1592.002 Gather Victim Host Information: Software (reading the notices page); T1195.001 Compromise Software Dependencies and Development Tools is the supply-chain technique family used for the write-up only (we do not reproduce an attacker compromising a dependency). (names VERIFIED)
- WSTG: WSTG-INFO-08 Fingerprint Web Application Framework (closest; WSTG has no dependency-scanning test; ID by section order).
- OWASP: 2025 A03 Software Supply Chain Failures / 2021 A06.

**Hints.**
1. "The shop lists the open-source software it uses. Which parts of the import service look old?"
2. "One library has a public advisory about merging objects when a JSON key is named in a special way."
3. "Put a `constructor` key with a `prototype` object in your import options, setting the property that the preview response mentions as audit-only, then run the preview again."

**Fix.** Upgrade lodash to a fixed release (4.17.12 or later; use the current one), keep a lockfile and an SBOM, scan on every build and on a schedule (Dependabot, OSV-Scanner), validate JSON keys before merging and use a safe merge (reject `__proto__`, `constructor`, `prototype`), and create objects with `Object.create(null)` where needed. For the 2025 scope, add pinned lockfiles, provenance, delayed adoption of new package versions, and least-privilege CI.

**Automated verification test.** Upload a small CSV with the pollution options, assert `auditToken` equals the flag. Fixed-build test: same request returns `auditToken: null`. Add a build test that scans the image SBOM and expects exactly one known high-severity finding.

**Unintended-exploit risks and prevention.**
- Containment: the import service runs preview-only, has **no database credentials, no outbound network, read-only filesystem**, CPU and memory limits, a 5 second timeout, and **forks a fresh child process per job**, so the pollution dies with the job and cannot break later jobs or the main app.
- No code-execution gadget: do not use `child_process`, template engines (ejs, pug, handlebars) or dynamic `require` after merging untrusted data in that service; polluted `execArgv`, `shell` or template options are known gadget patterns. The parent process never merges user data.
- Keep lodash 4.17.11 only in the import service, not in the main app.
- Supply chain safety: vendor the pinned tarball in the repo and build with `npm ci` offline, so no registry fetch happens at runtime.
- Expect Dependabot or `npm audit` alerts on the repo. Document them as intentional (CI should not fail), or the team will "fix" the challenge by accident.
- Spike: confirm on the chosen Node version that this exact input pollutes lodash 4.17.11 (I verified the advisory, not the run).

**Realism references.** The CVE and fix versions are from the GitHub advisory GHSA-jf85-cpcp-j695 (VERIFIED). The 2025 scope examples: CISA alert of 23 September 2025 on the npm compromise ("Shai-Hulud", over 500 packages, with the earlier chalk/debug compromise of 8 September; counts differ across sources) (VERIFIED title and date by search, UNVERIFIED details). TalkTalk (ICO) also cited unsupported, unpatched software as a failing.

---

## 4. Decision candidates for the user

1. **Who carries stored XSS and the support-agent bot?** (A05 Injection covers both.)
   a) C03 = SQL injection only; XSS goes to another challenge or is dropped. b) C03 = stored XSS in reviews/disputes seen by the support bot, SQLi dropped. c) C03 has two sub-flags (SQLi and XSS). **Recommend (a)** for a clean, automatically verifiable C03; give the support-agent role to a C04/C09/C11 variant that RS-F or RS-G confirms.
2. **C06 vulnerable component design.** a) lodash 4.17.11 prototype pollution in an isolated import service; b) ejs RCE; c) another dependency. **Recommend (a)**, the only one that stays contained without extra sandboxing.
3. **C02 weakness.** a) predictable gift-card codes; b) cracking MD5 password hashes; c) hard-coded key. **Recommend (a)**, since (b) depends on another challenge's leak.
4. **Role rule for C05.** C05 is anonymous. a) accept it (roles are carried by other challenges); b) move the weak spot into the admin or finance console so a role carries it. **Recommend (a)**, otherwise it overlaps C07.
5. **C01 starting account.** a) seeded seller staff login in the brief; b) player must apply as a seller first. **Recommend (a)** to avoid depending on seller onboarding.
6. **State-change versus response detection for C02 and C04.** a) both (event plus flag text); b) flag text only. **Recommend (a)** (D-01 style).

## 5. Evidence

| URL | What it supports | Status |
|---|---|---|
| https://top10.owasp.org/2025 | A01 to A10 2025 titles used in the tags | VERIFIED |
| https://top10.owasp.org/2025/A03_2025-Software_Supply_Chain_Failures | A03 scope and mapped CWEs; CWE-477 vs 447 inconsistency | VERIFIED |
| https://github.com/advisories/GHSA-jf85-cpcp-j695 | CVE-2019-10744, affected below 4.17.12, CWE-1321, CWE-20, CVSS 9.1 | VERIFIED |
| https://cwe.mitre.org/data/definitions/639.html (also 862, 863, 327, 328, 330, 338, 799, 840, 841, 89, 209, 489, 497, 1188, 1321, 1395, 1104) | Exact CWE names used | VERIFIED (916 and 321 fetched, not used) |
| https://attack.mitre.org/techniques/T1190/ (also T1657, T1078, T1592/002, T1195/001, T1552, T1595/003, T1213) | Exact ATT&CK names; T1190 page shows ATT&CK v19.2, modified 12 May 2026 | VERIFIED |
| https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/07-Input_Validation_Testing/05-Testing_for_SQL_Injection | WSTG-INPV-05 | VERIFIED |
| https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/05-Authorization_Testing/ (also 02-Configuration..., 10-Business_Logic..., 09-Testing_for_Weak_Cryptography, 01-Information_Gathering, 08-Testing_for_Error_Handling) | Test titles; the pages print section numbers, so IDs come from order (CONF-05 = 4.2.5 etc.). The "stable" site redirects to v4.2; numbering in a newer edition may differ | VERIFIED titles, IDs UNVERIFIED |
| Search: lodash CVE-2021-23337, ejs CVE-2022-29078, qs CVE-2022-24999, tough-cookie CVE-2023-26136 (sentinelone, gitlab advisories, tenable, checkmarx, wiz, snyk summaries) | Candidate CVE versions and impact | UNVERIFIED (secondary) |
| Search: Optus 2022 (techrepublic.com, csoonline.com, cpomagazine.com, innovationaus.com) | C01 realism | UNVERIFIED |
| Search: Tesco/Hotels.com codes (infosecurity-magazine.com, theregister.com/2020/07/06/clubcard_miscreants/), retail gift cards (pymnts.com) | C02 realism | UNVERIFIED |
| Search: TalkTalk 2015 ICO fine (siliconrepublic.com, collascrill.com, bankinfosecurity.com) | C03 realism | UNVERIFIED |
| Search: refund caps (Clover community, Mercado Pago developer docs) | C04 evidence that caps are standard | UNVERIFIED |
| https://www.wiz.io/blog/spring-boot-actuator-misconfigurations ; trendmicro.com research "from misconfigured spring boot actuator to sharepoint exfiltration" | C05 realism | UNVERIFIED (summaries) |
| https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem | C06 2025 supply-chain incident | UNVERIFIED (search summary only) |

## 6. Open questions and spikes to run later

- Spike: build the import service with lodash 4.17.11 and confirm the pollution input works on the chosen Node version, that the per-job fork resets state, and that `npm ci` works from a vendored tarball.
- Spike: confirm the read-only catalog database setup stops stacked queries, file access and long sleeps (SQLite or PostgreSQL).
- Spike: check the flag-in-response matcher handles JSON escaping and gzip (if a flag contains characters that get escaped).
- Open: WSTG IDs should be re-checked against the exact WSTG edition the team cites.
- Open: C04 depends on the refund model (R-08). Exact limits (1,500 and 2,500) are placeholders.
- Open: CWE-1035, 1329, 1357 names were taken from OWASP's list, not read on cwe.mitre.org.
- Open: no public disclosure of the exact C04 pattern was found; treat realism as "pattern", not "incident".

### Cross-challenge conflicts to check
1. **C02 vs C04:** both touch money. Gift-card credit and refund credit must be non-spendable ledgers, never the same wallet balance.
2. **C03 vs C07, C01:** the catalog database must exclude users, tokens and orders, so a UNION cannot reveal credentials or other flags.
3. **C05 vs C07:** the diagnostics dump must not contain the JWT or session secret or any password. **C05 vs C03:** it must not contain database credentials.
4. **C05 vs C11:** C11 (A10 2025) must not reuse the verbose error handler; use fail-open logic instead. **C05 vs C06:** diagnostics shows no dependency versions.
5. **C01 vs C09:** C09 logging challenge should log (or fail to log) the cross-store reads from C01 in a way that does not reveal C01's flag.
6. **C06 vs C10 (SSRF):** the import service has no outbound network access, so it can never become the SSRF target or pivot. **C06 vs C08:** the import preview must not deserialize untrusted objects (no second path).
7. **C01 vs C06:** both use the seeded seller staff login; make sure import jobs are scoped per store.
8. **C04 vs C01/C07:** order data for the C04 victim order must be the player's own order and must not be readable through another challenge's flaw in a way that leaks the flag.
9. **Role rule (D-11):** C01 carries seller staff; C02 and C04 carry customer; C06 carries seller; C05 is anonymous; support agent, finance and admin are not yet carried by C01 to C06 (to be settled with RS-F and RS-G; see Decision 1).
10. **Seed data (RS-G):** needs a seeded Northwind order, gift card serial 1, a delivered order for the player, an `ops_notes` row and a diagnostics config entry, each linked to one instance flag.

## 7. Impact on other streams

- **RS-G (shop domain):** needs sequential order numbers, per-store order lines, gift cards and a non-spendable wallet/ledger, a refund entity with amount and cumulative state, seller bulk-import (preview) feature, a separate catalog database, and the seeded records listed above. Passwords must use strong hashing.
- **RS-B (isolation and monitor):** needs response-body flag matching by route and session, signed app events for state-change captures (C02, C04), a per-instance flag injection step, a no-network, read-only container profile for the import service, per-job fork, and resource limits.
- **RS-C (scoring):** difficulty suggestions: C01 = 2, C02 = 3, C03 = 2, C04 = 3, C05 = 2, C06 = 4.
- **RS-F (C07 to C11):** see conflicts 3 to 8. In particular avoid reusing the C05 error handler (C11), keep SSRF away from the import service (C10), and agree who carries stored XSS.
- **RS-D (platform):** the report needs both OWASP editions per challenge plus CWE, ATT&CK and WSTG tags as listed; dashboards should show the hint text and fix write-up per challenge.
- **RS-H (privacy):** seeded data is fake; no personal data in any seed.

File: C:\Users\tanma\major-project\docs\research\RS-E-challenges-01-06.md
