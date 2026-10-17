# Spike S-4: cold start and memory per instance

Status: **measured on `vm-i` on 2026-10-17 with the STUB image** (run by Claude over SSH on the developer's authorisation, runbook `docs/runbooks/measure-instances.md`). The stub is a floor: the measurement with the real shop images (after T-04 and L-12) is still open.

## What is measured
- Cold start: `create` accepted until `ready` (injector exit 0 and shop healthy), images already on the host. Ten rounds, one instance at a time.
- Memory: container memory (usage minus page cache) of all containers of one instance, with ten instances running; and the drop of host `MemAvailable` divided by the count.

## Laptop dry run (tool check only, not a result)
2026-10-12, Windows with Docker Desktop, stub instance image (two components), 2 rounds and 2 instances: cold start 7.1-7.8 s, container memory about 31 MB per instance, 0 failures, 0 leftovers. Output: `docs/assets/orchestrator-measure-laptop-dryrun/measure-result.json`. Docker Desktop runs in a VM, so these say nothing about vm-i. The host-memory drop is not available on Windows.

## Result on vm-i (2026-10-17, stub image, evidence `docs/assets/orchestrator-measure/vm-i-s4-measure-result.json` and `docs/assets/story-3-6-concurrency-quotas/vm-i-concurrent-10.json`, `vm-i-concurrent-20.json`)
| Item | Value |
|---|---|
| Host class (kernel, CPUs, total MB) | Linux 7.0.0 (aws kernel), x86_64, 2 CPUs, 7776 MB; Docker 29.9.0 |
| Cold start, stub image, 10 rounds one at a time (s) | min 1.93, median 2.12, p95 2.81, max 2.81 |
| Create while 10 instances run (s) | median 2.07, p95 2.21 |
| Cold start with real shop images | pending (after T-04 and L-12) |
| Container memory per instance (MB), 10 running | median 30.41, p95 30.67 (limit 256) |
| Host memory drop per instance (MB) | 39.5 (394.8 MB for 10) |
| 10 instances started at once | 10 of 10 ready, 0 failed, 0 refused, wall 8.04 s, ready after: median 5.59 s, p95 8.04 s; most builds together 4 (the cap) |
| 20 instances started at once | 20 of 20 ready, 0 failed, 0 refused, wall 16.14 s, ready after: median 9.18 s, p95 16.13 s; most builds together 4 |
| Failures and leftovers | 0 and 0 in all three runs; containers and volumes on the host unchanged (0 and 0) |
| Defaults derived for story 3.4 (health timeout, capacity per instance) | From the stub only: health timeout about 3 x p95 = 9 s, capacity per instance about 40 MB plus a margin. NOT applied: the real shop with sidecar, import service and mocks is much heavier. Warm pool (ADR 0039, accepted): not needed on these numbers (no refusals; p95 16 s is below 30 s), to be re-read with the real images. |
Open: the stub is far lighter than the real shop with its sidecar, import service and mocks, so the measurement must be repeated with real images before capacity numbers are final.
