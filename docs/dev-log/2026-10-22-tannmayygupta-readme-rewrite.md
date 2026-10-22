# README rewrite for a first-time reader

| Field | Value |
|---|---|
| Date | 2026-10-22 |
| Developer | tannmayygupta |
| Branch / commit | readme-project-overview |
| Status | Done |
| Report tag | documentation |

## Requirements covered
Documentation (onboarding of a new reader or developer).

## Summary
The old `README.md` still said application code was not written, listed three developers and pointed at task files. It was replaced by a README that a person with no background can follow: what VulnMart is (with a driving-school comparison), the problem it solves, who uses it, the 11 challenges, a simple picture of how it works, what is in the repository, how to set up and run it on a computer, how to run the tests, how to deploy it, where secrets live, a map of the documentation, how the team works, a safety note, and who to ask.

## Why
Every guide on READMEs asks for the same things. GitHub's own guidance lists what the project does, why it is useful, how to get started, where to get help and who maintains it; Real Python and the make-a-readme guide add a clear first paragraph, step-by-step setup, usage examples, contribution rules, licence and contact, plain language, short sections with links to longer documents. The new README follows that order and links to the long documents (Project Guide, runbooks, architecture) instead of copying them.

Sources read: GitHub Docs "About the repository README file", makeareadme.com, Real Python "Creating Great README Files for Your Python Projects", and the KodeKloud and DEV Community notes on writing a README.

## What was built
`README.md` (about 250 lines).

## How it was checked
- All 36 relative links in the README were checked: none missing.
- Every script the README names exists (`dev.mjs`, `deploy-secrets.mjs`, `live-deploy.mjs`, `verify-deployed.mjs`, `verify-skills.mjs`, `apps/shop/dev/serve-local.mjs`).
- `node apps/shop/dev/serve-local.mjs` was started: `/healthz` and `/shop` answered 200.
- The tool versions in the table come from `.node-version`, `package.json` (`packageManager`), `.python-version` and `node scripts/dev.mjs doctor`.

## Tests
No code changed. `node scripts/check-text-files.mjs`: PASS.

## Problems met and how they were fixed
- Docker Desktop was not running on this PC, so `node scripts/dev.mjs up platform web` and the local demo were not run again for this change; their commands and ports come from the earlier verified runbooks (`docs/runbooks/local-demo.md`).

## Limitations and follow-ups
- No licence file exists; the README says so. Choosing a licence is the maintainer's decision.
- The deploy summary is short on purpose; `docs/runbooks/live-deploy.md` is the exact procedure.
