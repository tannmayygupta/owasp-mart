# L-11 live: Vercel rewrite, origin secret gate and the S-14 stream check

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay |
| Status | Done (live, throwaway project) |
| Report tag | live, vercel, S-14 |

## Requirements covered
LE-3; spike S-14; NFR-SEC-03; D-50, ADR 0031; handoffs H-116 (answered), H-113, H-115, H-117.

## Summary
The developer logged in to Vercel (device login) and authorised Claude to run the runbook `vercel-and-origin.md` on a throwaway Hobby project. The origin secret was created on vm-p, Caddy and the probe were started with the real Let's Encrypt certificate, port 443 was opened to the internet for the run only (and closed again), the project `vulnmart-s14-probe` was linked and deployed, and the S-14 script ran against the production alias. Result: all ten checks pass on the final shape. Evidence and findings: `docs/research/s-14-vercel-sse.md`.

## Tests (real results)
- Local script tests: `node --test scripts/check-sse-rewrite.test.mjs`: 27 passed (assertions for the new cache opt-out rule added).
- Live: `node scripts/check-sse-rewrite.mjs --url <alias> --direct https://tanmay-platform-prod.duckdns.org --hold 130`: ten PASS lines, exit 0; the stream was held 129 s without a cut.
- The Caddy reload hook after a certificate service run: `caddy reload` succeeded, Caddy stayed up, the gate still answered 403.
- Exposure closed: the 80 and 443 rules are back to the developer's address; AWS shows no rule open to the internet except ICMP type 3 code 4 (path MTU, by design).

## Problems met and how they were fixed
- **Byte-order mark.** The first request through Vercel failed with `TRANSFORM_INVALID_HEADER_VALUE`. Literal header values worked, every variable failed, even a non-secret one. A middleware experiment's runtime log showed `character at index 0 has a value of 65279`: the value stored by `vercel env add` started with a BOM, added by Windows PowerShell's process stdin. Setting the value from Node with raw bytes fixed it. The documented `env` expansion was correct all along; my first conclusion that it did not work was wrong and I changed course after reading the log.
- **Shared cache.** The check `no-shared-cache` failed (one visitor got another's response). A top-level `headers` entry beside `routes` did not help; the same header inside the route did. Template, validator and tests now require it.
- Caddy's probe crash-looped because the copied `probe/` folder was mode 700; `chmod -R a+rX` fixed it (runbook corrected).
- Git's `curl.exe` fails with `-w` ("bad argument"); plain `curl -i` and .NET requests were used for status checks.

## Security notes
No secret was printed or written to the repo. The origin secret went from vm-p into Vercel in memory only (a hidden, production-only variable). `vercel link` left an OIDC token in `.env.local` of the git-ignored deploy folder; deleted. The test variable `TEST_HDR` was removed from the project. The public exposure of 80 and 443 lasted about an hour and was closed by Terraform.

## Limitations and follow-ups
The throwaway project `vulnmart-s14-probe` still exists (delete it when P-07 replaces it). The real dashboards, the API's timing-safe re-check and the 15 s heartbeat are open (H-116, P-07). Longer streams than 130 s were not tried. 443 must be opened again (public_web_cidrs) for any future live run.