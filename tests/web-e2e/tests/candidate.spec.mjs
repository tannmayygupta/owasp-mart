// A candidate on a company assessment: invite, account, consent, start, countdown and warnings, hints only when allowed, flag, submit, results hidden until the recruiter
// releases them, withdraw and undo, a closed invite, and the practice lab never showing the assessment.
import { captureFlag, expect, hook, logIn, myAttempts, release, seed, shot, test } from './helpers.mjs';

async function acceptInvite(page, token, email) {
  await page.goto(`/invite?token=${token}`);
  await expect(page.getByTestId('invite-summary')).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/invite/);
  await page.getByRole('button', { name: 'Accept the invitation' }).click();
  await expect(page).toHaveURL(/\/assessment\/a-/);
  return page.url().split('/assessment/')[1];
}

async function consentAndStart(page) {
  const start = page.getByRole('button', { name: 'Start', exact: true });
  await expect(page.getByTestId('consent')).toBeVisible();
  await shot(page, 'candidate-1-consent');
  await expect(start).toBeDisabled(); // never pre-ticked
  await page.getByTestId('consent-agree').check();
  await start.click();
  await page.getByTestId('start-assessment').click();
  await expect(page.getByTestId('attempt-state')).toHaveText('running', { timeout: 45_000 });
}

test('a closed invite says so', async ({ page }) => {
  const s = await seed();
  await page.goto(`/invite?token=${s.tokens.closed}`);
  await expect(page.getByText('The company cancelled this invite.')).toBeVisible();
});

test('candidate with results released by the recruiter: invite, consent, start, warning, flag, submit, hidden, release, shown', async ({ page, browser }) => {
  const s = await seed();
  const email = s.candidates.release;
  const attemptId = await acceptInvite(page, s.tokens.release, email);
  await expect(page.getByRole('heading', { name: 'Release assessment' })).toBeVisible();
  await consentAndStart(page);

  // an assessment is never the practice lab: the same account's dashboard offers its own practice start and only links to the assessment
  const board = page.getByTestId('attempt-board');
  await expect(board).toHaveAttribute('data-mode', 'candidate');
  await page.goto('/dashboard');
  await shot(page, 'candidate-dashboard-note');
  await expect(page.getByTestId('practice')).toContainText('Start my lab');
  await expect(page.getByTestId('practice').getByTestId('attempt-board')).toHaveCount(0);
  await expect(page.getByTestId('assessment-note')).toBeVisible();
  await page.goto(`/assessment/${attemptId}`);

  // the countdown is the server's: 30 minutes; moving the server's clock 16 minutes brings the 15-minute warning
  await expect(page.getByTestId('time-left')).toContainText(/(29|30):\d\d|0?:?(29|30)/);
  await expect(page.getByTestId('time-warning')).toHaveCount(0);
  await hook('advance?seconds=960', { method: 'POST' });
  await page.reload();
  await expect(page.getByTestId('time-warning')).toContainText('15 minutes left');
  await shot(page, 'candidate-2-running-warning');

  // the page follows the ATTEMPT: its `hints_enabled` is false for every company attempt today (the API's placeholder, apps/api/src/vulnmart/lab/api.py hints_enabled), so
  // no hint control is drawn even though the template says hints on; when the API starts reading the template this assertion must change to the unlock flow
  const row = page.locator('tr[data-challenge="C01"]');
  await expect(row.getByTestId('no-hints')).toHaveText('off');
  await expect(row.getByRole('button', { name: 'Hints' })).toHaveCount(0);
  // flag, then submit
  const flag = await captureFlag(page, attemptId, 'C01');
  await row.getByLabel('Flag for C01').fill(flag);
  await row.getByRole('button', { name: 'Check' }).click();
  await expect(page.locator('p.banner.ok')).toContainText('C01: correct'); // the answer to the paste; what it earned stays hidden until the release
  await page.getByTestId('submit-attempt').click();
  await expect(page.getByTestId('attempt-state')).toHaveText('submitted');

  // results hidden until the recruiter releases them: no score anywhere, only the notice
  await expect(page.getByTestId('results-later')).toBeVisible();
  await expect(page.getByTestId('score')).toHaveCount(0);
  await shot(page, 'candidate-3-submitted-results-hidden');
  await page.reload();
  await expect(page.getByTestId('results-later')).toBeVisible();
  await expect(page.getByTestId('score')).toHaveCount(0);

  await release(browser, attemptId, s.recruiter_email);
  await page.reload();
  await expect(page.getByTestId('score')).toBeVisible();
  await expect(page.getByTestId('results-later')).toHaveCount(0);
  await shot(page, 'candidate-4-results-released');
  expect((await myAttempts(page)).find((a) => a.attempt_id === attemptId).mode).toBe('candidate');
});

test('candidate with hints off: no hint buttons; withdraw, then undo the withdrawal', async ({ page }) => {
  const s = await seed();
  const attemptId = await acceptInvite(page, s.tokens.submit, s.candidates.submit);
  await consentAndStart(page);
  const row = page.locator('tr[data-challenge="C01"]');
  await expect(row.getByTestId('no-hints')).toHaveText('off');
  await expect(row.getByRole('button', { name: 'Hints' })).toHaveCount(0);

  await page.getByTestId('withdraw').click();
  await expect(page.getByTestId('attempt-state')).toHaveText('withdrawn');
  await expect(page.getByTestId('withdrawn-note')).toContainText('undo');
  await page.getByTestId('undo-withdraw').click();
  await expect(page.getByText('Your withdrawal is undone')).toBeVisible();
  await expect(page.getByTestId('undo-withdraw')).toHaveCount(0);
  await expect(page.getByTestId('withdrawn-note')).toContainText('kept the record');
});

test('a practice run is never drawn on the assessment page and an assessment never on the practice page', async ({ page }) => {
  const email = `mode-${Date.now()}@e2e.example`;
  const { signUpAndVerify } = await import('./helpers.mjs');
  await signUpAndVerify(page, { name: 'Mode Learner', email });
  await logIn(page, { email });
  await page.getByRole('button', { name: 'Start my lab' }).click();
  await expect(page.getByTestId('stage-item')).toBeVisible({ timeout: 45_000 });
  const [run] = await myAttempts(page);
  await page.goto(`/assessment/${run.attempt_id}`);
  await expect(page.getByText('This assessment is not one of yours')).toBeVisible();
  await expect(page.getByTestId('attempt-board')).toHaveCount(0);
});