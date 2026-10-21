# OWASP ASVS 5.0.0 checklist, requirement by requirement

Task P-32 and requirement NFR-SEC-01 (work package G, 2026-10-21). This replaces the chapter-level table of `docs/traceability.md` with one row per requirement of **ASVS 5.0.0**
(the version the project cites, `OWASP/ASVS` tag `v5.0.0`, `5.0/docs_en`, 345 requirements: 70 at level 1, 183 at level 2, 92 at level 3, read 2026-10-21).

Target (D-21, D-35): **level 2 for the platform** (API, dashboards, workers) and **level 3 for the orchestrator, the admin functions and the key service**. Column *Applies?*: `yes` is a level 1 or 2
requirement; `L3 scope` is a level 3 requirement that counts for the admin, orchestrator and key-service scope and is assessed here for completeness; `no` means the platform has no such functionality
(the *Evidence* column says why). The shop and its parts are intentionally vulnerable and are not in scope (isolation instead, `docs/architecture/06-security.md` section 5).

Status words: **met** (the control exists and the evidence shows it), **partly** (some of it; the note says what is missing), **not met**, **n.a.** (the functionality does not exist).
*Evidence* names files or tests of this repository. *Owner* is the work package that closes a gap (A lifecycle and quotas, B company and mail, C deployment, E and F web, G verification and documents); `-` when nothing is open.
This is a review of the code and tests on `origin/main` (db3721b) plus the scenario tests of package G; it is not an independent audit. Rows marked *met* on the web or the deployed edge rest on the files named and on
`scripts/verify-deployed.mjs`, whose last recorded deployed run (2026-10-20) was 32 pass and 29 fail before the redeploy; the deployed re-run is the lead's step after the deploy.
`node scripts/check-asvs.mjs` checks this file: 345 unique ids, level counts as above, a valid status on every row, evidence on every row, and every path named in the evidence exists.

## Counts

| Status | Requirements |
|---|---|
| met | 176 |
| partly | 51 |
| not met | 13 |
| n.a. | 105 |
| Total | 345 |

## Requirements

