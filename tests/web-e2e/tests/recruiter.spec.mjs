// The recruiter of the seeded company in a real browser: company profile, a template (new, edit), invitations (single, bulk, resend, cancel, revoke), a candidate who takes the
// assessment, the report, the cohort view with its ranking-aid wording, the release of the results, and a template the candidate cannot see until released.
import { acceptInvite, captureFlag, consent, consentAndStart, expect, hook, logIn, PASSWORD, seed, shot, test } from './helpers.mjs';

async function signInRecruiter(page, s) {
  await logIn(page, { email: s.recruiter_email });
  await expect(page).toHaveURL(/\/dashboard/);
}

test('recruiter: company profile, a new template, an edit, invitations with resend, cancel and bulk, a revoke', async ({ page, browser, baseURL }) => {
  const s = await seed();
  await signInRecruiter(page, s);
  await page.getByRole('link', { name: 'Company', exact: true }).click();
  const standing = page.getByTestId('standing');
  await expect(standing).toContainText('Acme Security');
  await expect(standing).toContainText('Owner');
  await expect(page.getByTestId('terms-state')).toHaveText('Accepted by the owner');
  await page.getByRole('button', { name: 'Read the terms' }).click();
  await expect(page.getByTestId('terms-text')).not.toBeEmpty();
  await shot(page, 'recruiter-1-company');

  // a new template with every setting of the form
  const stamp = Date.now();
  const title = `UI journey ${stamp}`;
  await page.locator('#new-title').fill(title);
  await page.getByRole('form', { name: 'New template' }).getByLabel('C01', { exact: false }).first().check();
  await page.getByRole('form', { name: 'New template' }).getByLabel('C02', { exact: false }).first().check();
  await page.locator('#new-time').fill('45');
  await page.locator('#new-resets').fill('2');
  await page.locator('#new-expiry').fill('5');
  await page.locator('#new-retention').fill('90');
  await page.getByLabel('Candidates see their results when you release them').check();
  await page.getByLabel('Turn on the private cohort view', { exact: false }).check();
  await page.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByRole('status')).toHaveText('Template saved.');
  const row = page.locator('tr[data-template]', { hasText: title });
  await expect(row).toContainText('45 min');
  await expect(row).toContainText('version 1');
  await expect(row.getByRole('link', { name: /Cohort view of/ })).toBeVisible();

  // a value outside the API's range is refused and the page says so
  await row.getByRole('button', { name: `Edit ${title}` }).click();
  const edit = page.getByTestId('template-edit');
  await edit.getByLabel('Time limit', { exact: false }).fill('5');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('p.banner.bad')).toBeVisible();
  // then a good edit: the version goes up and the invites already made are untouched
  await edit.getByLabel('Time limit', { exact: false }).fill('60');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Template saved.');
  await expect(row).toContainText('60 min');
  await expect(row).toContainText('version 2');
  await shot(page, 'recruiter-2-template-edited');

  // two invitations in one go
  const a = `ui-a-${stamp}@e2e.example`;
  const b = `ui-b-${stamp}@e2e.example`;
  await page.locator('#template_id').selectOption({ label: title });
  await page.locator('#emails').fill(`${a}\n${b}`);
  await page.getByRole('button', { name: 'Send invitations' }).click();
  await expect(page.getByTestId('invite-result')).toContainText('Sent: 2.');

  await page.getByRole('link', { name: 'Candidates', exact: true }).click();
  const monitor = page.getByTestId('monitor');
  await expect(monitor.locator('tr', { hasText: a })).toBeVisible();
  // single resend
  await page.getByRole('button', { name: `Resend ${a}` }).click();
  await expect(page.getByRole('status')).toContainText(`${a}: a new link was sent.`);
  // bulk resend of both
  await page.getByLabel(`Choose ${a}`).check();
  await page.getByLabel(`Choose ${b}`).check();
  await page.getByRole('button', { name: 'Resend the chosen' }).click();
  await expect(page.getByRole('status')).toHaveText('Resent: 2 of 2.');
  // cancel one (an invite not yet seen to leave can be cancelled); the revoke button is not offered for it
  await expect(page.getByRole('button', { name: `Revoke ${b}` })).toHaveCount(0);
  await page.getByRole('button', { name: `Cancel ${b}` }).click();
  await expect(monitor.locator('tr', { hasText: b }).locator('.pill')).toHaveText('cancelled');
  await expect(page.getByRole('button', { name: `Resend ${b}` })).toHaveCount(0);

  // revoke: the candidates open their links (state `opened`), the recruiter revokes one, then two in bulk
  const visitor = await browser.newContext({ baseURL });
  const guest = await visitor.newPage();
  for (const key of ['rev1', 'rev2', 'rev3']) {
    await guest.goto(`/invite?token=${s.tokens[key]}`);
    await expect(guest.getByTestId('invite-summary')).toBeVisible();
  }
  await visitor.close();
  await page.reload();
  const one = s.candidates.rev1;
  await expect(monitor.locator('tr', { hasText: one }).locator('.pill')).toHaveText('opened');
  await page.getByRole('button', { name: `Revoke ${one}` }).click();
  await expect(monitor.locator('tr', { hasText: one }).locator('.pill')).toHaveText('revoked');
  await page.getByLabel(`Choose ${s.candidates.rev2}`).check();
  await page.getByLabel(`Choose ${s.candidates.rev3}`).check();
  await page.getByRole('button', { name: 'Revoke the chosen' }).click();
  await expect(page.getByRole('status')).toHaveText('Revoked: 2 of 2.');
  await expect(monitor.locator('tr', { hasText: s.candidates.rev3 }).locator('.pill')).toHaveText('revoked');
  await shot(page, 'recruiter-3-invite-actions');
});

