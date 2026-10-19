"""The lab routes of IF-2 (contracts/api/lab/lab.openapi.yaml) over the lab runtime: instances, attempts, flags, hints, score, evidence,
integrity flags, report and timeline. Stream L; the same shapes the fake lab (contracts/mocks/fake-lab) answers.

Who may do what: the owner of an attempt does everything on it; a reviewer (a recruiter of the company that owns a candidate attempt)
reads results and decides integrity flags; anyone else, and anything that does not exist, gets the same 404. Authentication, the Origin
check and the CSRF token are those of every account route (`vulnmart.accounts.http`). Nothing here shows a flag, a decoy, a digest, a seed,
an event key, an owner hash, an orchestrator address or a stack trace; a pasted flag is never echoed or stored.

Learner practice is complete. Candidate attempts need the invite and company stories of stream P (their attempts do not exist yet); the
reviewer paths are in place for them.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import re
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Literal, TypeVar

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import Field
from vulnmart_attempts import AttemptRecord, InvalidTransition, WindowClosed
from vulnmart_attempts.review import NotHeld, ReviewFinal, ReviewForbidden
from vulnmart_models.error_codes import ErrorCode

from vulnmart.accounts.http import Authenticated, Strict, authenticated, authenticated_with_csrf, read_json
from vulnmart.ingest.stores import FlagAlreadyDecided, InstanceInfo
from vulnmart.kernel.service import NO_STORE
from vulnmart.lab.catalog import HINT_KINDS
from vulnmart.lab.runtime import LabRuntime
from vulnmart.ports.errors import (
    AttemptGone,
    AttemptNotFound,
    AttemptStateInvalid,
    ChallengeNotFound,
    FlagRateLimited,
    InstanceMissing,
    InstanceNotReady,
    InstanceQuotaReached,
    InstanceStateInvalid,
    PortError,
)
from vulnmart.ports.instance_host import Access, Busy, InstanceNotFound, InstanceState, OrchestratorError
from vulnmart.ports.scope import Role
from vulnmart.problem import ProblemError

log = logging.getLogger("vulnmart.lab.api")
router = APIRouter(tags=["lab"])

_ATTEMPT = re.compile(r"^a-[A-Z2-7]{16}$")
_INSTANCE = re.compile(r"^i-[A-Z2-7]{16}$")
_FLAG_ID = re.compile(r"^g-[A-Z2-7]{16}$")
_CHALLENGE = re.compile(r"^C(0[1-9]|10|11)$")
_STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
_CURSOR = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_CURSOR_BODY = re.compile(r"^f\.([1-9][0-9]{0,8})\.([1-9][0-9]{0,15})$")
_OPENABLE = (InstanceState.READY, InstanceState.ACTIVE, InstanceState.IDLE)
_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
GONE_STATES = ("withdrawn", "cancelled")
TIMELINE_TYPES = {
    "session_started": "attempt.started", "milestone_reached": "milestone.reached", "flag_submitted": "flag.submitted",
    "hint_unlocked": "hint.unlocked", "instance_reset": "instance.reset", "session_submitted": "attempt.submitted",
    "session_expired": "attempt.expired",
}
M = TypeVar("M", bound=Strict)


# ---- bodies ----

class RequestInstanceBody(Strict):
    kind: Literal["learner"]


class ConfirmBody(Strict):
    confirm: Literal[True]


class FlagBody(Strict):
    challenge_key: str = Field(pattern=r"^C(0[1-9]|10|11)$")
    flag: str = Field(min_length=1, max_length=200)


class DecisionBody(Strict):
    decision: Literal["accept", "reject"]
    note: str = Field(min_length=1, max_length=1000)


# ---- small helpers ----

def lab(request: Request) -> LabRuntime:
    runtime = getattr(request.app.state, "lab", None)
    if runtime is None:
        log.error("lab routes called but the lab runtime is not configured")
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    return runtime


def stamp(moment: datetime | str | None) -> str | None:
    if moment is None:
        return None
    if isinstance(moment, str):
        if _STAMP.fullmatch(moment):
            return moment
        moment = datetime.fromisoformat(moment.replace("Z", "+00:00"))
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _b32(n: int) -> str:
    return base64.b32encode(n.to_bytes(10, "big")).decode("ascii")


def flag_public_id(flag_id: int) -> str:
    return "g-" + _b32(flag_id)


def flag_number(public: str) -> int | None:
    if not _FLAG_ID.fullmatch(public):
        return None
    try:
        return int.from_bytes(base64.b32decode(public[2:]), "big")
    except ValueError:
        return None


def call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run a runtime call and turn what it refuses into the registry's answer."""
    try:
        return fn(*args, **kwargs)
    except FlagRateLimited as exc:
        raise ProblemError(ErrorCode.ATT_FLAG_RATE_LIMITED, headers={"Retry-After": str(exc.retry_after)}) from None
    except (AttemptNotFound, AttemptGone, AttemptStateInvalid, ChallengeNotFound, InstanceMissing, InstanceNotReady,
            InstanceQuotaReached, InstanceStateInvalid) as exc:
        raise ProblemError(exc.code) from None
    except PortError as exc:
        raise ProblemError(exc.code) from None
    except InvalidTransition:
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    except WindowClosed:  # the undo window of a withdrawal has closed: the data is going or gone
        raise ProblemError(ErrorCode.ATT_GONE) from None
    except ReviewFinal:  # the held capture was already decided (two reviewers, opposite answers): the same answer as a decided integrity flag
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    except (ReviewForbidden, NotHeld):  # not allowed to decide it, or nothing is held: the same 404 as for anyone else
        raise ProblemError(ErrorCode.ATT_NOT_FOUND) from None
    except InstanceNotFound:
        raise ProblemError(ErrorCode.INST_NOT_FOUND) from None
    except Busy:
        # the host has no capacity or the orchestrator is busy: tell the browser to try again (429), not that the platform broke
        raise ProblemError(ErrorCode.REQ_RATE_LIMITED, headers={"Retry-After": "15"}) from None
    except OrchestratorError:
        log.exception("the orchestrator refused or did not answer")
        raise ProblemError(ErrorCode.REQ_INTERNAL) from None  # INST-START-FAILED is the code of a failed instance, not an HTTP answer


