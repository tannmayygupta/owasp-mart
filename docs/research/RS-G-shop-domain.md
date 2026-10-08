# RS-G — Shop domain model, six roles, refunds, bots, seeding, shop stack
Status: DRAFT research, NOT confirmed by the user · Date: 2026-10-08

Method note: only the Stripe Connect refund/dispute page and the Playwright Docker page were read in full this session (VERIFIED). Everything else (platform structures, memory figures, library facts) comes from background knowledge and is marked UNVERIFIED. Treat numbers as estimates until the spikes in Section 6 are run.

## 1. Questions answered

### 1.1 Domain model (bounded)
Real marketplaces (Amazon, Etsy, Flipkart) and open-source platforms (Medusa, Saleor, Vendure, Bagisto, Sylius, OpenCart) share one core: users, products with variants, a cart, an order split per seller, payments, and fulfilment. Marketplace add-ons (Bagisto marketplace, Medusa marketplace recipes, Saleor channels) add: store, seller approval, product approval, commission, payout, refund and dispute. Juice Shop is the opposite: small, one shop, a few roles, many planted bugs. We take the Juice Shop size with the marketplace entities of the others.

**Entities (proposed, 20 tables).**

| Group | Entity | Key fields and relations |
|---|---|---|
| Identity | users | id, email, password hash, role (one of six), store_id (nullable; set for seller owner and staff), status |
| | addresses | user_id, text fields |
| Catalog | stores | owner_user_id, name, status, commission_rate_bp, created_at |
| | categories | name, parent_id |
| | products | store_id, category_id, title, description (HTML-ish, user-written), price_cents, stock, status, image_path |
| | reviews | product_id, user_id, rating, body (user-written), status (visible, reported, removed) |
| Buying | carts, cart_items | user_id, product_id, qty |
| | coupons | code, type, value, usage_limit, store_id (nullable) |
| | orders | customer_id, status, total_cents, coupon_id, shipping address snapshot |
| | order_items | order_id, product_id, store_id, unit_price_cents, qty, status, commission_cents |
| | payments (simulated) | order_id, method, status, amount, fake card last4 |
| Money out | commissions (ledger lines) | order_item_id, amount, rate |
| | payouts | store_id, period, gross, commission, refunds_deducted, net, status |
| After sale | refunds | order_item_id, amount, reason, status, requested_by, decided_by |
| | disputes | order_item_id, opened_by, reason, status, resolution, liable_party |
| | tickets, ticket_messages | requester_id, subject, status, body (user-written), assignee_id |
| | notifications | user_id, text (user-written content may leak in), read |
| Files | uploads | owner_id, store_id, path, mime, original_name |
| Audit | audit_log | actor_id, action, target (kept thin, on purpose; see C09) |

Cut for bounds: real KYC documents, shipping carriers, tax, multi-currency, variants, inventory reservations, wishlists. Store KYC is a text field plus "approved" flag.

**State machines (proposed).**

- Seller onboarding: `pending` -> `approved` | `rejected`; `approved` <-> `suspended`. Only admin moves it. Pending sellers can edit their profile but cannot publish.
- Product: `draft` -> `pending_review` -> `published` | `rejected`; `published` -> `unlisted`. Edit of a published product's title/price sends it back to `pending_review` (realistic; CS-Cart works this way, UNVERIFIED for exact setting).
- Checkout: `cart` -> `address` -> `payment_pending` -> `paid` | `payment_failed`. Order is created at `payment_pending`, flips to `paid` on the simulated payment result.
- Order fulfilment (per order item, since one order has many sellers): `paid` -> `processing` -> `shipped` -> `delivered` -> `completed` (after a return window, for example 7 days, simulated by an admin button or timer); `paid|processing` -> `cancelled`.
- Refund: `requested` -> `approved` | `rejected` -> `processed`. Approver: seller owner for own store up to a limit; support agent for disputes; admin always.
- Dispute: `open` -> `under_review` -> `resolved_customer` | `resolved_seller` | `escalated`; resolved by support agent; admin if escalated.
- Payout: `accrued` -> `ready` -> `approved_by_finance` -> `paid` | `held`. Finance approves; admin can hold.

### 1.2 Permission matrix
See table below. "Own store" means the user's store_id. Staff are a subset of owner rights. Last column is empty on purpose.

