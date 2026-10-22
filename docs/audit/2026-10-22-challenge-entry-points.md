# Audit: can a learner reach every challenge from the shop's pages? (2026-10-22)

Question from the leader: is the practice shop vulnerable enough, and does a learner who only uses the shop find each weakness and get the flag, challenge by challenge?

## Method
For each of the 11 challenges: the brief, the start state and the three hints (`challenges/catalog/cNN.yaml`) against what the shop's pages offer (menus, links, forms, the requests the page makes), then a walk through the pages in a real browser. The 40 exploit tests of `challenges/tests` were already green: they prove a weakness works when its route is called, not that a person can find the route. The finding below is about the second.

## Result before this change: the weaknesses worked, most were unreachable from the pages
| Challenge | What the learner was told | What the shop offered | Verdict |
|---|---|---|---|
| C01 Broken Access Control | "look at how one order is identified when you open it" | no order list, no order number, no order page for a seller; the vulnerable `/api/seller/orders/{no}` was called by nothing | blocked |
| C02 Cryptographic Failures | "look at your two gift-card codes"; "register your own account" | no gift cards anywhere in the pages; no customer sign-up | blocked |
| C03 A Injection (search) | "what happens when the search text contains a quote?" | the search box used the safe listing; the injectable search was an API nothing called; an SQL error was swallowed | blocked |
| C03 B Injection (stored XSS) | Support and the Listener page | present | reachable |
| C04 Insecure Design | "refund your delivered order, then look at what is still refundable" | only the ordinary refund request; the quick-refund route and the refund statement had no page | blocked |
| C05 Security Misconfiguration | "break something on purpose" | the verbose error exists only on `POST /api/cart`, which no page called | blocked |
| C06 Supply chain | seller owner, bulk import preview | present | reachable |
| C07 Authentication Failures | "the finance address is on the public Contact page; the shop's password reset does the rest" | no Contact page, no forgot-password link or page; the settlement page had no menu entry | blocked |
| C08 Integrity Failures | "go as far as the Pay step"; "find the endpoint the provider calls" | checkout paid at once; the pending-payment flow had no page | blocked |
| C09 Logging Failures | "the shop also has a phone-app API"; "the dormant support agent" | nothing mentioned the mobile route or the agent; the case-notes page had no menu entry | blocked |
| C10 SSRF | "the product editor's Import image from URL" | no such form; the route had no page | blocked |
| C11 Exceptional Conditions | "create a new customer account, then register a store" | no customer sign-up; the store form posted to a different (safe) route without the tax id | blocked |

Two causes: the challenge routes were built as API adapters first, and the pages were never extended to expose them; and several start states describe pages that did not exist (sign-up, Contact, Gift cards, Import image).

## What was built (shop only; the weakness code and the exploit tests are unchanged)
- Customer sign-up (`/register`) and "Sell with us" in the menu (C02, C11).
- Gift cards page (`/wallet`): buy a card and get its serial and code on a receipt, redeem a code, see the promo credit (C02).
- Seller Orders list and order page (`/seller/orders`, `/seller/orders/{no}`); the page asks the order API by number, visible in the Network panel. The instance placement adds the neighbouring orders so the numbers run in sequence as hint 2 says (C01).
- The shop's search box now goes through the catalogue search; an SQL error shows as "Search failed: ..." (C03 A). The fixed build's search escapes LIKE wildcards, as the shop's own listing did.
- Order page: Quick refund and Refund statement (C04).
- Product page: the add-to-cart preview calls `/api/cart` (C05).
- Cart: "Pay with PayGate instead" and a pay page that waits for the provider and names the webhook (C08).
- Login: "Forgot your password?" and a reset page; Contact page with the finance mailbox and the support agent; footer links Contact and Mobile app; the Mobile app page names the version 1 login route (C07, C09).
- Seller dashboard: Orders link and an "Import a product image from a URL" form (C01, C10); the store registration form sends the tax id to the KYC route (C11); menu entries for Case notes (support) and Settlement (finance) (C09, C07).
- Shop theme styles for notes and lists; one page script, `/assets/shop.js`.

## Tests (real results)
- `apps/shop/test/challenge-entry-points.test.mjs`: 13 of 13, walking the vulnerable build by links and forms only.
- Browser walkthrough `tests/web-e2e/shop/shop-walkthrough.spec.mjs` (Playwright, installed Chrome, the shop on a seeded database): 12 of 12 — one test per challenge, using the page scripts.
- `challenges/tests/*` exploit tests: 40 of 40 (unchanged and still passing).

## What this does not prove
- C03 B (the bot), C06 (the import service) and C10 (the metadata mock) need the live instance's other containers; the walkthrough checks their entry points, not their end. The live exploit suite (`scripts/e2e-live-exploits.mjs`) covers them and needs two confirmed accounts.
- That a learner solves a challenge inside its countdown: the hints and the pages are now consistent, but human solve times are not measured.
- The browser walkthrough is run by hand (not in CI); the HTML-level test is.