test('recruiter: a candidate takes the assessment, the report, the cohort view as a ranking aid, release', async ({ page, browser, baseURL }) => {
  const s = await seed();
  // the candidate, in a browser context of their own
  const cctx = await browser.newContext({ baseURL });
  const cand = await cctx.newPage();
  cand.on('dialog', (d) => void d.accept()); // the candidate's confirms (start, submit) are answered yes
  const attemptId = await acceptInvite(cand, s.tokens.board, s.candidates.board);
  await consentAndStart(cand);

  // the recruiter sees the running candidate and may re-invite (a fault), but nothing is decided here
  await signInRecruiter(page, s);
  await page.goto('/company/candidates');
  const line = page.locator('tr', { hasText: s.candidates.board });
  await expect(line.locator('.pill').nth(1)).toHaveText('running');
  await expect(line.getByRole('button', { name: `Re-invite ${s.candidates.board}` })).toBeVisible();

  // the candidate captures C01 and submits
  const flag = await captureFlag(cand, attemptId, 'C01');
  const crow = cand.locator('tr[data-challenge="C01"]');
  await crow.getByLabel('Flag for C01').fill(flag);
  await crow.getByRole('button', { name: 'Check' }).click();
  await expect(cand.locator('p.banner.ok', { hasText: 'C01: correct' })).toBeVisible();
  await cand.getByTestId('submit-attempt').click();
  await expect(cand.getByTestId('attempt-state')).toHaveText('submitted');
  await expect(cand.getByTestId('results-later')).toBeVisible();

  // the cohort view: ranking-aid wording, the candidate with a score, no automatic decision anywhere
  await page.goto('/company');
  await page.getByRole('link', { name: 'Cohort view of Board assessment' }).click();
  await expect(page.getByTestId('cohort-label')).toContainText('ranking aid, the recruiter decides');
  await expect(page.getByTestId('cohort-label')).toContainText('nobody is ranked out');
  const board = page.getByTestId('cohort').locator('tr', { hasText: s.candidates.board });
  await expect(board).toContainText('1');
  await expect(board).toContainText('of 1000');
  await expect(page.getByTestId('cohort')).not.toContainText(/rejected|failed|hire/i);
  await expect(page.getByTestId('cohort').getByRole('button')).toHaveCount(0); // no decision control: it is an aid
  await shot(page, 'recruiter-4-cohort');

  // the report and the release
  await board.getByRole('link', { name: `Report of ${s.candidates.board}` }).click();
  await expect(page.getByTestId('report-score')).toBeVisible();
  await page.getByRole('button', { name: 'Release the results to the candidate' }).click();
  await expect(page.getByRole('status')).toContainText('Results released.');
  await cand.reload();
  await expect(cand.getByTestId('score')).toBeVisible();
  await cctx.close();
});

test('the cohort view is off for a template that did not turn it on, and the API says so', async ({ page }) => {
  const s = await seed();
  await signInRecruiter(page, s);
  await page.goto('/company');
  // the seeded "Submit assessment" keeps the board off: no link, and the page itself explains when opened by address
  await expect(page.locator('tr[data-template="Submit assessment"]').getByRole('link', { name: /Cohort view/ })).toHaveCount(0);
  const id = await page.evaluate(async () => (await (await fetch('/api/v1/company/templates')).json()).items.find((t) => t.title === 'Submit assessment').template_id);
  await page.goto(`/company/templates/${id}/cohort`);
  await expect(page.getByTestId('cohort-off')).toBeVisible();
});