| Resource / action | Customer | Seller owner | Seller staff | Support agent | Finance | Admin | Challenge hook |
|---|---|---|---|---|---|---|---|
| Register / login / reset password | own | own | own (invited by owner) | seeded | seeded | seeded | |
| View catalog, search | all published | all + own drafts | all + own drafts | all | none needed | all | |
| Create / edit product | no | own store | own store (create/edit, no delete, no price change) | no | no | all | |
| Approve product | no | no | no | no | no | yes | |
| Cart, checkout, pay (simulated) | own | own (as customer) | no | no | no | no | |
| View order | own | own store's items only | own store's items only | any (read) | amounts only (no personal data) | all | |
| Update fulfilment status | no | own store | own store | no | no | all | |
| Cancel order | own, before shipped | own store items | no | yes | no | yes | |
| Request refund | own order | no | no | on behalf of customer | no | no | |
| Approve refund | no | own store, under limit | no | yes (any) | no (can see) | yes | |
| Open dispute | own order | no | no | on behalf | no | no | |
| Resolve dispute | no | respond only | no | yes | no | yes (escalated) | |
| Write review | own purchased | no | no | no | no | no | |
| Report / moderate review | report | report | report | remove/restore | no | yes | |
| Tickets | create own | create | create | view all, reply, assign | no | all | |
| Manage staff | no | own store | no | no | no | yes | |
| Approve seller | no | no | no | no | no | yes | |
| Manage coupons | no | own store | no | no | no | yes (global) | |
| View commissions / payouts | no | own store | no (default) | no | all | all | |
| Approve / hold payout | no | no | no | no | approve | hold, override | |
| Set commission rate | no | no | no | no | propose | set | |
| Uploads (product image, ticket attachment) | ticket | product images | product images | view | no | view all | |
| Manage users / roles | no | no | no | no | no | yes | |
| View audit log / system config | no | no | no | no | no | yes | |

Every role has some data or action unique to it, which supports the D-11 rule (each role carries a challenge). Role-to-challenge mapping is RS-E/RS-F work, not decided here.

### 1.3 Refunds and disputes
Real behavior (Stripe Connect, VERIFIED, see Section 5):
- Platform balance pays the refund and any dispute amount and fee. The platform can then recover money from the seller by reversing the transfer. It must act quickly after a chargeback or it carries the loss.
- Partial refund: the transfer is reversed in proportion. Example in the docs: US$100 payment, US$5 fee, US$40 refund returns US$2 of the fee (40%).
- Application fee (commission) is NOT returned by default; the platform chooses via `refund_application_fee`.
- Platform is ultimately liable for chargebacks; it can push the loss to the seller account balance (reserve, negative balance, debit).
- With separate charges and transfers, a refund does not touch the transfer; the platform must reconcile it itself.
- Shopify and Amazon: seller bears the refund cost; the platform may keep or refund its fee depending on policy and may hold payouts during disputes (UNVERIFIED, not read this session; fetch the Amazon "A-to-z Guarantee" and Shopify Payments chargeback pages before quoting).

**Proposed simple, correct model (integer cents, in basis points).**
1. Refund is always against one `order_item`. `refunded_total <= paid_for_item` is checked in a database transaction (prevents double refund, a real flaw pattern).
2. Refund of amount `r` on item with price `p`, commission `c`: seller_reversal = `r`; commission_reversal = `round(c * r / p)` (proportional, same as Stripe). Seller net effect = `-(r - commission_reversal)`.
3. Seller liability: refund approved by the seller or lost dispute -> the seller bears it. If the seller already got paid, the amount becomes a negative balance, deducted from the next payout.
4. Chargeback (simulated): a dispute type "bank_chargeback" injected by an admin or seed: platform pays full amount plus a flat fee; liable party is the seller unless support marks it platform error.
5. Payout formula: `net = sum(item_price) - sum(commission) - sum(refunds) + sum(commission_reversals) - sum(dispute_fees)`.
6. Idempotency key on every refund request; ledger rows are append-only (good for later logging challenges).

This is simple enough to implement in about 3 tables and still has real business-logic edges (rounding, partial, double submit, state skipping).

### 1.4 Bots (simulated users)
Needed: the support agent (views tickets, reported reviews), the admin (views pending product descriptions and seller profiles), and optionally a customer (views seller store pages).

| | Headless browser (Playwright/Puppeteer) | Lightweight HTTP bot |
|---|---|---|
| Runs JavaScript, so stored XSS really fires | yes | no (would need fake detection) |
| Realistic cookies, CSP, DOM sinks | yes | no |
| Cost | Chromium roughly 150-400 MB RAM while a page is open, plus CPU spikes (UNVERIFIED estimate; spike needed) | a few MB |
| Safety | needs sandbox care (see below) | trivial |
| Detects XSS execution | page callback or in-page hook | cannot truly; only string match (fake) |

