// A learner works through the practice shop in a real browser, by what the pages offer: menus, links, forms and buttons. Nothing here types an address that a page does not
// lead to, except where the challenge itself says so (a changed order number, a changed request). Every test is one challenge; the page scripts are the real ones.
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';

const CUSTOMER = ['player.customer@vulnmart.test', 'player-customer-demo-b2'];
const HARBOR_OWNER = ['owner.harbor@vulnmart.test', 'vulnmart-seed-demo'];
const HARBOR_STAFF = ['staff.harbor@vulnmart.test', 'harbor-staff-demo-a1'];

async function logIn(page, [email, password]) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/shop/);
}

test('C01: Orders lists the store\'s orders by number, an order opens, and the next numbers are one change away', async ({ page }) => {
  await logIn(page, HARBOR_STAFF);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Orders' }).click();
  const first = page.locator('table a[href^="/seller/orders/VM-"]').first();
  await expect(first).toBeVisible();
  const [mine] = (await first.getAttribute('href')).match(/VM-\d+/);
  const calls = [];
  page.on('request', (r) => { if (r.url().includes('/api/seller/orders/')) calls.push(r.url()); });
  await first.click();
  await expect(page.locator('#order-body')).toBeVisible();
  expect(calls.some((u) => u.endsWith(`/api/seller/orders/${mine}`)), 'the page asks the order API for the order').toBe(true);
  // the numbers run in sequence: the next one belongs to somebody else (the competitor)
  await page.goto('/seller/orders/VM-100777');
  await expect(page.locator('#order-note')).toHaveText('C01-FLAG-IN-THE-NOTE');
});

test('C02: a new customer signs up, finds Gift cards, buys two cards, sees how the codes are made and redeems the forged code of card 1', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Email').fill('learner.c02@example.test');
  await page.getByLabel('Password').fill('a-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/shop/);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Gift cards' }).click();
  await page.getByRole('button', { name: 'Buy gift card' }).click();
  await expect(page.locator('#receipts li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Buy gift card' }).click();
  await expect(page.locator('#receipts li')).toHaveCount(2);
  const codes = await page.locator('#receipts li code').allTextContents();
  const serials = (await page.locator('#receipts li b').allTextContents()).map((t) => Number(t.replace('Card ', '')));
  const md5 = (n) => `VM-${createHash('md5').update(String(n)).digest('hex').slice(0, 12)}`;
  expect(codes[0], 'the code is the first 12 hex of the MD5 of the serial').toBe(md5(serials[0]));
  await page.getByLabel('Gift card code').fill(md5(1));
  await page.getByRole('button', { name: 'Redeem' }).click();
  await expect(page.locator('#wallet-msg')).toContainText('C02-FLAG-IN-THE-CARD');
});

test('C03 A: the search box shows the database error for a quote and returns the notes table for a UNION', async ({ page }) => {
  await page.goto('/shop');
  await page.getByLabel('Search products').fill("'");
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('alert')).toContainText('Search failed');
  await page.getByLabel('Search products').fill("zzz' UNION SELECT id,body,0,'notes' FROM ops_notes--");
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.locator('.grid')).toContainText('C03A-FLAG-MARKER');
});

test('C03 B: a customer finds Support and the listener page', async ({ page }) => {
  await logIn(page, CUSTOMER);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Support' }).click();
  await expect(page).toHaveURL(/\/tickets/);
  await page.goto('/lab/listener');
  await expect(page.locator('body')).toContainText(/listener|collector/i);
});

test('C04: the order page has the quick refund and the statement; two refunds under the limit break the total and show the goodwill line', async ({ page }) => {
  await logIn(page, CUSTOMER);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Orders' }).click();
  await page.locator('table a[href^="/orders/"]').first().click();
  await expect(page.locator('#statement')).toContainText('Refunded so far');
  for (let i = 0; i < 2; i += 1) {
    await page.getByLabel('Refund amount in cents').fill('1500');
    await page.getByRole('button', { name: 'Refund now' }).click();
    await expect(page.locator('#refund-msg')).toContainText('Refunded');
  }
  await expect(page.locator('#statement')).toContainText('Goodwill adjustment');
});

test('C05: adding to the cart sends a request to /api/cart; a damaged copy of it answers with a trace that names the ops area, and the page it names is open', async ({ page }) => {
  await logIn(page, CUSTOMER);
  await page.goto('/product/1');
  const preview = page.waitForRequest((r) => r.url().endsWith('/api/cart') && r.method() === 'POST');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await preview;
  const broken = await page.request.post('/api/cart', { data: Buffer.from('{"items": ['), headers: { 'content-type': 'application/json' } });
  expect(await broken.text()).toContain('_ops');
  const ops = await page.request.get('/_ops/diagnostics');
  expect(await ops.text()).toContain('support_bridge_token');
});

test('C06: the seller dashboard leads to the bulk import preview', async ({ page }) => {
  await logIn(page, HARBOR_OWNER);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Seller' }).click();
  await page.getByRole('link', { name: 'Bulk import preview' }).click();
  await expect(page.getByLabel(/Advanced options/)).toBeVisible();
});

test('C07: Log in leads to Forgot your password, the Contact page names the finance mailbox, and a wrong code is refused', async ({ page }) => {
  await page.goto('/contact');
  await expect(page.locator('main')).toContainText('finance.ops@vulnmart.test');
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await page.getByLabel('Email', { exact: true }).fill('finance.ops@vulnmart.test');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page.locator('#reset-confirm')).toBeVisible();
  await page.getByLabel('Code from the email').fill('0000');
  await page.getByLabel('New password').fill('another-long-password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('#reset-msg')).toContainText('invalid or expired');
});

test('C08: the cart offers PayGate, and the pay page waits for the provider and names the webhook', async ({ page }) => {
  await logIn(page, CUSTOMER);
  await page.goto('/product/1');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page).toHaveURL(/\/cart/);
  await page.getByLabel('Address line 1').fill('1 Test Street');
  await page.getByLabel('City').fill('Testville');
  await page.getByLabel('Country').fill('Landia');
  await page.getByLabel('Card number (simulated)').fill('4242424242424242');
  await page.getByRole('button', { name: /Pay with PayGate/ }).click();
  await expect(page.getByRole('heading', { name: /Waiting for the payment provider/ })).toBeVisible();
  await expect(page.locator('main')).toContainText('/webhooks/payments');
});

test('C09: the footer leads to the mobile app page that names the old login route, and Contact names the support agent', async ({ page }) => {
  await page.goto('/shop');
  await page.getByRole('link', { name: 'Mobile app' }).click();
  await expect(page.locator('main')).toContainText('/m/api/v1/login');
  await page.getByRole('link', { name: 'Contact us' }).click();
  await expect(page.locator('main')).toContainText('s.iyer@vulnmart.test');
});

test('C10: the seller dashboard has Import a product image from a URL, and it answers', async ({ page }) => {
  await logIn(page, HARBOR_OWNER);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Seller' }).click();
  await page.getByLabel('Image URL').fill('http://169.254.169.254/latest/meta-data/');
  await page.getByRole('button', { name: 'Import image' }).click();
  await expect(page.locator('#import-result')).toBeVisible();
});

test('C11: a new customer finds Sell with us and the store form asks for a tax id', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Email').fill('future.seller@example.test');
  await page.getByLabel('Password').fill('a-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sell with us' }).click();
  await page.getByLabel('Store name').fill('Learner Goods');
  await page.getByLabel('Tax id').fill('29ABCDE1234F1Z5');
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.locator('main')).toContainText(/Store registration|Registration/);
});
