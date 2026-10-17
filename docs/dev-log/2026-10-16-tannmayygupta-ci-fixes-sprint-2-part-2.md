# CI fixes of the pull request for sprint 2 part 2 (stream L)

| Field | Value |
|---|---|
| Date | 2026-10-16 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-2-tanmay-b` |
| Status | Done (the next CI run on GitHub is the proof) |
| Report tag | CI, isolation probe, compose profiles |

## Requirements covered
NFR-ISO-01, NFR-ISO-02 (spike S-3), story 4.1 (isolation probe) and story 4.2 (socket proxy in the `lab` profile).

## Summary (plain language)
The first CI run of the pull request failed in two places, both caused by my stories and both invisible on my Windows machine with Docker Desktop. The isolation probe found the host's own SSH answering on the bridge gateway of the Linux runner, which is exactly the gap that spike S-3 measures; and a test expected the `lab` Compose profile to be empty, but story 4.2 put the Docker socket proxy there.

## Why
A test that only passes on Docker Desktop is a wrong test for a Linux CI job, and the probe must be allowed to show the S-3 gap without failing the build.

## What was built
- `scripts/isolation-probe.test.mjs`: the real-Docker test now accepts, on Linux, an exit 1 whose only problems are open ports of the network gateway (a host without the host rule of `infra/hosts/vulnmart-egress.sh`); every other target must still be blocked, the control must connect and nothing may be left. On Docker Desktop the probe must still pass completely.
- `scripts/e2e/dev.e2e.test.mjs`: the test of an empty profile uses `mocks`; `README.md` says what `lab` holds.

## How it works
Docker's internal network has no route out, but the host's bridge address is the host itself: a service that listens on all addresses (SSH on a CI runner) answers there unless the host drops instance-to-host traffic. This is why NFR-ISO-02 needs the host rule and why the VM-I runbook runs the probe with the rule on and off.

## Files changed
- `scripts/isolation-probe.test.mjs`, `scripts/e2e/dev.e2e.test.mjs`, `README.md`, `CHANGELOG.md`, `docs/bmad/initiative-lab/deferred-work.md`

## Decisions made
None new (D-57 and D-58 stand).

## Tests
- `node --test scripts/isolation-probe.test.mjs` -- 18 passed (Docker Desktop).
- `node --test --test-name-pattern "profile with no services" scripts/e2e/dev.e2e.test.mjs` -- 1 passed.
- `node scripts/check-text-files.mjs` -- PASS.
The Linux branch of the probe test ran only on the CI runner (the log that showed the failure); it runs for the first time as written on the next CI run.

## Evidence
The failing CI logs were pasted by the developer (not stored).

## Problems met and how they were fixed
The probe test and the empty-profile test were never run on Linux before the push. The lesson is in `deferred-work.md`: run `scripts/e2e/*` and the probe test in the Linux image (`pnpm run ci:linux` is not used alone because of low memory) or accept one CI round for tests that depend on the host.

## Security notes (vulnerable parts only)
No planted weakness. Finding for S-3: an instance network that is `internal` can still reach the host through the bridge gateway address; only the host rule stops it.

## Limitations and follow-ups
The VM-I run (rule off, rule on) is still the developer's.