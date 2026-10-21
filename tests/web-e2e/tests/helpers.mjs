// Shared pieces of the browser tests: a page that fails on Content-Security-Policy violations and uncaught page errors, the hooks of the test API, sign-up and sign-in.
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base } from '@playwright/test';

const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 3100}`;
const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 18080}`;
export const PASSWORD = 'correct horse battery staple'; // the local test accounts of the test API only

export const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('console', (m) => { if (/Content Security Policy|Refused to (apply|execute|load)/i.test(m.text())) problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('dialog', (d) => void d.accept(d.type() === 'prompt' ? 'Reason typed in the browser test' : undefined)); // every confirm is answered yes, every prompt with a reason
    await use(page);
    expect(problems, 'no CSP violation and no uncaught error on any page').toEqual([]);
  },
});
export { expect };

/** A screenshot for the evidence folder when E2E_SHOTS_DIR is set (docs/assets/<slug>/); otherwise nothing. */
export async function shot(page, name) {
  if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/${name}.png`, fullPage: true });
}

export async function seed() {
  const r = await fetch(`${API}/_e2e/seed`);
  return r.json();
}

/** A hook of the test API (never reachable through the dashboards' proxy). */
export async function hook(path, { method = 'GET' } = {}) {
  const r = await fetch(`${API}/_e2e/${path}`, { method });
  if (!r.ok) throw new Error(`hook ${path}: ${r.status}`);
  return r.json();
}

export async function signUpAndVerify(page, { name, email, password = PASSWORD }) {
  await page.goto('/signup');
  await page.getByLabel('Name shown on your dashboard').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('I am 18 or over.').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('signup-sent')).toBeVisible();
  const { token } = await hook(`mail?to=${encodeURIComponent(email)}`);
  await page.goto(`/verify-email?token=${token}`);
  await expect(page.getByTestId('verified')).toBeVisible();
}

export async function logIn(page, { email, password = PASSWORD, next }) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** The attempts and instance of the signed-in user, read through the page's own session. */
export async function myAttempts(page) {
  return page.evaluate(async () => (await (await fetch('/api/v1/me/attempts')).json()).items);
}
export async function instanceOf(page, attemptId) {
  return page.evaluate(async (id) => (await (await fetch(`/api/v1/attempts/${id}`)).json()).instance_id, attemptId);
}

/** What a player's requests would give the lab, then the flag of one challenge (made from the test API's random keys, never a real flag). */
export async function captureFlag(page, attemptId, key) {
  const iid = await instanceOf(page, attemptId);
  await hook(`play?instance_id=${iid}`, { method: 'POST' });
  return (await hook(`flag?instance_id=${iid}&challenge_key=${key}`)).flag;
}

/** The recruiter of the seeded company releases a candidate's results: signed in through the sign-in page in a browser context of their own, then the release call. */
export async function release(browser, attemptId, recruiterEmail) {
  const ctx = await browser.newContext({ baseURL: WEB });
  const page = await ctx.newPage();
  await logIn(page, { email: recruiterEmail });
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('link', { name: 'Your candidates' })).toBeVisible();
  const status = await page.evaluate(async (id) => {
    const session = await (await fetch('/api/v1/session')).json();
    const r = await fetch(`/api/v1/attempts/${id}/release`, { method: 'POST', headers: { 'x-csrf-token': session.csrf_token, 'content-type': 'application/json' } });
    return r.status;
  }, attemptId);
  expect(status, 'the recruiter releases the results').toBe(200);
  await ctx.close();
}

/** A candidate follows the invite link, signs in and accepts: returns the attempt id. */
export async function acceptInvite(page, token, email) {
  await page.goto(`/invite?token=${token}`);
  await expect(page.getByTestId('invite-summary')).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/invite/);
  await page.getByRole('button', { name: 'Accept the invitation' }).click();
  await expect(page).toHaveURL(/\/assessment\/a-/);
  return page.url().split('/assessment/')[1];
}

/** Consent (never pre-ticked): the attempt is then ready, no instance yet. */
export async function consent(page) {
  const start = page.getByRole('button', { name: 'Start', exact: true });
  await expect(page.getByTestId('consent')).toBeVisible();
  await expect(start).toBeDisabled();
  await page.getByTestId('consent-agree').check();
  await start.click();
  await expect(page.getByTestId('attempt-state')).toHaveText('ready');
}

/** Consent, Start, and wait for the running attempt. */
export async function consentAndStart(page) {
  await consent(page);
  await page.getByTestId('start-assessment').click();
  await expect(page.getByTestId('attempt-state')).toHaveText('running', { timeout: 45_000 });
}

/** Sign in as a seeded admin: the password step, then the current code of the test API's authenticator (a seeded secret that exists in the runner only). */
export async function adminLogIn(page, email) {
  await logIn(page, { email });
  await expect(page.getByLabel('Code')).toBeVisible();
  const { code } = await hook(`totp?email=${encodeURIComponent(email)}`);
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: /sign in|verify|continue/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** The accessibility check (OI-30): axe-core with the WCAG 2.0, 2.1 and 2.2 A and AA rules on the page as drawn now. Any violation fails the test and names the rule and the nodes. */
export async function checkAccessible(page, name) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const lines = result.violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(lines, `accessibility violations on ${name}`).toEqual([]);
}