async def run(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    return await asyncio.to_thread(call, fn, *args, **kwargs)


def query(request: Request, allowed: tuple[str, ...]) -> dict[str, str]:
    """The query parameters of a GET: only the listed ones, each at most once (422 REQ-VALIDATION with `/query/<name>` otherwise)."""
    out: dict[str, str] = {}
    for name in set(request.query_params.keys()):
        values = request.query_params.getlist(name)
        pointer = ("query", name) if re.fullmatch(r"[A-Za-z0-9_-]{1,32}", name) else ("query",)
        if name not in allowed or len(values) > 1:
            raise RequestValidationError([{"type": "extra_forbidden", "loc": pointer, "msg": "", "input": None}])
        out[name] = values[0]
    return out


def parse_limit(params: dict[str, str], default: int, maximum: int) -> int:
    if "limit" not in params:
        return default
    text = params["limit"]
    if not re.fullmatch(r"[1-9][0-9]{0,2}", text) or int(text) > maximum:
        raise RequestValidationError([{"type": "value_error", "loc": ("query", "limit"), "msg": "", "input": None}])
    return int(text)


async def no_body(request: Request) -> None:
    if await request.body():
        raise RequestValidationError([{"type": "extra_forbidden", "loc": ("body",), "msg": "", "input": None}])


def mode_of(rec: AttemptRecord) -> str:
    return "candidate" if rec.org_id else "learner"


def hints_enabled(rec: AttemptRecord) -> bool:
    return rec.org_id is None  # practice has hints; an assessment's template decides (placeholder: off until stream P sets it)


def is_owner(auth: Authenticated, rec: AttemptRecord) -> bool:
    return rec.user_id == auth.session.user.id


def is_reviewer(auth: Authenticated, rec: AttemptRecord) -> bool:
    if rec.org_id is None:
        return is_owner(auth, rec)  # a learner reviews their own practice
    scope = auth.session.scope
    return scope.org_id == rec.org_id and Role.RECRUITER in auth.session.roles


def load_attempt(rt: LabRuntime, attempt_id: str) -> AttemptRecord:
    """The attempt, or the one 404 for a malformed id, an unknown id and a deleted attempt."""
    if not _ATTEMPT.fullmatch(attempt_id):
        raise ProblemError(ErrorCode.ATT_NOT_FOUND)
    try:
        rec = rt.engine.get(attempt_id)
    except KeyError:
        raise ProblemError(ErrorCode.ATT_NOT_FOUND) from None
    if rec.purged_at is not None or rec.state.value == "deleted":
        raise ProblemError(ErrorCode.ATT_NOT_FOUND)
    return rec


def readable(rt: LabRuntime, auth: Authenticated, attempt_id: str) -> AttemptRecord:
    rec = load_attempt(rt, attempt_id)
    if not (is_owner(auth, rec) or is_reviewer(auth, rec)):
        raise ProblemError(ErrorCode.ATT_NOT_FOUND)
    return rec


def not_gone(rec: AttemptRecord) -> AttemptRecord:
    if rec.state.value in GONE_STATES:
        raise ProblemError(ErrorCode.ATT_GONE)
    return rec


def owned(rt: LabRuntime, auth: Authenticated, attempt_id: str) -> AttemptRecord:
    rec = load_attempt(rt, attempt_id)
    if not is_owner(auth, rec):
        raise ProblemError(ErrorCode.ATT_NOT_FOUND)
    return rec


def reviewable(rt: LabRuntime, auth: Authenticated, attempt_id: str) -> AttemptRecord:
    rec = load_attempt(rt, attempt_id)
    if not is_reviewer(auth, rec):
        raise ProblemError(ErrorCode.ATT_NOT_FOUND)
    return not_gone(rec)


def json_ok(body: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers=NO_STORE)


# ---- views ----

def attempt_view(rt: LabRuntime, rec: AttemptRecord) -> dict[str, Any]:
    info = rt.directory.for_attempt(rec.id)
    view = {"attempt_id": rec.id, "mode": mode_of(rec), "state": rec.state.value, "hints_enabled": hints_enabled(rec),
            "instance_id": rec.instance_id or (info.instance_id if info else None), "started_at": stamp(rec.started_at),
            "deadline_at": stamp(rec.deadline_at), "submitted_at": stamp(rec.submitted_at), "frozen_until": stamp(rec.frozen_until),
            "server_time": stamp(rt.clock())}
    if rec.state.value == "withdrawn":  # optional in IF-2 1.1.0: only a withdrawn attempt carries it (null once the withdrawal is undone)
        view["delete_after"] = stamp(rec.delete_after)
    return view


def instance_view(rt: LabRuntime, info: InstanceInfo, rec: AttemptRecord) -> dict[str, Any]:
    try:
        st = rt.host.get(info.instance_id)
    except InstanceNotFound:
        raise ProblemError(ErrorCode.INST_NOT_FOUND) from None
    ready = st.state in (InstanceState.READY, InstanceState.ACTIVE, InstanceState.IDLE)
    return {"instance_id": info.instance_id, "attempt_id": info.attempt_id, "state": st.state.value, "access": st.access.value,
            "health": st.health.value, "epoch": st.epoch, "error_code": st.error_code if st.state is InstanceState.FAILED else None,
            "requested_at": stamp(st.created_at), "ready_at": stamp(rec.started_at) if ready else None,
            "expires_at": stamp(rec.deadline_at), "updated_at": stamp(st.updated_at)}


def own_instance(rt: LabRuntime, auth: Authenticated, instance_id: str) -> tuple[InstanceInfo, AttemptRecord]:
    """The instance and its attempt when both are the caller's; one 404 otherwise."""
    if not _INSTANCE.fullmatch(instance_id):
        raise ProblemError(ErrorCode.INST_NOT_FOUND)
    info = rt.directory.get(instance_id)
    if info is None:
        raise ProblemError(ErrorCode.INST_NOT_FOUND)
    try:
        rec = rt.engine.get(info.attempt_id)
    except KeyError:
        raise ProblemError(ErrorCode.INST_NOT_FOUND) from None
    if not is_owner(auth, rec) or rec.purged_at is not None or rec.state.value == "deleted":
        raise ProblemError(ErrorCode.INST_NOT_FOUND)
    return info, rec


def can_change(rt: LabRuntime, rec: AttemptRecord) -> bool:
    return rec.access != "frozen" and rec.state.value == "running"


def score_rows(rt: LabRuntime, rec: AttemptRecord) -> tuple[int, list[dict[str, Any]]]:
    return rt.score_rows(rec.id)


def hint_view(rt: LabRuntime, rec: AttemptRecord, key: str, level: int) -> dict[str, Any]:
    unlocked = level in rt.hints.levels(rec.id, key)
    catalog = rt.catalog
    return {"level": level, "kind": HINT_KINDS[level - 1], "unlocked": unlocked, "cost_pct": level * 10 if rec.org_id else 0,
            "text": catalog.hint_text(key, level) if unlocked else None}


def flag_view(rt: LabRuntime, row: Any) -> dict[str, Any]:
    held = row.status == "open" and row.kind.value == "activity" and bool(row.challenge_key) and rt.milestones.is_held(row.attempt_id, row.challenge_key)
    return {"integrity_flag_id": flag_public_id(row.flag_id), "type": row.kind.value, "challenge_key": row.challenge_key,
            "explanation": row.explanation[:500] or "-", "status": row.status, "held": held, "created_at": stamp(row.created_at or rt.clock()),
            "decided_at": stamp(row.decided_at), "decision_note": row.decision_note}


def visible_flags(auth: Authenticated, rec: AttemptRecord, rows: list[Any]) -> list[Any]:
    """The owner of a learner attempt does not see `decoy` and `sharing` flags: they would tell why a pasted value was not correct."""
    recruiter = Role.RECRUITER in auth.session.roles
    return [r for r in rows if recruiter or r.kind.value not in ("decoy", "sharing")]


def parse_evidence(text: str) -> tuple[str, str, str | None]:
    """`METHOD path` on the first line, then a blank line and the body (how the sidecar writes a capture)."""
    head, _, rest = text.partition("\n")
    parts = head.split(" ")
    method = parts[0] if parts and parts[0] in _METHODS else "GET"
    path = (parts[1] if len(parts) > 1 else "/")[:2048] or "/"
    body = rest[1:] if rest.startswith("\n") else rest
    return method, path, (body if body else None)


# ---- cursor ----

def encode_cursor(epoch: int, seq: int) -> str:
    return base64.urlsafe_b64encode(f"f.{epoch}.{seq}".encode()).rstrip(b"=").decode("ascii")


def decode_cursor(text: str) -> tuple[int, int] | None:
    if not _CURSOR.fullmatch(text):
        return None
    try:
        raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)).decode("ascii")
    except (ValueError, UnicodeDecodeError):
        return None
    m = _CURSOR_BODY.fullmatch(raw)
    if not m or encode_cursor(int(m.group(1)), int(m.group(2))) != text:
        return None
    return int(m.group(1)), int(m.group(2))


