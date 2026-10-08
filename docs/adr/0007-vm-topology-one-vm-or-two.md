# 0007. Host topology: one Oracle VM or two

- **Status:** Accepted by the user (D-34, 2026-10-08): two Oracle VMs, VM-P (platform and personal data) and VM-I (hostile instances). This amends the wording of D-15, which said "an Oracle VM".
- **Date:** 2026-10-08
- **Deciders:** (pending the user)
- **Requirements:** D-15, D-23, NFR-ISO-06, NFR-AVL-01, FR-INS-06; OI-28

## Context
NFR-ISO-06 wants the orchestrator and instances in a dedicated VM "not next to personal data", yet the platform database holds candidate data and D-15 reads as one VM.

## Options considered
A. One VM (2 OCPU, 12 GB) for everything. Simplest; all CPU shared; a container escape reaches the database host.
B. Two Arm VMs inside the same free allowance: VM-P (platform, personal data) and VM-I (hostile instances). Blast-radius benefit and NFR-ISO-06 met. Costs: about 1 OCPU each so instances get less CPU and memory; both VMs must stay active against Oracle's 7-day idle reclaim; two machines to operate; a private link with mTLS; whether the account may hold two A1 instances is not confirmed on Oracle's page.
C. Managed free database and cache plus one VM: sleeping database, command quotas, third-party processor.

## Decision (proposed)
B as target, with A selectable by configuration only. If you keep A, amend NFR-ISO-06 and accept the residual risk.

## Consequences
Under B the flag key, database and keystore never share a host with instances. Capacity model and the memory split depend on spike S-4; the private link on S-17.

## Evidence
https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm (VERIFIED: budget and idle rule; instance count UNVERIFIED). See docs/architecture/02-deployment-and-network.md.
