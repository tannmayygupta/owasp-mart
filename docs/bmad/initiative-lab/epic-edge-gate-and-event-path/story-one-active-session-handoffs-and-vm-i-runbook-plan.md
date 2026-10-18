---
title: 'One active browser session end to end, handoffs for the platform and the VM runbook'
type: 'feature'
ticket: '5'
created: '2026-10-17'
status: 'done'
baseline_revision: '601ba11732757d1dcfc62bbc371be47d511eaac0'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/dev/HANDOFFS.md', '{project-root}/docs/runbooks/deploy.md']
---

<frozen-after-approval reason="human-owned intent, do not modify unless human renegotiates">

## Intent

**Problem:** FR-SES-11 ("one active browser session per candidate", AC: a new login invalidates the older browser session for that attempt) is split between the platform (sessions) and the gate (instance cookies), and nobody has written who does what. The live part (names, certificate, vm-i, private link) has no runbook, and ADR 0004 and 0005 still say Proposed with open choices.

**Approach (D-65):** Stream L provides the access-epoch mechanism; the platform owns browser sessions. Rule: every `open` and every login of the account raise the access epoch of the account's live instances through IF-5 `access`; the gate refuses any cookie or ticket with an older epoch, so the earlier browser tab loses the instance at once, and the platform's own session store invalidates the older platform session at login (Akshay). This story (1) proves the rule end to end locally (a test with the story-1 library or the story-2 edge: cookie A works; a second ticket with epoch n+1 gives cookie B; A is then refused, B works; a login-time bump with no new open refuses A and B until a new ticket), (2) writes the handoff rows for Akshay (below) in `docs/dev/HANDOFFS.md` and answers H-64 and H-75, (3) updates ADR 0004 and ADR 0005 text (the decisions D-60 to D-68, Proposed until the developer confirms; the main session writes `initial.md`), and (4) writes the runbook section for the developer in `docs/runbooks/deploy.md` (numbered, copy-paste, with the evidence to save and the rule "paste no secret").

Handoff rows to add (Akshay, tasks P-05 InstancePort, P-xx session store, P-17 key service, the ingest owner): (a) ticket: `InstancePort.open_ticket` (`apps/api/src/vulnmart/ports/instances.py:55`, `Ticket(url, expires_at)`, fake at `lab_fakes.py:236`) must call IF-5 `access open` with `access_epoch = stored + 1` first, wait for 200 (the orchestrator pushes the gate before it answers), then sign the ticket of `contracts/edge/gate-ticket.md` with `K_gate` (owner_hash from KeyPort, the new epoch, 60 s, random jti) and return `https://<hostname>/_vm/enter?t=<ticket>`; never issue a ticket when the access call failed; (b) login bump: when a login creates a session for an account, for each live instance of that account call IF-5 `access` with `open` or the current value and `access_epoch + 1` (the epoch must be stored by the platform with the instance, `InstanceView.access_epoch`), and invalidate the account's older platform sessions in the same transaction; (c) freeze, expiry, withdraw: IF-5 `access frozen` or `closed` with an epoch bump (already in the attempt design), no direct call to the gate ever; (d) `K_gate` and the gate admin secret are two secrets, written out of band to vm-p and vm-i (`docs/runbooks/deploy.md` new section), rotation by two keys; (e) ingest: stream L added `POST /internal/v1/events` in `apps/api/src/vulnmart/kernel/entrypoints/ingest.py` and the `ingest/` package with an in-memory store; the Postgres `events` store and the `InstanceEpochs` feed from the state receiver (H-106) are Akshay's migration and receiver (P-06, P-17), please confirm the port shape.

## Boundaries & Constraints

**Always:** Rows are written for the developer to confirm, with the default stated (CLAUDE.md handoff rule), status `open`. The runbook lists commands and what evidence to save; it contains no live result, no real host name or address, no secret. Local proof only claims local results.

