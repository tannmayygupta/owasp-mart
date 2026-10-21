# Browser tests of the dashboards (Playwright)

What it is: `tests/web-e2e/` drives a real browser through the production build of `apps/web` against the real API app on a throw-away database (ADR 0070). It covers sign-up and sign-in, the sequenced learner run (start, begin, hint, flag, next, the countdown ending a challenge, finish, a new run), and a candidate (invite, account, consent, start, time warning, flag, submit, results hidden until the recruiter releases them, withdraw and undo, a closed invite, the mode split).

## Run it on your machine
Needs Node 24, pnpm, `uv` and a browser.

```powershell
# with the installed Chrome (no download)
$env:E2E_BROWSER_CHANNEL = "chrome"
pnpm --filter "@vulnmart/web" test:e2e

# or with Playwright's own Chromium
pnpm --dir tests/web-e2e install --ignore-workspace
pnpm --dir tests/web-e2e exec playwright install chromium
pnpm --filter "@vulnmart/web" test:e2e
```

Screenshots for the evidence folder: set `E2E_SHOTS_DIR` to `docs/assets/<slug>` (absolute path) before the run. Ports: `E2E_WEB_PORT` (3100) and `E2E_API_PORT` (18080).

The API runner alone: `uv run --locked --package vulnmart-api python apps/api/tests/e2e_web_server.py --port 18080 --web-origin http://127.0.0.1:3100`.

## Proposed CI job (not added: `.github/workflows` belongs to the pipeline work)
```yaml
  web-e2e:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@<pinned sha>
      - uses: pnpm/action-setup@<pinned sha>
      - uses: actions/setup-node@<pinned sha>
        with: { node-version-file: .node-version, cache: pnpm }
      - uses: astral-sh/setup-uv@<pinned sha>
      - run: pnpm install --frozen-lockfile
      - run: pnpm --dir tests/web-e2e install --frozen-lockfile --ignore-workspace
      - run: pnpm --dir tests/web-e2e exec playwright install --with-deps chromium
      - run: pnpm --filter "@vulnmart/web" test:e2e
      - if: failure()
        uses: actions/upload-artifact@<pinned sha>
        with: { name: web-e2e-traces, path: tests/web-e2e/test-results }
```
Pin the actions the same way the existing jobs do. This job has not been run on the GitHub ubuntu runner yet; only on Windows with the installed Chrome (see the dev-log).

## Things to know
- The tests share one API process and one clock (`/_e2e/advance` moves it forward and never back), so they run one after the other.
- The hooks under `/_e2e` exist only in the runner. The dashboards' proxy forwards `/api/*` only, so a browser never reaches them.
- A company attempt shows `hints_enabled: false` in the API today (placeholder in `lab/api.py`), so the candidate hint unlock flow has no end-to-end test yet.