"""Errors of the internal ports (IF-9): one class per error code of the registry (IF-8).

`code` is a code of `contracts/errors/error-codes.yaml` and `http_status` its status, so an API route that
lets one of these through answers the matching problem body. `InstanceHost` keeps its own `OrchestratorError`
family (IF-5); these are the errors of the ports between stream P and stream L.
"""
from __future__ import annotations

from vulnmart_models.error_codes import ERRORS, ErrorCode


class PortError(Exception):
    """Base of every port error. `code` is the IF-8 code, `http_status` the HTTP status the API answers."""

    code: ErrorCode = ErrorCode.REQ_INTERNAL
    http_status = 500

    def __init__(self, message: str = "", *, field: str | None = None):
        super().__init__(message or self.code.value)
        self.message = message or self.code.value
        self.field = field

    def __init_subclass__(cls, **kwargs: object) -> None:
        super().__init_subclass__(**kwargs)
        # the status comes from the registry, so a class can never disagree with IF-8
        cls.http_status = ERRORS[cls.code].status or 500


# ---- programming errors: a caller broke the contract of a port (always a bug, answered 500 REQ-INTERNAL) ----

class PortMisuse(PortError):
    """The one class of REQ-INTERNAL; the subclasses below say which rule was broken."""

    code = ErrorCode.REQ_INTERNAL


class ScopeMissing(PortMisuse):
    """A scoped call ran without a user or organisation in scope (ADR 0014: refuse, never return everything)."""


class UnknownSetting(PortMisuse):
    """A setting name that is not in `ports.settings.SETTINGS`."""


class EventInvalid(PortError):
    """A domain event that is not an IF-3 event (unknown type, wrong schema version, missing member)."""

    code = ErrorCode.EVT_SCHEMA


class KeyIntegrity(PortMisuse):
    """A sealed value that does not belong to this attempt, or whose associated data differs."""


# ---- attempt errors (IF-2 vocabulary) ----

class AttemptNotFound(PortError):
    code = ErrorCode.ATT_NOT_FOUND


class AttemptStateInvalid(PortError):
    code = ErrorCode.ATT_INVALID_STATE


class AttemptGone(PortError):
    """The attempt was purged, or its key was shredded: its data cannot be read any more."""

    code = ErrorCode.ATT_GONE


class ChallengeNotFound(PortError):
    code = ErrorCode.ATT_CHALLENGE_NOT_FOUND


class FlagRateLimited(PortError):
    """Too many incorrect flag pastes for one challenge (story 6.3): the API answers 429 with `Retry-After: retry_after`."""

    code = ErrorCode.ATT_FLAG_RATE_LIMITED

    def __init__(self, message: str = "", *, field: str | None = None, retry_after: int = 1):
        super().__init__(message, field=field)
        self.retry_after = max(1, int(retry_after))


# ---- instance errors (IF-2 vocabulary; the orchestrator's own are in instance_host.py) ----

class InstanceMissing(PortError):
    code = ErrorCode.INST_NOT_FOUND


class InstanceStateInvalid(PortError):
    code = ErrorCode.INST_INVALID_STATE


class InstanceNotReady(PortError):
    code = ErrorCode.INST_NOT_READY


class InstanceQuotaReached(PortError):
    code = ErrorCode.INST_QUOTA_REACHED


class KeyShredded(AttemptGone):
    """The attempt's key was shredded: deleting the key is how an attempt's evidence is erased (ATT-GONE, like a purge)."""


# One class per code (subclasses such as ScopeMissing or KeyShredded are caught by their code's class).
ERRORS_BY_CODE: dict[ErrorCode, type[PortError]] = {
    cls.code: cls
    for cls in (PortMisuse, EventInvalid, AttemptNotFound, AttemptStateInvalid, AttemptGone, ChallengeNotFound, FlagRateLimited,
                InstanceMissing, InstanceStateInvalid, InstanceNotReady, InstanceQuotaReached)
}
