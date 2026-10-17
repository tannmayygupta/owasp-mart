# 0039. No warm pool for the first release; the numbers that would change it

- **Status:** Proposed (D-59, decided on the developer's delegation, story 3.6 "Concurrency, quotas, start failures, warm-pool decision", 2026-10-16; to be confirmed by the developer after the vm-i numbers)
- **Date:** 2026-10-16
- **Deciders:** Tanmay (by delegation to Claude Code)
- **Requirements:** FR-INS-06, FR-INS-07, FR-INS-08, FR-INS-09, OI-21, OI-24, D-59; handoffs H-66, H-72, H-79; spike S-4

## Context
A learner who presses "start" waits for a cold start: network and volumes, containers, the injector with the flags, then every healthcheck. A warm pool would keep some instances already built and hand one out at once, but it costs memory all day for instances nobody uses, needs flags and the owner put in after the build (which breaks "the injector runs once, before anything else", IF-6), and adds a second life cycle (pool, refill, expire).

What is measured today: only on a developer PC with Docker Desktop and the two-component stub image. Cold start (create until `ready`, the destroy is not counted) about 7 s for one instance at a time, and 7.6 s for 3 started together (`docs/assets/story-3-6-concurrency-quotas/`, local only). Nothing is measured on vm-i, and nothing with the real shop image. Those numbers say little about the real host.

## Options considered
1. **No warm pool for the first release (chosen).** Simplest, no idle memory, the flag path stays as designed. Cost: the learner waits the cold start. Mitigations already built: a cap on parallel builds so a burst does not overload Docker, one retry of a failed start, a quota so one user cannot take the host.
2. **A small fixed warm pool.** Faster start. Needs flags injected into a running instance (a new path), holds memory when nobody uses it, and its size is a guess before we know the real cold start and the real number of users.
3. **A pool that grows with demand.** Best fit later; the most code. Not justified without numbers.

## Decision
No warm pool for the first release. Revisit when, measured on vm-i with the real images, the cold start of the shop template is above 30 s at the 95th percentile, or when any start is refused for capacity. Both are read from the `concurrent_start` block of `measure.py --concurrent N`: the 95th percentile is `ready_after_s.p95` (time from the call until `ready`, a wait for a build slot is inside it) and a refusal is a non-zero `busy` (the host answered ORCH-BUSY). The earlier wording "more than 10 percent of starts wait for capacity" was dropped because the JSON cannot show it; a wait for a build slot shows up in `ready_after_s`. Neither number is measured yet.

## Consequences
- Easier: one code path for every start; the capacity number stays the memory of the live instances only.
- Harder: a classroom that starts everyone at the same moment sees the cold start, plus the wait for a build slot (default 4 builds together, setting `max_parallel_builds`).
- Quota and retry: a `failed` instance frees its quota place, but the orchestrator can move `failed` back to `provisioning` on a start retry, so a user can briefly hold one more instance than the quota. The fake accepts this; the real `QuotaPort` and `InstancePort` should count a `failed` instance whose retry is pending (the orchestrator reports `failed` and then `provisioning`, and the platform sees both). Written in handoff H-126.
- A waiting build has no queue order (it polls and is woken together with the others), so under sustained load a build can wait longer than a later one; a retry keeps its build slot for up to (1 + `start_retries`) health timeouts. Both are in `deferred-work.md`.
- To watch: the cold start with the real shop image, and the time spent waiting for a slot. The runbook `docs/runbooks/measure-instances.md` has a numbered `--concurrent` step for vm-i; its result is the developer's.
- **Not measured yet:** anything on vm-i, anything with the real images, any real user load. The local numbers must not be quoted as results.

## Evidence
- Local run only (Windows, Docker Desktop, stub image): `docs/assets/story-3-6-concurrency-quotas/measure-concurrent-3-output.txt` and `measure-result.json`.
- Spike S-4 note `docs/research/s4-cold-start-and-memory.md` (table still empty until the vm-i run).
- No outside source was needed for this decision; the thresholds (30 s at the 95th percentile, 10 percent waiting) were set by the story plan and are an engineering judgement, not a published standard. Unverified until measured.
