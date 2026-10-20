"""The recruiter's routes of IF-1 (story P-27, FR-ORG-01, 02, 07, 08, FR-ASM-01 to 06, for FR-DSH-02 and FR-DSH-03): sign-up, the company's standing, re-applying, the
data-processing terms, the assessment templates and the invites. The services are stories P-18 to P-21 (`CompanyService`, `AssessmentService`).

`signupRecruiter` needs no session and answers 202 whatever the address is, like `createAccount`. Every other route needs a recruiter's session (`requires(Role.RECRUITER)`):
a learner or an admin is answered 404 REQ-ROUTE-UNKNOWN, as for a route that does not exist; the terms and re-applying need the company's owner (`Role.ORG_OWNER`). The
services check the company against the database again (the session's company must be the one the account is an active recruiter of), so a template or invite of
another company is 404 ATT-NOT-FOUND (not yours is not found). A company that is not active, invites before the terms are accepted, an invite in a state the change does
not start from, and a template that invites use are 409 ATT-INVALID-STATE; a changed terms text is 409 ATT-CONSENT-STALE; a single invite past the daily cap is 429
REQ-RATE-LIMITED (a bulk invite answers what was not tried as `remaining`). No new error code (ADR 0059). The candidate's results are the lab's reviewer routes (IF-2).
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import Field
from vulnmart_models.error_codes import ErrorCode

from vulnmart.accounts.http import Authenticated, Strict, accepted, check_origin, hash_slots, invalid, ip_of, limit, read_json, requires, services, timestamp
from vulnmart.accounts.security import normalize_email
from vulnmart.accounts.service import InvalidInput
from vulnmart.assessments.service import (
    AlreadyStarted, AssessmentService, BulkResult, InviteCapReached, InviteClosed, InviteExists, InviteNotFound, InviteTaken, InviteView, TemplateInUse,
    TemplateNotFound, TemplateView,
)
from vulnmart.kernel.ratelimit import email_key
from vulnmart.kernel.service import NO_STORE
from vulnmart.ports.scope import Role
from vulnmart.problem import ProblemError

from .service import CompanyNotFound, CompanyService, InvalidTransition, NotARecruiter, NotActiveRecruiter, NotTheOwner, TermsNotAccepted, TermsStale

router = APIRouter(tags=["company"])

recruiter_read = requires(Role.RECRUITER)
recruiter_write = requires(Role.RECRUITER, csrf=True)
owner_read = requires(Role.ORG_OWNER)
owner_write = requires(Role.ORG_OWNER, csrf=True)

TEMPLATE_ID = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
INVITE_ID = r"^i-[A-Z2-7]{16}$"
INVITE_STATES = Literal["created", "sent", "opened", "consented", "started", "declined", "expired", "cancelled", "revoked"]


class RecruiterSignupBody(Strict):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=128)
    display_name: str = Field(min_length=1, max_length=60)
    company_name: str = Field(min_length=1, max_length=120)
    captcha_token: str | None = Field(default=None, max_length=2048)  # OI-29: rate limits only; accepted and ignored


class TermsBody(Strict):
    version: str = Field(min_length=1, max_length=40)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class TemplateBody(Strict):
    title: str = Field(min_length=1, max_length=200)
    challenge_keys: list[str] = Field(min_length=1, max_length=11)
    time_limit_min: int | None = None
    hints_mode: Literal["off", "on"] | None = None
    hint_cost_pct: int | None = None
    reset_limit: int | None = None
    invite_expiry_days: int | None = None
    retention_days: int | None = None
    writeup_required: bool | None = None
    results_visibility: Literal["after_submit", "after_release"] | None = None
    flag_submissions_per_minute: int | None = None

    def values(self) -> dict[str, Any]:
        return {k: v for k, v in self.model_dump().items() if v is not None}


class InvitesBody(Strict):
    template_id: str = Field(pattern=TEMPLATE_ID)
    emails: list[str] = Field(min_length=1, max_length=500)


class InviteActionBody(Strict):
    action: Literal["resend", "cancel", "revoke", "reinvite"]


def parts(request: Request) -> tuple[CompanyService, AssessmentService]:
    companies = getattr(request.app.state, "companies", None)
    assessments = getattr(request.app.state, "assessments", None)
    if companies is None or assessments is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return companies, assessments


async def run(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run a service call off the event loop and turn its refusals into the contract's answers."""
    try:
        return await asyncio.to_thread(lambda: fn(*args, **kwargs))
    except InvalidInput as exc:
        raise invalid(exc) from None
    except (TemplateNotFound, InviteNotFound, CompanyNotFound):
        raise ProblemError(ErrorCode.ATT_NOT_FOUND) from None
    except (NotTheOwner, NotARecruiter):
        raise ProblemError(ErrorCode.REQ_ROUTE_UNKNOWN) from None
    except TermsStale:
        raise ProblemError(ErrorCode.ATT_CONSENT_STALE) from None
    except InviteCapReached:
        raise ProblemError(ErrorCode.REQ_RATE_LIMITED) from None
    except (NotActiveRecruiter, TermsNotAccepted, InvalidTransition, InviteExists, InviteClosed, InviteTaken, AlreadyStarted, TemplateInUse):
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None


