# Spike S-4: cold start and memory per instance

Status: **tool built and checked on the developer laptop; the real measurement on `vm-i` is NOT done yet** (developer-run, runbook `docs/runbooks/measure-instances.md`). No number below is a result for the labs host.

## What is measured
- Cold start: `create` accepted until `ready` (injector exit 0 and shop healthy), images already on the host. Ten rounds, one instance at a time.
- Memory: container memory (usage minus page cache) of all containers of one instance, with ten instances running; and the drop of host `MemAvailable` divided by the count.

## Laptop dry run (tool check only, not a result)
2026-10-12, Windows with Docker Desktop, stub instance image (two components), 2 rounds and 2 instances: cold start 7.1-7.8 s, container memory about 31 MB per instance, 0 failures, 0 leftovers. Output: `docs/assets/orchestrator-measure-laptop-dryrun/measure-result.json`. Docker Desktop runs in a VM, so these say nothing about vm-i. The host-memory drop is not available on Windows.

## Result on vm-i (to fill after the developer run)
| Item | Value |
|---|---|
| Host class (kernel, CPUs, total MB) | pending |
| Cold start, median / p95 / max (s), stub image | pending |
| Cold start with real shop images | pending (after T-04 and L-12) |
| Container memory per instance (MB) | pending |
| Host memory drop per instance (MB) | pending |
| Defaults derived for story 3.4 (health timeout, capacity per instance) | pending |

Open: the stub is far lighter than the real shop with its sidecar, import service and mocks, so the measurement must be repeated with real images before capacity numbers are final.