| Req | L | Applies? | Status | Evidence | Owner | Note |
|---|---|---|---|---|---|---|
| V1.1.1 | 2 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | Every body is read once into a Strict model (extra fields refused). |
| V1.1.2 | 2 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | Every body is read once into a Strict model (extra fields refused). |
| V1.2.1 | 1 | yes | met | `apps/web/app` `apps/api/src/vulnmart/kernel/db.py` | - | React escapes output; no innerHTML, dangerouslySetInnerHTML or eval in apps/web or apps/api; the ORM parameterises SQL. |
| V1.2.2 | 1 | yes | met | `apps/web/app` `apps/api/src/vulnmart/kernel/db.py` | - | React escapes output; no innerHTML, dangerouslySetInnerHTML or eval in apps/web or apps/api; the ORM parameterises SQL. |
| V1.2.3 | 1 | yes | met | `apps/web/app` `apps/api/src/vulnmart/kernel/db.py` | - | React escapes output; no innerHTML, dangerouslySetInnerHTML or eval in apps/web or apps/api; the ORM parameterises SQL. |
| V1.2.4 | 1 | yes | met | `apps/web/app` `apps/api/src/vulnmart/kernel/db.py` | - | React escapes output; no innerHTML, dangerouslySetInnerHTML or eval in apps/web or apps/api; the ORM parameterises SQL. |
| V1.2.5 | 1 | yes | met | `apps/api/src/vulnmart/ports/http_instance_host.py` | - | The API starts no processes; the orchestrator is reached over HTTP. |
| V1.2.6 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform has no LDAP, XPath, LaTeX or user-built regular expressions. |
| V1.2.7 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform has no LDAP, XPath, LaTeX or user-built regular expressions. |
| V1.2.8 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform has no LDAP, XPath, LaTeX or user-built regular expressions. |
| V1.2.9 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform has no LDAP, XPath, LaTeX or user-built regular expressions. |
| V1.2.10 | 3 | L3 scope | met | `apps/api/src/vulnmart/privacy/exports.py` `apps/api/tests/test_exports.py` | - | CSV cells starting with = + - @ tab or CR are prefixed. |
| V1.3.1 | 1 | no | n.a. | `docs/architecture/06-security.md` | - | No WYSIWYG, SVG, Markdown, JNDI, memcache or format-string input exists on the platform. |
| V1.3.2 | 1 | yes | met | `apps/api/src` | - | No eval or dynamic code execution (grep). |
| V1.3.3 | 2 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | Strict models with patterns and length limits. |
| V1.3.4 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No WYSIWYG, SVG, Markdown, JNDI, memcache or format-string input exists on the platform. |
| V1.3.5 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No WYSIWYG, SVG, Markdown, JNDI, memcache or format-string input exists on the platform. |
| V1.3.6 | 2 | yes | met | `apps/api/src/vulnmart/ports/http_instance_host.py` | - | The API calls one configured orchestrator address and the mail provider; no user-supplied URL is fetched. |
| V1.3.7 | 2 | yes | met | `apps/api/src/vulnmart/notifications/templates.py` | - | Mail templates are code with validated parameters; no template is built from input. |
| V1.3.8 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No WYSIWYG, SVG, Markdown, JNDI, memcache or format-string input exists on the platform. |
| V1.3.9 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No WYSIWYG, SVG, Markdown, JNDI, memcache or format-string input exists on the platform. |
| V1.3.10 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No WYSIWYG, SVG, Markdown, JNDI, memcache or format-string input exists on the platform. |
| V1.3.11 | 2 | yes | met | `apps/api/src/vulnmart/accounts/security.py` | - | Addresses are canonicalised and control characters (CR, LF) refused. |
| V1.3.12 | 3 | L3 scope | partly | `apps/api/src/vulnmart/accounts/http.py` | G | Regular expressions are short and anchored; no ReDoS review was done. |
| V1.4.1 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | Python and TypeScript are memory safe. |
| V1.4.2 | 2 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | Numeric fields have bounds in the request models. |
| V1.4.3 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | Python and TypeScript are memory safe. |
| V1.5.1 | 1 | no | n.a. | `docs/architecture/06-security.md` | - | No XML parsing and no object deserialisation (YAML is read with safe_load, JSON only). |
| V1.5.2 | 2 | yes | met | `apps/api/src/vulnmart/lab/catalog.py` | - | yaml.safe_load only; JSON bodies into Strict models. |
| V1.5.3 | 3 | L3 scope | partly | `apps/api/src/vulnmart/accounts/http.py` | G | One JSON parser per service, but the API and the Node services are not compared for edge cases. |
| V2.1.1 | 1 | yes | partly | `contracts/api/platform/platform.openapi.yaml` | G | Validation rules live in the OpenAPI contract, not in a separate document. |
| V2.1.2 | 2 | yes | partly | `docs/prd/PRD.md` | G | Cross-field rules are in the PRD requirements, not collected. |
| V2.1.3 | 2 | yes | met | `docs/prd/PRD.md` `apps/api/src/vulnmart/kernel/settings.py` | - | Limits and caps are requirements and admin settings. |
| V2.2.1 | 1 | yes | met | `apps/api/src/vulnmart/accounts/http.py` `apps/api/tests/test_problem.py` | - | Positive validation with Strict models; refusals never echo the value. |
| V2.2.2 | 1 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | Validation runs in the API; the dashboards only help the user. |
| V2.2.3 | 2 | yes | met | `apps/api/src/vulnmart/assessments/service.py` `apps/api/tests/test_assessments.py` | - | Template rules are checked together (range and combinations). |
| V2.3.1 | 1 | yes | met | `packages/py-attempts/src/vulnmart_attempts` `apps/api/tests/test_scenarios_candidate.py` | - | The attempt state machine refuses skipped steps (submit before start, flags after submit). |
| V2.3.2 | 2 | yes | met | `apps/api/src/vulnmart/kernel/quota.py` `apps/api/tests/test_scenarios_refresh.py` | - | User, company and platform quotas and the assessment reserve are enforced at the start (test_a09, test_a12). |
| V2.3.3 | 2 | yes | met | `apps/api/src/vulnmart/kernel/db.py` | - | Operations run in one transaction (sessions.begin()). |
| V2.3.4 | 2 | yes | met | `apps/api/tests/test_assessments_postgres.py` `apps/api/tests/test_invite_acceptance_postgres.py` | - | Row locks and unique keys; the races are proved on Postgres (they skip without a database). |
| V2.3.5 | 3 | L3 scope | met | `apps/api/src/vulnmart/admin/breakglass.py` `apps/api/tests/test_breakglass.py` | - | Break-glass needs a second admin's review. |
| V2.4.1 | 2 | yes | met | `apps/api/src/vulnmart/kernel/ratelimit.py` `apps/api/tests/test_ratelimit.py` | - | Per-address and per-account limits on signup, login, reset, invite open, flags. |
| V2.4.2 | 3 | L3 scope | partly | `apps/api/src/vulnmart/flags/submit.py` | A | Flag pastes are rate limited; no human-timing rule elsewhere. |
| V3.1.1 | 3 | L3 scope | partly | `docs/architecture/06-security.md` | G | Browser requirements are not listed in one place. |
| V3.2.1 | 1 | yes | met | `infra/deploy/Caddyfile.platform` | - | nosniff, Content-Type set by the API, CSP default-src self. |
| V3.2.2 | 1 | yes | met | `apps/web/app` | - | React text rendering; no innerHTML. |
| V3.2.3 | 3 | L3 scope | partly | `apps/lab-console/app.js` | G | The vanilla console was not reviewed for DOM clobbering. |
| V3.3.1 | 1 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | __Host-vm_session with Secure. |
| V3.3.2 | 2 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | SameSite=Lax plus the Origin check and CSRF token on every state change. |
| V3.3.3 | 2 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | The only cookie has the __Host- prefix. |
| V3.3.4 | 2 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | HttpOnly. |
| V3.3.5 | 3 | L3 scope | met | `apps/api/src/vulnmart/accounts/http.py` | - | The cookie holds one 43-character token. |
| V3.4.1 | 1 | yes | partly | `infra/deploy/Caddyfile.platform` `scripts/verify-deployed.mjs` | C | HSTS max-age is one year; includeSubDomains and preload are not set. verify-deployed checks the header. |
| V3.4.2 | 1 | yes | met | `apps/api/src/vulnmart/kernel/origin.py` `apps/api/tests/test_kernel_origin.py` | - | No CORS headers; one fixed origin is accepted for state changes. |
| V3.4.3 | 2 | yes | met | `infra/deploy/Caddyfile.platform` | - | CSP on every response of the edge. |
| V3.4.4 | 2 | yes | met | `infra/deploy/Caddyfile.platform` | - | X-Content-Type-Options nosniff. |
| V3.4.5 | 2 | yes | met | `infra/deploy/Caddyfile.platform` | - | Referrer-Policy no-referrer. |
| V3.4.6 | 2 | yes | met | `infra/deploy/Caddyfile.platform` | - | frame-ancestors 'none' and X-Frame-Options DENY. |
| V3.4.7 | 3 | L3 scope | not met | `infra/deploy/Caddyfile.platform` | C | The CSP has no report-uri or report-to. |
| V3.4.8 | 3 | L3 scope | not met | `infra/deploy/Caddyfile.platform` | C | No Cross-Origin-Opener-Policy header. |
| V3.5.1 | 1 | yes | met | `apps/api/src/vulnmart/kernel/origin.py` `apps/api/src/vulnmart/accounts/sessions.py` | - | Origin check and a CSRF token on every state change. |
| V3.5.2 | 1 | yes | met | `apps/api/src/vulnmart/kernel/origin.py` | - | No cross-origin read is possible: no CORS headers. |
| V3.5.3 | 1 | yes | met | `contracts/api/bundle/openapi.json` | - | Every state change is POST, PUT, PATCH or DELETE; GETs are reads (the exports are POST). |
| V3.5.4 | 2 | yes | partly | `infra/deploy/Caddyfile.platform` | C | The lab console and the API share one hostname behind Caddy; the shop instances use their own hostnames. |
| V3.5.5 | 2 | no | n.a. | `apps/web/app` | - | No postMessage use. |
| V3.5.6 | 3 | L3 scope | met | `apps/api/src` | - | No JSONP. |
| V3.5.7 | 3 | L3 scope | met | `apps/web/app` | - | No authorised data in script files. |
| V3.5.8 | 3 | L3 scope | partly | `infra/deploy/Caddyfile.platform` | G | Fetch metadata headers are not checked. |
| V3.6.1 | 3 | L3 scope | met | `infra/deploy/Caddyfile.platform` | - | script-src and style-src are 'self': no external assets. |
| V3.7.1 | 2 | yes | met | `apps/web/package.json` | - | Supported frameworks only (Next 16, React). |
| V3.7.2 | 2 | yes | met | `apps/web/app` | - | No open redirect parameter. |
| V3.7.3 | 3 | no | n.a. | `apps/web/app` | - | The app redirects nowhere outside itself. |
| V3.7.4 | 3 | L3 scope | not met | `infra/deploy/Caddyfile.platform` | C | The demo domain is not on the HSTS preload list. |
| V3.7.5 | 3 | L3 scope | partly | `apps/web/app` | E | No unsupported-browser behaviour is documented. |
| V4.1.1 | 1 | yes | met | `apps/api/src/vulnmart/kernel/service.py` `apps/api/tests/test_contract.py` | - | JSON and problem+json with a Content-Type; contract tests check the answers. |
| V4.1.2 | 2 | yes | met | `infra/deploy/Caddyfile.platform` `scripts/verify-deployed.mjs` | - | Edge redirects HTTP to HTTPS; verify-deployed checks it. |
| V4.1.3 | 2 | yes | met | `apps/edge/src/gate.mjs` | - | Host and forwarded headers are set by the edge, never taken from the client. |
| V4.1.4 | 3 | L3 scope | partly | `infra/deploy/Caddyfile.platform` | C | OPTIONS and TRACE handling by Caddy was not tested. |
| V4.1.5 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | No high-value signed-message flow beyond the orchestrator's HMAC-signed calls (see V13.2). |
| V4.2.1 | 2 | yes | met | `infra/deploy/Caddyfile.platform` | - | Caddy in front of uvicorn; both parse by framing rules. |
| V4.2.2 | 3 | L3 scope | met | `apps/api/src/vulnmart/kernel/service.py` | - | Responses are built by the framework. |
| V4.2.3 | 3 | L3 scope | met | `infra/deploy/Caddyfile.platform` | - | Caddy speaks HTTP/2 and HTTP/3 to browsers and strips connection headers. |
| V4.2.4 | 3 | L3 scope | met | `infra/deploy/Caddyfile.platform` | - | Caddy rejects invalid header characters. |
| V4.2.5 | 3 | L3 scope | met | `apps/api/src/vulnmart/ports/http_instance_host.py` | - | Outbound calls use fixed paths; ids are validated against patterns. |
| V4.3.1 | 2 | no | n.a. | `contracts/api/bundle/openapi.json` | - | No GraphQL. |
| V4.3.2 | 2 | no | n.a. | `contracts/api/bundle/openapi.json` | - | No GraphQL. |
| V4.4.1 | 1 | no | n.a. | `apps/api/src/vulnmart/live/api.py` | - | Live updates use server-sent events over HTTPS, not WebSocket. |
| V4.4.2 | 2 | no | n.a. | `apps/api/src/vulnmart/live/api.py` `apps/api/tests/test_live_authorisation.py` | - | No WebSocket; the SSE stream authorises per user and company (checked in test_live_authorisation). |
| V4.4.3 | 2 | no | n.a. | `apps/api/src/vulnmart/live/api.py` `apps/api/tests/test_live_authorisation.py` | - | No WebSocket; the SSE stream authorises per user and company (checked in test_live_authorisation). |
| V4.4.4 | 2 | no | n.a. | `apps/api/src/vulnmart/live/api.py` `apps/api/tests/test_live_authorisation.py` | - | No WebSocket; the SSE stream authorises per user and company (checked in test_live_authorisation). |
| V5.1.1 | 2 | no | n.a. | `contracts/api/bundle/openapi.json` | - | The platform accepts no file uploads. |
| V5.2.1 | 1 | no | n.a. | `contracts/api/bundle/openapi.json` | - | The platform accepts no file uploads. |
| V5.2.2 | 1 | no | n.a. | `contracts/api/bundle/openapi.json` | - | The platform accepts no file uploads. |
| V5.2.3 | 2 | no | n.a. | `contracts/api/bundle/openapi.json` | - | The platform accepts no file uploads. |
| V5.2.4 | 3 | no | n.a. | `contracts/api/bundle/openapi.json` | - | The platform accepts no file uploads. |
| V5.2.5 | 3 | no | n.a. | `contracts/api/bundle/openapi.json` | - | The platform accepts no file uploads. |
| V5.2.6 | 3 | no | n.a. | `contracts/api/bundle/openapi.json` | - | The platform accepts no file uploads. |
| V5.3.1 | 1 | no | n.a. | `contracts/api/bundle/openapi.json` | - | No uploaded files are stored. |
| V5.3.2 | 1 | no | n.a. | `contracts/api/bundle/openapi.json` | - | No uploaded files are stored. |
| V5.3.3 | 3 | no | n.a. | `contracts/api/bundle/openapi.json` | - | No uploaded files are stored. |
| V5.4.1 | 2 | yes | met | `apps/api/src/vulnmart/privacy/export_api.py` | - | Export file names are made by the server. |
| V5.4.2 | 2 | yes | met | `apps/api/src/vulnmart/privacy/export_api.py` `apps/api/tests/test_exports.py` | - | The name is built by the server and sent as an attachment with nosniff. |
| V5.4.3 | 2 | no | n.a. | `apps/api/src/vulnmart/privacy/exports.py` | - | Downloads are generated by the platform from its own data, not obtained from users. |
| V6.1.1 | 1 | yes | met | `docs/adr/0042-sessions-hashed-cookie-hmac-csrf-and-login-throttle.md` `apps/api/src/vulnmart/kernel/ratelimit.py` | - | ADR 0042 defines the throttles. |
| V6.1.2 | 2 | yes | partly | `apps/api/src/vulnmart/accounts/passwords.py` | G | Context words are the person's own address and name; no organisation list is documented. |
| V6.1.3 | 2 | yes | met | `apps/api/src/vulnmart/accounts/session_api.py` `apps/api/src/vulnmart/accounts/mfa_api.py` `apps/api/src/vulnmart/accounts/password_api.py` | - | One path: password, optional TOTP, reset by mailed link (ADR 0042, 0045). |
| V6.2.1 | 1 | yes | met | `apps/api/src/vulnmart/accounts/passwords.py` | - | Minimum 12 characters. |
| V6.2.2 | 1 | yes | met | `apps/api/src/vulnmart/accounts/me_api.py` `apps/api/tests/test_me_api.py` | - | changePassword. |
| V6.2.3 | 1 | yes | met | `apps/api/src/vulnmart/accounts/me_api.py` `apps/api/tests/test_me_api.py` | - | Current and new password are required. |
| V6.2.4 | 1 | yes | met | `apps/api/src/vulnmart/accounts/passwords.py` `apps/api/tests/test_passwords.py` | - | The bundled 10,000 most common passwords (the production policy). |
| V6.2.5 | 1 | yes | met | `apps/api/src/vulnmart/accounts/passwords.py` | - | No composition rules; only length, common list and identity. |
| V6.2.6 | 1 | yes | met | `apps/web/app/login/page.tsx` `apps/web/app/signup/page.tsx` | - | type=password. |
| V6.2.7 | 1 | yes | partly | `apps/web/app/signup/page.tsx` | E | Paste is not blocked in the code, but no test or manual check records it. |
| V6.2.8 | 1 | yes | met | `apps/api/src/vulnmart/accounts/security.py` | - | The password is hashed as received. |
| V6.2.9 | 2 | yes | met | `apps/api/src/vulnmart/accounts/passwords.py` | - | Up to 128 characters. |
| V6.2.10 | 2 | yes | met | `apps/api/src/vulnmart/accounts/passwords.py` | - | No expiry rule. |
| V6.2.11 | 2 | yes | partly | `apps/api/src/vulnmart/accounts/passwords.py` | G | Only the address and name are used as context words. |
| V6.2.12 | 2 | yes | partly | `apps/api/src/vulnmart/accounts/passwords.py` `docs/adr/0044-password-policy-bundled-list-and-optional-range-check.md` | C | The bundled list is on; the Pwned Passwords range check is optional and off by default (ADR 0044). |
| V6.3.1 | 1 | yes | met | `docs/adr/0042-sessions-hashed-cookie-hmac-csrf-and-login-throttle.md` `apps/api/tests/test_login_bump.py` `apps/api/tests/test_session_api.py` | - | Login throttle per address and per account. |
| V6.3.2 | 1 | yes | met | `apps/api/src/vulnmart/accounts/seed_admin.py` | - | The only admin is seeded with a generated password and a mandatory second factor. |
| V6.3.3 | 2 | yes | partly | `apps/api/src/vulnmart/accounts/mfa.py` `apps/api/tests/test_mfa_api.py` | G | A second factor is mandatory for admins and optional for everyone else; a decision for the leader whether recruiters must have it. |
| V6.3.4 | 2 | yes | met | `apps/api/src/vulnmart/accounts/session_api.py` | - | No undocumented sign-in path. |
| V6.3.5 | 3 | L3 scope | not met | `apps/api/src/vulnmart/accounts/session_api.py` | B | No mail on a sign-in from a new device. |
| V6.3.6 | 3 | L3 scope | met | `apps/api/src/vulnmart/accounts/session_api.py` | - | Mail is not a sign-in factor (only a reset and verification link). |
| V6.3.7 | 3 | L3 scope | partly | `apps/api/src/vulnmart/notifications/templates.py` `apps/api/src/vulnmart/accounts/self_service.py` | H | A reset and an address change mail the person (the old address is told, test_c06); a plain password change sends no mail. |
| V6.3.8 | 3 | L3 scope | met | `apps/api/src/vulnmart/accounts/service.py` `apps/api/tests/test_accounts_api.py` `apps/api/tests/test_scenarios_learner.py` | - | Same 202 for known and unknown address; one generic sign-in error with a dummy hash. |
| V6.4.1 | 1 | yes | met | `apps/api/src/vulnmart/accounts/admins.py` | - | Admin activation by a random single-use link. |
| V6.4.2 | 1 | yes | met | `apps/api/src/vulnmart/accounts/service.py` | - | No secret questions. |
| V6.4.3 | 2 | yes | met | `apps/api/src/vulnmart/accounts/password_api.py` `apps/api/tests/test_password_reset.py` | - | A reset ends every session; the second factor still applies at the next sign-in. |
| V6.4.4 | 2 | yes | partly | `apps/api/src/vulnmart/accounts/mfa.py` `docs/runbooks/seed-admin.md` | G | A lost factor is recovered with recovery codes; operator reset of an admin is a runbook step. |
| V6.4.5 | 3 | no | n.a. | `apps/api/src/vulnmart/accounts/mfa.py` | - | Nothing the platform issues to a user expires on a schedule needing renewal. |
| V6.4.6 | 3 | L3 scope | met | `apps/api/src/vulnmart/admin/ops.py` `apps/api/tests/test_scenarios_admin.py` | - | An admin starts a reset mail; the admin never sets the password. |
| V6.5.1 | 2 | yes | met | `apps/api/src/vulnmart/accounts/totp.py` `apps/api/tests/test_totp_and_fieldkeys.py` | - | TOTP step and recovery codes are single use. |
| V6.5.2 | 2 | yes | met | `apps/api/src/vulnmart/accounts/mfa.py` | - | Recovery codes and secrets are stored sealed or hashed. |
| V6.5.3 | 2 | yes | met | `apps/api/src/vulnmart/accounts/totp.py` | - | secrets module. |
| V6.5.4 | 2 | yes | met | `apps/api/src/vulnmart/accounts/totp.py` | - | 6 digits for TOTP, 48 bits for recovery codes. |
| V6.5.5 | 2 | yes | met | `apps/api/src/vulnmart/accounts/totp.py` | - | 30 second step; tickets and links expire. |
| V6.5.6 | 3 | L3 scope | partly | `apps/api/src/vulnmart/accounts/mfa.py` | G | A factor can be disabled with the password; an admin cannot remove another person's factor yet. |
| V6.5.7 | 3 | no | n.a. | `apps/api/src/vulnmart/accounts/mfa.py` | - | No biometrics. |
| V6.5.8 | 3 | L3 scope | met | `apps/api/src/vulnmart/accounts/totp.py` | - | The server clock checks the code. |
| V6.6.1 | 2 | yes | met | `apps/api/src/vulnmart/accounts/mfa.py` | - | No SMS or phone factor. |
| V6.6.2 | 2 | yes | met | `apps/api/src/vulnmart/accounts/service.py` | - | Mailed tokens are bound to the account and purpose. |
| V6.6.3 | 2 | yes | met | `apps/api/src/vulnmart/kernel/ratelimit.py` `apps/api/tests/test_password_reset.py` | - | Per-address and per-email limits on token routes. |
| V6.6.4 | 3 | no | n.a. | `apps/api/src/vulnmart/accounts/mfa.py` | - | No push factor. |
| V6.7.1 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | No user-facing cryptographic authenticators; the orchestrator's mTLS is V12. |
| V6.7.2 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | No challenge-response authenticators. |
| V6.8.1 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No external identity provider. |
| V6.8.2 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No external identity provider. |
| V6.8.3 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No external identity provider. |
| V6.8.4 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No external identity provider. |
| V7.1.1 | 2 | yes | met | `docs/adr/0042-sessions-hashed-cookie-hmac-csrf-and-login-throttle.md` | - | Idle and absolute limits documented (admin: 15 minutes and 12 hours). |
| V7.1.2 | 2 | yes | partly | `docs/adr/0042-sessions-hashed-cookie-hmac-csrf-and-login-throttle.md` | G | Several sessions per account are allowed and listed; the limit is not written down. |
| V7.1.3 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No federation. |
| V7.2.1 | 1 | yes | met | `apps/api/src/vulnmart/accounts/sessions.py` | - | Every check is a database lookup. |
| V7.2.2 | 1 | yes | met | `apps/api/src/vulnmart/accounts/sessions.py` | - | Random reference tokens, no static keys. |
| V7.2.3 | 1 | yes | met | `apps/api/src/vulnmart/accounts/security.py` | - | 256-bit secrets.token_urlsafe; only a hash is stored. |
| V7.2.4 | 1 | yes | met | `apps/api/src/vulnmart/accounts/sessions.py` `apps/api/tests/test_sessions_service.py` | - | A new token at sign-in and at rotation; the old one is revoked. |
| V7.3.1 | 2 | yes | met | `apps/api/src/vulnmart/accounts/sessions.py` `apps/api/tests/test_scenarios_admin.py` | - | Idle timeout; test_a02 proves the admin 15 minutes. |
| V7.3.2 | 2 | yes | met | `apps/api/src/vulnmart/accounts/sessions.py` `apps/api/tests/test_scenarios_admin.py` | - | Absolute limit; test_a02 proves the admin 12 hours. |
| V7.4.1 | 1 | yes | met | `apps/api/src/vulnmart/accounts/session_api.py` `apps/api/tests/test_session_api.py` | - | Logout revokes the row. |
| V7.4.2 | 1 | yes | met | `apps/api/src/vulnmart/accounts/status.py` `apps/api/tests/test_roles_and_admins.py` | - | Lock and delete end the sessions. |
| V7.4.3 | 2 | yes | met | `apps/api/src/vulnmart/accounts/self_service.py` `apps/api/tests/test_my_sessions_api.py` | - | A password change or reset ends the other sessions; log out everywhere exists. |
| V7.4.4 | 2 | yes | partly | `apps/web/app` | E | Logout is in the web header; the lab console has it too; not every page was checked. |
| V7.4.5 | 2 | yes | partly | `apps/api/src/vulnmart/admin/ops.py` | F | An admin lock ends a person's sessions; no admin screen to end all sessions. |
| V7.5.1 | 2 | yes | met | `apps/api/src/vulnmart/accounts/me_api.py` `apps/api/tests/test_me_api.py` | - | Password change needs the current password; the second factor is changed with the password. |
| V7.5.2 | 2 | yes | met | `apps/api/src/vulnmart/accounts/me_api.py` `apps/api/tests/test_my_sessions_api.py` | - | List and end sessions. |
| V7.5.3 | 3 | L3 scope | met | `apps/api/src/vulnmart/admin/breakglass.py` | - | Break-glass needs a reason on top of the session. |
| V7.6.1 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No federation. |
| V7.6.2 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No federation. |
| V8.1.1 | 1 | yes | met | `docs/architecture/06-security.md` `contracts/db/table-owners.yaml` | - | Roles and tables documented; the privacy wall table lists every operation's class. |
| V8.1.2 | 2 | yes | partly | `docs/architecture/06-security.md` | G | Field-level rules (e.g. decoy flags hidden from the owner) are in code comments, not in one document. |
| V8.1.3 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | No contextual rules. |
| V8.1.4 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | No contextual rules. |
| V8.2.1 | 1 | yes | met | `apps/api/src/vulnmart/accounts/http.py` `apps/api/tests/test_role_gates.py` | - | Role gates per route; non-admins get the answer of an unknown route. |
| V8.2.2 | 1 | yes | met | `apps/api/tests/test_privacy_wall.py` `apps/api/tests/test_scenarios_candidate.py` | - | Every route with an id checks ownership; strangers get 404. |
| V8.2.3 | 2 | yes | met | `apps/api/src/vulnmart/lab/api.py` `apps/api/tests/test_scenarios_candidate.py` | - | Candidates do not see integrity flags, decoy or sharing signals; hidden results stay hidden until release. |
| V8.2.4 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | No adaptive controls. |
| V8.3.1 | 1 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | Authorisation is in the API, never in the client. |
| V8.3.2 | 3 | L3 scope | met | `apps/api/src/vulnmart/accounts/sessions.py` | - | Roles are read per request. |
| V8.3.3 | 3 | L3 scope | met | `apps/api/src/vulnmart/lab/api.py` | - | Access is by the signed-in person's own id. |
| V8.4.1 | 2 | yes | met | `apps/api/src/vulnmart/kernel/db.py` `apps/api/tests/test_companies_postgres.py` `apps/api/tests/test_scenarios_recruiter.py` | - | Organisation guard on queries; row-level security on Postgres. |
| V8.4.2 | 3 | L3 scope | met | `apps/api/src/vulnmart/admin/breakglass.py` `apps/api/src/vulnmart/accounts/sessions.py` | - | Admin: second factor, short idle timeout, break-glass for candidate data. |
| V9.1.1 | 1 | no | n.a. | `docs/architecture/06-security.md` | - | No JWT or other self-contained tokens (grep). |
| V9.1.2 | 1 | no | n.a. | `docs/architecture/06-security.md` | - | No JWT or other self-contained tokens (grep). |
| V9.1.3 | 1 | no | n.a. | `docs/architecture/06-security.md` | - | No JWT or other self-contained tokens (grep). |
| V9.2.1 | 1 | no | n.a. | `docs/architecture/06-security.md` | - | No JWT or other self-contained tokens (grep). |
| V9.2.2 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No JWT or other self-contained tokens (grep). |
| V9.2.3 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No JWT or other self-contained tokens (grep). |
| V9.2.4 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No JWT or other self-contained tokens (grep). |
| V10.1.1 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.1.2 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.2.1 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.2.2 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.2.3 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.3.1 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.3.2 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.3.3 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.3.4 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.3.5 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.1 | 1 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.2 | 1 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.3 | 1 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.4 | 1 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.5 | 1 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.6 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.7 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.8 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.9 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.10 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.11 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.12 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.13 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.14 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.15 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.4.16 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.5.1 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.5.2 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.5.3 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.5.4 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.5.5 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.6.1 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.6.2 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.7.1 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.7.2 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V10.7.3 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | The platform is neither an OAuth client nor a provider. |
| V11.1.1 | 2 | yes | partly | `docs/runbooks/keystore-and-audit-anchor.md` `docs/adr/0047-audit-log-on-postgres-and-key-service-over-a-separate-keystore.md` | G | Key service and rotation are documented; no key-management standard is named. |
| V11.1.2 | 2 | yes | partly | `docs/architecture/06-security.md` | G | No maintained cryptographic inventory. |
| V11.1.3 | 3 | L3 scope | not met | `docs/architecture/06-security.md` | G | No cryptographic discovery. |
| V11.1.4 | 3 | L3 scope | not met | `docs/architecture/06-security.md` | G | No migration plan for new standards. |
| V11.2.1 | 2 | yes | met | `apps/api/src/vulnmart/accounts/security.py` `apps/api/src/vulnmart/accounts/fieldkeys.py` | - | argon2-cffi and cryptography. |
| V11.2.2 | 2 | yes | partly | `apps/api/src/vulnmart/accounts/security.py` | G | Algorithms are named in code in few places; not designed for swap. |
| V11.2.3 | 2 | yes | met | `apps/api/src/vulnmart/accounts/fieldkeys.py` | - | 256-bit keys, SHA-256, AES-GCM. |
| V11.2.4 | 3 | L3 scope | met | `apps/api/src/vulnmart/kernel/origin.py` `apps/api/src/vulnmart/accounts/sessions.py` | - | hmac.compare_digest wherever secrets are compared. |
| V11.2.5 | 3 | L3 scope | met | `apps/api/src/vulnmart/accounts/fieldkeys.py` | - | Decryption failures are refused without detail. |
| V11.3.1 | 1 | yes | met | `apps/api/src/vulnmart/accounts/fieldkeys.py` | - | No ECB or PKCS1 v1.5. |
| V11.3.2 | 1 | yes | met | `apps/api/src/vulnmart/accounts/fieldkeys.py` `apps/api/src/vulnmart/kernel/keys.py` | - | AES-GCM. |
| V11.3.3 | 2 | yes | met | `apps/api/src/vulnmart/accounts/fieldkeys.py` | - | Authenticated encryption. |
| V11.3.4 | 3 | L3 scope | met | `apps/api/src/vulnmart/accounts/fieldkeys.py` | - | A fresh random nonce per encryption. |
| V11.3.5 | 3 | no | n.a. | `apps/api/src/vulnmart/accounts/fieldkeys.py` | - | AEAD is used; no separate MAC. |
| V11.4.1 | 1 | yes | met | `apps/api/src/vulnmart/accounts/fieldkeys.py` | - | SHA-256 and HMAC-SHA-256. |
| V11.4.2 | 2 | yes | met | `apps/api/src/vulnmart/accounts/security.py` | - | Argon2id at the OWASP profile. |
| V11.4.3 | 2 | yes | met | `apps/api/src/vulnmart/accounts/fieldkeys.py` | - | SHA-256. |
| V11.4.4 | 2 | yes | met | `apps/api/src/vulnmart/kernel/keys.py` | - | Keys come from random secrets, not passwords; the KEK is random. |
| V11.5.1 | 2 | yes | met | `apps/api/src/vulnmart/accounts/security.py` | - | secrets module. |
| V11.5.2 | 3 | L3 scope | met | `apps/api/src/vulnmart/accounts/security.py` | - | OS random source. |
| V11.6.1 | 2 | yes | met | `scripts/make-test-certs.ps1` `infra/deploy/Caddyfile.platform` | - | TLS and mTLS certificates use ECDSA or RSA from standard tools. |
| V11.6.2 | 3 | L3 scope | met | `infra/deploy/Caddyfile.platform` | - | Caddy's default key exchange. |
| V11.7.1 | 3 | L3 scope | not met | `docs/runbooks/isolation-vm-i.md` | C | No memory encryption on the VMs. |
| V11.7.2 | 3 | L3 scope | partly | `apps/api/src/vulnmart/kernel/keys.py` | G | Fields are sealed at rest and flags are never stored; no in-use encryption. |
| V12.1.1 | 1 | yes | met | `infra/deploy/Caddyfile.platform` `scripts/verify-deployed.mjs` | - | Caddy serves TLS 1.2 and 1.3. |
| V12.1.2 | 2 | yes | met | `infra/deploy/Caddyfile.platform` | - | Caddy's default cipher suites. |
| V12.1.3 | 2 | yes | met | `apps/api/tests/test_mtls.py` | - | The orchestrator client verifies certificates; test_mtls proves refusals. |
| V12.1.4 | 3 | L3 scope | not met | `infra/deploy/Caddyfile.platform` | C | OCSP stapling not checked. |
| V12.1.5 | 3 | L3 scope | not met | `infra/deploy/Caddyfile.platform` | C | ECH not enabled. |
| V12.2.1 | 1 | yes | met | `infra/deploy/Caddyfile.platform` `scripts/verify-deployed.mjs` | - | HTTPS everywhere; the http port redirects. |
| V12.2.2 | 1 | yes | met | `docs/runbooks/certificates.md` | - | Publicly trusted certificates through ACME. |
| V12.3.1 | 2 | yes | partly | `infra/deploy/platform.compose.yaml` | C | The mail provider and orchestrator links use TLS; the Mailpit demo mailer and the database link inside the compose network do not. |
| V12.3.2 | 2 | yes | met | `apps/api/tests/test_mtls.py` | - | TLS clients validate certificates. |
| V12.3.3 | 2 | yes | partly | `infra/deploy/platform.compose.yaml` | C | Services on the private compose network talk plain HTTP; the orchestrator link on the second VM is TLS. |
| V12.3.4 | 2 | yes | met | `apps/api/tests/test_mtls.py` `scripts/make-test-certs.ps1` | - | An internal CA is pinned for mTLS. |
| V12.3.5 | 3 | L3 scope | met | `apps/api/tests/test_mtls.py` `apps/api/src/vulnmart/ports/http_instance_host.py` | - | mTLS plus signed requests to the orchestrator. |
| V13.1.1 | 2 | yes | met | `docs/architecture/06-security.md` `docs/prd/PRD.md` | - | External services (mail, DNS, ACME, hosting) are documented. |
| V13.1.2 | 3 | L3 scope | partly | `infra/compose/compose.yaml` | C | Pool and connection limits are set per service but not documented together. |
| V13.1.3 | 3 | L3 scope | partly | `infra/compose/compose.yaml` | C | Container limits exist; the strategy is not documented. |
| V13.1.4 | 3 | L3 scope | partly | `docs/runbooks/keystore-and-audit-anchor.md` | C | Critical secrets are named; no rotation schedule. |
| V13.2.1 | 2 | yes | met | `apps/api/src/vulnmart/ports/http_instance_host.py` `apps/api/tests/test_mtls.py` | - | Signed requests (HMAC with nonce) and mTLS to the orchestrator. |
| V13.2.2 | 2 | yes | met | `apps/api/src/vulnmart/ports/http_instance_host.py` | - | Service accounts and keys per service. |
| V13.2.3 | 2 | yes | met | `scripts/deploy-secrets.mjs` | - | Generated secrets; no defaults (the deploy script refuses fixed values). |
| V13.2.4 | 2 | yes | met | `infra/deploy/platform.compose.yaml` | - | Egress is limited by the networks; the API reaches only the orchestrator and the mailer. |
| V13.2.5 | 2 | yes | met | `docs/runbooks/isolation-vm-i.md` | - | Shop instances have no route to the platform. |
| V13.2.6 | 3 | L3 scope | partly | `infra/compose/compose.yaml` | C | Documented limits and actual settings were not compared. |
| V13.3.1 | 2 | yes | partly | `scripts/deploy-secrets.mjs` `apps/api/src/vulnmart/kernel/keys.py` | C | A key service seals data keys; deployment secrets are files on the host, not a vault. |
| V13.3.2 | 2 | yes | met | `scripts/deploy-secrets.mjs` | - | Secret files per service with narrow modes. |
| V13.3.3 | 3 | L3 scope | partly | `apps/api/src/vulnmart/kernel/keys.py` | G | Keys are in the key service in a separate store; no HSM. |
| V13.3.4 | 3 | L3 scope | not met | `docs/runbooks/keystore-and-audit-anchor.md` | C | No rotation schedule. |
| V13.4.1 | 1 | yes | met | `apps/web/Dockerfile` `infra/deploy/Caddyfile.platform` | - | Images contain built output; .git is not served. |
| V13.4.2 | 2 | yes | met | `apps/api/src/vulnmart/kernel/settings.py` `apps/api/tests/test_lab_production_guard.py` | - | Staging and production refuse to start without secrets, with a fake instance host or with an in-memory lab store (package A, merged). |
| V13.4.3 | 2 | yes | met | `infra/deploy/Caddyfile.platform` | - | Caddy serves fixed routes and files; no directory browsing. |
| V13.4.4 | 2 | yes | partly | `infra/deploy/Caddyfile.platform` | C | TRACE was not tested on the deployed site. |
| V13.4.5 | 2 | yes | partly | `apps/api/src/vulnmart/kernel/service.py` `scripts/verify-deployed.mjs` | C | /docs and /openapi.json exposure on the deployed site is not part of verify-deployed. |
| V13.4.6 | 3 | L3 scope | met | `infra/deploy/Caddyfile.platform` | - | Server header removed. |
| V13.4.7 | 3 | L3 scope | met | `infra/deploy/Caddyfile.platform` | - | Fixed routes only. |
| V14.1.1 | 2 | yes | met | `docs/prd/PRD.md` `docs/architecture/06-security.md` | - | Personal data is classified (D-8x, FR-PRV). |
| V14.1.2 | 2 | yes | met | `docs/prd/PRD.md` | - | Retention, sealing and access rules per class. |
| V14.2.1 | 1 | yes | met | `apps/api/src/vulnmart/accounts/api.py` `apps/web/app/invite/page.tsx` | - | Secrets go in bodies; the invite token is read from the link once and kept in sessionStorage only until used. |
| V14.2.2 | 2 | yes | met | `apps/api/src/vulnmart/kernel/service.py` | - | Cache-Control no-store on every API answer. |
| V14.2.3 | 2 | yes | met | `infra/deploy/Caddyfile.platform` | - | CSP blocks third parties; no trackers. |
| V14.2.4 | 2 | yes | met | `apps/api/src/vulnmart/kernel/observability.py` `apps/api/src/vulnmart/privacy/retention/candidates.py` | - | Logging, retention and access follow classes. |
| V14.2.5 | 3 | L3 scope | met | `apps/api/src/vulnmart/kernel/service.py` | - | Private no-store on sensitive routes. |
| V14.2.6 | 3 | L3 scope | met | `apps/api/tests/test_data_minimum.py` | - | A dedicated test of the data minimum. |
| V14.2.7 | 3 | L3 scope | met | `apps/api/src/vulnmart/privacy/retention/candidates.py` `apps/api/tests/test_scenarios_refresh.py` `scripts/check-deployed-compose.mjs` | - | Retention jobs erase candidate records, idle learners and old rows (proved in test_l24); the deployed configuration has the scheduler on. |
| V14.2.8 | 3 | no | n.a. | `contracts/api/bundle/openapi.json` | - | No uploads. |
| V14.3.1 | 1 | yes | not met | `infra/deploy/Caddyfile.platform` | E | No Clear-Site-Data on logout. |
| V14.3.2 | 2 | yes | met | `apps/api/src/vulnmart/kernel/service.py` | - | no-store. |
| V14.3.3 | 2 | yes | partly | `apps/web/app/invite/page.tsx` | E | The invite token sits in sessionStorage until the invite is accepted. |
| V15.1.1 | 1 | yes | partly | `.github/workflows/ci.yml` | G | No written remediation time frames. |
| V15.1.2 | 2 | yes | partly | `.github/workflows/images.yml` | G | Images carry SBOM output; the Python and Node dependency inventory is the lock files. |
| V15.1.3 | 2 | yes | partly | `docs/architecture/06-security.md` | G | Password hashing and exports are known heavy paths; not catalogued. |
| V15.1.4 | 3 | L3 scope | not met | `docs/architecture/06-security.md` | G | No risky-component list. |
| V15.1.5 | 3 | L3 scope | partly | `docs/runbooks/isolation-vm-i.md` | G | The dangerous part (instances running hostile code) is documented; not as a list. |
| V15.2.1 | 1 | yes | partly | `.github/workflows/ci.yml` | G | Lock files are pinned; there is no scheduled vulnerability scan in CI. |
| V15.2.2 | 2 | yes | met | `apps/api/src/vulnmart/accounts/http.py` `apps/api/src/vulnmart/kernel/ratelimit.py` | - | Hash slots, body limits, rate limits. |
| V15.2.3 | 2 | yes | met | `apps/api/src/vulnmart/main.py` | - | Only the routes of the contract exist (contract test). |
| V15.2.4 | 3 | L3 scope | met | `pnpm-lock.yaml` `uv.lock` | - | Locked, from the registries. |
| V15.2.5 | 3 | L3 scope | partly | `docs/runbooks/isolation-vm-i.md` | C | Isolation (gVisor, separate VM) protects the dangerous part; not independently verified. |
| V15.3.1 | 1 | yes | met | `apps/api/tests/test_data_minimum.py` | - | Views build answers field by field. |
| V15.3.2 | 2 | yes | met | `apps/api/src/vulnmart/ports/http_instance_host.py` | - | No redirect following to arbitrary hosts. |
| V15.3.3 | 2 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | Strict models refuse extra fields. |
| V15.3.4 | 2 | yes | met | `apps/api/src/vulnmart/accounts/api.py` `apps/api/tests/test_accounts_api.py` | - | The client address rule is tested. |
| V15.3.5 | 2 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | Typed models; strict booleans (age declaration). |
| V15.3.6 | 2 | yes | met | `apps/web/app` | - | No object-merge code on untrusted JSON in the web app. |
| V15.3.7 | 2 | yes | met | `apps/api/src/vulnmart/lab/api.py` | - | Query parameters are listed and each at most once. |
| V15.4.1 | 3 | L3 scope | met | `apps/api/tests/test_scenarios_cross.py` | - | Locks in the lab stores; thread tests at runtime level. |
| V15.4.2 | 3 | L3 scope | met | `apps/api/tests/test_assessments_postgres.py` | - | Atomic checks and updates (Postgres tests). |
| V15.4.3 | 3 | L3 scope | partly | `apps/api/tests/test_scenarios_cross.py` | G | No deadlock analysis; the thread tests found a duplicate journal line (xc2b). |
| V15.4.4 | 3 | L3 scope | partly | `apps/api/src/vulnmart/accounts/http.py` | G | Hash slots bound the hashing work; no wider fairness review. |
| V16.1.1 | 2 | yes | partly | `docs/architecture/06-security.md` `apps/api/src/vulnmart/kernel/observability.py` | G | Logging is described in the architecture; no inventory per layer. |
| V16.2.1 | 2 | yes | met | `apps/api/src/vulnmart/kernel/observability.py` | - | JSON lines with time, service, request id. |
| V16.2.2 | 2 | yes | met | `apps/api/src/vulnmart/kernel/observability.py` | - | UTC with Z. |
| V16.2.3 | 2 | yes | partly | `apps/api/src/vulnmart/kernel/observability.py` | G | Stdout only; the log inventory is missing. |
| V16.2.4 | 2 | yes | met | `apps/api/src/vulnmart/kernel/observability.py` | - | One JSON format. |
| V16.2.5 | 2 | yes | met | `apps/api/tests/test_kernel_observability.py` `apps/api/tests/test_audit_log.py` | - | No secrets or flags in logs; audit entries use pseudonyms. |
| V16.3.1 | 2 | yes | met | `apps/api/src/vulnmart/accounts/sessions.py` `apps/api/tests/test_session_audit.py` | - | Sign-ins are audited. |
| V16.3.2 | 2 | yes | partly | `apps/api/src/vulnmart/kernel/observability.py` | G | Refusals are logged as requests; a dedicated audit event for failed authorisation is missing. |
| V16.3.3 | 2 | yes | met | `apps/api/src/vulnmart/kernel/audit.py` `apps/api/tests/test_audit_log.py` | - | Admin actions, break-glass and exports are audited. |
| V16.3.4 | 2 | yes | met | `apps/api/src/vulnmart/kernel/observability.py` `apps/api/tests/test_problem.py` | - | Unhandled errors are logged by type. |
| V16.4.1 | 2 | yes | met | `apps/api/src/vulnmart/kernel/observability.py` | - | JSON encoding of each field. |
| V16.4.2 | 2 | yes | met | `apps/api/src/vulnmart/kernel/audit.py` `docs/runbooks/keystore-and-audit-anchor.md` | - | Hash-chained audit log with a daily anchor. |
| V16.4.3 | 2 | yes | not met | `docs/runbooks/incident-procedure.md` | C | Logs stay on the host; no separate analysis system. |
| V16.5.1 | 2 | yes | met | `apps/api/src/vulnmart/problem.py` `apps/api/tests/test_problem.py` | - | Generic messages, no traces. |
| V16.5.2 | 2 | yes | partly | `apps/api/src/vulnmart/kernel/service.py` | G | Health checks degrade; the API has no circuit breaker for the orchestrator or mail. |
| V16.5.3 | 2 | yes | met | `apps/api/src/vulnmart/accounts/http.py` | - | Fails closed (rate limiter unavailable refuses). |
| V16.5.4 | 3 | L3 scope | met | `apps/api/src/vulnmart/kernel/observability.py` | - | A last-resort handler logs and answers 500. |
| V17.1.1 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No WebRTC. |
| V17.1.2 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | No WebRTC. |
| V17.2.1 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No WebRTC. |
| V17.2.2 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No WebRTC. |
| V17.2.3 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No WebRTC. |
| V17.2.4 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No WebRTC. |
| V17.2.5 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | No WebRTC. |
| V17.2.6 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | No WebRTC. |
| V17.2.7 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | No WebRTC. |
| V17.2.8 | 3 | no | n.a. | `docs/architecture/06-security.md` | - | No WebRTC. |
| V17.3.1 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No WebRTC. |
| V17.3.2 | 2 | no | n.a. | `docs/architecture/06-security.md` | - | No WebRTC. |
