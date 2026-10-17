---
title: 'Gate core: ticket, host-only cookie, access state and strict hostname rule'
type: 'feature'
ticket: '1'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/adr/0004-instance-access-gate.md', '{project-root}/docs/architecture/03-origins-and-access.md']
---

<frozen-after-approval reason="human-owned intent, do not modify unless human renegotiates">

## Intent

**Problem:** Nothing decides who may reach an instance. The stub gate (`contracts/mocks/stub-instance/gate.mjs`) allows everything, ADR 0004 is still Proposed and no ticket or cookie format exists (FR-INS-10, FR-SES-04, FR-SES-11).

**Approach:** Decide ADR 0004 as Option 1 (Proposed, decided on the developer's delegation, D-60) and build its core as a small dependency-free Node library plus admin handlers under `apps/edge/` (the real edge code; the mocks folder stays test-only). Contract first: `contracts/edge/gate-ticket.md` and `contracts/edge/examples/ticket-vectors.json` (D-63). Ticket: `base64url(JSON)` + `.` + `base64url(HMAC-SHA256(K_gate, "vm-ticket-v1\n" + payload_b64))`, payload `{v:1, inst, own, ae, exp, jti}` (instance id, owner hash, access epoch, expiry at most 60 s ahead, 16 random bytes). Cookie `__Host-vm_gate` (Secure, HttpOnly, Path=/, no Domain, SameSite=Lax), same shape with prefix `vm-cookie-v1` and `{v, inst, own, ae}`. State per instance, pushed by the orchestrator and kept in memory: `{hostname, instance_id, epoch, owner, access, access_epoch}`; an unknown instance behaves as closed (fail closed). Hostname rule (D-68): only `^i-[a-z2-7]{16}\.<zone>$` after lower-casing, no port, no trailing dot, no userinfo; anything else is refused before any lookup with the same answer as an unknown instance. Two keys are accepted (current and previous) for rotation.

## Boundaries & Constraints

**Always:** Decision per request, in this order: host rule, state lookup (unknown, closed gives 410 "ended" page, frozen gives 423 "paused" page, both static and never forwarded), ticket path `/_vm/enter` only on GET with `t`, other `/_vm/` paths 404, cookie check (signature, `inst` equals the host's instance, `ae` equals the state's access epoch, `own` equals the state's owner), then allow. Ticket checks: signature, `exp` not past and at most 60 s from `iat` rules in the contract, `inst` equals host, `own` equals state owner, `ae` equals state access epoch (a ticket older than the state is refused), `jti` not seen (kept until `exp`, bounded set). All comparisons constant time. Refusal pages are identical for bad ticket, wrong owner and unknown instance (no enumeration). Admin handlers (`PUT /internal/v1/gate/instances/{id}`, `DELETE` the same, `PUT /internal/v1/gate/sync` with the full list) check the header `X-VM-Gate-Admin` against a secret read from a file (constant time) and validate bodies strictly (D-63); the access epoch only grows, an equal epoch with another value is 409, like IF-5. On allow the library returns the upstream name `vm-<id lower>-e<epoch>-sidecar:8080` built only from validated fields and strips the `__Host-vm_gate` cookie from the forwarded Cookie header; it adds no CSP, HSTS or other security header to shop responses (architecture 03 section 2.4). Keys and the admin secret never appear in logs or tests as real values; tests use random throwaway keys.

**Never:** Docker, compose, Caddy, orchestrator or API changes (stories 2 to 5); `.github/workflows/**`; terraform; real keys; any change to the stub gate; pushes and commits; deciding ADR 0004 as final (the developer confirms).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Good ticket | valid, owner and epoch match, state open | 302 to `/`, Set-Cookie as above, Referrer-Policy no-referrer | none |
| Reused ticket | same `jti` again | refused | generic 403 page |
| Expired, forged, other instance, other owner, old epoch | any one | refused, nothing forwarded | generic 403 page |
| Cookie of instance A on host B | host rule passes, `inst` differs | refused | generic 403 page |
| Old cookie after a new open | state `ae` raised | refused | generic 403 page |
| Frozen | state frozen, valid cookie | 423 page, upstream not called | static |
| Closed or unknown | no state or closed | 410 page, upstream not called | static |
| Crafted Host | `i-x.labs.evil`, uppercase, port, `i-<15>`, `i-<17>`, trailing dot, two labels in front | refused as unknown | same page as unknown |
| `/_vm/` other path | any method | 404 | static |
| Admin without or with a wrong secret | any admin call | 401, no state change | static |
| Epoch rule | push with a lower epoch, or equal with another value | 409, state unchanged | problem body |

</frozen-after-approval>

## Code Map

- `contracts/mocks/stub-instance/gate.mjs` and `edge.mjs` (whole files, 12 and 25 lines) -- the stub to replace in behaviour, not to edit; `common.mjs` exports `passThrough`, `sendProblem`, `listen`, `readDocument` (read, copy ideas, do not import from mocks into production code).
- `apps/edge/src/gate.mjs` (new): `createGate({keys, zone, now})` returns `decide(req)`; `apps/edge/src/tickets.mjs` (new): sign and verify; `apps/edge/src/state.mjs` (new): the push store and epoch rule; `apps/edge/src/admin.mjs` (new): admin handlers; `apps/edge/test/*.test.mjs` (new).
- `contracts/edge/gate-ticket.md`, `contracts/edge/examples/ticket-vectors.json` (new; register in `contracts/registry.json` following the shape of the existing entries, check `contracts/COMPAT.md` for the change rule; run the contract checks).
- `apps/orchestrator/src/vulnmart_orchestrator/builder.py:330-331` (`_prefix`, the container name `vm-<id lower>-e<epoch>` plus `-sidecar`) and `:243-247` (`parse_access`, the access values and epoch rule to mirror).
- `package.json` scripts `test` (add `apps/edge/test/*.test.mjs` to the glob).
- Docs: ADR 0004 (status line and decision text, Accepted by delegation, pending the developer's confirmation), `initial.md` D-60, D-63, D-68 (main session writes them), dev-log, CHANGELOG, traceability rows FR-INS-10, FR-SES-04, FR-SES-11 (state: gate core built, not live), evidence `docs/assets/story-5-1-gate-core/`.

## Tasks & Acceptance

**Execution:**
- [ ] `contracts/edge/*` -- ticket, cookie, admin API, hostname rule, vectors (fixed key, fixed times, expected verdicts)
- [ ] `apps/edge/src/tickets.mjs`, `state.mjs`, `gate.mjs`, `admin.mjs` -- as above, no dependencies
- [ ] `apps/edge/test/` -- one test per matrix row, vector test, constant-time helper used (no `===` on secrets, checked by reading)
- [ ] docs -- ADR 0004 update, dev-log, CHANGELOG, traceability, evidence, story `built`

**Acceptance Criteria:**
- Given the vectors file, then every ticket and cookie verdict of the library equals the file.
- Given each row of the matrix, then the answer and the "upstream called or not" flag are as written.
- Given a lower or equal-different access epoch push, then 409 and the old state remains.

## Design Notes

Proposed (decided on the developer's delegation): D-60 ADR 0004 is Option 1 with these refinements, fail closed, ticket single use in memory (a gate restart loses the used-id set and the state, so after a restart everything is closed until the orchestrator syncs; a replay inside the 60 s window after a restart is the accepted residual); D-63 the push API, the secret file and the contract location; D-68 the strict hostname rule and the unique-name routing. The owner binding uses `owner_hash` (IF-5, derived by the platform), so the gate never sees an account id. The gate key `K_gate` is shared by API and gate only (ADR 0009).

## Verification

**Commands:**
- `node --test apps/edge/test/*.test.mjs` -- expected: pass
- `node scripts/check-contract-rules.mjs` and `node --test scripts/check-contract-rules.test.mjs` -- expected: pass
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass

## Implementation Notes

Built 2026-10-17 (implementer agent; review, docs and commit are the main session's). Not yet reviewed, not committed.

**Built:**
- Contract `contracts/edge/gate-ticket.md` (0.1.0) and `contracts/edge/examples/ticket-vectors.json` (31 ticket and 12 cookie vectors, fixed throwaway keys, fixed time, made by an independent script that computes the HMAC directly). Registered as contract `GATE` (new id; IF-9 is taken by the ports) in `contracts/registry.json` (no mock by design, conformance = the two edge test files), a `0.1.0` section in `contracts/CHANGELOG.md` with a `registry change:` line, a Versions row and an owner row (`pending`) in `contracts/COMPAT.md`. No frozen 1.0.0 file was changed.
- `apps/edge/src/tickets.mjs` (sign, verify, strict base64url, `safeEqual` on `crypto.timingSafeEqual`, cookie header), `state.mjs` (hostname rule, strict record validation, store with the IF-5 epoch rule, all-or-nothing sync), `gate.mjs` (`createGate({keys, zone, now, store})` and `decide(req)` returning `respond` or `forward`; bounded used-ticket set of 10000), `admin.mjs` (`createAdmin({store, secretFile})` and `handle(req)`; secret read from the file on each call). No dependencies.
- Tests: `apps/edge/test/vectors.test.mjs`, `gate.test.mjs`, `admin.test.mjs` (plus `helpers.mjs`); root `package.json` script `test` now includes `apps/edge/test/*.test.mjs`.

**Decisions made while building (for the main session to record or the developer to change):**
1. Contract id `GATE`, version 0.1.0 (a new contract below 1.0.0; see open problems).
2. Hostname rule is strict about case: a Host that is not already lower case is refused (the matrix lists "uppercase" as refused; the Approach said "after lower-casing"). Only `Host` counts, never `X-Forwarded-Host`.
3. No `iat` in the ticket: valid while `exp > now` and `exp - now <= 60`; no clock-skew allowance.
4. A ticket whose `ae` is higher than the state's is refused too (equal only).
5. `GET /_vm/enter` without exactly one `t` is 404; an oversized ticket (over 1024 characters) is 403. `/_vm` detection works on the decoded, dot-resolved, case-folded path; only the literal `/_vm/enter` does the exchange.
6. Epoch rule of a push: refuse (409) when `access_epoch` or `epoch` is lower, or `access_epoch` is equal with another `access` or `owner`; an identical repeat is 204. Consequence, mirroring `engine.set_access`: freeze, thaw and close must each carry a higher `access_epoch`, so a cookie from before a freeze does not survive the thaw (a new ticket is needed).
7. Admin: 204 on success, problem+json (`about:blank`) on errors, 401 before anything else, 422 for invalid bodies, 415, 413 (4 KiB record, 1 MiB sync), 400 for bad JSON, DELETE repeatable (204), sync at most 2000 records and an empty list closes everything; secret shorter than 16 characters, empty or missing refuses every call.
8. The full used-ticket set refuses new tickets instead of evicting an id (fail closed).

**Real results:**
- `node --test apps/edge/test/*.test.mjs`: tests 77, pass 77, fail 0 (vectors 47 tests, gate and admin 30). Raw output: `docs/assets/story-edge-1-gate-core/test-output.txt`.
- `node scripts/check-contract-rules.mjs`: 18 PASS, 0 FAIL, 1 NOT-APPLICABLE (approvals, no tag `contracts-v*` yet).
- `node --test scripts/check-contract-rules.test.mjs`: tests 83, pass 83, fail 0.
- `node scripts/check-text-files.mjs`: PASS. `node scripts/scan-secrets.mjs`: PASS.
- Dead end: the first run of the constant-time hygiene test failed because its own regular expression backtracked; fixed in the test, no change in the library.

**Open problems:** (a) a 0.1.0 contract conflicts with tag precondition 5 (every contract labelled 1.0.0): the release commit or `scripts/tag-contracts.mjs` must account for `GATE`, a human decision; (b) after the tag, the rules engine needs a second listed person for `GATE` (only the owner is listed, so no other person could approve a change): add Akshay as consumer once agreed; (c) 403 (bad ticket, known instance) versus 410 (unknown) is distinguishable, kept as frozen in the plan; (d) the admin JSON parser does not detect duplicate member names (last wins); (e) clock skew between API and gate.