Playwright docs (VERIFIED): its Docker image is "for testing and development only", should not visit untrusted sites by default; running as root disables the Chromium sandbox; for untrusted content run as non-root `pwuser` with a seccomp profile; `--ipc=host` is recommended to avoid crashes; `--init` avoids zombie processes.

**Placement.** Options: (a) one bot container inside each instance; (b) one shared bot service outside instances. Shared service is cheaper but would hold credentials to many instances and visits content that attackers wrote, so one learner's payload could try to reach another's. Inside-instance bot is simplest to isolate (same private network, no cross-user path) but costs memory per instance. Middle path (recommended): a **per-instance bot worker that is started on demand**: the browser launches only when a "bot visit" job is queued, visits, then closes (about 10 to 30 seconds), so idle cost is near zero. Run the browser container on the instance's internal network only with no internet egress, with a hostname allowlist (only the shop), and as non-root.

**Flags and bot.** The bot's cookie must be a normal session for a seeded agent/admin account, never containing a real platform secret. The "flag" for stored XSS should be something that exists only in the bot's session (for example a per-instance token in the bot's cookie or page, or an admin-only page the XSS must fetch). It is revealed only via what the payload sends out. The bot must not hold the platform API key.

**How the platform learns the bot saw a payload.** Two layers: (1) the shop records the bot visit (bot user, URL, time) in a table the monitor reads; (2) the payload-observed signal is a request the payload makes to a per-instance "collector" endpoint inside the instance (like XSS Hunter-style callback, kept inside the lab network) carrying the bot's session token; the monitor sees that token and credits the capture. This also verifies the learner really had code run in the bot's session, and the token in D-02 style is unique per instance. For CSRF-like business flows (bot clicks a link), the monitor checks the state change (for example an admin action row with the bot as actor).

### 1.5 Seeding, storage, stack

**Seeding.** Use a seeded fake-data generator (faker with a fixed seed per challenge-independent "world"), so catalog, users and orders are identical across instances, and only flags and secrets are injected per instance at startup from environment variables or a mounted file. Do not randomize the world per instance: it makes write-ups and automated verification impossible. Flags go into specific rows (an admin-only note, a hidden order field, a file path) by a small injector step.

| Approach | Startup | Pros | Cons |
|---|---|---|---|
| Script at every start (migrate + seed) | 1-5 s for a few hundred rows on SQLite (UNVERIFIED estimate) | transparent, easy to test, flags inserted trivially | slower for large data |
| Pre-built snapshot (seeded DB file baked in image), flags patched at start | under 1 s | fastest | flags and data must be patched; image rebuild when schema changes |
| Hybrid (recommended): seed script runs in CI to build a snapshot file; container copies it and runs a short "inject flags" script | about 1 s | best of both | two steps to maintain |

Budget proposal: shop container ready (health check ok) in under 10 s on the laptop; this is a spike.

**Storage per instance.**

| Option | Memory | Startup | SQLi realism | Notes |
|---|---|---|---|---|
| SQLite (file) | near 0 extra (in-process) | instant | good: UNION, boolean and error-based work; no stacked queries by default in most drivers; no `information_schema`, but `sqlite_master` | Juice Shop uses SQLite via Sequelize (UNVERIFIED, from memory), proven for this training use. Easy to snapshot by copying a file |
| PostgreSQL (container) | about 50-150 MB idle (UNVERIFIED) | 2-5 s | excellent: stacked queries, `pg_sleep`, `information_schema`, file functions if over-privileged | extra container per instance, matters at many instances |
| MySQL/MariaDB | 150-400 MB | 5-15 s | excellent and classic | heavy |

Recommend SQLite per instance: smallest cost, and realistic enough for the injection challenge. Caveat: the platform database is separate (PostgreSQL in the platform, D-stack), so the two do not need to match. Wrong if a challenge needs stacked queries, a DBA-level feature, or heavy concurrent writes.

**Shop stack options.**

| Option | Realism | Planting vulns safely | Container size / RAM (UNVERIFIED est.) | Claude Code productivity | Known-vulnerable libs ecosystem |
|---|---|---|---|---|---|
| Node.js + Express + ORM (Sequelize/Prisma/Knex) | high, matches the synopsis and Juice Shop | easy: raw query strings next to ORM calls, weak middleware | image about 150-250 MB on alpine; 80-150 MB RAM | very high | very large (npm advisories, old lodash, jsonwebtoken, serialize-javascript) |
| Node.js + Fastify/NestJS | NestJS more "enterprise" | more structure means more work to look sloppy | similar | high | same npm |
| Python (Flask/Django/FastAPI) + SQLAlchemy | high; Django ORM is safe by default so SQLi needs raw SQL | easy in Flask | image 100-200 MB slim; 60-120 MB RAM | very high | good (old PyYAML, Jinja2 SSTI, Pillow) |
| PHP (plain or Laravel/Symfony) | highest for classic bugs; DVWA world | easiest classic SQLi, file include, upload | Apache+PHP image about 200-450 MB; 50-150 MB | high | large (WordPress-style plugins, old Composer packages) |
| Java Spring | enterprise realism; WebGoat world | harder | large (300+ MB, 300+ MB RAM) | good | strong (Log4Shell, Struts) |

Recommendation: **Node.js 22 LTS + Express 4 (plain) + SQLite via better-sqlite3 with a thin query layer (some parameterised, some string-built), server-rendered with EJS or Nunjucks**, independent of the platform stack (FastAPI). Reasons: lowest memory and size, Claude Code writes it fast, matches the synopsis "Node/Express or equivalent", Juice Shop and many labs prove the pattern, and an old-package supply-chain challenge is natural (pin a known-vulnerable npm package; verify the specific CVE in RS-E/F). Because the shop talks to the platform only through the monitor and env vars, the shop stack is swappable.

### 1.6 Frontend
| | Server-rendered (EJS/Nunjucks + a little JS) | SPA (React/Angular, JSON API) |
|---|---|---|
| XSS types | stored and reflected in HTML, attribute and script contexts; classic realistic | DOM-based and `dangerouslySetInnerHTML`; reflected/stored in HTML less natural (frameworks escape by default) |
| Bot needed | yes, same | yes, same |
| Realism | like Amazon, Etsy, OpenCart, Bagisto | like Juice Shop (Angular), modern shops |
| Cost | tiny, one container, easy view-source for learners | build step, larger image, more things to break |
| Pentest tooling | works well with Burp/ZAP crawl | needs API and JS analysis; ZAP spider weaker |
| Claude Code speed | high | high, more files |

Recommend server-rendered with light progressive JavaScript (forms, a few fetch calls for cart). It gives all three XSS flavours (stored, reflected, DOM through a small client script) with the least cost, and a clean path to later API-security scope (O6) by exposing a JSON API next to HTML pages. Theme: a clean, believable "everyday marketplace" look (neutral palette, product grid, seller badges, order timeline), not a hacker theme. Visual style choice is the user's; a design pass can use the UI/UX skill later.

## 2. Options compared

| Option | Fit with our constraints | Free-tier / cost | Complexity | Main risks | Evidence |
|---|---|---|---|---|---|
| Shop stack: Node + Express + SQLite + SSR | best: small, fast, per-instance | free, ~100-150 MB RAM per instance (UNVERIFIED) | low | npm supply chain noise in our own build; SQLite SQLi limits | Playwright/Stripe pages do not cover; background knowledge |
| Shop stack: Python Flask | good | free, similar | low | slightly fewer classic Node-style challenges | UNVERIFIED |
| Shop stack: PHP | good for classic bugs | free, heavier images | low-medium | different from synopsis; less like modern shops | UNVERIFIED |
| DB: SQLite | best | none | lowest | not full SQL feature set | UNVERIFIED |
| DB: PostgreSQL per instance | good realism | +50-150 MB per instance | medium | memory at scale | UNVERIFIED |
| Bot: on-demand browser per instance, no egress | good | CPU/RAM only during visit | medium | memory spikes with many instances | Playwright Docker docs |
| Bot: shared service | cheaper at scale | one container | medium | cross-instance leakage, big blast radius | reasoning |
| Bot: HTTP-only | cheapest | tiny | low | cannot verify real XSS | reasoning |
| Frontend: SSR | best | tiny | low | less "modern" | reasoning |
| Frontend: SPA | okay | bigger | medium | harder to crawl, XSS mostly DOM | reasoning |
| Refund model: proportional reversal, seller liable | matches Stripe | none | medium | rounding bugs (also a feature) | Stripe refunds page |

## 3. Recommendation
- Shop = Node.js 22 + Express + better-sqlite3, server-rendered, about 20 tables as in 1.1, deterministic seed + per-instance flag injector, snapshot built in CI.
- Six roles per the matrix; seller staff scoped by `store_id` on every query (and deliberately missed in some places for challenges).
- Refund and payout model from 1.3 (per order item, proportional commission reversal, seller liability, append-only ledger).
- Bots: on-demand headless Chromium (Playwright) per instance, non-root, internal network only, one job queue entry per visit; detection by a collector token plus a visit log.

This would be wrong if: (a) memory per instance with Chromium is too high for the laptop (then share one bot browser per host with strict per-visit fresh contexts, or limit XSS verification to fewer scenarios); (b) a challenge requires stacked-query SQLi or file-read SQL features (then use PostgreSQL for that instance); (c) the team prefers Python or PHP; the shop stack is independent so this switch is cheap before coding starts.

## 4. Decision candidates for the user

1. **Shop stack.** (a) Node + Express (recommended), (b) Python Flask, (c) PHP. Reason: lowest footprint, matches synopsis, best Claude Code speed.
2. **Shop database per instance.** (a) SQLite (recommended), (b) PostgreSQL container, (c) decide per challenge. Reason: tiny and realistic enough.
3. **Frontend style.** (a) Server-rendered with light JS (recommended), (b) SPA (React), (c) hybrid with JSON API now. Reason: richer XSS types, cheaper, easier crawling.
4. **Bot design.** (a) On-demand headless browser inside each instance, no internet (recommended), (b) one shared bot service, (c) HTTP-only bot. Reason: real JavaScript execution with the smallest blast radius.
5. **Refund liability model.** (a) Seller bears refunds and chargebacks, commission reversed in proportion (recommended), (b) platform bears all, (c) seller bears refunds only. Reason: mirrors Stripe Connect behavior.
6. **Seeding.** (a) Hybrid: CI-built snapshot + flag injector at start (recommended), (b) script at every start, (c) snapshot only. Reason: fast and still unique flags.
7. **Scope of the model.** (a) The 20-table bounded model (recommended), (b) smaller (no disputes or tickets), (c) larger (variants, shipping). Reason: disputes and tickets feed Support and Finance roles.
8. **Visual theme.** (a) Neutral everyday marketplace (recommended), (b) playful brand like Juice Shop, (c) dark "hacker" look. Reason: the synopsis wants it to look like a real product.

## 5. Evidence

| URL | What it supports | Status |
|---|---|---|
| https://docs.stripe.com/connect/marketplace/tasks/refunds-disputes | Platform pays refunds and disputes; transfer reversal; proportional partial refunds; application fee refund option; platform ultimately liable; negative balances and reserves | VERIFIED (fetched 2026-10-08) |
| https://playwright.dev/docs/docker | `--init`, `--ipc=host`, non-root and seccomp for untrusted sites, dev/test purpose | VERIFIED (fetched 2026-10-08) |
| https://docs.stripe.com/connect/separate-charges-and-transfers | Page index only was returned; no content used | not read in detail |
| Medusa, Saleor, Vendure, Bagisto, Sylius, OpenCart docs; Juice Shop (SQLite, Sequelize, Angular) | Domain structure and stack comparison | UNVERIFIED (background knowledge; not fetched) |
| Shopify and Amazon refund/chargeback policies | Seller bears cost; fee handling; payout holds | UNVERIFIED (not fetched) |
| Memory/startup figures for Chromium, SQLite, Postgres, images | Resource estimates | UNVERIFIED (spikes needed) |

## 6. Open questions and spikes to run later
- Spike: RAM and time of one Playwright Chromium visit inside a 1 CPU / 512 MB container; how many concurrent bot visits fit on the laptop.
- Spike: shop container cold start with the hybrid seed; target under 10 s; image size.
- Spike: confirm SQLi techniques available on better-sqlite3 (UNION, blind, error) and whether stacked queries can be enabled.
- Read Shopify Payments chargeback and Amazon A-to-z Guarantee pages before the report quotes them.
- Verify how Medusa/Saleor/Vendure/Bagisto model multi-vendor orders and payouts before the report cites them.
- Decide how the bot's session "flag" appears so it is unique per instance (D-02) and checked by the monitor.
- Bot behavior details: schedule (on event vs poll), how many pages visited, timeouts.
- Which challenge each role carries is RS-E/RS-F.
- The "challenge hook" column stays empty until then.

## 7. Impact on other streams
- RS-B (isolation, monitor): bot container needs no egress and an internal collector endpoint; monitor reads the bot-visit and collector tables; flag injector runs at start.
- RS-A (hosting, capacity): add Chromium bursts to per-instance memory; bot is on-demand, not always on.
- RS-D (platform stack): none required; shop stack independent of FastAPI; contract is env vars, health check and monitor events.
- RS-E / RS-F (challenges): matrix and state machines supply hooks (store-scoped queries for access control, refund and payout logic for design flaws, ticket and review content for XSS, uploads for misconfiguration or SSRF, image import by URL).
- RS-C (scoring): "time taken" can use first request to instance and the capture event; bot visits delay XSS capture by seconds.
- RS-H (privacy): shop data is fictional and seeded; no real personal data enters seed files; audit_log of the shop is separate from the platform audit log.
