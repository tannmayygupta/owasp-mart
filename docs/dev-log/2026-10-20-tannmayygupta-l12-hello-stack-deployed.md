# L-12: the hello stack from CI on both VMs and the laptop

| Field | Value |
|---|---|
| Date | 2026-10-20 |
| Developer | tannmayygupta |
| Branch / commit | l-12-hello-stack-deployed |
| Status | Done |
| Report tag | deploy, L-12 |

## Requirements covered
L-12, LE-4, ADR 0032, D-51.

## Summary
The developer ran scripts/deploy.mjs with the release manifest of the latest CI run on main (hello image pinned by digest, public on GHCR) against vm-p, vm-i and the laptop. Every step passed on all three, including verify image (the container runs exactly the pulled digest). Run twice with the same result.

## Why
The Done-when of L-12: a hello stack from CI runs on both VMs and on the laptop. Claude could not run it: the permission system refused a production deploy from the session, so the developer ran it in their own window.

## What was built
Nothing new: scripts/deploy.mjs and infra/compose/hello-stack.yaml existed. The first attempt needed --identity (the key for the hosts).

## How it works
See docs/runbooks/deploy.md.

## Files changed
docs only: the evidence file, the task file, traceability, changelog.

## Decisions made
None. CI still holds no deploy credential (ADR 0032); arm64 stays off (D-51).

## Tests
The developer's run, pasted into docs/assets/production-readiness/l12-hello-deploy.txt: RESULT PASS twice.

## Evidence
docs/assets/production-readiness/l12-hello-deploy.txt

## Problems met and how they were fixed
The first command lacked --identity; the second typed a stray 123456 at the end of the command line, which was harmless (the same run again).

## Security notes
The hello container runs read only as a non-root user with all capabilities dropped, bound to loopback.

## Limitations and follow-ups
The containers of the hello stack were left running; remove them with docker rm -f vulnmart-hello-stack on each machine if wanted.