def template_body(t: TemplateView) -> dict[str, Any]:
    return {"template_id": t.template_id, "title": t.title, "challenge_keys": list(t.challenge_keys), "time_limit_min": t.time_limit_min, "hints_mode": t.hints_mode,
            "hint_cost_pct": t.hint_cost_pct, "reset_limit": t.reset_limit, "invite_expiry_days": t.invite_expiry_days, "retention_days": t.retention_days,
            "writeup_required": t.writeup_required, "results_visibility": t.results_visibility, "flag_submissions_per_minute": t.flag_submissions_per_minute,
            "version": t.version, "updated_at": timestamp(t.updated_at)}


def invite_body(i: InviteView) -> dict[str, Any]:
    def when(value: Any) -> str | None:
        return None if value is None else timestamp(value)

    rules = i.rules or {}
    return {"invite_id": i.invite_id, "template_id": i.template_id, "email": i.email, "state": i.state, "attempt_id": i.attempt_id, "generation": i.generation,
            "superseded_by": i.superseded_by, "expires_at": timestamp(i.expires_at), "created_at": timestamp(i.created_at), "sent_at": when(i.sent_at),
            "opened_at": when(i.opened_at), "consented_at": when(i.consented_at), "started_at": when(i.started_at), "closed_at": when(i.closed_at),
            "time_limit_min": rules.get("time_limit_min"), "hints_mode": rules.get("hints_mode", "off"), "hint_cost_pct": rules.get("hint_cost_pct", 0),
            "results_visibility": rules.get("results_visibility", "after_submit")}


# ---- sign-up and the company ----

@router.post("/api/v1/recruiters", operation_id="signupRecruiter", status_code=202)
async def signup_recruiter(request: Request) -> JSONResponse:
    check_origin(request)
    companies, _ = parts(request)
    _, limiter = services(request)
    limit(request, limiter, "signup:ip", ip_of(request), "rate_signup_per_ip_per_hour")
    body = await read_json(request, RecruiterSignupBody)
    address = normalize_email(body.email)
    if address is None:
        raise invalid(InvalidInput("/email"))
    limit(request, limiter, "signup:email", email_key(address), "rate_signup_per_email_per_hour")
    try:
        async with hash_slots(request):
            await asyncio.to_thread(lambda: companies.signup_recruiter(email=body.email, password=body.password, display_name=body.display_name,
                                                                       company_name=body.company_name))
    except InvalidInput as exc:
        raise invalid(exc) from None
    return accepted()


@router.get("/api/v1/company", operation_id="getMyCompany")
async def get_my_company(request: Request, auth: Authenticated = Depends(recruiter_read)) -> JSONResponse:
    companies, _ = parts(request)
    s = await run(companies.standing, auth.session.user.id)
    role = "owner" if Role.ORG_OWNER in auth.session.roles else "member" if s.org_id else None
    return JSONResponse({"state": s.state, "company_name": s.org_name, "reason": s.reason, "terms_accepted": s.terms_accepted, "role": role}, headers=NO_STORE)


@router.post("/api/v1/company/reapply", operation_id="reapplyCompany", status_code=204)
async def reapply_company(request: Request, auth: Authenticated = Depends(owner_write)) -> Response:
    companies, _ = parts(request)
    await run(companies.reapply, auth.session.user.id)
    return Response(status_code=204, headers=NO_STORE)


@router.get("/api/v1/company/terms", operation_id="getCompanyTerms")
async def get_company_terms(request: Request, auth: Authenticated = Depends(owner_read)) -> JSONResponse:
    companies, _ = parts(request)
    t = await run(companies.terms_for, auth.session.user.id)
    return JSONResponse({"version": t.version, "text": t.text, "sha256": t.sha256}, headers=NO_STORE)


@router.post("/api/v1/company/terms", operation_id="acceptCompanyTerms", status_code=204)
async def accept_company_terms(request: Request, auth: Authenticated = Depends(owner_write)) -> Response:
    companies, _ = parts(request)
    body = await read_json(request, TermsBody)
    await run(companies.accept_terms, auth.session.user.id, body.version, body.sha256)
    return Response(status_code=204, headers=NO_STORE)


# ---- templates ----

