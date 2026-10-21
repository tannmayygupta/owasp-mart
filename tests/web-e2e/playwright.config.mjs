// Browser tests of the dashboards (work package E). Two servers start for the run and stop after it:
//   1. the API: the real FastAPI app on a throw-away SQLite file with the fake instance host and the real (offset) clock
//      (apps/api/tests/e2e_web_server.py), seeded with an approved company, a recruiter and three invited candidates (local test accounts);
//   2. the dashboards: `next build` then `next start` of apps/web (the production build, so the production CSP is in force), pointed at that API through its own proxy.
// Run: pnpm --filter @vulnmart/web test:e2e      (E2E_BROWSER_CHANNEL=chrome uses the installed Chrome instead of the Playwright download)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
const API_PORT = Number(process.env.E2E_API_PORT ?? 18080);
export const WEB = `http://127.0.0.1:${WEB_PORT}`;
export const API = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // one API process with one clock: the tests share it, so they run one after the other
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: WEB,
    channel: process.env.E2E_BROWSER_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: false,
  },
  webServer: [
    {
      command: `uv run --locked --package vulnmart-api python apps/api/tests/e2e_web_server.py --port ${API_PORT} --web-origin ${WEB}`,
      cwd: ROOT,
      url: `${API}/_e2e/seed`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // the production build, started on its own port; API_ORIGIN is read by proxy.ts at runtime
      command: `pnpm --filter @vulnmart/web exec next build && pnpm --filter @vulnmart/web exec next start -p ${WEB_PORT} -H 127.0.0.1`,
      cwd: ROOT,
      url: `${WEB}/login`,
      reuseExistingServer: false,
      timeout: 600_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { API_ORIGIN: API, NEXT_TELEMETRY_DISABLED: '1', DASHBOARD_ORIGIN: WEB },
    },
  ],
});