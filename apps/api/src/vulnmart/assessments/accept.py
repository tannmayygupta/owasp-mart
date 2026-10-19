"""Accepting an invite (story P-21, FR-ASM-04): the candidate opens the link, signs in, the verified address must match, the consent comes first, then the attempt.

`InviteAcceptance` is what the routes of story 5.3 will call: `open_link(token)` when the link is opened (the invite becomes `opened`), `accept(user_id, token)` once
the candidate is signed in. `accept` refuses an account that is not an active, verified participant (a recruiter or an admin cannot take an assessment) and an
account whose verified address is not the one the invite was made for (the refusal never says what the invite's address is). The invite is then bound to the account
with a conditional UPDATE and given the id its attempt will have; the consent notice and the decision follow through `ConsentService` (story P-16), with
`InviteConsentTargets` as the invite side of its port: while an invite is `opened` its attempt is in `consent`; a grant moves the invite to `consented`, creates the
attempt through the lab port with that id and gives the candidate role (FR-ACC-06); a decline closes the invite as `declined`. Every step can be repeated: a failure
between two steps is finished by repeating the same request.

Registration (18 or over, the verification mail) is the accounts module's; a candidate with no account registers first and comes back to the link. The candidate role is
the only thing accepting adds to the account.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from vulnmart.accounts.directory import UserDirectory
from vulnmart.accounts.roles import RoleService
from vulnmart.ports.attempts import AttemptPort
from vulnmart.privacy.targets import ConsentTarget

from .service import AssessmentService, InviteClosed, InviteView
from .tokens import org_of


class LinkInvalid(Exception):
    """The link opens nothing (malformed, unknown, or its token was emptied by the invite purge). The answer must not say which."""


class NotEligible(Exception):
    """The account cannot take an assessment: not an active, verified participant."""


class AddressMismatch(Exception):
    """The verified address of the account is not the one the invite was made for."""


@dataclass(frozen=True, slots=True)
class Accepted:
    invite: InviteView
    attempt_id: str  # the attempt the consent screen is for


def attempt_template_key(template_id: str, generation: int) -> str:
    """What the lab port is given as the attempt's template: the engine allows one attempt per account and template, so the later attempts of a re-invite (FR-ASM-05)
    get a key of their own (`<template>~2`, `~3` ...). Handoff H-141: stream L should give the port a proper way to supersede."""
    return template_id if generation <= 1 else f"{template_id}~{generation}"


class InviteAcceptance:
    def __init__(self, assessments: AssessmentService, directory: UserDirectory):
        self._assessments, self._directory = assessments, directory

    def open_link(self, token: str) -> InviteView | None:
        """The link was opened: `created` and `sent` become `opened` (an opened link was delivered). Returns the invite as it is afterwards (the caller looks at its
        state: a closed invite is shown as closed), None for a link that opens nothing."""
        view = self._assessments.find_by_token(token)
        if view is None:
            return None
        if view.state in ("created", "sent"):
            org = org_of(token)
            try:
                view = self._assessments.advance(str(org), view.invite_id, "opened")
            except InviteClosed:
                view = self._assessments.find_by_token(token) or view  # another request moved it first: go on from what is there
        return view

    def accept(self, user_id: str, token: str) -> Accepted:
        """Bind the invite to the signed-in candidate. Raises LinkInvalid, InviteClosed(state), NotEligible, AddressMismatch, and InviteTaken when another account got
        there first. Repeating it for the same account returns the same attempt id."""
        view = self.open_link(token)
        if view is None:
            raise LinkInvalid
        if view.state not in ("opened", "consented"):
            raise InviteClosed(view.state)
        brief = self._directory.brief(user_id)
        if brief is None or brief.status != "active" or brief.account_type != "participant" or not brief.email_verified or brief.email_ci is None:
            raise NotEligible
        if brief.email_ci != view.email:
            raise AddressMismatch
        bound = self._assessments.bind_candidate(str(org_of(token)), view.invite_id, user_id)
        assert bound.attempt_id is not None  # bind_candidate gives it out in the same UPDATE as the account
        return Accepted(bound, bound.attempt_id)


_ATTEMPT_STATE = {"opened": "consent", "consented": "ready", "started": "running", "declined": "cancelled", "revoked": "cancelled", "cancelled": "cancelled",
                  "expired": "cancelled", "created": "invited", "sent": "invited"}


class InviteConsentTargets:
    """The invite side of `ConsentTargets` (story P-16's port): finds an attempt by the id given out at binding and applies the decision."""

    def __init__(self, assessments: AssessmentService, attempts: AttemptPort, roles: RoleService):
        self._assessments, self._attempts, self._roles = assessments, attempts, roles

    def find(self, attempt_id: str) -> ConsentTarget | None:
        found = self._assessments.for_attempt(attempt_id)  # read as the signed-in candidate: only their own invite is visible (policy `own_invite`)
        if found is None:
            return None
        view, org_id, company = found
        if view.user_id is None:
            return None
        days = view.rules.get("retention_days")
        return ConsentTarget(attempt_id, view.user_id, org_id, view.template_id, company, _ATTEMPT_STATE.get(view.state, "cancelled"),
                             int(days) if isinstance(days, int) else None)

    def _move(self, org_id: str, invite_id: str, to_state: str, *, already: tuple[str, ...]) -> None:
        """Move the invite; a request that lost the race to the same move (two clicks at once) finds the invite already there and goes on."""
        try:
            self._assessments.advance(org_id, invite_id, to_state)
        except InviteClosed as late:
            if late.state not in already:
                raise

    def proceed(self, attempt_id: str, *, decision: str, consent_id: str) -> None:
        found = self._assessments.for_attempt(attempt_id)
        if found is None:
            raise LookupError("no invite for this attempt")  # the record exists, so this is a real fault: ConsentService logs it and the request can be repeated
        view, org_id, _ = found
        if view.user_id is None:
            raise LookupError("the invite is not bound")
        if decision == "declined":
            if view.state == "opened":
                self._move(org_id, view.invite_id, "declined", already=("declined",))
            return
        if view.state == "opened":
            self._move(org_id, view.invite_id, "consented", already=("consented", "started"))
        elif view.state not in ("consented", "started"):
            raise InviteClosed(view.state)  # revoked or expired between the decision and now: nothing is created
        self._attempts.create_from_consent(user_id=view.user_id, org_id=org_id, template_id=attempt_template_key(view.template_id, view.generation),
                                           invite_id=view.invite_id, consent_id=consent_id, attempt_id=attempt_id,
                                           history={"invite_created": view.created_at, "invite_opened": view.opened_at, "consent_given": view.consented_at or datetime.now(UTC)})  # FR-TIM-04
        self._roles.grant_candidate_role(view.user_id)
