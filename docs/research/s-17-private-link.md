# S-17: private link between VM-P and VM-I (spike record)

Status: **template; live fields empty until `node scripts/private-link-check.mjs` has run on the real hosts** (runbook Part C). No addresses here.

## Question
Do the two VMs reach each other over their private addresses on the named ports, with mutual TLS, and how fast?

## Design (from the code, read 2026-10-10)
- One VCN, one subnet, one network security group per VM. Private ingress rules are in `infra/terraform/oci/network-rules.json`: from `vm-p` to `vm-i` on 9443 (orchestrator, architecture 02 F-07) and from `vm-i` to `vm-p` on 9444 (ingest internal listener, F-08 and F-13). Both ports are **proposals**; production certificates and rotation stay open (handoff H-68).
- The check generates a throwaway CA and one node certificate on VM-P (both private addresses as names, client and server use), copies them to a `0700` folder in `/dev/shm` on VM-I, starts a TLS server bound to the private address (certificate required), connects with a client certificate (must succeed), connects without one (must be refused), measures 20 TCP connect times, then deletes the folder on both hosts and checks it is gone.
- The helper programs were run locally on loopback in a container on 2026-10-10 (`docs/assets/l-08-oracle-hosts/local-mtls-helper-check.txt`); that is not a result for the Oracle hosts.

## Fields to fill from the live run
| Field | VM-P to VM-I (9443) | VM-I to VM-P (9444) |
|---|---|---|
| TCP connect min / median / p95 / max (ms) | | |
| Mutual-TLS handshake (TLS version, ms) | | |
| Client without certificate refused | | |
| Port closed from the internet (both public addresses) | | |
| Certificates left on hosts | | |

## Rules recorded
- Ingress to the link ports comes only from the other VM's network group, never from an address range.
- The host firewall accepts the link ports only from the subnet range.
- Open questions: final ports (S-17, L-13, IF-4), certificate issuing and rotation for production (H-68), whether latency allows synchronous calls from the platform to the orchestrator.
