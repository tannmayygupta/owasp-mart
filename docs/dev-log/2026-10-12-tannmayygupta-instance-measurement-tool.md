# S-4 measurement tool (story 3.3, L-13 part 3)

| Field | Value |
|---|---|
| Date | 2026-10-12 |
| Developer | tannmayygupta |
| Branch / commit | shared-L-13 (not pushed), later carried by sprint-2-tanmay |
| Status | Partly done: tool, runbook and note built; the real S-4 run on vm-i is not done |
| Report tag | spike S-4, orchestrator, measurement |

## Requirements covered
FR-INS-01 (cold start), spike S-4, task L-13 (row FR-INS-01 in `docs/traceability.md`).

## Summary (plain language, 3-5 lines)
A tool measures how long an instance takes to become ready and how much memory it uses, on the real Docker engine, and cleans up after itself. Only a laptop dry run was done; the numbers for vm-i do not exist yet.

## Why
Spike S-4 must give the real cold-start time and memory per instance on vm-i so the limits and capacity numbers (H-31, H-72) stop being placeholders.

## What was built
`vulnmart_orchestrator/measure.py` runs the real engine with the Docker backend, measures cold start over N rounds and container and host memory with N instances running, destroys everything, checks nothing is left and writes `measure-result.json`. Random fake flags, seed and key per run. Also `tests/test_measure.py`, the runbook `docs/runbooks/measure-instances.md` and the research note `docs/research/s4-cold-start-and-memory.md` (result table still pending).

## How it works
Cold start is measured with images already on the host (a pull is a one-off and not part of a start). The stub image is used first; real images later through `--manifest`.

## Files changed
- `apps/orchestrator/src/vulnmart_orchestrator/measure.py`, `apps/orchestrator/tests/test_measure.py`
- `docs/runbooks/measure-instances.md`, `docs/research/s4-cold-start-and-memory.md`

## Decisions made
No new decision.

## Tests
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests/test_measure.py`: 6 passed.
- Laptop dry run (Docker Desktop, 2 rounds, 2 instances): all ready, about 7.1 to 7.8 s, about 31 MB per instance, 0 leftovers. Not a result for vm-i.

## Evidence
`docs/assets/orchestrator-measure-laptop-dryrun/measure-result.json`.

## Problems met and how they were fixed
`Set-Content -Encoding utf8` wrote a BOM in PowerShell 5.1; removed (check-text-files would fail). Later (audit 2026-10-13) the runbook step that said `git clone` on vm-i was wrong, because vm-i allows no ssh or git egress; it now copies the repo from the PC.

## Security notes (vulnerable parts only)
None. Random fake flags and keys; the result holds only numbers and the host class.

## Limitations and follow-ups
The real run on vm-i is the developer's (credits, SSH, runbook). Until its output is recorded, the S-4 Done-when of L-13 is not met. Reset (3.4) and the reconciler (3.5) belong to L-14.