# ---- catalogue and my attempts (IF-1: the platform serves them; the data is the lab's) ----

def catalog_summary(entry: Any) -> dict[str, Any]:
    return {"challenge_key": entry.key, "title": entry.title[:120], "owasp_2021": entry.owasp_2021, "owasp_2025": entry.owasp_2025,
            "difficulty": entry.difficulty, "tier": entry.tier}


@router.get("/api/v1/challenges", operation_id="listCatalogue")
async def list_catalogue(request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rt = lab(request)
    query(request, ())
    entries = [rt.catalog.get(k) for k in rt.catalog.keys()]
    return json_ok({"items": [catalog_summary(e) for e in entries if e is not None], "has_more": False})


@router.get("/api/v1/challenges/{challenge_key}", operation_id="getCatalogueChallenge")
async def get_catalogue_challenge(challenge_key: str, request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rt = lab(request)
    query(request, ())
    entry = rt.catalog.get(challenge_key) if _CHALLENGE.fullmatch(challenge_key) else None
    if entry is None:
        raise ProblemError(ErrorCode.ATT_CHALLENGE_NOT_FOUND)
    return json_ok({**catalog_summary(entry), "cwe_primary": entry.cwe[0] if entry.cwe else "CWE-0", "attack": list(entry.attack)[:20]})


@router.get("/api/v1/me/attempts", operation_id="listMyAttempts")
async def list_my_attempts(request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rt = lab(request)
    params = query(request, ("limit",))
    limit = parse_limit(params, 50, 100)
    rows = [r for r in await run(rt.engine.for_user, auth.session.user.id) if r.purged_at is None and r.state.value != "deleted"]
    items = [{"attempt_id": r.id, "mode": mode_of(r), "state": r.state.value, "instance_id": r.instance_id,
              "created_at": stamp(r.created_at), "deadline_at": stamp(r.deadline_at)} for r in rows[:limit]]
    return json_ok({"items": items, "has_more": len(rows) > limit})


# ---- instances ----

@router.post("/api/v1/instances", operation_id="requestInstance", status_code=202)
async def request_instance(request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    rt = lab(request)
    await read_json(request, RequestInstanceBody)
    user_id = auth.session.user.id
    existing = rt.engine.find(user_id, rt.template_id)  # the one attempt of this user for this template
    if existing is not None and rt.instance_alive(existing.instance_id) and existing.state.value == "running":
        raise ProblemError(ErrorCode.INST_QUOTA_REACHED)
    started = await run(rt.start_attempt_async, user_id)
    info, rec = own_instance(rt, auth, started.instance_id)
    return json_ok(instance_view(rt, info, rec), 202)


@router.get("/api/v1/instances/{instance_id}", operation_id="getInstance")
async def get_instance(instance_id: str, request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rt = lab(request)
    query(request, ())
    info, rec = own_instance(rt, auth, instance_id)
    return json_ok(await run(instance_view, rt, info, rec))


@router.post("/api/v1/instances/{instance_id}/open", operation_id="openInstance")
async def open_instance(instance_id: str, request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    rt = lab(request)
    info, rec = own_instance(rt, auth, instance_id)
    await no_body(request)
    st = await run(rt.host.get, info.instance_id)
    if st.state not in _OPENABLE or st.access is not Access.OPEN:
        raise ProblemError(ErrorCode.INST_NOT_READY)
    minter = getattr(request.app.state, "lab_tickets", None)
    if minter is None:
        log.error("openInstance called but no gate key or labs zone is configured")
        raise ProblemError(ErrorCode.REQ_INTERNAL)
    ticket = minter.mint(info.instance_id, rt.keys.owner_hash(rec.user_id), st.access_epoch)
    return json_ok({"url": ticket.url, "expires_at": stamp(ticket.expires_at)})


@router.post("/api/v1/instances/{instance_id}/reset", operation_id="resetInstance", status_code=202)
async def reset_instance(instance_id: str, request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    rt = lab(request)
    info, rec = own_instance(rt, auth, instance_id)
    await read_json(request, ConfirmBody)
    st = await run(rt.host.get, info.instance_id)
    if st.state not in _OPENABLE or not can_change(rt, rec):
        raise ProblemError(ErrorCode.INST_INVALID_STATE)
    await run(rt.reset_attempt_async, rec.id)
    info, rec = own_instance(rt, auth, instance_id)
    return json_ok(await run(instance_view, rt, info, rec), 202)


@router.post("/api/v1/instances/{instance_id}/stop", operation_id="stopInstance", status_code=202)
async def stop_instance(instance_id: str, request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    rt = lab(request)
    info, rec = own_instance(rt, auth, instance_id)
    await no_body(request)
    st = await run(rt.host.get, info.instance_id)
    if st.state in (InstanceState.STOPPING, InstanceState.DESTROYED):
        return json_ok(await run(instance_view, rt, info, rec), 200)
    if not can_change(rt, rec):
        raise ProblemError(ErrorCode.INST_INVALID_STATE)
    try:
        await run(rt.stop_instance, rec.id)
    except ProblemError as exc:
        if exc.code is ErrorCode.ATT_INVALID_STATE:
            raise ProblemError(ErrorCode.INST_INVALID_STATE) from None
        raise
    return json_ok(await run(instance_view, rt, info, rec), 202)


# ---- attempts ----

@router.get("/api/v1/attempts/{attempt_id}", operation_id="getAttempt")
async def get_attempt(attempt_id: str, request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rt = lab(request)
    query(request, ())
    return json_ok(attempt_view(rt, readable(rt, auth, attempt_id)))


@router.post("/api/v1/attempts/{attempt_id}/submit", operation_id="submitAttempt")
async def submit_attempt(attempt_id: str, request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    rt = lab(request)
    rec = owned(rt, auth, attempt_id)
    await read_json(request, ConfirmBody)
    if rec.state.value != "running":
        raise ProblemError(ErrorCode.ATT_INVALID_STATE)
    await run(rt.submit, rec.id)
    return json_ok(attempt_view(rt, load_attempt(rt, rec.id)))


@router.post("/api/v1/attempts/{attempt_id}/withdraw", operation_id="withdrawAttempt")
async def withdraw_attempt(attempt_id: str, request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    """FR-SES-10: the candidate leaves the assessment. The instance is destroyed, deletion is scheduled after the undo window, nothing scores any more."""
    rt = lab(request)
    rec = owned(rt, auth, attempt_id)
    await read_json(request, ConfirmBody)
    if rec.org_id is None:  # a learner has no assessment to withdraw from (their practice data is erased through the privacy routes)
        raise ProblemError(ErrorCode.ATT_INVALID_STATE)
    await run(rt.withdraw, rec.id)
    return json_ok(attempt_view(rt, load_attempt(rt, rec.id)))


@router.post("/api/v1/attempts/{attempt_id}/withdraw/undo", operation_id="undoWithdrawal")
async def undo_withdrawal(attempt_id: str, request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    """FR-SES-10, D-91: inside the window the scheduled deletion is cancelled. The attempt stays `withdrawn`; it is not resumed."""
    rt = lab(request)
    rec = owned(rt, auth, attempt_id)
    await no_body(request)
    if rec.org_id is None:
        raise ProblemError(ErrorCode.ATT_INVALID_STATE)
    await run(rt.undo_withdrawal, rec.id)
    return json_ok(attempt_view(rt, load_attempt(rt, rec.id)))


@router.post("/api/v1/attempts/{attempt_id}/flags", operation_id="submitFlag")
async def submit_flag(attempt_id: str, request: Request, auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    rt = lab(request)
    rec = owned(rt, auth, attempt_id)
    body = await read_json(request, FlagBody)
    if rec.state.value != "running":
        raise ProblemError(ErrorCode.ATT_INVALID_STATE)
    result = await run(rt.submit_flag, rec.id, body.challenge_key, body.flag)
    return json_ok({"challenge_key": body.challenge_key, "result": result.result, "credit": result.credit})


@router.get("/api/v1/attempts/{attempt_id}/score", operation_id="getScore")
async def get_score(attempt_id: str, request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rt = lab(request)
    query(request, ())
    rec = not_gone(readable(rt, auth, attempt_id))
    total, rows = await run(score_rows, rt, rec)
    return json_ok({"attempt_id": rec.id, "score": total, "computed_at": stamp(rt.clock()), "per_challenge": rows})


@router.get("/api/v1/attempts/{attempt_id}/challenges", operation_id="listChallenges")
async def list_challenges(attempt_id: str, request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rt = lab(request)
    query(request, ())
    rec = not_gone(readable(rt, auth, attempt_id))

    def build() -> list[dict[str, Any]]:
        out = []
        for key in rt.challenge_keys:
            best = rt.milestones.best(rec.id, key)
            out.append({"challenge_key": key, "best_milestone": best.value, "solved": best.value == "M3",
                        "held": rt.milestones.is_held(rec.id, key), "hints_used": len(rt.hints.levels(rec.id, key)),
                        "hints_available": hints_enabled(rec)})
        return out

    return json_ok({"items": await run(build), "has_more": False})


def hint_context(rt: LabRuntime, auth: Authenticated, attempt_id: str, challenge_key: str) -> AttemptRecord:
    rec = not_gone(owned(rt, auth, attempt_id))  # ownership 404, then 410, then the hints-off 404
    if not hints_enabled(rec):
        raise ProblemError(ErrorCode.ATT_HINTS_DISABLED)
    if not _CHALLENGE.fullmatch(challenge_key):
        raise ProblemError(ErrorCode.ATT_CHALLENGE_NOT_FOUND)
    return rec


@router.get("/api/v1/attempts/{attempt_id}/challenges/{challenge_key}/hints", operation_id="listHints")
async def list_hints(attempt_id: str, challenge_key: str, request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rt = lab(request)
    query(request, ())
    rec = hint_context(rt, auth, attempt_id, challenge_key)
    items = await run(lambda: [hint_view(rt, rec, challenge_key, level) for level in (1, 2, 3)])
    return json_ok({"challenge_key": challenge_key, "items": items, "has_more": False})


@router.post("/api/v1/attempts/{attempt_id}/challenges/{challenge_key}/hints/{level}/unlock", operation_id="unlockHint")
async def unlock_hint(attempt_id: str, challenge_key: str, level: str, request: Request,
                      auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    rt = lab(request)
    rec = hint_context(rt, auth, attempt_id, challenge_key)
    await no_body(request)
    if not re.fullmatch(r"[1-3]", level):
        raise ProblemError(ErrorCode.ATT_CHALLENGE_NOT_FOUND)
    if rec.state.value != "running":
        raise ProblemError(ErrorCode.ATT_INVALID_STATE)
    await run(rt.unlock_hint, rec.id, challenge_key, int(level))
    return json_ok(await run(hint_view, rt, rec, challenge_key, int(level)))


# ---- results ----

@router.get("/api/v1/attempts/{attempt_id}/evidence", operation_id="listEvidence")
async def list_evidence(attempt_id: str, request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rt = lab(request)
    params = query(request, ("limit",))
    limit = parse_limit(params, 100, 100)
    rec = reviewable(rt, auth, attempt_id)

    def build() -> tuple[list[dict[str, Any]], bool]:
        items = rt.reports.evidence(rec.id)
        out = []
        for item in items[:limit]:
            text = rt.reports.evidence_body(rec.id, item.evidence_id).decode("utf-8", "replace")
            method, path, body = parse_evidence(text) if text else ("GET", "/", None)
            out.append({"evidence_id": item.evidence_id, "challenge_key": item.challenge_key, "captured_at": stamp(item.captured_at),
                        "method": method, "path": path, "body": body[:8192] if body else None,
                        "body_truncated": bool(body) and len(body.encode("utf-8")) >= 8192})
        return out, len(items) > limit

    items, more = await run(build)
    return json_ok({"items": items, "has_more": more})


@router.get("/api/v1/attempts/{attempt_id}/integrity-flags", operation_id="listIntegrityFlags")
async def list_integrity_flags(attempt_id: str, request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rt = lab(request)
    params = query(request, ("limit",))
    limit = parse_limit(params, 100, 100)
    rec = reviewable(rt, auth, attempt_id)
    rows = visible_flags(auth, rec, await run(rt.integrity.of, rec.id))
    return json_ok({"items": [flag_view(rt, r) for r in rows[:limit]], "has_more": len(rows) > limit})


@router.post("/api/v1/attempts/{attempt_id}/integrity-flags/{integrity_flag_id}/decision", operation_id="decideIntegrityFlag")
async def decide_integrity_flag(attempt_id: str, integrity_flag_id: str, request: Request,
                                auth: Authenticated = Depends(authenticated_with_csrf)) -> JSONResponse:
    rt = lab(request)
    rec = reviewable(rt, auth, attempt_id)
    if Role.RECRUITER not in auth.session.roles:
        raise ProblemError(ErrorCode.ATT_NOT_FOUND)  # the owner may read but not decide (OI-38): the same 404 as for anyone else
    number = flag_number(integrity_flag_id)
    rows = {r.flag_id: r for r in await run(rt.integrity.of, rec.id)}
    if number is None or number not in rows:
        raise ProblemError(ErrorCode.ATT_NOT_FOUND)
    body = await read_json(request, DecisionBody)
    row = rows[number]
    if row.status != "open":
        raise ProblemError(ErrorCode.ATT_INVALID_STATE)
    reviewer = {"id": auth.session.user.id, "role": "recruiter", "org_id": auth.session.scope.org_id or ""}

    def decide() -> Any:
        if row.kind.value == "activity" and row.challenge_key and rt.milestones.is_held(rec.id, row.challenge_key):
            rt.decide_held(rec.id, row.challenge_key, reviewer, body.decision, body.note)  # credits M3 on accept, audited
        try:
            return rt.integrity.decide(rec.id, number, body.decision, body.note, auth.session.user.id, rt.clock())
        except FlagAlreadyDecided:
            raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None

    return json_ok(flag_view(rt, await run(decide)))


@router.get("/api/v1/attempts/{attempt_id}/report", operation_id="getReport")
async def get_report(attempt_id: str, request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rt = lab(request)
    query(request, ())
    rec = reviewable(rt, auth, attempt_id)

    def build() -> dict[str, Any]:
        total, rows = score_rows(rt, rec)
        metrics = rt.time_metrics(rec.id)
        end = rec.submitted_at or rt.clock()
        elapsed = max(0, int((end - rec.started_at).total_seconds())) if rec.started_at else None
        flags = visible_flags(auth, rec, rt.integrity.of(rec.id))
        per = [{"challenge_key": r["challenge_key"], "best_milestone": r["best_milestone"], "points": r["points"], "held": r["held"],
                "hints_used": r["hints_used"], "time_to_capture_seconds": metrics.headline.get(r["challenge_key"]),
                "technique_label": None} for r in rows]
        return {"attempt_id": rec.id, "mode": mode_of(rec), "state": rec.state.value, "generated_at": stamp(rt.clock()), "score": total,
                "elapsed_seconds": elapsed, "active_seconds": metrics.active_seconds if rec.started_at else None,
                "hints_used_total": sum(r["hints_used"] for r in rows), "integrity_open": sum(1 for f in flags if f.status == "open"),
                "per_challenge": per}

    return json_ok(await run(build))


@router.get("/api/v1/attempts/{attempt_id}/timeline", operation_id="getTimeline")
async def get_timeline(attempt_id: str, request: Request, auth: Authenticated = Depends(authenticated)) -> JSONResponse:
    rt = lab(request)
    params = query(request, ("cursor", "limit"))
    limit = parse_limit(params, 50, 200)
    after = None
    if "cursor" in params:
        after = decode_cursor(params["cursor"])
        if after is None:
            raise RequestValidationError([{"type": "value_error", "loc": ("query", "cursor"), "msg": "", "input": None}])
    rec = not_gone(readable(rt, auth, attempt_id))

    def build() -> dict[str, Any]:
        entries = []
        for seq, event in rt.attempt_log.read_keyed(rec.id):
            kind = TIMELINE_TYPES.get(event.get("event", ""))
            if kind is None or (after is not None and (1, seq) <= after):
                continue
            result = event.get("result") if kind == "flag.submitted" else None
            entries.append((seq, {"at": stamp(event["at"]), "type": kind, "challenge_key": event.get("challenge_key"),
                                  "milestone": event.get("level") if kind == "milestone.reached" and event.get("level") in ("M1", "M2", "M3") else None,
                                  "result": result if result in ("correct", "incorrect") else None}))
        page = entries[:limit]
        more = len(entries) > limit
        return {"items": [e for _, e in page], "has_more": more, "next_cursor": encode_cursor(1, page[-1][0]) if more else None}

    return json_ok(await run(build))
