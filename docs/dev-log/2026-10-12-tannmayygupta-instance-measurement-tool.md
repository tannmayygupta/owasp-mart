# Dev-log: S-4 measurement tool (story 3.3, L-13 part 3)

- **Date:** 2026-10-12 · **Developer:** tannmayygupta · **Branch:** shared-L-13 · **Task:** L-13

## What was done
Added `vulnmart_orchestrator/measure.py`: runs the real engine with the real Docker backend, measures cold start over N rounds and container/host memory with N instances running, destroys everything and checks nothing is left; writes `measure-result.json`. Random fake flags, seed and key per run. Added `tests/test_measure.py`, the runbook `docs/runbooks/measure-instances.md` and the research note `docs/research/s4-cold-start-and-memory.md` (result table still pending).

## Decisions
No new decision. Cold start is measured with images already on the host (a pull is a one-off and not part of a start). Stub image first, real images later (`--manifest`).

## Tests and results (real)
- `uv run --locked --package vulnmart-orchestrator pytest -q apps/orchestrator/tests/test_measure.py`: 6 passed.
- Laptop dry run (Docker Desktop, 2 rounds, 2 instances): all ready, about 7.1-7.8 s, about 31 MB per instance, 0 leftovers. Not a result for vm-i.

## Problems
`Set-Content -Encoding utf8` wrote a BOM in PowerShell 5.1; removed (check-text-files would fail).

## Open
The real run on vm-i is the developer's (credits, SSH). Until its output is recorded, story 3.3 and task L-13 are not done.
