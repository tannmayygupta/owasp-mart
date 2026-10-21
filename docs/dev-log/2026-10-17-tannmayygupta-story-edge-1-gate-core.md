# Gate core: ticket, host-only cookie, access state and strict hostname rule (edge story 1)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | `sprint-3-tanmay`, baseline `601ba11` (commit of this story follows; not committed when this entry was written) |
| Status | Partly done: gate library, admin handlers, contract `GATE` 0.1.0 and tests built and passed locally; not wired to the orchestrator or the API, not live |
| Report tag | edge gate, access ticket, host-only cookie, FR-INS-10, FR-SES-04, FR-SES-11, D-60, D-63, D-68 |

## Requirements covered
FR-INS-10, FR-SES-04, FR-SES-11 (gate core only); ADR 0004 (status changed to Accepted by delegation, pending the developer's confirmation); decisions D-60, D-63, D-68 (Proposed, in ADR 0090); handoffs H-336, H-337, H-338 (new). Task L-17 (first story; stays unticked).

## Summary (plain language, 3-5 lines)
Nothing decided who may reach an instance; the stub gate let everything through. There is now a small Node library that checks a signed one-time ticket, exchanges it for a host-only cookie and decides per request: allow, show a "paused" page (frozen), show an "ended" page (closed or unknown), or refuse. Only a strict hostname shape is accepted. The orchestrator will push the access state to it through admin handlers; the secret and keys are read from files.

## Why
ADR 0004 was Proposed and no ticket or cookie format existed. FR-INS-10 (only the owner reaches an instance), FR-SES-04 (frozen refuses requests) and FR-SES-11 (a newer login must cut the older browser session) need a decision point at the edge.

## What was built
- Contract `contracts/edge/gate-ticket.md` (0.1.0) and `contracts/edge/examples/ticket-vectors.json` (31 ticket and 12 cookie vectors, throwaway keys, fixed time, made by an independent script). Registered as contract `GATE` in `contracts/registry.json` (no mock by design), with entries in `contracts/CHANGELOG.md` and `contracts/COMPAT.md`. No frozen 1.0.0 file changed.
- `apps/edge/src/tickets.mjs` (sign, verify, strict base64url, constant-time compare, cookie header), `state.mjs` (hostname rule, record validation, store with the IF-5 epoch rule, all-or-nothing sync), `gate.mjs` (`createGate` and `decide`), `admin.mjs` (`createAdmin`, secret read from a file on each call). No dependencies.
- Tests: `apps/edge/test/vectors.test.mjs`, `gate.test.mjs`, `admin.test.mjs`, `helpers.mjs`; the root `package.json` script `test` includes them.

## How it works
Ticket: `base64url(JSON) . base64url(HMAC-SHA256(K_gate, "vm-ticket-v1\n" + payload))`, payload with instance id, owner hash, access epoch, expiry (at most 60 s ahead) and a random id; single use. Cookie `__Host-vm_gate` (Secure, HttpOnly, Path=/, no Domain, SameSite=Lax). State per instance is pushed by the orchestrator and kept in memory; an unknown instance behaves as closed. Order per request: hostname rule, state lookup (closed or unknown 410, frozen 423, both static and never forwarded), `/_vm/enter` only on GET with `t`, cookie check (signature, instance, access epoch equal to the state's, owner equal), then allow. Refusals look the same for bad ticket, wrong owner and unknown instance. On allow the library returns the upstream `vm-<id lower>-e<epoch>-sidecar:8080` built from validated fields, strips the gate cookie and adds no security header to shop responses.

## Files changed
- `contracts/edge/gate-ticket.md`, `contracts/edge/examples/ticket-vectors.json` - new
- `contracts/registry.json`, `contracts/CHANGELOG.md`, `contracts/COMPAT.md` - contract `GATE` registered
- `apps/edge/src/{tickets,state,gate,admin}.mjs`, `apps/edge/test/*.mjs` - new
- `package.json` - test glob
- `docs/adr/0004-instance-access-gate.md` (status), `docs/adr/0090-edge-gate-ticket-and-hostname-model.md`, `initial.md`, HANDOFFS, CHANGELOG, traceability, dev1 file
- `docs/assets/story-edge-1-gate-core/test-output.txt`

## Decisions made
D-60 (ADR 0004 Option 1 with refinements: fail closed, single-use ticket kept in memory), D-63 (push API, secret file, contract location), D-68 (strict hostname rule and unique-name routing). Decisions made while building, to confirm: contract id `GATE` at 0.1.0; a Host that is not already lower case is refused; no `iat` in the ticket (valid while `exp > now` and `exp - now <= 60`, no skew allowance); a ticket with a higher `ae` than the state is refused too; freeze, thaw and close each need a higher `access_epoch` (mirrors `engine.set_access`), so a cookie from before a freeze does not survive the thaw; a full used-ticket set refuses new tickets instead of evicting. Alternatives for the whole model are in ADR 0004 (mTLS, hostname only, proxy through the API).

## Tests
- `node --test apps/edge/test/*.test.mjs`: tests 77, pass 77, fail 0 (vectors 47, gate and admin 30).
- `node scripts/check-contract-rules.mjs`: 18 PASS, 0 FAIL, 1 NOT-APPLICABLE (approvals, no tag `contracts-v*` yet).
- `node --test scripts/check-contract-rules.test.mjs`: tests 83, pass 83, fail 0.
- `node scripts/check-text-files.mjs` and `node scripts/scan-secrets.mjs`: PASS.
Traceability rows: FR-INS-10, FR-SES-04, FR-SES-11, D-60, D-63, D-68.

## Evidence
`docs/assets/story-edge-1-gate-core/test-output.txt`.

## Problems met and how they were fixed
The first run of the constant-time hygiene test failed because its own regular expression backtracked; fixed in the test, the library did not change.

## Security notes (vulnerable parts only)
Not a vulnerable part; this is the platform's own access control. Keys and the admin secret are never real values in tests (random throwaway keys). The gate key is shared by the API and the gate only (ADR 0009).

## Limitations and follow-ups
- Not live: nothing here ran on vm-i, with a real browser, a real certificate or the real orchestrator.
- Contract `GATE` is 0.1.0, which conflicts with tag precondition 5 (every contract labelled 1.0.0): a human decision at the release commit or in `scripts/tag-contracts.mjs`. After the tag the rules engine needs a second listed person for `GATE`; Akshay is to be added as consumer (H-336 to H-338).
- 403 (bad ticket, known instance) versus 410 (unknown) can be told apart; kept as frozen in the plan.
- The admin JSON parser does not detect duplicate member names (last wins); clock skew between API and gate is not handled.
- A gate restart loses the used-ticket set and the state: everything is closed until the orchestrator syncs; a replay inside the 60 s window after a restart is the accepted residual.
