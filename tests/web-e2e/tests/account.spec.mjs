// Changing the email address from the account page (FR-ACC-09): the link goes to the new address, nothing changes before it is used, the sessions end, and the person signs in with
// the new address; a wrong current password is refused and says so.
import { expect, hook, logIn, PASSWORD, signUpAndVerify, test } from './helpers.mjs';

test('change the email address: wrong password refused, then the mailed link, then sign in with the new address', async ({ page }) => {
  const stamp = Date.now();
  const oldAddress = `change-${stamp}@e2e.example`;
  const newAddress = `changed-${stamp}@e2e.example`;
  await signUpAndVerify(page, { name: 'Change Mail', email: oldAddress });
  await logIn(page, { email: oldAddress });
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto('/account');
  const section = page.getByTestId('change-email');
  await section.getByLabel('New email address').fill(newAddress);
  await section.getByLabel('Your current password').fill('not the password at all');
  await section.getByRole('button', { name: 'Send the link' }).click();
  await expect(page.locator('p.banner.bad')).toContainText('do not match');
  await section.getByLabel('Your current password').fill(PASSWORD);
  await section.getByRole('button', { name: 'Send the link' }).click();
  await expect(page.getByRole('status')).toContainText('a link is on its way');
  const { token } = await hook(`mail?to=${encodeURIComponent(oldAddress)}&template=account.email_change`);
  await page.goto(`/confirm-email-change?token=${token}`);
  await expect(page.getByTestId('email-changed')).toBeVisible();
  // the link is single use
  await page.goto(`/confirm-email-change?token=${token}`);
  await expect(page.locator('p.banner.bad')).toBeVisible();
  await logIn(page, { email: newAddress });
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto('/account');
  await expect(page.getByText(newAddress)).toBeVisible();
});