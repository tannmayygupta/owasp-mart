"""Token-guarded demo routes of the lab runtime (story 8.1, D-95, D-96). Mounted only when `VULNMART_LAB_DEMO=1` and the token
is non-empty; never in a deployed compose profile. Header `X-Lab-Demo-Token`, compared in constant time, 401 without it.
Answers hold ids, states, numbers and result words only."""
from __future__ import annotations

import hmac
import logging
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header
from pydantic import BaseModel, ConfigDict, Field
from vulnmart_attempts import InvalidTransition
from vulnmart_models.error_codes import ErrorCode

from vulnmart.lab.clock import OffsetClock
from vulnmart.lab.runtime import LabRuntime
from vulnmart.ports.errors import (
    AttemptGone, AttemptNotFound, AttemptStateInvalid, ChallengeNotFound, FlagRateLimited, InstanceMissing, InstanceNotReady,
)
from vulnmart.ports.instance_host import OrchestratorError
from vulnmart.problem import ProblemError

log = logging.getLogger("vulnmart.lab")
PREFIX = "/internal/v1/lab-demo"


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StartBody(_Body):
    user_id: str = Field(min_length=1, max_length=64)
    template_id: str | None = Field(default=None, min_length=3, max_length=32)


class FlagBody(_Body):
    challenge_key: str = Field(min_length=3, max_length=3)
    text: str = Field(max_length=512)


class HintBody(_Body):
    challenge_key: str = Field(min_length=3, max_length=3)
    level: int = Field(ge=1, le=3)


class AdvanceBody(_Body):
    seconds: int = Field(strict=True, ge=1, le=7200)


def _score_json(score) -> dict[str, Any]:
    return {"attempt_id": score.attempt_id, "score": score.score, "computed_at": score.computed_at,
            "per_challenge": [{"challenge_key": r.challenge_key, "milestone": r.milestone.value, "hints_used": r.hints_used,
                               "points": r.points} for r in score.per_challenge]}


def _call(fn, *args):
    """Run a runtime call and turn a port error into the registry code of its answer."""
    try:
        return fn(*args)
    except (AttemptNotFound, AttemptGone):
        raise ProblemError(ErrorCode.ATT_NOT_FOUND) from None
    except (AttemptStateInvalid, InvalidTransition):
        raise ProblemError(ErrorCode.ATT_INVALID_STATE) from None
    except ChallengeNotFound:
        raise ProblemError(ErrorCode.ATT_CHALLENGE_NOT_FOUND) from None
    except FlagRateLimited as exc:
        raise ProblemError(ErrorCode.ATT_FLAG_RATE_LIMITED, headers={"Retry-After": str(getattr(exc, "retry_after", 60))}) from None
    except InstanceNotReady:
        raise ProblemError(ErrorCode.INST_START_FAILED) from None
    except InstanceMissing:
        raise ProblemError(ErrorCode.INST_NOT_FOUND) from None
    except OrchestratorError:
        log.exception("the orchestrator refused a demo call")
        raise ProblemError(ErrorCode.INST_START_FAILED) from None


def install_demo_routes(app: FastAPI, runtime: LabRuntime, token: str) -> bool:
    """Mount the routes. Returns False (and mounts nothing) when the token is empty."""
    if not token:
        log.error("lab demo routes not mounted: VULNMART_LAB_DEMO_TOKEN is empty")
        return False
    wanted = token.encode("utf-8")

    def guard(x_lab_demo_token: Annotated[str | None, Header()] = None) -> None:
        if x_lab_demo_token is None or not hmac.compare_digest(x_lab_demo_token.encode("utf-8"), wanted):
            raise ProblemError(ErrorCode.AUTH_SESSION_REQUIRED)  # the registry's 401; no new code for a demo-only route

    deps = [Depends(guard)]

    @app.post(f"{PREFIX}/attempts", include_in_schema=False, dependencies=deps)
    def start(body: StartBody) -> dict[str, Any]:
        started = _call(runtime.start_attempt, body.user_id, body.template_id)
        return {"attempt_id": started.attempt_id, "instance_id": started.instance_id, "state": started.state}

    @app.get(PREFIX + "/attempts/{attempt_id}", include_in_schema=False, dependencies=deps)
    def state(attempt_id: str) -> dict[str, Any]:
        return _call(runtime.state, attempt_id)

    @app.get(PREFIX + "/instances/{instance_id}", include_in_schema=False, dependencies=deps)
    def instance_state(instance_id: str) -> dict[str, Any]:
        """What the orchestrator reported for an instance (state reports, H-147): the recorded state and the ordered history."""
        recorded = runtime.state_reports.state_of(instance_id)
        if recorded is None:
            raise ProblemError(ErrorCode.INST_NOT_FOUND)
        return {"instance_id": instance_id, "state": recorded.value,
                "transitions": [{"epoch": r.epoch, "transition": r.transition, "from_state": r.from_state.value if r.from_state else None,
                                 "to_state": r.to_state.value} for r in runtime.state_reports.history(instance_id)]}

    @app.post(PREFIX + "/attempts/{attempt_id}/flags", include_in_schema=False, dependencies=deps)
    def flag(attempt_id: str, body: FlagBody) -> dict[str, str]:
        res = _call(runtime.submit_flag, attempt_id, body.challenge_key, body.text)
        return {"result": res.result, "credit": res.credit}

    @app.post(PREFIX + "/attempts/{attempt_id}/hints", include_in_schema=False, dependencies=deps)
    def hint(attempt_id: str, body: HintBody) -> dict[str, int]:
        return {"levels_unlocked": _call(runtime.unlock_hint, attempt_id, body.challenge_key, body.level)}

    @app.post(PREFIX + "/attempts/{attempt_id}/submit", include_in_schema=False, dependencies=deps)
    def submit(attempt_id: str) -> dict[str, str]:
        return {"state": _call(runtime.submit, attempt_id)}

    @app.get(PREFIX + "/attempts/{attempt_id}/score", include_in_schema=False, dependencies=deps)
    def score(attempt_id: str) -> dict[str, Any]:
        return _score_json(_call(runtime.score, attempt_id))

    @app.post(PREFIX + "/tick", include_in_schema=False, dependencies=deps)
    def tick() -> dict[str, Any]:
        return {"changed": list(runtime.tick())}

    @app.post(PREFIX + "/advance", include_in_schema=False, dependencies=deps)
    def advance(body: AdvanceBody) -> dict[str, int]:
        clock = runtime.clock
        if not isinstance(clock, OffsetClock):
            raise ProblemError(ErrorCode.REQ_VALIDATION)
        return {"offset_seconds": clock.advance(body.seconds)}

    return True
