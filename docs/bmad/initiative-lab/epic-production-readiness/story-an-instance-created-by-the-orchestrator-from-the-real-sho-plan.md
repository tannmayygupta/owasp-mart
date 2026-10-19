---
title: 'An instance created by the orchestrator from the real shop image, locally and on vm-i'
type: 'feature'
ticket: '4'
created: '2026-10-18'
status: 'review'
baseline_revision: '915317e'
route: 'full'
risk: 'high'
---

## Intent
The orchestrator creates, resets and destroys instances through the Docker backend, and a flag read from the real shop credits a milestone.

## Result (honest state, 2026-10-18)
Done on vm-i: the orchestrator creates a complete instance (shop, sidecar, injector, import, mock, bot, volume keeper) from digest-pinned images, 7 at once, with the audit and isolation checks passing (docs/assets/production-readiness/).
Not done: the shop in those instances is the stub shop with planted flags. The real shop has no injector yet (stream T, tasks T-17 to T-32), so a real exploitable shop instance cannot start. This story stays in progress until that exists; it must not be marked done before.

## Update 2026-10-19
The real shop now runs in instances: the missing real injector was built (docs/dev-log/2026-10-19-tannmayygupta-real-shop-injector.md), the orchestrator creates, resets and destroys instances of the real shop on vm-i, and a flag read from the real shop credits a milestone (deployed journey 30 of 30). Not yet shown: the isolation probe from inside an orchestrator-made instance. Waiting for the developer's confirmation before the state is done.
Live link: the console at the root of the site was found empty (stale mount) and fixed; demo accounts exist; journey 31 of 31 (docs/dev-log/2026-10-19-tannmayygupta-real-shop-injector.md).
Akshay's merged work is wired in (live events, invite rules, free learner hints): docs/dev-log/2026-10-19-tannmayygupta-wiring-akshay-live-events-and-invite-rules.md.
