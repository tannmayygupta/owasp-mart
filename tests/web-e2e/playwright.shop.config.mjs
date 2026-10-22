// Browser walkthrough of the practice shop: a learner works through the challenges by what the pages offer. One server: the vulnerable shop over a seeded in-memory database
// (apps/shop/dev/serve-local.mjs). Run: pnpm exec playwright test -c playwright.shop.config.mjs     (E2E_BROWSER_CHANNEL=chrome uses the installed Chrome)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.E2E_SHOP_PORT ?? 3200);

export default defineConfig({
  testDir: './shop',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel: process.env.E2E_BROWSER_CHANNEL || undefined, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: `node apps/shop/dev/serve-local.mjs`,
    cwd: ROOT,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(PORT) },
  },
});