**Never:** Editing Akshay's tracker folder or his non-port code; running AWS, VM-I or SSH; the Excel tracker; `.github/workflows/**`; commits and pushes (the main session commits); recording any live result.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Second open | ticket at epoch n+1 | cookie B works, cookie A refused | gate page |
| Login bump | state epoch raised, no new ticket | A and B refused until a new ticket | gate page |
| Same ticket twice | replay | refused | gate page |
| Platform access call fails | gate down | no ticket issued (stated in the handoff; tested on the fake `InstancePort` only if the fake allows, otherwise written as a rule) | n/a |
| Rotation | ticket signed with the previous key | accepted until the previous key is removed | n/a |

</frozen-after-approval>

## Code Map

- `apps/edge/test/session-epoch.test.mjs` (new), using story 1's library; optional extension in `scripts/e2e/edge.e2e.test.mjs` (story 2) for the real edge.
- `docs/dev/HANDOFFS.md` (rows for Akshay; new ids after the last one; answers to the rows of H-64 and H-75 and of any row addressed to L-17 and L-18, none found by task id on 2026-10-17 besides those two), `docs/dev/messages/` (a short message for Akshay in the style of `2026-10-17-for-akshay-and-sahil-claude-plan-for-the-19th.md`).
- `docs/adr/0004-instance-access-gate.md`, `0005-instance-network-and-event-path.md`, `0010-docker-socket-proxy.md` (sentence on connect) -- text only; `docs/architecture/03-origins-and-access.md:153-165` (section 3 bullets on epoch and freeze) -- note the as-built name rule.
- `docs/runbooks/deploy.md` -- new numbered sections (read the file first for numbering): (1) labs name and wildcard certificate with lego DNS-01 (existing `docs/runbooks/certificates.md`), files into the edge's cert folder; (2) K_gate and gate admin secret as files; (3) `docker compose --profile lab up` for edge and gate and orchestrator flags `--edge-container`, `--gate-url`; (4) S-15 attach test on vm-i with 20 instances, evidence `docker network ls` count, memory, request check per hostname; (5) relay over the private link: `--ingest` URL of vm-p port, from an instance network the ingest address must stay unreachable (reuse `docs/runbooks/isolation-vm-i.md`); (6) a browser check by the developer: owner reaches own shop, second account does not, freeze, expiry. Evidence folders named, no values.
- Docs: dev-log, CHANGELOG, traceability FR-SES-11, FR-INS-10 (rows say: local proof done in stories 1 to 4, live step open until the developer's run), evidence `docs/assets/story-5-5-session-epoch/`, task ticks L-17 and L-18 in `docs/dev/dev1-tanmay.md` only after the developer confirms.

## Tasks & Acceptance

**Execution:**
- [ ] `apps/edge/test/session-epoch.test.mjs` -- the matrix, run and recorded
- [ ] `docs/dev/HANDOFFS.md` + the message file -- rows (a) to (e), answers for H-64, H-75
- [ ] ADR 0004, 0005, 0010 text and the runbook sections
- [ ] docs -- dev-log, CHANGELOG, traceability, story `built`; tracker state through `bmad-ticket`

**Acceptance Criteria:**
- Given the test, then cookie A is refused after a higher-epoch ticket and B works.
- Given `docs/dev/HANDOFFS.md`, then the five rows exist with defaults and status open, and H-64 and H-75 carry the new answers.
- Given the runbook, then every live step has its command, the evidence to save and the note that the result is the developer's to record.

## Design Notes

Proposed (decided on the developer's delegation): D-65 the access epoch is the only session-binding mechanism at the gate; the platform bumps it on open and on login; the gate never learns about platform sessions or accounts (owner hash only). D-67 local proof boundary: loopback plain HTTP and a throwaway self-signed certificate for the Caddy test; the wildcard certificate, DuckDNS resolution (spike S-16), vm-i firewall behaviour, the private link and a real browser are runbook steps and stay open items in the traceability until the developer runs them.

## Verification

**Commands:**
- `node --test apps/edge/test/session-epoch.test.mjs` -- expected: pass
- `node scripts/check-text-files.mjs`, `node scripts/scan-secrets.mjs` -- expected: pass
- `node scripts/check-docs.mjs` (the documentation gate the commit hook runs) -- expected: pass
