---
title: 'L-04 limits: mTLS test, Akshay handoff and CI check'
type: 'chore'
ticket: '10'
created: '2026-10-09'
status: 'built'
baseline_revision: '3180e581b0d9c39a5042e8014b28ba2cf53344fe'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 1.4 left three limits: mutual TLS between the orchestrator client and the orchestrator is not exercised, Akshay has not been told about the IF-5 open points, the `apps/api` skeleton and ADR 0018, and the Python and contract CI steps have never run on GitHub.

**Approach:** Give the fake orchestrator optional TLS flags and test `HttpInstanceHost` against it over real mTLS with certificates made at test time; write the team-chat message and a pinned handoff row for Akshay; after the developer opens the pull request, read the CI result, fix failures and record it.

## Boundaries & Constraints

**Always:** Plain HTTP stays the default of the fake. Certificates and keys exist only in a temporary folder that the test deletes; none is committed. Test certificate authorities and keys are throwaway values, never written to docs. Real commands and real results only. Decisions confirmed by the developer on 2026-10-09: TLS flags on the fake (`--tls-cert`, `--tls-key`, `--tls-ca`, client certificate required); certificates made with the `openssl` command, no new dependency, no lockfile change.

**Never:** No change to the IF-5 contract meaning (mTLS stays a deployment matter outside OpenAPI), to the signing rule, or to `HttpInstanceHost` (it already takes an `ssl_context`). No new Python or Node dependency. No push, merge or pull request by Claude: the developer opens the pull request on GitHub from the personal account; `gh` and the work browser session are not used. No decision on the open points themselves (Akshay's).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | Fake started with a server certificate and the test CA; client has a certificate from that CA and trusts the CA | create, get, reset, destroy work over `https://localhost:<port>` | No error expected |
| No client certificate | Client trusts the CA but presents none | Handshake refused | `OrchestratorUnavailable` |
| Client certificate from another CA | Client certificate signed by a second throwaway CA | Handshake refused | `OrchestratorUnavailable` |
| Server certificate not trusted | Client does not trust the test CA | Client refuses the server | `OrchestratorUnavailable` |
| Wrong host name | Server certificate names only `localhost`; client connects to `127.0.0.1` | Client refuses (host name check on) | `OrchestratorUnavailable` |
| mTLS ok, signing wrong | Valid certificates, wrong signing key | 401 `ORCH-BAD-SIGNATURE` mapped by the client as for plain HTTP | existing error mapping |
| Plain HTTP client to TLS fake | Client uses `http://` | Connection fails | `OrchestratorUnavailable` |
| TLS flags incomplete | Fake started with `--tls-cert` but no key or CA | Fake exits with code 2 and a clear message | usage error |
| `openssl` missing | Command not found | Test skips with a clear message locally; fails when the `CI` variable is set | no silent pass on CI |

</frozen-after-approval>

## Code Map

- `apps/api/src/vulnmart/ports/http_instance_host.py` -- already takes `ssl_context` (refuses `https` without one, `http` to non-loopback); transport errors become `OrchestratorUnavailable`. Do not change.
- `contracts/mocks/fake-orchestrator/server.mjs` -- imports only `node:http`; `parseArgs` (about L488) rejects unknown flags with exit 2; first stdout line is `{"listening":true,"port":N}`. Add the TLS flags here (Node `https` with `requestCert` and `rejectUnauthorized`).
- `apps/api/tests/support.py` -- `ServiceProcess(..., extra_args=())` starts the fake, reads the port, sets `url` to `http://127.0.0.1:<port>`; needs a way to give the scheme and host name. `conftest.py` fixtures start and stop services.
- `apps/api/tests/test_http_service.py` -- pattern for client tests against the service; new tests go in a new `apps/api/tests/test_mtls.py`.
- `contracts/orchestrator/orchestrator-api.md` section 4 (L74-97) and open point 6; `docs/adr/0018-orchestrator-request-signing.md`; `docs/architecture/06-security.md` L64 (private CA, short-lived leaf certificates).
- `docs/dev/HANDOFFS.md` -- row H-68 (mTLS, L-08 and L-13) gets a note; a new row for Akshay is added (rule 2b of `CLAUDE.md`). Task ids for Akshay's orchestrator client are read from `docs/dev/dev2-akshay.md`.
- `.github/workflows/ci.yml` -- the `scripts` job runs `uv run --locked --package vulnmart-api pytest -q` on `ubuntu-24.04`, which has `openssl`; triggers are `pull_request` and push to `main`.
- Do not touch: other developers' tracker folders, `contracts/orchestrator/orchestrator.openapi.yaml`, the signing code.

## Tasks & Acceptance

**Execution:**
- [x] `contracts/mocks/fake-orchestrator/server.mjs` -- add optional `--tls-cert`, `--tls-key`, `--tls-ca` (all three or none, else exit 2); serve with `https`, require and verify a client certificate against the CA; first output line unchanged -- real mTLS server for the test
- [x] `apps/api/tests/support.py` -- let `ServiceProcess` serve and report an `https` URL when TLS args are given; helper that builds the throwaway CAs and certificates with `openssl` in a temp folder and removes it afterwards -- keep certificate code out of the tests
- [x] `apps/api/tests/test_mtls.py` -- one test per row of the matrix above (skip when `openssl` is missing and `CI` is unset) -- proves the transport behaves
- [x] `scripts/e2e/orchestrator.e2e.test.mjs` -- one end-to-end test that starts the fake with TLS flags and checks, with Node only and its own certificates, that a call without a client certificate is refused -- independent consumer check
- [ ] `docs/dev/HANDOFFS.md` and `docs/dev/messages/2026-10-09-akshay-orchestrator-contract.md` -- new row for Akshay (30+ open points, `apps/api` skeleton, ADR 0018, where the proposals live, what stands by default) and the ready chat message; note on H-68 that the fake now offers mTLS -- Akshay's Claude finds it at his task
- [x] Documentation rule -- dev-log, CHANGELOG line, traceability row, evidence in `docs/assets/l-04-limits/` (real output)
- [ ] CI check -- after the developer opens the pull request: read the result they report (screenshot or pasted log), fix failures, rerun, record the real result in the dev-log

**Acceptance Criteria:**
- Given the fake with TLS flags and valid certificates, when the client creates, gets, resets and destroys an instance, then all calls succeed over `https` and the signing rule still applies.
- Given any matrix row marked refused, when the client calls, then it raises `OrchestratorUnavailable` and the fake records no instance change.
- Given the fake without TLS flags, when started as before, then all existing tests pass unchanged (244 Python, 82 unit, e2e).
- Given the repository after the tests, when searched, then no certificate or private key file is committed.
- Given the handoff row and message, when Akshay's Claude plans his task, then the row names the contract, the skeleton and ADR 0018 with the default that stands.
- Given the pull request, when CI finishes, then every job is green or each failure is fixed and recorded.

## Implementation Notes

## Plan Change Log

## Review Triage Log

Pass 1 (2026-10-09, thorough, four lenses). Verdict counts: medium 3, low 9, false 3, maybe-false 2. No intent_gap or bad_plan.

| Finding | Verdict | Route | Evidence |
|---|---|---|---|
| Changelog path typo `pps/api` (Blind, Edge) | low | patch | Real; fixed to `apps/api`. |
| Message to Akshay starts with a byte-order mark (Blind, Edge) | low | patch | Bytes 239,187,191 confirmed; removed. |
| Node test passes on any rejection, so a refused connection or timeout would pass (Edge, Blind, Verification) | medium | patch | Now the error must match a TLS failure (reset, hang up, alert, certificate); 13 of 13 e2e pass. |
| Empty-string TLS flag counted as not given (Edge, Blind) | medium | patch | `filter(Boolean)` confirmed; now `!== undefined`, so an empty value fails with exit 2. |
| Dev-log "Problems met: None" while OPENSSL_CONF workaround exists (Blind) | low | patch | Entry added; the reason was not recorded and the log says so. |
| Node e2e test is not run by CI (Verification) | medium | defer | CI runs only `scripts/*.test.mjs`, pytest and contracts:check; the Python mTLS tests cover the same refusals on CI. Added to deferred work. |
| TLS 1.3 refusal may surface as reset or broken pipe on Linux (Edge) | maybe-false | defer | The client maps every OSError to OrchestratorUnavailable (checked by the investigation); the Linux CI run will settle it. |
| `localhost` resolving to `::1` first (Edge, Blind) | false | none | Python tries every address returned and Node 24 tries both families; the Windows run passed. Linux run will confirm. |
| CI-fail branch for missing openssl never run; `CI=false` counts as set (Edge, Verification, Blind) | low | defer | Needs a monkeypatch test; low risk on ubuntu-24.04. |
| No expired, wrong-usage or TLS 1.1 case; one-day certificates; 38 s runtime; duplicated certificate code (Blind) | low | defer | Not in the plan's matrix; recorded for later. |
| No `tlsClientError` handler (Edge) | false | none | Node closes the socket by default; no unhandled error. |
| Unreadable certificate file gives a raw message (Edge, Blind) | low | none | Still exits 2; fix adds a branch for a test-only mock. |
| Key files may remain if cleanup fails or setup aborts (Edge) | low | none | Throwaway keys in the OS temp folder; extra guards not worth the complexity. |
| Tracker state, unchecked tasks, 33 versus 30 open points (Blind, Intent) | false | none | Tasks and status are closed at step 5; IF-5 added open points 31 to 33 in the follow-up, so 33 is right. |
| Intent alignment: the diff implements the test-level reading plus discoverability; the CI step stays open | false | none | Matches the plan; CI result is recorded after the pull request. |
## Design Notes

Server certificate: subject alternative name `localhost` only, so the test can use a wrong host name by connecting to `127.0.0.1`. Client certificate: extended key usage `clientAuth`. Both short-lived, created per test run, signed by one throwaway CA; a second CA makes the "wrong CA" case.

## Verification

**Commands:**
- `uv run --locked --package vulnmart-api pytest -q` -- expected: all pass, including the new mTLS tests (no skips on this PC)
- `node --test "scripts/e2e/orchestrator.e2e.test.mjs"` -- expected: all pass
- `node --test "scripts/*.test.mjs"` -- expected: 82 pass
- `pnpm run contracts:check` -- expected: PASS for all three contracts
- `git ls-files | Select-String "\.(pem|key|crt)$"` -- expected: no output

**Manual checks:**
- Pull request CI: all four jobs green (developer reports it).
