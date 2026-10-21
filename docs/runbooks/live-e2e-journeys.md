# Live role journeys (recruiter, candidate, admin)

`scripts/e2e-live.mjs` walks one learner. `scripts/e2e-live-journeys.mjs` (tracker audit 2026-10-21, L-30; work package G) walks the hiring product against a deployed site:
recruiter creates a template and invites, the candidate signs up, opens the invite, accepts, consents and starts, a flag is read off the shop and pasted, the candidate submits,
the results stay hidden, the recruiter reads the report, releases the results, the candidate then sees the same score, the company export, and the admin (with the second factor)
reads the queue, users, capacity and audit log and cannot read the candidate's answers without break-glass. It prints PASS, FAIL or SKIP per check and never prints a password,
cookie, ticket, token or flag.

## Before you run it (one time per deployment)

The run needs two people that already exist on the deployed site. Make them yourself; the script never creates companies or admins.

1. A recruiter whose company is **active** and whose owner **accepted the terms** (sign up on the site, approve it as the admin, accept the terms). Use a throw-away work address.
2. The seeded admin with its authenticator (`docs/runbooks/seed-admin.md`) and the base32 secret of that authenticator. Without the secret use `--skip-admin`.

Put the values in the environment of your own terminal for this run only. They never go on the command line, into a file of the repository or into a document:

```powershell
$env:VM_E2E_RECRUITER_EMAIL = '<the recruiter address>'
$env:VM_E2E_RECRUITER_PASSWORD = '<its password>'
$env:VM_E2E_ADMIN_EMAIL = '<the admin address>'
$env:VM_E2E_ADMIN_PASSWORD = '<its password>'
$env:VM_E2E_ADMIN_TOTP_SECRET = '<the base32 secret>'
```

## The command, after the deploy

The candidate's mail (confirmation and invite) is read from the Mailpit container on VM-P over ssh, the same way `e2e-live.mjs` does (`docs/runbooks/live-deploy.md`, secrets folder and ssh path as there):

```powershell
node scripts/e2e-live-journeys.mjs --base https://<platform host> --mailpit-ssh ubuntu@<vm-p address> --json docs/assets/live-e2e-journeys/<date>.json
```

First check the plan and the environment without any request:

```powershell
node scripts/e2e-live-journeys.mjs --base https://<platform host> --mailpit-ssh ubuntu@<vm-p address> --dry-run
```

Exit code 0 means every check passed or was skipped on purpose, 1 means a check failed, 2 means a bad argument or a missing variable (the message names the variable, never its value).
The run leaves one candidate account (`e2e-cand-...@example.test`) and one template on the site. The candidate's instance is freed by the submit. Remove the account with the admin
(`actOnUser` delete) if you want the site clean, and record the result in a dev-log with the real output.

## The local variant (no deployment needed)

The API of the browser tests runs the real routes on SQLite with the in-memory fake instance host (`apps/api/tests/e2e_web_server.py`). It seeds a recruiter, a candidate and an invite
and has test hooks for the flag. The script uses the seeded candidate and invite:

```powershell
uv run --locked --package vulnmart-api python apps/api/tests/e2e_web_server.py --port 18080 --web-origin http://127.0.0.1:18080 --out state.json
$s = Get-Content state.json -Raw | ConvertFrom-Json
$env:VM_E2E_RECRUITER_EMAIL = $s.recruiter_email; $env:VM_E2E_RECRUITER_PASSWORD = $s.password
node scripts/e2e-live-journeys.mjs --local-e2e http://127.0.0.1:18080 --skip-admin
```

A fresh server is needed for each run (the seeded invite is used up). Checks that need the company, view-history and export services are reported as `SKIP` because that test
server does not mount them (they answer 500 there). The recorded local run of 2026-10-21 is in the dev-log of this task: 15 PASS, 0 FAIL, 4 SKIP. The Compose platform profile
(`infra/compose/compose.yaml`, Mailpit on 127.0.0.1:8025) can be used instead with `--base`, a loopback `--mailpit-url http://127.0.0.1:8025`, and an https origin; it was not run for this task.

## What a failure means

| Failing check | Look at |
|---|---|
| the recruiter signs in, company not active | the recruiter or company state; approve the company and accept the terms |
| the invite mail carries the token | Mailpit on VM-P (the mail provider is Mailpit on the demo, LB-1 of the role-scenario audit) |
| Start / the instance runs | `scripts/live-free-test-instances.mjs`, capacity, the orchestrator logs |
| a flag is found, pasted and credited | the shop image and the sidecar; compare `scripts/e2e-live.mjs` |
| the results stay hidden / the candidate then sees the same score | package A (results visibility is enforced on main today) |
| the admin signs in with the second factor | the admin's TOTP secret and the server clock |
| without break-glass the admin reads no candidate answers | `docs/audit/2026-10-21-scenario-matrix.md` A-17 |

Not run yet on a deployed site: the lead runs it after the deploy.
