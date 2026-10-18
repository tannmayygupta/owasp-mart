# S-8 instance sandboxing options (reasoning only, live tests NOT run)

Status: 2026-10-18. The live experiments on vm-i (userns-remap, gVisor) were **not run**. The developer decided to skip them for the 19 Oct demo (the automatic safety check also refused the remote Docker config change). Everything below is reasoning from the design and from the S-3/S-15 measurements, not a measured result.

## What is already in place (measured, see `s-3-s-15-vm-i-isolation.md`)
- Per-instance internal network, host INPUT drop rules per covered subnet, DOCKER-USER jump, audit 8 PASS, isolation probe PASS on vm-i.
- Instance containers run with dropped capabilities, a non-root user and limits (L-15/L-16 design).

## Options and decision

| Option | Gain | Cost / risk | Decision for demo |
|---|---|---|---|
| userns-remap | root in a container is not root on the host | the orchestrator and socket proxy need the host socket; named volumes written by uid 65532 and image storage move to a remapped directory; whole-daemon setting | Not enabled. Not tested. Revisit after demo with a test on an empty vm-i. |
| gVisor (runsc) | separate user-space kernel, strongest isolation for hostile exploit code | extra install, slower start, some syscalls missing; start time and memory not measured | Not enabled. Probe supports `--runtime runsc` so it can be tested later. |
| Rootless Docker | no root daemon | bridge networks and our iptables host rules behave differently; the egress script assumes the rootful daemon | Rejected for now: would invalidate the measured S-3 isolation result. |
| Address pool | more networks | S-3 found a subnet outside the covered set leaks gateway:22 | Keep one /16 pool with /24 networks (256 networks), inside the covered set. |

## Open follow-ups
- Run the userns-remap and runsc experiments on an empty vm-i, each reversible, with the isolation probe (`--runtime`) as the pass/fail check.
- Record results here only after they are run.
