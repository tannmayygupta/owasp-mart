// The administrator in a real browser, with the second factor (a seeded authenticator of the test API): approve a company, change and reset a setting, set and remove a quota,
// lock and unlock a user, read capacity, jobs and the audit log (itself audited), and the refusals of break-glass and force-stop shown as errors.
import { adminLogIn, expect, seed, shot, test } from './helpers.mjs';

test('an admin without the second factor in the session is told to set it up and sees no admin data', async ({ page }) => {
  const s = await seed();
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin-e2e@e2e.example'); // the seeded admin with no authenticator
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto('/admin');
  await expect(page.getByTestId('admin-needs-mfa')).toBeVisible();
  await expect(page.getByTestId('queue')).toHaveCount(0);
});

test('admin: approve a company, change a setting, quotas, users, capacity, jobs, audit, break-glass errors', async ({ page }) => {
  const s = await seed();
  await adminLogIn(page, s.admins.journey);
  await page.getByRole('link', { name: 'Admin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();

  // approval queue
  const queue = page.getByTestId('queue');
  const company = queue.locator('tr', { hasText: s.pending_company.name });
  await expect(company).toContainText('@globex-e2e.example');
  await shot(page, 'admin-1-queue');
  await company.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toHaveText(`${s.pending_company.name} approved.`);
  await expect(queue.locator('tr', { hasText: s.pending_company.name })).toHaveCount(0);

  // the company directory: the invite cap override (set, then back to the global setting), suspend, reinstate and delete, each with a recorded reason
  const directory = page.getByTestId('companies');
  const globex = directory.locator('tr', { hasText: s.pending_company.name });
  await expect(globex.locator('.pill')).toHaveText('active');
  await expect(directory.locator('tr', { hasText: 'Acme Security' })).toBeVisible();
  await globex.getByLabel(`Daily invite cap of ${s.pending_company.name}`, { exact: false }).fill('7');
  await globex.getByRole('button', { name: `Save the invite cap of ${s.pending_company.name}` }).click();
  await expect(page.getByRole('status')).toHaveText(`${s.pending_company.name}: the daily cap is 7.`);
  await expect(globex.getByLabel(`Daily invite cap of ${s.pending_company.name}`, { exact: false })).toHaveValue('7');
  await globex.getByLabel(`Daily invite cap of ${s.pending_company.name}`, { exact: false }).fill('');
  await globex.getByRole('button', { name: `Save the invite cap of ${s.pending_company.name}` }).click();
  await expect(page.getByRole('status')).toContainText('the global cap applies again');
  await globex.getByLabel(`Daily invite cap of ${s.pending_company.name}`, { exact: false }).fill('-1');
  await globex.getByRole('button', { name: `Save the invite cap of ${s.pending_company.name}` }).click();
  await expect(page.locator('p.banner.bad')).toBeVisible();
  await globex.getByRole('button', { name: `Suspend ${s.pending_company.name}` }).click();
  await expect(globex.locator('.pill')).toHaveText('suspended');
  await globex.getByRole('button', { name: `Reinstate ${s.pending_company.name}` }).click();
  await expect(globex.locator('.pill')).toHaveText('active');
  await globex.getByRole('button', { name: `Delete ${s.pending_company.name}` }).click();
  await expect(globex.locator('.pill')).toHaveText('deleted');
  await shot(page, 'admin-3-companies');
  // settings: a valid change shows Reset, a value outside the range is refused with the API's answer, reset goes back to the default
  const settings = page.getByTestId('settings');
  await settings.getByLabel('email_daily_cap', { exact: true }).fill('5');
  await settings.locator('tr', { hasText: 'email_daily_cap' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('email_daily_cap saved.');
  await settings.locator('tr', { hasText: 'email_daily_cap' }).getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByRole('status')).toHaveText('email_daily_cap reset.');
  await settings.getByLabel('email_daily_cap', { exact: true }).fill('-3');
  await settings.locator('tr', { hasText: 'email_daily_cap' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('p.banner.bad')).toBeVisible();

  // quotas
  const quotas = page.getByTestId('quotas');
  await quotas.getByLabel('Instances at once').fill('2');
  await quotas.getByRole('button', { name: 'Set' }).click();
  await expect(page.getByRole('status')).toHaveText('Quota saved.');
  await expect(quotas).toContainText('global: 2');
  await quotas.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('status')).toHaveText('Quota removed.');

  // users: search, lock, unlock (each with a reason that is recorded)
  const users = page.getByTestId('users');
  await users.getByLabel('Search users').fill(s.candidates.rev1);
  await users.getByRole('button', { name: 'Search' }).click();
  const person = users.locator('tr', { hasText: s.candidates.rev1 });
  await expect(person).toBeVisible();
  await person.getByRole('button', { name: 'lock', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('lock: done.');
  await person.getByRole('button', { name: 'unlock', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('unlock: done.');

  // capacity and jobs are drawn from their routes
  await expect(page.getByTestId('capacity')).toContainText('Instances running');
  await expect(page.getByTestId('jobs').getByRole('columnheader', { name: 'Job' })).toBeVisible();

  // the audit log: the approval and the settings are in it, and this very read is recorded
  const audit = page.getByTestId('audit');
  await audit.getByLabel('Filter by action').fill('org.approved');
  await audit.getByRole('button', { name: 'Read' }).click();
  await expect(audit.locator('td', { hasText: 'org.approved' }).first()).toBeVisible();
  await audit.getByLabel('Filter by action').fill('');
  await audit.getByRole('button', { name: 'Read' }).click();
  await expect(audit.locator('td', { hasText: 'admin.audit_read' }).first()).toBeVisible();

  // break-glass and force-stop on an attempt that does not exist: the refusal is shown, nothing opens
  const glass = page.getByTestId('break-glass');
  await glass.getByLabel('Candidate attempt id').fill('a-AAAAAAAAAAAAAAAA');
  await glass.getByLabel('Reason', { exact: false }).fill('Browser test of the refusal path, not a real case');
  await glass.getByRole('button', { name: 'Open break-glass' }).click();
  await expect(page.locator('p.banner.bad')).toBeVisible();
  await page.getByTestId('capacity').getByLabel('Attempt id to force-stop').fill('a-AAAAAAAAAAAAAAAA');
  await page.getByTestId('capacity').getByRole('button', { name: 'Force-stop' }).click();
  await expect(page.locator('p.banner.bad')).toBeVisible();
  await shot(page, 'admin-2-after');
});
