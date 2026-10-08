# 0011. Multi-architecture builds and image registry

- **Status:** arm64 built natively on the VM is Accepted (D-28); the rest is Proposed
- **Date:** 2026-10-08
- **Deciders:** the user (D-28) for the VM build; pending for the rest
- **Requirements:** NFR-POR-02, NFR-MNT-04, NFR-CST-02, D-14

## Context
Oracle's VM is arm64, all developer machines are amd64. Images need both.

## Options considered
1. Build arm64 natively on the Oracle VM, amd64 in CI (D-28).
2. Native matrix on GitHub runners: `ubuntu-24.04-arm` now works in private repos with 2 vCPU and uses free minutes; the minutes ratio is not stated.
3. QEMU emulation on one runner: Docker says it can significantly extend build times.
Registry: GHCR (private quota conflict in its docs), Docker Hub, or no registry (build on the VM).

## Decision
Option 1 (D-28). Proposed refinement: CI on amd64 runners runs tests and exploit checks; if the 2,000 free minutes allow (spike S-21), add the GitHub arm64 runner so arm64 failures appear before deploy. Registry decision left open; building on the VM needs none.

## Consequences
Builds on the VM use its CPU, so schedule them away from demos and pilots. The custom Caddy build (DNS plugin) must build on both architectures.

## Evidence
https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories (VERIFIED); https://docs.github.com/en/billing/concepts/product-billing/github-actions (VERIFIED, ratio UNVERIFIED); https://docs.docker.com/build/ci/github-actions/multi-platform/ (VERIFIED); https://docs.github.com/en/billing/concepts/product-billing/github-packages (CONFLICTING).
