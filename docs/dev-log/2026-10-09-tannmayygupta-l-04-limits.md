# L-04 limits: mTLS test, Akshay handoff and CI check plan (story 1.10)

| Field | Value |
|---|---|
| Date | 2026-10-09 |
| Developer | tannmayygupta |
| Branch / commit | sprint-1-tanmay, based on 3180e58; not committed and not pushed when this entry was written |
| Status | Partly done: mTLS test and Akshay handoff done and tested; the CI check on GitHub is still open (it needs the developer to open the pull request) |
| Report tag | contracts, IF-5, mTLS, handoff, sprint 1 |

## Requirements covered
IF-5 section 4 and open point 6 (mTLS is a deployment matter), ADR 0018 (signing), architecture 06 (private CA, short-lived leaf certificates); handoffs H-68 (note) and H-83 (new); traceability row LB-5. Decisions confirmed by the developer on 2026-10-09 are in the story plan (TLS flags on the fake; certificates with the `openssl` command, no new dependency).

## Summary (plain language)
The fake orchestrator can now speak HTTPS and demand a client certificate. The Python client `HttpInstanceHost` is tested against it over real mutual TLS: the normal calls work, and a missing, foreign or untrusted certificate, a wrong host name and a plain HTTP client are all refused as `OrchestratorUnavailable`. A handoff row and a ready chat message tell Akshay about the 33 open points, the `apps/api` skeleton and ADR 0018.

## Why
Story 1.4 left three limits: mTLS was never exercised, Akshay had not been told, and the Python and contract CI steps had never run on GitHub.

## What was built
- Fake orchestrator flags `--tls-cert`, `--tls-key`, `--tls-ca`: all three or none (otherwise exit 2 with a message); with them it uses Node `https` with `requestCert` and `rejectUnauthorized`, minimum TLS 1.2. Without them nothing changes. The first stdout line is unchanged.
- Test helper `Pki` in `apps/api/tests/support.py`: makes two throwaway CAs, a server certificate (name `localhost` only), a client certificate (`clientAuth`) from the first CA and one from the second CA, with `openssl` in a temporary folder, removed at the end. `ServiceProcess` takes `tls=` and then reports an `https://localhost:<port>` URL.
- `apps/api/tests/test_mtls.py`: one test per row of the plan's matrix (11 test cases, the incomplete-flags row is run with four flag combinations). Skips locally when `openssl` is missing; fails when `CI` is set.
- `scripts/e2e/orchestrator.e2e.test.mjs`: one Node-only consumer test with its own certificates: with a client certificate the signed call works, without one the handshake is refused.
- `docs/dev/HANDOFFS.md`: new row H-83 (Akshay, P-05 and P-08), note on H-68; `docs/dev/dev2-akshay.md` P-05 and P-08 point to H-83; `docs/dev/messages/2026-10-09-akshay-orchestrator-contract.md` is the chat message.

## How it works
The test makes certificates, starts the fake with the three flags, and gives the client an `ssl.SSLContext` built from the test CA and the client certificate. Refused cases also check that the fake recorded no change: a correct client then gets `InstanceNotFound` for the id. The signing rule is unchanged and still applies on top (valid certificates with a wrong signing key give `BadSignature`).

## Files changed
- `contracts/mocks/fake-orchestrator/server.mjs` (TLS flags, usage error on incomplete flags)
- `apps/api/tests/support.py`, `apps/api/tests/test_mtls.py` (new)
- `scripts/e2e/orchestrator.e2e.test.mjs` (one test, imports)
- `docs/dev/HANDOFFS.md`, `docs/dev/dev2-akshay.md`, `docs/dev/messages/2026-10-09-akshay-orchestrator-contract.md` (new)
- `CHANGELOG.md`, `docs/traceability.md`, this entry, `docs/assets/l-04-limits/verification.txt`
- Not changed: the contract, the OpenAPI file, the signing code, `HttpInstanceHost`, dependencies, lockfiles.

## Decisions made
No new ADR: the two choices (flags on the fake, `openssl` command) were confirmed by the developer in the plan and add no dependency or contract meaning.

## Tests
Real results are in `docs/assets/l-04-limits/verification.txt`.
- `uv run --locked --package vulnmart-api pytest -q` : 255 passed in 179 s (244 existing plus 11 new), no skips on this PC (openssl from Git for Windows).
- `node --test "scripts/e2e/orchestrator.e2e.test.mjs"` : 13 pass, 0 fail (includes the new TLS test and the Python suite run).
- `node --test "scripts/*.test.mjs"` : 82 pass, 0 fail.
- `pnpm run contracts:check` : contracts, events and orchestrator contract PASS.
- `git ls-files | Select-String "\.(pem|key|crt)$"` : no output. After the runs no `.pem`, `.key`, `.csr` or `.srl` file was found in the repository (outside `node_modules` and `.venv`) and no temporary `vm-*mtls-*` folder was left.
- The `CI` branch (fail instead of skip when `openssl` is missing) was written but not run, because `openssl` exists on this PC.

## Evidence
`docs/assets/l-04-limits/verification.txt` (tails of the command outputs).

## Problems met and how they were fixed
None in the build: the new tests passed on the first run. The tests set a minimal OPENSSL_CONF so the openssl command does not depend on the machine configuration file; the reason this was needed was not recorded. The 11 mTLS tests take about 38 s together; the cause was not investigated.

## Security notes (vulnerable parts only)
None. The fake orchestrator is a test aid. Certificates and keys are throwaway and are never committed or written to docs.

## Limitations and follow-ups
- CI check not done: the developer opens the pull request on GitHub; then the result (screenshot or pasted log) is read, failures fixed and the real result added here.
- Production certificates, their rotation and the private CA stay open (H-68, L-08, L-13).
- The wrong-host test relies on the Python client's host name check being on; the Windows run proves it, the Linux CI run is still to be seen.
