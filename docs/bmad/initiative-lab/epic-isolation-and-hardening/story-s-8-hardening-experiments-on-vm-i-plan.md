---
title: 'S-8 hardening experiments on VM-I: user namespaces, rootless Docker, gVisor and wider Docker address pools, keeping only what passes the probe and an instance run (L-29 part 2)'
type: 'feature'
ticket: '4'
created: '2026-10-18'
status: 'dropped'
route: 'full'
risk: 'high'
---

## Why dropped
The developer decided on 2026-10-18 to skip the live S-8 experiments for the 19 Oct demo (the remote Docker config change was also refused by the automatic safety check). Nothing was changed on vm-i. Reasoning only: docs/research/s-8-instance-sandboxing.md. Reopen after the demo; the probe already has a --runtime option for the gVisor test.
