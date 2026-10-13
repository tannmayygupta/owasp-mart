# Vercel same-origin rewrite, origin-secret gate and S-14 check (preparation for L-11)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | tannmayygupta |
| Branch / commit | sprint-2-tanmay; not committed when this entry was written (the developer commits) |
| Status | Partly done: the local preparation is done and tested; the live Vercel run, the S-14 result and the wiring with P-07 are open (the developer's). L-11 is not ticked, the story is not marked done |
| Report tag | edge security, origin gate, live stream through a proxy, free hosting |

## Requirements covered
LE-3, spike S-14, D-15, D-21, NFR-SEC-03, D-50 (new, Proposed), ADR 0002, ADR 0031 (new, Proposed); handoffs H-116 (Akshay) and H-117 (L-12) added.

## Summary (plain language, 3-5 lines)
The platform Caddy now refuses every request that does not carry the secret header, supports a secret rotation with two files, never logs the secret and keeps live streams unbuffered. A throwaway Vercel probe project and a check script exist to prove the live stream through the Vercel rewrite from the developer's PC. All of it is tested locally with stock Caddy in Docker; nothing has been run against Vercel or the real VM.

## Why
LE-3 needs the dashboards to reach the API through a same-origin Vercel rewrite with an origin secret (ADR 0002) and needs the live stream proven through it (S-14). The real dashboards (P-07) and the certificates (L-10) do not exist yet, so everything that needs neither was built first.

## What was built
- `infra/caddy/`: `origin-gate.caddy` (the gate), `Caddyfile.p` (TLS, vm-p), `Caddyfile.test` (no TLS, same gate), `compose.p.yaml` (stock Caddy and probe, both by digest), `probe/server.mjs` (stream, echo, cookie, cache endpoints).
- `infra/vercel/s14-probe/`: `vercel.json` (`routes` with a `request.headers` transform from `ORIGIN_SECRET`, destination host a placeholder filled in by `--render`) and `index.html`.
- `scripts/check-sse-rewrite.mjs`: live checks and the offline validator (`--validate`).
- Tests: `scripts/e2e/caddy-origin.e2e.test.mjs`, `scripts/check-sse-rewrite.test.mjs`, a shape test in `scripts/ci-workflow-shape.test.mjs`; CI step in job `compose`.
- Docs: ADR 0031, D-50, runbook `docs/runbooks/vercel-and-origin.md`, `docs/research/s-14-vercel-sse.md`, architecture 03 note, handoffs, traceability, changelog.

## How it works
Browser, Vercel (`routes` rewrite, sets `x-origin-secret` from a sensitive variable), vm-p Caddy (gate: exact match with the current or previous secret file, else 403), upstream. The upstream must repeat the check with a timing-safe compare (H-116). `flush_interval -1` and the stream headers keep events flowing; Caddy keeps Vercel's visitor address in `X-Edge-Forwarded-For`.

## Files changed
- `infra/caddy/Caddyfile.p`, `Caddyfile.test`, `origin-gate.caddy`, `compose.p.yaml`, `probe/server.mjs` (new; `.gitkeep` removed)
- `infra/vercel/s14-probe/vercel.json`, `index.html` (new)
- `scripts/check-sse-rewrite.mjs`, `scripts/check-sse-rewrite.test.mjs`, `scripts/e2e/caddy-origin.e2e.test.mjs` (new); `scripts/ci-workflow-shape.test.mjs`, `.github/workflows/ci.yml` (step and test added)
- `docs/adr/0031-...md`, `docs/adr/README.md`, `initial.md` (D-50), `docs/runbooks/vercel-and-origin.md`, `docs/research/s-14-vercel-sse.md`, `docs/architecture/03-origins-and-access.md`, `docs/dev/HANDOFFS.md`, `docs/dev/dev1-tanmay.md`, `docs/traceability.md`, `CHANGELOG.md`, the story plan file

## Decisions made
ADR 0031 / D-50 (Proposed, on the developer's delegation): `routes` transform and not Middleware (Middleware is the fallback), `/api` prefix kept, two-value rotation from files, fail closed, application re-check, free only, port 443 open to the internet because Vercel has no address range. Alternatives are in the ADR.

## Tests
Real commands and results (after the review fixes, 2026-10-12, Windows with Docker Desktop) are in `docs/assets/vercel-origin-gate/test-output.txt`:
- `node --test scripts/e2e/caddy-origin.e2e.test.mjs scripts/check-sse-rewrite.test.mjs scripts/scan-secrets.test.mjs scripts/ci-workflow-shape.test.mjs`: 66 tests, 66 pass, 0 skipped (the production-shape tests ran: openssl was available). A single test also passes alone (run with `--test-name-pattern` for the reload and the rotation tests).
- `node scripts/check-sse-rewrite.mjs --validate`: PASS. `docker compose -f infra/caddy/compose.p.yaml config -q`: exit 0. `check-text-files`, `scan-secrets` and `check-contract-rules`: exit 0.
- `node --test "scripts/*.test.mjs"` (full suite, run after the last change): 558 tests, 557 pass, 0 fail, 1 skipped (the flock test, not available on Windows).
The CI step itself cannot run here (GitHub Actions); the job commands were run locally. Traceability rows updated: LE-3, D-50, S-14, NFR-SEC-03, D-15 and D-21.

## Evidence
`docs/assets/vercel-origin-gate/test-output.txt`.

## Problems met and how they were fixed
- First attempt at the gate with the `expression` matcher and `{file.}` failed (Caddy's CEL conversion does not accept the path in a placeholder); the plain `header` matcher with `{file.}` works and is read per request.
- The e2e fail-closed rows failed: a request with an EMPTY `X-Origin-Secret` header matched an EMPTY or missing secret file (200). Fixed with `header_regexp X-Origin-Secret .+`.
- The log row failed: the access log filter was in place but the proxy's own warning ("aborting with incomplete response") printed the full request headers including the secret. Fixed by also deleting the header in the default logger (global options of both Caddyfiles); the Caddyfile.p test checks that both filters are in the adapted config.
- The S-14 checker hung on a buffering proxy because the time limit started only after the response headers; the limit now covers the wait for the first byte.
- Hand-written test commands left a stray file named after a test secret in the repository root once (a malformed PowerShell call, not from a test); the coordinator deleted it. Tests write only to the system temporary folder (mkdtemp) and remove it afterwards.
- Review fixes (2026-10-12): (1) the default-logger filter is now pinned by parsing the adapted JSON of `Caddyfile.p`, and the real `Caddyfile.p` is started with the compose flags over TLS; (2) `admin off` would have made `caddy reload` (the H-115 hook) impossible: it is now a unix socket in the tmpfs, tested in the running and in the read-only container, command noted in H-115 and H-117; (3) the tests no longer share secret files: each sets its own, waits until the container sees them, restores in finally, and callback assertions reject instead of throwing (any test passes alone); (4) `${ORIGIN_URL}` in `dest` is not documented to expand: the committed `vercel.json` has a placeholder host and `--render` fills it in; (5) the validator crashed on a non-object transform and accepted `routes` next to `headers` and the like: now a strict allowlist; (6) a secret file ending or starting with `*` is a wildcard in Caddy's header matcher: the gate now needs exactly 64 hex and refuses a non-hex file; (7) the probe fell to a 10 ms interval for an empty parameter: helper with defaults and a maximum stream age; (8) the checker got timeouts, frame buffering, a cacheable probe endpoint, eight more checks and a failing-case test for each, the direct check also needs the body `forbidden`; (9) `.vercel`, `.env*.local` and `infra/vercel/.deploy/` are ignored and the secret scan refuses a tracked `.vercel/` or local env file; (10) runbook and ADR: routes-only limit and an S-14 coexistence step, 443 published on purpose, rotation of the application store, image re-pin, secret file rules, residual risk, ten PASS lines.
- A usage limit cut the first session; Docker Desktop had also stopped and was restarted.

## Security notes (vulnerable parts only)
Not a vulnerable part. The real protection of the platform origin is the secret plus the application's timing-safe re-check; the gate is a first filter. Random per-run secrets in tests only; no secret, token, address or account name is in any file.

## Limitations and follow-ups
Open and not claimed: live Vercel project and deployment, environment variables, secret files and port 443 on vm-p, the S-14 run and its result (SSE through Vercel, longest stream, Host header, cookie and cache behaviour, rewrite caching switch), the rotation test on the real host, the wiring with P-07, certificates (L-10), the application's re-check and heartbeat (H-116), compose profile on L-12 (H-117). If the real Vercel transform misbehaves the fallback is Routing Middleware (runbook).