test('recruiter cancels a candidate attempt that has not started', async ({ page, browser, baseURL }) => {
  const s = await seed();
  const cctx = await browser.newContext({ baseURL });
  const cand = await cctx.newPage();
  const attemptId = await acceptInvite(cand, s.tokens.cancel, s.candidates.cancel);
  await consent(cand);
  await signInRecruiter(page, s);
  await page.goto('/company/candidates');
  const line = page.locator('tr', { hasText: s.candidates.cancel });
  await line.getByRole('button', { name: `Cancel the attempt of ${s.candidates.cancel}` }).click(); // the dialog is answered yes
  await expect(page.getByRole('status')).toHaveText(`${s.candidates.cancel}: the attempt was cancelled.`);
  await expect(line.locator('.pill').nth(1)).toHaveText('cancelled');
  await expect(line.getByRole('button', { name: /Cancel the attempt/ })).toHaveCount(0);
  await shot(page, 'recruiter-5-attempt-cancelled');
  // the candidate sees it as the lab says
  const state = await cand.evaluate(async (id) => (await (await fetch(`/api/v1/attempts/${id}`)).json()), attemptId);
  expect(['cancelled', 'ATT-GONE']).toContain(state.state ?? state.code);
  await cctx.close();
});

test('a candidate asks for the record to be deleted and the recruiter decides', async ({ page, browser, baseURL }) => {
  const s = await seed();
  const cctx = await browser.newContext({ baseURL });
  const cand = await cctx.newPage();
  cand.on('dialog', (d) => void d.accept());
  await acceptInvite(cand, s.tokens.del, s.candidates.del);
  await consentAndStart(cand);
  // a request is possible only once the attempt is over: submit it first
  await cand.getByTestId('submit-attempt').click();
  await expect(cand.getByTestId('attempt-state')).toHaveText('submitted');
  await cand.getByRole('button', { name: 'Ask the company to delete this record' }).click();
  await expect(cand.locator('p.banner.ok')).toBeVisible();
  await signInRecruiter(page, s);
  await page.goto('/company');
  const deletions = page.getByTestId('deletions');
  const request = deletions.locator('tr', { hasText: s.candidates.del });
  await expect(request.locator('.pill')).toHaveText('pending');
  await shot(page, 'recruiter-6-deletion-request');
  await request.getByRole('button', { name: `Approve the deletion of ${s.candidates.del}` }).click();
  await expect(page.getByRole('status')).toContainText('Approved.');
  await expect(request.locator('.pill')).toHaveText('approved');
  await cctx.close();
});

test('the owner approves a colleague who asked to join, then removes them', async ({ page, browser, baseURL }) => {
  const s = await seed();
  const email = `colleague-${Date.now()}@acme.example`;
  const ctx = await browser.newContext({ baseURL });
  const guest = await ctx.newPage();
  await guest.goto('/login');
  const status = await guest.evaluate(async ([address, password]) => (await fetch('/api/v1/recruiters', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: address, password, display_name: 'Colin Colleague', company_name: 'Acme Security' }),
  })).status, [email, PASSWORD]);
  expect(status).toBe(202);
  const { token } = await hook(`mail?to=${encodeURIComponent(email)}`);
  await guest.goto(`/verify-email?token=${token}`);
  await expect(guest.getByTestId('verified')).toBeVisible();
  await ctx.close();

  await signInRecruiter(page, s);
  await page.goto('/company');
  const colleagues = page.getByTestId('colleagues');
  await expect(colleagues).toContainText('Colin Colleague');
  await colleagues.getByRole('button', { name: 'Let Colin Colleague join' }).click();
  await expect(page.getByRole('status')).toHaveText('Colin Colleague joined.');
  await expect(colleagues.getByRole('list').last()).toContainText('Colin Colleague');
  await shot(page, 'recruiter-7-colleagues');
  await colleagues.getByRole('button', { name: 'Remove Colin Colleague' }).click();
  await expect(page.getByRole('status')).toHaveText('Colin Colleague was removed.');
  await expect(colleagues.getByRole('list').last()).not.toContainText('Colin Colleague');
});
