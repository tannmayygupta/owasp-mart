# 0050. Invites: a sealed recipient address, a company-prefixed token, rules copied onto the invite, and `sent` read from the mail

- **Status:** Proposed (the builder's design for the developer to confirm; the requirements fix the outcome; OI-14 and OI-15 were answered by the developer on 2026-10-18)
- **Date:** 2026-10-18
- **Deciders:** Claude Code (design); the developer to confirm
- **Requirements:** FR-ASM-01, FR-ASM-02, FR-ASM-03, FR-NTF-02, FR-ORG-06, FR-ORG-08, OI-14, OI-15, OI-25, ADR 0014, ADR 0040, ADR 0049

## Context
An invited candidate has no account, so the outbox (ADR 0040: a template name and a user id, never an address) has nothing to look the address up from. The invite is a company row behind row-level security, but the candidate who opens the link has no session and so no company in scope. The invite lifecycle has a state `sent` that the architecture says the mail worker writes, but the worker has no company in scope either. A template's rules must not change under an invite or an attempt that already runs (FR-ASM-01). The test of a resend against a revoke found an unconditional write that could bring a revoked invite back.

## Options considered
1. **The address of a candidate:** a placeholder account per invite / the address looked up from the `invites` table at send time (the worker has no company in scope, so row-level security hides it) / the address sealed in the outbox row.
2. **Finding an invite from its token:** a table or policy that is readable with no company / a company prefix inside the token.
3. **`sent`:** the worker updates the invite (needs a company-less write to a company table) / the invite remembers its queued mail and `sent` is read from it.
4. **Rules of a template:** the invite reads the template when the candidate starts / the invite copies the rules when it is made.
5. **Moves of an invite:** read, then write what was read / every move is a conditional UPDATE from the state it starts from.

## Decision
- **Sealed address:** `email_outbox.to_address_sealed` (migration 0010) holds the candidate's address sealed with the field key (AES-256-GCM, bound to the invite id as associated data); `to_user_id` carries the invite id (`i-...`). `DbOutboxPort.enqueue_email(..., to_address=...)` seals it and refuses an address in `params`; `EmailOutboxService` opens it with the same key, sends, and clears the column in the transaction that marks the row sent. A row that cannot be opened fails as `no-recipient` and goes nowhere; nothing about the address is logged. The mail worker now needs the field secret (Compose gives it the development value). The `OutboxPort` protocol of stream L is unchanged (the extra argument is on the platform's implementation only).
- **Token:** `<company>.<secret>`: the company UUID in lower-case Base32 (26 characters) and 256 random bits in URL-safe Base64 (43 characters), only SHA-256 of the whole string stored. The prefix is not secret (the mail names the company) and lets `find_by_token` put that company in scope for the one lookup the candidate needs; a token with another company's prefix finds nothing. 256 bits, the larger of the two sizes the research gave (OI-25).
- **`sent`:** the invite stores the id of its queued mail; when invites are read, `created` becomes `sent` if that mail row is `sent` (a conditional UPDATE), so the worker never writes a company table. Opening a link counts as delivery: `created -> opened` is a legal move that also stamps `sent_at`.
- **Rules:** `Invite.rules` is a copy of the template's rules (and its version) made when the invite is created; an edit of the template affects only invites made afterwards, and an attempt copies the invite's rules when it starts (story P-21). A template's own edit raises its version.
- **Conditional moves:** every change of state (the lazy `sent`, expiry, cancel, revoke, resend, and the moves of the accepting story) is `UPDATE ... WHERE state = <the state it starts from>`, and the invite is read again afterwards. An invite past its expiry is closed on the next read; `expire_all` does it for every company.
- **Cap and duplicates:** the company's invites of the day are counted and the new one inserted in one transaction under an advisory lock per company (a creator at the cap is refused whatever the others do); a unique partial index allows one live invite per template and address, and a live invite already past its expiry is closed first so it does not block a new one. A resend does not count against the cap; a re-issue after a closed invite is a new invite and counts.
- **Template fields (FR-ASM-01):** title, any of the 11 challenges (at least one), time limit 30 to 480 minutes (default 120), hints off (default) or on with a cost of 0 to 100 percent, resets 0 to 10 (default 3), flag submissions 1 to 60 a minute (default 10), invite expiry 1 to 30 days (default 7), retention 30 to 365 days (default the setting `candidate_retention_days`), a write-up required or optional (**default optional**, OI-14) and when the candidate sees results (**default right after submit**, a recruiter setting, OI-15). The ranges are the research placeholders of OI-25. The things that can never be switched off (per-instance flags, evidence capture, the audit log, the consent screen) are refused by name; anything unknown is refused.
- **Audit:** `template.*` and `invite.*` entries name the company and the invite id and never the address or the token. Recruiter calls need a recruiter scope whose company is the one they are an active recruiter of; creating an invite also needs the terms (ADR 0049).

## Consequences
- An outbox row of a failed invite mail keeps the sealed address until an admin requeues it; the address is not readable without the field key.
- `sent` can lag: an invite shows `created` until it is next read after the mail left. A candidate who opens the link first makes it right.
- A candidate who changes company policy mid-way is protected: the rules they accepted are the rules that run. A recruiter who wants new rules sends a new invite.
- Without the field secret the API and the worker cannot agree on addresses; in dev and test each makes its own random secret, so the compose stack must give both the same value (it does).
- The token's company prefix names the company in any link a candidate forwards; the mail already does.
- Counting only creations means a recruiter can resend as often as they like; a limit on resends is not built.

## Evidence
- `test_assessments.py` (templates and their validation, the token, invites, the lifecycle edge by edge, expiry, resend, cap, duplicates, what stays inside a company), `test_notifications_sealed.py` (the sealed address in the outbox), `test_assessments_postgres.py` (row-level security and forced RLS on the three tables, privileges, the database's own checks, creation under races, creators at the cap never pass it, resend against revoke, eight moves of one invite, cascade on company deletion, migration 0010 down and up).
- Real stack: the invite mail arrives at an address with no account through the real worker, which opened the sealed address; the sent outbox row holds no token and no address; the database holds the hash of the token; a resend kills the old link; the cap refuses and keeps the rest; the audit entries are under pseudonyms.
- OWASP ASVS and the lawyer's view of the invite and consent wording: **not read and not verified** (OI-33).
