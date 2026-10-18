# Runbook: laptop fallback for the demo (story 8.4, ADR 0015, D-96)

Goal: if the deployed site or a VM fails during the live demo of 19 Oct, show the product from the laptop in under 5 minutes, with one command.

What it is: the platform stack (Postgres, Valkey, Mailpit, migrations, API, dashboards) on Docker Desktop in its own Compose project `vulnmart-fallback`, optionally with the lab runtime. It shows the product. It does not restore production data (use `docs/runbooks/backup-restore.md` for that) and the instances are stubs or shop instances on the laptop, not the labs host.

Proven on 17 Oct 2026 on Tanmay's PC: `up --no-web`, `check` and `down` (evidence `docs/assets/story-8-4-backup-fallback/backup-fallback-output.txt`). Not proven: `up` with the dashboards (`web` profile) and `--lab` (story 1's lab runtime is not in the tree yet; the script refuses `--lab` until `apps/api/src/vulnmart/lab` exists). Run the full command once yourself before the demo (rehearsal pass 1 of `demo-19-oct.md`).

## Before the demo day (once, on the laptop)
1. Docker Desktop installed, "Engine running", and at least 6 GB of memory given to it.
2. `node --version` shows 24.x, `uv --version` works, repository checked out on the demo commit.
3. Build the images once while you have internet: `node scripts/fallback.mjs up`, then `node scripts/fallback.mjs check`, then `node scripts/fallback.mjs down`. After that the switch works offline for the stack itself.
4. Free ports on 127.0.0.1: 3000, 8000, 8025 (and 8100 with `--lab`). Close anything else that uses them.
5. No other VulnMart stack running: the Compose file uses fixed container names (`vulnmart-postgres`, `vulnmart-api` ...). `up` stops with a message naming the clash and starts nothing.

## When to switch
Use the failure table in `docs/runbooks/demo-19-oct.md`. In short: switch when the deployed site does not answer after the 5-minute recovery step there, or `live-smoke` fails on the pre-flight and you cannot fix it in 10 minutes. Decide out loud, say "switching to the local copy", do not debug live in front of the audience.

## The switch (about 3 minutes with warm images)
```powershell
node scripts/fallback.mjs up            # platform + dashboards; add --no-web to skip dashboards, --lab for the lab runtime
node scripts/fallback.mjs check         # PASS lines for api, mailpit, web and the 403 guard
```
`up` prints the local URLs: dashboards http://127.0.0.1:3000, API http://127.0.0.1:8000, Mailpit http://127.0.0.1:8025. With `--lab` it also starts the lab runtime on http://127.0.0.1:8100 with the demo routes switched on and a random token written to a file in the temp folder (`vulnmart-fallback\demo-token`); the script does not print the token.

For the live instance part of the demo, use the local demo: `node scripts/dev.mjs demo --keep` (its own project `vulnmart-demo`; stop the fallback first, the two cannot run together because of the fixed container names).

## What works in the fallback and what does not
| Works | Does not |
|---|---|
| Dashboards, API health, login and the API of the platform stack | The deployed hostnames, certificates and the Vercel proxy |
| Mailpit as the mail catcher | Real email |
| Lab runtime with in-memory attempts and score (`--lab`, once story 1 is merged) | Data of the production database (state is empty; restore only by hand, see the backup runbook) |
| Stub or shop instances through `node scripts/dev.mjs demo` | The labs host isolation (that is vm-i; the laptop shows behaviour, not the host rules) |

## Switch back and clean up
```powershell
node scripts/fallback.mjs down
```
Prints `PASS down` only when no container, network or volume of project `vulnmart-fallback` remains. It stops the lab runtime process it started, removes the state files in the temp folder, and touches nothing else (not `vulnmart-demo`, not other containers or volumes).

## Troubleshooting
- `FAIL port N is busy`: close what uses it (`netstat -ano | findstr :N`), run `up` again. Nothing was started.
- `FAIL containers of another VulnMart stack exist`: `node scripts/dev.mjs down` or `node scripts/dev.mjs demo down`, then `up` again.
- `compose up failed`: look at `docker compose -p vulnmart-fallback -f infra/compose/compose.yaml --profile platform logs api`. The script runs `down` for you after a failed `up`.
- `a fallback is already up`: run `down` first (or delete the folder `vulnmart-fallback` in your temp folder if a crash left a stale state file, then check `docker ps -a` for leftovers of the project).
- A crash in the middle: `docker compose -p vulnmart-fallback down -v --remove-orphans` removes everything of the project.
