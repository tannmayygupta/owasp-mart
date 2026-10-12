# Runbook: Vercel project, origin secret and the S-14 live-stream check

Story: L-11 preparation (D-50, ADR 0031). Files: `infra/caddy/` (`Caddyfile.p`, `origin-gate.caddy`, `compose.p.yaml`, `probe/server.mjs`), `infra/vercel/s14-probe/` (`vercel.json`, `index.html`), `scripts/check-sse-rewrite.mjs`. Claude never runs these steps and never sees a secret. Nothing below puts a secret, token, address or account name into a file of the repository: they live in your Vercel project settings, in files on vm-p and in your password manager. Where this runbook shows `<...>`, you fill the value at your keyboard.

Everything here is free: Vercel Hobby, stock Caddy, DuckDNS and Let's Encrypt (L-10). Vercel Hobby is for non-commercial use; this coursework project fits, and the developer confirms that judgement (ADR 0031 D6).

Status of this story: the files are built and tested locally (Docker, stock Caddy). **Open (the developer's, in this order):** certificates on vm-p (L-10 runbook), Parts A to H below, the S-14 result, and the wiring with Akshay's dashboards (P-07) in Part J. Until Part F passes, nobody may say that SSE works through Vercel.

## How it works (short)
- The browser calls `/api/*` on the Vercel site. A `routes` entry in `vercel.json` proxies it to `https://<platform-name>.duckdns.org/api/$1` and sets the request header `x-origin-secret` from the sensitive environment variable `ORIGIN_SECRET` (`op: set` overwrites a value a visitor sends). The `/api` prefix is kept. Only the transform `args` are documented to expand environment variables, so the host is written into the file (by `--render`, Part D) and the rendered folder is never committed.
- vm-p runs stock Caddy. `origin-gate.caddy` proxies only requests whose `X-Origin-Secret` is exactly 64 lower-case hex characters and equals the content of `origin_secret_current` or `origin_secret_previous` (files, read at every request, so rotation needs no reload). Anything else gets 403 (body `forbidden`) and never reaches the upstream. A missing or empty file, or a file with any character that is not hex (a `*` would be a wildcard in Caddy), refuses every request. The header is deleted from every log line.
- The upstream (today the probe, later the API) must repeat the check with a timing-safe compare. Caddy compares text exactly and is only the first filter.
- **Port 443 of vm-p is published on purpose and is the only published port of this stack** (Vercel publishes no address range, so it cannot be limited to Vercel). The other ports and the isolation rules (H-100, H-103) are separate concerns and are not changed here. Part C opens it.

## Residual risk (accepted, written down)
- 443 is open to the whole internet and the secret is the only protection in front of the application. A 256-bit secret makes guessing infeasible; the secret is checked again in the application (H-116).
- Stock Caddy has no rate limit: a flood of requests (with or without the secret) is not slowed down here. Free-tier limits of the host are the only brake.
- There is no health endpoint for uptime monitors: `/api/v1/healthz` of the probe sits behind the gate like everything else (a monitor would need the secret). Decide on a monitoring route with the real API (L-12).
- The probe is throwaway and is replaced by the API; nothing here protects the API's own routes.

## Part A. The two secret files on vm-p
Rules (the gate depends on all of them): each secret is exactly 64 lower-case hex characters made with `openssl rand -hex 32`; the files are written **in place** (`cat >` or `tee`, never an editor that saves by replacing the file, and never `mv` a new file over them, because the bind mount keeps pointing at the old file); **both** files must exist before `docker compose up` (`origin_secret_previous` is an empty file outside a rotation); if a file is missing at start Docker creates a directory with that name and the gate refuses everything.
1. On vm-p, folder first, then each file created with mode 0600 under umask 077 (the folder stays 0700, the files never exist with a looser mode, not even for a moment): `sudo install -d -m 0700 /opt/vulnmart/secrets`, then `openssl rand -hex 32 | ( umask 077; sudo install -m 0600 /dev/stdin /opt/vulnmart/secrets/origin_secret_current )` and `sudo install -m 0600 /dev/null /opt/vulnmart/secrets/origin_secret_previous`. Check: `sudo stat -c '%a %U' /opt/vulnmart/secrets /opt/vulnmart/secrets/origin_secret_*` prints `700 root` and then `600 root` twice. The Caddy container runs as root and reads the files through the read-only mount, so the folder mode does not matter to it. Show the value once to copy it into your password manager: `sudo cat /opt/vulnmart/secrets/origin_secret_current` (never into a chat or a file of the repository).
2. Preflight (must print `ok`, and must be repeated before every `compose up`): `sudo sh -c 'test -f /opt/vulnmart/secrets/origin_secret_current && test -f /opt/vulnmart/secrets/origin_secret_previous && echo ok'`. A directory or a missing file prints nothing (the e2e test runs this exact command against a directory and sees it fail).
3. Check the size (sizes only): `sudo wc -c /opt/vulnmart/secrets/origin_secret_*` prints 65 for `current` and 0 for `previous`.

## Part B. Put the Caddy files on vm-p and start the probe
1. Certificates must exist first: `docs/runbooks/certificates.md` (files in `/opt/vulnmart/certs/live/`). Check: `sudo ls /opt/vulnmart/certs/live` lists `fullchain.pem` and `privkey.pem`.
2. From your PC: `scp -r infra/caddy ubuntu@<vm-p>:/tmp/vulnmart-caddy` (AWS runbook, Part G, "push over SSH"), then on vm-p: `sudo install -d /opt/vulnmart/origin && sudo cp -r /tmp/vulnmart-caddy/. /opt/vulnmart/origin/`.
3. Run the preflight of Part A step 2, then `cd /opt/vulnmart/origin && sudo docker compose -f compose.p.yaml up -d`. Check: `sudo docker compose -f compose.p.yaml ps` shows `caddy` and `probe` running; `sudo docker logs vulnmart-origin-caddy-1 2>&1 | tail -n 5` shows no `error` lines about the certificate.
4. Reload after a certificate renewal: automatic. `vulnmart-certs.service` runs `ExecStartPost=-/usr/bin/docker exec vulnmart-origin-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock` after every renewal run (the `-` means a failed reload, for example before Caddy is first started, never fails the unit; the error is in `sudo journalctl -u vulnmart-certs.service`). The same command by hand, if you ever need it: `sudo docker exec vulnmart-origin-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//tmp/caddy-admin.sock`. The admin endpoint is a unix socket in the container's tmpfs, never a network port (tested, also in the read-only production-shape container). Check: `sudo systemctl show vulnmart-certs.service -p ExecStartPost` lists the line, and the Part E request still works after a renewal.

## Part C. Open port 443 (Terraform, your approval)
Vercel has no fixed addresses, so the public web port must be open: set `public_web_cidrs` for vm-p in your Terraform variables (not committed) and apply as in the AWS runbook. This is the one published port; do not open others. Check from your PC: `curl -s -w "%{http_code}" https://<platform-name>.duckdns.org/api/v1/echo` prints `forbidden403` (the gate answers a request without the secret). If it hangs, the port is not open.

## Part D. Vercel project (the owner's account)
1. `npm i -g vercel` (or `npx vercel`), then `vercel login` (browser sign-in; no token goes in any file). Hobby Git deployment only accepts commits of the team owner, so deploy with the CLI as the owner.
2. Render the project folder with the platform host filled in (the committed file has a placeholder): `node scripts/check-sse-rewrite.mjs --render https://<platform-name>.duckdns.org --out infra/vercel/.deploy`. It refuses an origin that is not `https://<label>.duckdns.org`, validates the result and prints `PASS`. The folder is git-ignored; `.vercel/` (project and organisation ids written by the CLI) is git-ignored too and the secret scan refuses a tracked copy.
3. In `infra/vercel/.deploy/`: `vercel link` (new project, a throwaway name). Add one environment variable for Production in the Vercel dashboard (Project, Settings, Environment Variables): `ORIGIN_SECRET` = the secret from Part A, marked **Sensitive**. Do not type the value into your shell history.
4. Deploy from that folder: `vercel deploy --prod`. Note the URL it prints. Check: open `<url>/` shows the probe page.

## Part E. First request
`curl -s <url>/api/v1/echo` returns JSON with `"secretPresent":true` and the host and forwarded headers the origin saw. If it returns 403 from Caddy, the secret in Vercel differs from the file (or the file is not 64 hex characters); if Vercel answers 404 or 502, check the rendered host and that port 443 is open. If `secretPresent` is `false`, the transform did not apply: see "Fallback" below.

## Part F. The S-14 run (from your PC)
`node scripts/check-sse-rewrite.mjs --url <url> --direct https://<platform-name>.duckdns.org --hold 130`
It takes about three minutes (the longest-stream check holds a stream open for `--hold` seconds; use 130 to pass the 120 second mark, more to look for a longer cut). Expected: **ten `PASS` lines**, one `INFO` line (what the origin saw: Host, forwarded host) and the final line `S-14: all checks passed`, exit 0. Without `--direct` the last check prints `SKIP` and there are nine PASS lines. What each line means:
- `echo-through-rewrite`: the route reaches the origin and the origin got the secret.
- `visitor-header-overwritten`: a visitor-chosen `x-origin-secret` is replaced, not passed.
- `stream-steady`: 6 events 2 s apart arrive one by one (smallest gap at least 0.8 s, first within 6.5 s). Events in batches or all at the end mean Vercel buffers the stream: **S-14 failed**.
- `stream-no-compression` and `stream-cache-control`: the stream has no `content-encoding` and keeps `no-cache, no-transform`.
- `stream-longest`: heartbeats only, held for `--hold` seconds. A `CUT after N s` line is the answer to "how long can a stream live".
- `cookie-passthrough`: `Set-Cookie` with HttpOnly, Secure and SameSite reaches the client and a cookie sent back reaches the origin.
- `no-shared-cache`: the probe answers `Cache-Control: public, max-age=60` with a random body; two callers with different cookies must get different bodies and no `x-vercel-cache: HIT`. If this fails, add the rewrite cache switch of architecture 03 section 1.3 to the route and run again (that is a change of the config shape, see Part G).
- `request-body-and-query`: a POST body and a query string reach the origin unchanged.
- `direct-access-refused`: a request straight to vm-p without the secret gets 403 with the body `forbidden`.
Paste the printed lines (they contain no secret; they contain the host names you passed) into `docs/research/s-14-vercel-sse.md`, and tell Tanmay the result before anything is decided (a failed S-14 means the fallbacks of architecture 03 section 5, the developer's call).

## Part G. The limit of the `routes`-only shape (S-14 step for the real dashboards)
Vercel does not allow `routes` together with `rewrites`, `redirects`, `headers`, `cleanUrls` or `trailingSlash`. The real dashboards need security headers and perhaps a single-page fallback, so the probe shape cannot simply be copied. The validator refuses that combination on purpose. Test the options once, with the probe:
1. In `infra/vercel/.deploy/vercel.json` (the rendered copy, never the committed file) replace `routes` by a `rewrites` entry for `/api/(.*)` to the same host plus a `headers` entry (for example `X-Content-Type-Options: nosniff`) and deploy. Check: `curl -sI <url>/` shows the header, and a request to `/api/v1/echo` still works. **If it works but `secretPresent` is `false`:** a rewrite cannot carry the header transform, so the secret must be set by Routing Middleware (next paragraph). **If `routes` plus `headers` is refused at deploy:** same conclusion.
2. Fallback: Routing Middleware (all plans) sets the header on `/api/*` and may sit next to `rewrites` and `headers`. Run Part F against that deployment (the middleware runs a function: watch the Hobby limits and that the stream still passes).
3. Record which shape worked in `docs/research/s-14-vercel-sse.md` and tell Akshay (H-116): his real `vercel.json` follows the shape that passed.

## Part H. Rotation (do it once as a test, then it is the routine)
1. New secret on vm-p: `openssl rand -hex 32` into a variable you do not print, then in this order: copy the current value into `previous` in place (`sudo sh -c 'cat /opt/vulnmart/secrets/origin_secret_current > /opt/vulnmart/secrets/origin_secret_previous'`), write the new value into `current` in place (`... | ( umask 077; sudo tee /opt/vulnmart/secrets/origin_secret_current >/dev/null )`, which truncates the existing 0600 file and keeps its mode). Check the preflight of Part A step 2 again.
2. **Rotate the application's own current/previous store in the same window** (H-116): the API keeps a current and a previous value too and must accept both until step 5.
3. Set `ORIGIN_SECRET` in Vercel to the new value and redeploy (`vercel deploy --prod`; environment variable changes apply to new deployments).
4. Check: `curl -s <url>/api/v1/echo` returns `secretPresent:true` before and after the redeploy (both values are accepted meanwhile).
5. Drop the old value: empty `previous` in place (`sudo sh -c ': > /opt/vulnmart/secrets/origin_secret_previous'`) and the application's previous store. Check: the same request still works, and a direct request with the old value gets 403.
What happens to live streams: the secret is checked only when a request starts. A stream that is already open stays open (it is not checked again) until it ends or the client reconnects; the browser then reconnects through the new deployment, which sends the new value, and `EventSource` resends `Last-Event-ID` so the API continues from the last event.

## Part I. Refresh the pinned images (Caddy and node)
The images in `infra/caddy/compose.p.yaml` are pinned by digest. To refresh one: pull the new tag on your PC (`docker pull caddy:2.10-alpine`), read the digest (`docker images --digests caddy` or `docker buildx imagetools inspect caddy:2.10-alpine`; use the index digest, as now), replace the `image:` line in `compose.p.yaml` (tag, `@sha256:...`), run `node --test scripts/e2e/caddy-origin.e2e.test.mjs scripts/ci-workflow-shape.test.mjs` (the e2e test and the shape test read their images from that file, so there is nowhere else to change; a test that fails after a bump is a real change in Caddy's behaviour), then `docker compose -f infra/caddy/compose.p.yaml pull` and `up -d` on vm-p. The node image is the same repository pin as the other Dockerfiles (`node:24.21.0-alpine@sha256:...`); change them together.

## Part J. Still open for the full L-11 (after P-07 and L-10)
- Create the real Vercel project from Akshay's dashboards skeleton using the shape that passed Part G, set `ORIGIN_SECRET`, repeat Parts E and F against the real API.
- The application's timing-safe re-check and the 15 s heartbeat (handoff H-116).
- Record the S-14 result in `docs/research/s-14-vercel-sse.md`, then close L-11. Delete the throwaway Vercel project (dashboard, Settings, Delete) when P-07 has replaced it.

## Fallback (only if the live run shows a problem)
If `secretPresent` is `false` or a visitor header is not overwritten, the transform does not behave as documented: use Vercel Routing Middleware (all plans) to set the header on `/api/*` requests, and run Part F again. If the stream is buffered or cut short, do not work around it alone: tell Tanmay (plan B of architecture 03 section 5 is a design change).

## Checks that already ran locally (not live)
`node --test scripts/e2e/caddy-origin.e2e.test.mjs scripts/check-sse-rewrite.test.mjs` (stock Caddy in Docker with the probe, including the real `Caddyfile.p` with the flags of `compose.p.yaml` over TLS, the reload through the admin socket, a missing secret file at start; the S-14 script against the probe through good and broken stand-in proxies). These prove the gate, rotation, fail-closed, log redaction and flush behaviour of Caddy, and that the checker detects buffering, batching, cuts, missing or visitor secrets, compression, cache rewrites, caches, lost cookies, queries and bodies. They do not prove anything about Vercel.
