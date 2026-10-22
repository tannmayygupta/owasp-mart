// A learner's whole path on the DEPLOYED site, in a real browser: sign in, start a lab in the console, begin a challenge, follow what the brief and the start state say in the shop,
// copy the flag from the page, paste it into the console and read the answer. One test per challenge, run in order, so a challenge opens when the one before it is captured.
//   $env:VM_LIVE_BASE="https://<platform host>"; $env:VM_XP_EMAIL_1="..."; $env:VM_XP_PASSWORD_1="..."
//   pnpm exec playwright test -c playwright.live.config.mjs     (E2E_BROWSER_CHANNEL=chrome uses the installed Chrome)
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './live',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: process.env.VM_LIVE_BASE, channel: process.env.E2E_BROWSER_CHANNEL || undefined, trace: 'retain-on-failure', screenshot: 'on', ignoreHTTPSErrors: false },
});
