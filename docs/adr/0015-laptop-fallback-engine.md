# 0015. Laptop fallback and developer engine

- **Status:** Proposed
- **Date:** 2026-10-08
- **Deciders:** (pending the user)
- **Requirements:** NFR-AVL-02, NFR-ISO-02, NFR-ISO-06, NFR-POR-03, D-15

## Context
The demo laptop (Windows 11 Home) is the fallback host. Docker Desktop's VM cannot take the host-side drop rule.

## Options considered
1. Docker Desktop with WSL2 for everything: easy, rule not installable.
2. Docker Engine inside a dedicated WSL2 Ubuntu distro for the fallback demo (rule installable, matches NFR-ISO-06 wording), Docker Desktop for daily development.
3. A full VM or dual boot: heavy.

## Decision (proposed)
Option 2 if spike S-3 shows the rule works there; otherwise option 1 with the laptop marked lower assurance (no platform secrets, not publicly exposed). Developers keep Docker Desktop on Windows and Intel Mac.

## Consequences
Extra setup on Tanmay's PC (WSL and Docker data on D:). Docker's Windows page lists WSL 2 requirements without the Home edition yet says Home runs Linux containers, so Home must be tested first (R-16, OI-6).

## Evidence
https://docs.docker.com/desktop/setup/install/windows-install/ (CONFLICTING for Home); https://docs.docker.com/desktop/setup/install/mac-install/ (VERIFIED, Intel supported); RS-A section 1.4 (`.wslconfig` keys verified there); systemd in WSL UNVERIFIED here.
