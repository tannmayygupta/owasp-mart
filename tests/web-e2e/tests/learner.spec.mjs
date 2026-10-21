// A learner on the deployed lab's SEQUENCED run: sign up, confirm, sign in, start, begin one challenge at a time, hint, flag, next, the countdown ending a challenge, a new run.
import { captureFlag, expect, hook, instanceOf, logIn, myAttempts, shot, signUpAndVerify, test } from './helpers.mjs';

test('sign up, confirm the email, sign in and sign out', async ({ page }) => {
  const email = `auth-${Date.now()}@e2e.example`;
  await signUpAndVerify(page, { name: 'Auth Learner', email });
  await logIn(page, { email });
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('heading', { name: 'Hello, Auth Learner' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await logIn(page, { email, password: 'a wrong password entirely' });
  await expect(page.locator('p.banner.bad')).toContainText('do not match');
});

test('learner: start, begin, hint, flag, next, time runs out, finish, new run', async ({ page }) => {
  const email = `learner-${Date.now()}@e2e.example`;
  await signUpAndVerify(page, { name: 'Seq Learner', email });
  await logIn(page, { email });
  await expect(page).toHaveURL(/\/dashboard/);

  // before a run: only a count, no list of challenges
  const practice = page.getByTestId('practice');
  await expect(practice).toContainText('Start my lab');
  await expect(page.getByTestId('catalogue')).toContainText('11 challenges');
  await expect(practice).not.toContainText('C02');
  await page.getByRole('button', { name: 'Start my lab' }).click();

  // one challenge on stage, not begun: no countdown running, no flag box, nothing ahead
  const stage = page.getByTestId('stage-item');
  await expect(stage).toBeVisible({ timeout: 45_000 });
  await expect(stage).toHaveAttribute('data-challenge', 'C01');
  await expect(stage).toHaveAttribute('data-phase', 'ready');
  await expect(page.getByTestId('sequenced-stage')).toContainText('Challenge 1 of 11');
  await expect(page.getByTestId('sequenced-stage')).not.toContainText('C02');
  await expect(page.getByTestId('account-points')).toContainText('0 of 1000');
  await expect(page.getByPlaceholder('VM{...}')).toHaveCount(0);
  await shot(page, 'learner-1-challenge-ready');

  // begin: the countdown of the tier (Easy, 20 minutes) from the server's clock, the hints and the flag box
  await page.getByTestId('begin').click();
  await expect(stage).toHaveAttribute('data-phase', 'active');
  await expect(page.getByTestId('challenge-timer')).toContainText(/(19|20):\d\d/);
  const hint1 = page.locator('.hint[data-level="1"]');
  await expect(hint1.getByRole('button', { name: 'Reveal' })).toBeVisible();
  await expect(page.locator('.hint[data-level="2"]').getByRole('button', { name: 'Locked' })).toBeDisabled();
  await hint1.getByRole('button', { name: 'Reveal' }).click();
  await expect(hint1.getByRole('button')).toHaveCount(0); // the hint text replaced the button and stays
  await expect(hint1).toContainText('Hint 1');
  await shot(page, 'learner-2-active-countdown-hint');

  // a wrong flag says so and stays; the right one captures, shows the result and the way on
  const [attempt] = await myAttempts(page);
  const flag = await captureFlag(page, attempt.attempt_id, 'C01');
  await page.getByPlaceholder('VM{...}').fill('VM{AAAAAAAAAAAAAAAAAAAAAAAA}');
  await page.getByRole('button', { name: 'Check flag' }).click();
  await expect(page.getByTestId('flag-note')).toContainText('not the flag');
  await page.getByPlaceholder('VM{...}').fill(flag);
  await page.getByRole('button', { name: 'Check flag' }).click();
  await expect(stage).toHaveAttribute('data-phase', 'solved');
  await expect(page.getByTestId('challenge-result')).toContainText(/captured|waiting for a review/i);
  await expect(page.getByTestId('writeup')).toBeVisible();
  await shot(page, 'learner-3-captured-writeup');
  await expect(page.getByTestId('account-points')).not.toContainText(/^Account points0 of/);
  const points = await page.getByTestId('account-points').innerText();
  expect(points).not.toMatch(/^0 of 1000/);

  // next challenge: Medium, 40 minutes, not begun
  await page.getByTestId('next').click();
  await expect(stage).toHaveAttribute('data-challenge', 'C02');
  await expect(stage).toHaveAttribute('data-phase', 'ready');
  await expect(page.getByTestId('sequenced-stage')).toContainText('40 minutes');
  await page.getByTestId('begin').click();
  await expect(stage).toHaveAttribute('data-phase', 'active');

  // the time runs out (the test API's clock moves 41 minutes): the page reads the server's clock again, ends the challenge and shows the write-up
  await hook('advance?seconds=2460', { method: 'POST' });
  await expect(page.getByTestId('challenge-result')).toContainText('time for this challenge is over', { timeout: 40_000 });
  await expect(page.getByTestId('writeup')).toBeVisible();
  await shot(page, 'learner-4-time-ran-out');
  await page.getByTestId('next').click();
  await expect(stage).toHaveAttribute('data-challenge', 'C03');

  // finish the run, then a new run starts and keeps the account points
  await page.getByRole('button', { name: 'Finish this run' }).first().click();
  await expect(page.getByTestId('run-finished')).toContainText('This run is finished');
  await expect(page.getByTestId('run-finished')).toContainText('Your account keeps your best result');
  await shot(page, 'learner-5-run-finished');
  await page.getByRole('button', { name: 'Start a new run' }).click();
  await expect(page.getByTestId('stage-item')).toHaveAttribute('data-challenge', 'C01', { timeout: 45_000 });
  await expect(page.getByTestId('stage-item')).toHaveAttribute('data-phase', 'ready');
  expect(await page.getByTestId('account-points').innerText()).not.toMatch(/^0 of 1000/);
  const runs = await myAttempts(page);
  expect(runs.filter((a) => a.mode === 'learner').length).toBe(2);
  expect(await instanceOf(page, runs[0].attempt_id)).toBeTruthy();
});