"""The candidate's invite routes of IF-1: openInvite, acceptInvite, listMyInvites (story P-26, FR-ASM-04, FR-DSH-04; the service is story P-21's `InviteAcceptance`).

`openInvite` needs no session (the candidate may have no account yet): the token is the key, so it is rate limited per visitor like the email links, and the answer says what the
assessment is (company, title, time limit, hints, write-up and results rules, expiry, state) and never the invite's address. A link that opens nothing is 400 AUTH-TOKEN-INVALID, as for
the email links. `acceptInvite` needs a session and the CSRF header: it binds the invite to the signed-in candidate and answers the attempt id the consent screen is for; a closed or taken
invite, an account that cannot take an assessment and an account whose verified address is not the invite's are one 409 ATT-INVALID-STATE (the registry has no invite codes; the
answer must not say what the invite's address is). `listMyInvites` lists the invites bound to the caller.
"""
from __future__ import annotations

import asyncio
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field
from vulnmart_models.error_codes import ErrorCode

from vulnmart.accounts.http import Authenticated, Strict, authenticated, authenticated_with_csrf, check_origin, ip_of, limit, read_json, services, timestamp
from vulnmart.kernel.service import NO_STORE
from vulnmart.problem import ProblemError

from .accept import AddressMismatch, InviteAcceptance, LinkInvalid, NotEligible
from .service import AssessmentService, CandidateInvite, InviteClosed, InviteNotFound, InviteTaken
from .tokens import org_of

router = APIRouter(tags=["invites"])


class TokenBody(Strict):
    token: str = Field(min_length=1, max_length=200)


def parts(request: Request) -> tuple[AssessmentService, InviteAcceptance]:
    assessments = getattr(request.app.state, "assessments", None)
    acceptance = getattr(request.app.state, "invite_acceptance", None)
    if assessments is None or acceptance is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return assessments, acceptance


def invite_body(found: CandidateInvite, *, with_ids: bool) -> dict[str, Any]:
    invite, rules = found.invite, found.invite.rules
    body: dict[str, Any] = {
        "state": invite.state, "company_name": found.company_name, "title": found.title, "expires_at": timestamp(invite.expires_at),
        "time_limit_min": rules.get("time_limit_min"), "challenge_count": len(rules.get("challenge_keys") or []), "hints_mode": rules.get("hints_mode", "off"),
        "hint_cost_pct": rules.get("hint_cost_pct", 0), "writeup_required": bool(rules.get("writeup_required", False)),
        "results_visibility": rules.get("results_visibility", "after_submit"),
    }
    if with_ids:
        body |= {"invite_id": invite.invite_id, "attempt_id": invite.attempt_id}
    return body


@router.post("/api/v1/invites/open", operation_id="openInvite")
async def open_invite(request: Request) -> JSONResponse:
    check_origin(request)
    assessments, acceptance = parts(request)
    _, limiter = services(request)
    limit(request, limiter, "invite-open:ip", ip_of(request), "rate_verify_per_ip_per_hour")
    body = await read_json(request, TokenBody)

    def run() -> CandidateInvite | None:
        view = acceptance.open_link(body.token)
        return None if view is None else assessments.describe(str(org_of(body.token)), view)

    found = await asyncio.to_thread(run)
    if found is None:
        raise ProblemError(ErrorCode.AUTH_TOKEN_INVALID)
    return JSONResponse(invite_body(found, with_ids=False), headers=NO_STORE)


@router.post("/api/v1/invites/accept", operation_id="acceptInvite")
async def accept_invite(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    assessments, acceptance = parts(request)
    _, limiter = services(request)
    user_id = auth.session.user.id
    limit(request, limiter, "invite-accept:user", user_id, "rate_verify_per_ip_per_hour")
    body = await read_json(request, TokenBody)

    def run() -> CandidateInvite:
        accepted = acceptance.accept(user_id, body.token)
        return assessments.describe(str(org_of(body.token)), accepted.invite)

    try:
        found = await asyncio.to_thread(run)
    except LinkInvalid:
        raise ProblemError(ErrorCode.AUTH_TOKEN_INVALID) from None
    except (InviteClosed, InviteTaken, InviteNotFound, NotEligible, AddressMismatch):
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    return JSONResponse(invite_body(found, with_ids=True), headers=NO_STORE)


@router.get("/api/v1/me/invites", operation_id="listMyInvites")
async def list_my_invites(request: Request, auth: Authenticated = Depends(authenticated), limit_: Annotated[int, Query(alias="limit", ge=1, le=100)] = 50) -> JSONResponse:
    assessments, _ = parts(request)
    items = await asyncio.to_thread(assessments.my_invites, auth.session.user.id, limit_)
    return JSONResponse({"items": [invite_body(i, with_ids=True) for i in items]}, headers=NO_STORE)
