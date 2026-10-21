// Accessibility check of every main page with axe-core (OI-30): WCAG 2.0, 2.1 and 2.2 A and AA rules, as the production build draws them, for each role. This file is named so that
// it runs after the journeys: the recruiter pages that need a finished candidate (report, cohort) and the assessment page use what those tests created.
import { adminLogIn, checkAccessible, expect, logIn, seed, signUpAndVerify, test } from './helpers.mjs';

test('public pages', async ({ page }) => {
  const s = await seed();
  for (const path of ['/', '/login', '/signup', '/forgot-password', '/reset-password?token=x', '/verify-email?token=x', '/confirm-email-change?token=x', `/invite?token=${s.tokens.closed}`]) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    await checkAccessible(page, path);
  }
});

test('learner pages, with a running practice lab', async ({ page }) => {
  const email = `axe-${Date.now()}@e2e.example`;
  await signUpAndVerify(page, { name: 'Axe Learner', email });
  await logIn(page, { email });
  await expect(page).toHaveURL(/\/dashboard/);
  await checkAccessible(page, '/dashboard');
  await page.getByRole('button', { name: 'Start my lab' }).click();
  await expect(page.getByTestId('stage-item')).toBeVisible({ timeout: 45_000 });
  await checkAccessible(page, '/dashboard (running lab)');
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: /account/i }).first()).toBeVisible();
  await checkAccessible(page, '/account');
});

test('candidate pages: the assessment and the invite', async ({ page }) => {
  const s = await seed();
  await logIn(page, { email: s.candidates.board });
  await expect(page).toHaveURL(/\/dashboard/);
  await checkAccessible(page, '/dashboard (candidate)');
  const invites = await page.evaluate(async () => (await (await fetch('/api/v1/me/invites')).json()).items);
  const mine = invites.find((i) => i.attempt_id);
  expect(mine, 'the board candidate has an attempt from the recruiter journey').toBeTruthy();
  await page.goto(`/assessment/${mine.attempt_id}`);
  await expect(page.getByTestId('attempt-state')).toBeVisible();
  await checkAccessible(page, '/assessment/[attemptId]');
});

test('recruiter pages: company, candidates, report, cohort', async ({ page }) => {
  const s = await seed();
  await logIn(page, { email: s.recruiter_email });
  await expect(page).toHaveURL(/\/dashboard/);
  await checkAccessible(page, '/dashboard (recruiter)');
  await page.goto('/company');
  await expect(page.getByTestId('templates')).toBeVisible();
  await page.locator('tr[data-template]').first().getByRole('button', { name: /^Edit / }).click(); // the edit form is on the page too
  await expect(page.getByTestId('template-edit')).toBeVisible();
  await checkAccessible(page, '/company');
  await page.goto('/company/candidates');
  await expect(page.getByTestId('monitor')).toBeVisible();
  await checkAccessible(page, '/company/candidates');
  await page.getByRole('link', { name: `Report of ${s.candidates.board}` }).click();
  await expect(page.getByTestId('report')).toBeVisible();
  await checkAccessible(page, '/company/candidates/[attemptId]');
  await page.goto('/company');
  await page.getByRole('link', { name: 'Cohort view of Board assessment' }).click();
  await expect(page.getByTestId('cohort')).toBeVisible();
  await checkAccessible(page, '/company/templates/[templateId]/cohort');
});

test('admin page, with its tables filled', async ({ page }) => {
  const s = await seed();
  await adminLogIn(page, s.admins.a11y);
  await page.goto('/admin');
  await expect(page.getByTestId('queue')).toBeVisible();
  await page.getByTestId('users').getByLabel('Search users').fill('cand-');
  await page.getByTestId('users').getByRole('button', { name: 'Search' }).click();
  await expect(page.getByTestId('users').locator('tbody tr').first()).toBeVisible();
  await page.getByTestId('audit').getByRole('button', { name: 'Read' }).click();
  await expect(page.getByTestId('audit').locator('tbody tr').first()).toBeVisible();
  await checkAccessible(page, '/admin');
});