@router.get("/api/v1/company/templates", operation_id="listTemplates")
async def list_templates(request: Request, auth: Authenticated = Depends(recruiter_read), limit_: Annotated[int, Query(alias="limit", ge=1, le=100)] = 100) -> JSONResponse:
    _, assessments = parts(request)
    rows = await run(assessments.list_templates, auth.session.scope, limit_)
    return JSONResponse({"items": [template_body(t) for t in rows]}, headers=NO_STORE)


@router.post("/api/v1/company/templates", operation_id="createTemplate", status_code=201)
async def create_template(request: Request, auth: Authenticated = Depends(recruiter_write)) -> JSONResponse:
    _, assessments = parts(request)
    body = await read_json(request, TemplateBody)
    t = await run(assessments.create_template, auth.session.scope, body.values())
    return JSONResponse(template_body(t), status_code=201, headers=NO_STORE)


@router.get("/api/v1/company/templates/{template_id}", operation_id="getTemplate")
async def get_template(request: Request, template_id: Annotated[str, Path(pattern=TEMPLATE_ID)], auth: Authenticated = Depends(recruiter_read)) -> JSONResponse:
    _, assessments = parts(request)
    return JSONResponse(template_body(await run(assessments.get_template, auth.session.scope, template_id.lower())), headers=NO_STORE)


@router.put("/api/v1/company/templates/{template_id}", operation_id="updateTemplate")
async def update_template(request: Request, template_id: Annotated[str, Path(pattern=TEMPLATE_ID)], auth: Authenticated = Depends(recruiter_write)) -> JSONResponse:
    _, assessments = parts(request)
    body = await read_json(request, TemplateBody)
    return JSONResponse(template_body(await run(assessments.update_template, auth.session.scope, template_id.lower(), body.values())), headers=NO_STORE)


@router.delete("/api/v1/company/templates/{template_id}", operation_id="deleteTemplate", status_code=204)
async def delete_template(request: Request, template_id: Annotated[str, Path(pattern=TEMPLATE_ID)], auth: Authenticated = Depends(recruiter_write)) -> Response:
    _, assessments = parts(request)
    await run(assessments.delete_template, auth.session.scope, template_id.lower())
    return Response(status_code=204, headers=NO_STORE)


# ---- invites ----

@router.get("/api/v1/company/invites", operation_id="listCompanyInvites")
async def list_company_invites(request: Request, auth: Authenticated = Depends(recruiter_read), state: Annotated[INVITE_STATES | None, Query()] = None,
                               template_id: Annotated[str | None, Query(pattern=TEMPLATE_ID)] = None,
                               limit_: Annotated[int, Query(alias="limit", ge=1, le=100)] = 100) -> JSONResponse:
    _, assessments = parts(request)
    rows = await run(assessments.list_invites, auth.session.scope, state=state, template_id=template_id.lower() if template_id else None, limit=limit_)
    return JSONResponse({"items": [invite_body(i) for i in rows]}, headers=NO_STORE)


@router.post("/api/v1/company/invites", operation_id="createInvites", status_code=201)
async def create_invites(request: Request, auth: Authenticated = Depends(recruiter_write)) -> JSONResponse:
    """One address: the invite or the refusal (409 a live invite exists, 429 the daily cap). Several: the bulk result, address by address (FR-ASM-06)."""
    _, assessments = parts(request)
    body = await read_json(request, InvitesBody)
    template_id = body.template_id.lower()
    if len(body.emails) == 1:
        made = await run(assessments.create_invite, auth.session.scope, template_id, body.emails[0])
        result = BulkResult((made,), (), ())
    else:
        result = await run(assessments.create_invites, auth.session.scope, template_id, body.emails)
    return JSONResponse({"created": [invite_body(i) for i in result.created], "skipped": [{"email": e, "reason": r} for e, r in result.skipped],
                         "remaining": list(result.remaining), "cap": result.cap}, status_code=201, headers=NO_STORE)


@router.post("/api/v1/company/invites/{invite_id}/actions", operation_id="actOnInvite")
async def act_on_invite(request: Request, invite_id: Annotated[str, Path(pattern=INVITE_ID)], auth: Authenticated = Depends(recruiter_write)) -> JSONResponse:
    _, assessments = parts(request)
    body = await read_json(request, InviteActionBody)
    if body.action == "resend":  # a resend sends a mail and the daily invite cap does not count it (a re-invite does); story 1.9, deferred R5
        limit(request, services(request)[1], "invite-resend:user", auth.session.user.id, "rate_invite_resend_per_user_per_hour")
    fn = {"resend": assessments.resend, "cancel": assessments.cancel, "revoke": assessments.revoke, "reinvite": assessments.reinvite}[body.action]
    return JSONResponse(invite_body(await run(fn, auth.session.scope, invite_id)), headers=NO_STORE)
