# Message for Akshay: orchestrator contract (IF-5), ready to paste in the team chat

Date: 2026-10-09. From: Tanmay.

---

Hi Akshay, the orchestrator contract (IF-5) is in the repository, and part of it is for you to confirm.

What is there
- `contracts/orchestrator/orchestrator-api.md` and `orchestrator.openapi.yaml`: the seven calls, the signed state report, the state machine, signing, errors. At the end of the .md file is a table "Open points (to confirm)" with 33 proposals. None is decided.
- `apps/api` is already a Python package (`vulnmart-api`) with the `InstanceHost` protocol, `FakeInstanceHost`, `HttpInstanceHost` (standard library only) and tests. Please add your ports and fakes next to them in `apps/api/src/vulnmart/ports/` and your tests in `apps/api/tests/`. Please do not rename the package or change the pinned versions without telling me first.
- `contracts/mocks/fake-orchestrator/server.mjs` is a fake orchestrator you can run (Node, no dependencies). It now also speaks mutual TLS with the flags `--tls-cert`, `--tls-key` and `--tls-ca`.
- `docs/adr/0018-orchestrator-request-signing.md` records the signing rule (HMAC-SHA256 over method, request target, timestamp, nonce and body hash). It is still "Proposed".

What I need from you
- When you plan P-05 and P-08, your Claude will read your rows H-08 to H-23 and the new row H-83 in `docs/dev/HANDOFFS.md`. Confirm or change each proposal there.
- If you say nothing, the written proposals stand (all 33, and ADR 0018 stays Proposed). Review is optional during initial development (D-37).
- If you change something, tell me in this chat and I update the contract by pull request.

Not decided yet and not mine to decide: who writes the `InstancePort`, `AttemptPort` and `ReportPort` stubs (H-06, H-79), and production mTLS certificates (H-68).
