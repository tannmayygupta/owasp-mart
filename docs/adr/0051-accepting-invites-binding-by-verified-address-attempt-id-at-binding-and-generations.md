# 0051. Accepting invites: binding by verified address, the attempt id given out at binding, consent before the attempt, and generations for a re-invite

- **Status:** Proposed (the builder's design for the developer to confirm; the requirements fix the outcome)
- **Date:** 2026-10-18
- **Deciders:** Claude Code (design); the developer to confirm
- **Requirements:** FR-ASM-04, FR-ASM-05, FR-ASM-06, FR-ACC-06, FR-PRV-01, FR-PRV-02, ADR 0014, ADR 0046, ADR 0050
- **Handoffs:** H-141

## Context
A candidate who opens an invite link has no company in scope, and often no account yet. FR-ASM-04 lets the requirement choose between two ways to stop a different person using the link: a different verified address is refused, or the invite is bound only after the candidate confirms. The consent record (ADR 0046) names an attempt id, and the consent has to come before any attempt exists (FR-ASM-04: "the consent screen before anything starts"), but the lab port only creates an attempt that is already `ready` and gives it an id of its own. FR-ASM-05 wants a new attempt for the same person on the same template, and the lab engine allows one attempt per account and template. FR-ASM-06 wants 200 invites to go out over time under a daily mail cap without losing any.

## Options considered
1. **Who may use the link:** any signed-in account that confirms / only the account whose verified address is the invite's address.
2. **The id of the attempt named by the consent record:** create a placeholder attempt in `consent` through the lab port (the port cannot) / let the consent record name an id the invite hands out at binding, and create the attempt with that id after the grant.
3. **Where the candidate finds the invite:** a table or policy readable with no company / a read-only policy on the invite's own `user_id`, like `own_membership` and `own_join_request`.
4. **A re-invite:** reuse the invite and reset it / a new invite with a generation number that names the attempt it replaces.
5. **The second attempt on one template:** change the lab engine / a template key per generation on the port call.
6. **A bulk invite:** one call that is all-or-nothing / one invite per address, each its own transaction, outcome per address, stop at the cap and hand back the rest.

## Decision
- **Binding:** the first option of the requirement. `InviteAcceptance.accept(user_id, token)` needs an active, verified participant account whose canonical address equals the invite's; the refusal (`AddressMismatch`) never says what the invite's address is. A recruiter or admin account is refused (`NotEligible`). The invite is bound by one conditional UPDATE (`user_id IS NULL`), so two accounts cannot both bind; the same account again gets the same result.
- **The attempt id is given out at binding** (`a-` and 16 Base32 characters, column `invites.attempt_id`, unique when set). The consent record names it. The consent screen's attempt is in state `consent` exactly while the invite is `opened`, `consented` maps to `ready` and `started` to `running`. No attempt exists in the lab until a grant.
- **`InviteConsentTargets`** is the invite side of `ConsentTargets` (ADR 0046): `find` reads the invite as the signed-in candidate, with the new policy `own_invite` (`FOR SELECT USING (user_id = current_setting('vulnmart.user_id', true))`, migration 0011) and `invites` listed as a self-visible table of the session guard; the company's name is read in the company's own scope. `proceed` is idempotent and race-safe: a grant moves the invite to `consented`, creates the attempt through the lab port with the pre-allocated id and the consent id, and gives the candidate role; a decline moves the invite to `declined` and creates nothing. A request that loses the race to the same move finds the invite already there and goes on (a Postgres test with eight clicks on one consent found this).
- **Retention shown to the candidate** is the invite's own copy of the template's `retention_days` (`ConsentTarget.retention_days`), so the notice and the record state what will actually run; without it the setting `candidate_retention_days` is used.
- **Re-invite (FR-ASM-05):** `reinvite` works only on an invite that is `consented` or `started` and not yet superseded. It makes a new invite with `generation + 1` and `supersedes_attempt_id`, taking the template's rules as they are now, and marks the old invite `superseded_by` in the same transaction (a `consented` old invite is revoked there too, so its link cannot start a second attempt). A refusal (the cap, the terms) leaves the old invite as it was. After the commit the old attempt is cancelled through the lab port when the port allows (ready or running); one that cannot be cancelled is left and logged. A re-invite counts against the daily cap. A plain `create_invite` for an address that already has a `started` invite is refused (`AlreadyStarted`): the candidate cannot start a second attempt on their own.
- **One attempt per account and template:** the lab engine's rule stays. The port is called with the template key `<template>` for the first generation and `<template>~2`, `~3` ... for later ones. This is a stand-in until stream L gives the port a proper way to supersede (handoff H-141).
- **Bulk (FR-ASM-06):** `create_invites` takes up to 500 addresses. Each is its own invite, token, outbox row and place under the cap. Invalid, repeated, already-live and already-started addresses are reported with a reason and do not stop the rest. At the company's daily cap it stops and returns the addresses it did not reach, in order, so nothing is lost. The provider's daily sending cap is separate: the outbox claims rows in order up to that cap each day, so mail is delayed, never dropped (a test sends five invites at two a day over three days, in order).
- **Purge:** `purge_closed_tokens(before)` empties `token_hash` of expired, cancelled, declined and revoked invites that closed at or before `before`; the row stays. Story P-24 decides `before`. `expire_all` already shows the purge job the invites that ran out.
- **Port change:** `AttemptPort.create_from_consent` takes an optional `attempt_id` (used for the new attempt when given); `EngineAttemptPort` already did, and `FakeAttemptPort` now does. A proposal to stream L.

## Consequences
- A candidate who registers with a different address than the invite's cannot use the link; they must ask the recruiter for a new invite to the right address. The other option of FR-ASM-04 (bind after the candidate confirms) is not built.
- An invite bound to an account stays bound; a recruiter who invited a wrong address revokes and invites again.
- The attempt template key `<template>~n` shows up in what the lab stores until stream L replaces it with a real supersede.
- In production no lab port is given to `create_app` yet, so the consent routes still answer 404 for every attempt id; the demo runtime and the tests wire it. Wiring the real port is stream L's (handoff H-141).
- A grant that was recorded but could not move the invite (the invite was revoked in between) leaves a consent record without an attempt; the request is refused with the invite's state and the recruiter's revoke wins.
- `invites` now holds a person's account id and attempt id; the data inventory test lists them.

## Evidence
- `test_invite_acceptance.py` (opening the link, accepting, every refusal, consent first, grant, decline, repeats, a failure between the invite move and the attempt, a revoke between decision and attempt, who finds the attempt, re-invites, generations, bulk, the provider cap over days, the purge), `test_invite_acceptance_postgres.py` (the policy and columns, as the application role: a candidate reads only their own invite and cannot change it, the unique attempt id, the whole flow through row-level security, eight accepts of one link, two accounts binding one invite, eight re-invites of one invite, eight clicks on one consent, migration 0011 down and up).
- Real stack: see the dev-log. The lawyer's view of the consent wording is **not read and not verified** (OI-33).
