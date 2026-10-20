"""The export routes of IF-1 (story P-29, FR-EXP-01 to 04): exportMyData and exportCompanyResults, both answered as a zip download.

Both change state (each writes an audit entry, and the company export writes view-history entries), so both are POST with the CSRF header; both are rate limited
per account (`rate_export_per_user_per_hour`). `exportMyData` is any signed-in person's own data. `exportCompanyResults` is the recruiter's (`requires(Role.RECRUITER)`:
anyone else is 404 REQ-ROUTE-UNKNOWN); a template of another company is 404 ATT-NOT-FOUND, a company that is not active 409 ATT-INVALID-STATE (ADR 0060).
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from pydantic import Field
from vulnmart_models.error_codes import ErrorCode

from vulnmart.accounts.http import Authenticated, Strict, authenticated_with_csrf, limit, read_json, requires, services
from vulnmart.assessments.service import TemplateNotFound
from vulnmart.kernel.service import NO_STORE
from vulnmart.orgs.service import NotActiveRecruiter
from vulnmart.ports.scope import Role
from vulnmart.problem import ProblemError

from .exports import ExportService

router = APIRouter(tags=["exports"])

TEMPLATE_ID = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"


class CompanyExportBody(Strict):
    template_id: str = Field(pattern=TEMPLATE_ID)


def exports_of(request: Request) -> ExportService:
    service = getattr(request.app.state, "export_service", None)
    if service is None:
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return service


def zip_answer(data: bytes, name: str) -> Response:
    return Response(content=data, media_type="application/zip",
                    headers={**NO_STORE, "Content-Disposition": f'attachment; filename="{name}"', "X-Content-Type-Options": "nosniff"})


@router.post("/api/v1/me/exports", operation_id="exportMyData")
async def export_my_data(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> Response:
    service = exports_of(request)
    _, limiter = services(request)
    user_id = auth.session.user.id
    limit(request, limiter, "export:user", user_id, "rate_export_per_user_per_hour")
    data, _ = await asyncio.to_thread(service.own_zip, user_id)
    return zip_answer(data, "vulnmart-my-data.zip")


@router.post("/api/v1/company/exports", operation_id="exportCompanyResults")
async def export_company_results(request: Request, auth: Authenticated = Depends(requires(Role.RECRUITER, csrf=True))) -> Response:
    service = exports_of(request)
    _, limiter = services(request)
    limit(request, limiter, "export:user", auth.session.user.id, "rate_export_per_user_per_hour")
    body = await read_json(request, CompanyExportBody)
    try:
        data, _ = await asyncio.to_thread(service.company_zip, auth.session.scope, body.template_id.lower())
    except TemplateNotFound:
        raise ProblemError(ErrorCode.ATT_NOT_FOUND) from None
    except NotActiveRecruiter:
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    return zip_answer(data, "vulnmart-results.zip")
