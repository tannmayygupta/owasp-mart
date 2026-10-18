"""The consent routes of IF-1: getConsentNotice, recordConsent, listMyConsents (story P-16, FR-PRV-01, FR-PRV-02).

Every route needs a session; the two that name an attempt answer 404 ATT-NOT-FOUND for an attempt that is not the caller's (the contract's "not
yours is not found"). The decision is limited per account (a person decides once per attempt, so the limit only stops a script) and the request
carries the notice version and text hash the person saw. Withdrawal is a later route (story P-25).
"""
from __future__ import annotations

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field
from vulnmart_models.error_codes import ErrorCode

from vulnmart.accounts.http import (
    Authenticated, Strict, authenticated, authenticated_with_csrf, ip_of, limit, read_json, services, timestamp,
)
from vulnmart.kernel.service import NO_STORE
from vulnmart.problem import ProblemError

from .consent import ConsentNotFound, ConsentService, ConsentStale, ConsentState, ConsentView

router = APIRouter(tags=["consent"])

ATTEMPT_ID = r"^a-[A-Z2-7]{16}$"  # the contract's AttemptId, checked here before it reaches a store


class ConsentBody(Strict):
    attempt_id: str = Field(pattern=ATTEMPT_ID)
    notice_version: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}\.\d{1,3}$")
    notice_text_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    decision: Literal["granted", "declined"]


def consent_service(request: Request) -> ConsentService:
    service = getattr(request.app.state, "consent_service", None)
    if service is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return service


def record_body(view: ConsentView) -> dict[str, str]:
    return {"consent_id": view.consent_id, "attempt_id": view.attempt_id, "notice_version": view.notice_version, "decision": view.decision,
            "recorded_at": timestamp(view.recorded_at)}


@router.get("/api/v1/consent/notice", operation_id="getConsentNotice")
async def get_notice(request: Request, attempt_id: Annotated[str, Query(pattern=ATTEMPT_ID)], auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    service = consent_service(request)
    try:
        target, notice = await asyncio.to_thread(service.notice, auth.session.user.id, attempt_id)
    except ConsentNotFound:
        raise ProblemError(ErrorCode.ATT_NOT_FOUND) from None
    except ConsentState:
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    return JSONResponse({"attempt_id": target.attempt_id, "notice_version": notice.version, "notice_text": notice.text,
                         "notice_text_sha256": notice.sha256, "retention_days_shown": notice.retention_days_shown, "company_name": notice.company_name},
                        headers=NO_STORE)


@router.post("/api/v1/consent", operation_id="recordConsent", status_code=201)
async def record_consent(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    service = consent_service(request)
    _, limiter = services(request)
    user_id = auth.session.user.id
    limit(request, limiter, "consent:user", user_id, "rate_consent_per_user_per_hour")
    body = await read_json(request, ConsentBody)
    try:
        view = await asyncio.to_thread(
            service.record, user_id=user_id, attempt_id=body.attempt_id, notice_version=body.notice_version, notice_sha256=body.notice_text_sha256,
            decision=body.decision, ip=ip_of(request), user_agent=request.headers.get("user-agent"))
    except ConsentNotFound:
        raise ProblemError(ErrorCode.ATT_NOT_FOUND) from None
    except ConsentStale:
        raise ProblemError(ErrorCode.ATT_CONSENT_STALE) from None
    except ConsentState:
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    return JSONResponse(record_body(view), status_code=201, headers=NO_STORE)


@router.get("/api/v1/me/consents", operation_id="listMyConsents")
async def list_my_consents(request: Request, auth: Authenticated = Depends(authenticated), limit_: Annotated[int, Query(alias="limit", ge=1, le=100)] = 50) -> JSONResponse:
    service = consent_service(request)
    items, has_more = await asyncio.to_thread(service.list_mine, auth.session.user.id, limit_)
    return JSONResponse({"items": [record_body(v) for v in items], "has_more": has_more}, headers=NO_STORE)
