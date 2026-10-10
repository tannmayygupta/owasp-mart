# S-17: private link between VM-P and VM-I (spike record)

Status: **live result recorded 2026-10-11** (AWS Sydney, runbook Part C): `RESULT PASS (22 checks)`. No addresses here.

## Question
Do the two VMs reach each other over their private addresses on the named ports, with mutual TLS, and how fast?

## Design (from the code, read 2026-10-10)
- Retargeted to AWS on 2026-10-11 (D-41, story 2.6): one VPC, one subnet, one security group per host (the Oracle text "VCN" and "network security group" below means the same on AWS). Private ingress rules are in `infra/network-rules.json`: from `vm-p` to `vm-i` on 9443 (orchestrator, architecture 02 F-07) and from `vm-i` to `vm-p` on 9444 (ingest internal listener, F-08 and F-13). Both ports are **proposals**; production certificates and rotation stay open (handoff H-68).
- The check generates a throwaway CA and one node certificate on VM-P (both private addresses as names, client and server use), copies them to a `0700` folder under `/run` (memory-backed; created with sudo; `/dev/shm` was tried first and is wiped by systemd-logind when an ssh session ends, found in the first live run) on VM-I, starts a TLS server bound to the private address (certificate required), connects with a client certificate (must succeed), connects without one (must be refused), measures 20 TCP connect times, then deletes the folder on both hosts and checks it is gone.
- The helper programs were run locally on loopback in a container on 2026-10-10 (`docs/assets/l-08-oracle-hosts/local-mtls-helper-check.txt`); that is not a result for the real hosts. Evidence of the live run goes to `docs/assets/l-08-aws-hosts/`.

## Fields to fill from the live run
| Field | VM-P to VM-I (9443) | VM-I to VM-P (9444) |
|---|---|---|
| TCP connect min / median / p95 / max (ms) | 0.38 / 0.44 / 0.68 / 1.79 (n=20) | 0.41 / 0.44 / 0.70 / 1.25 (n=20) |
| Mutual-TLS handshake (TLS version, ms) | TLSv1.3, tcp 2.61, handshake 2.43 | TLSv1.3, tcp 1.31, handshake 2.15 |
| Client without certificate refused | yes (SSLError, rejection in the server log) | yes (SSLError, rejection in the server log) |
| Port closed from the internet (both public addresses) | yes (timeout) | yes (timeout) |
| Certificates left on hosts | none | none |
## Rules recorded
- Ingress to the link ports comes only from the other VM's network group, never from an address range.
- The host firewall accepts the link ports only from the subnet range.
- Open questions: final ports (S-17, L-13, IF-4), certificate issuing and rotation for production (H-68), whether latency allows synchronous calls from the platform to the orchestrator.
- Result: the link works in both directions with mutual TLS on TLS 1.3; the median connect time is about 0.44 ms, so synchronous calls from the platform to the orchestrator are not limited by the link. The wrong direction (vm-i to vm-p on 9443, vm-p to vm-i on 9444) and an unlisted port (9445) are dropped by the security groups (timeouts). Evidence: docs/assets/l-08-aws-hosts/private-link-check.txt (addresses redacted).
