"""InstanceHost: the platform-side port of the orchestrator API (IF-5, with IF-9).

One method per call of `contracts/orchestrator/orchestrator.openapi.yaml`. Three things implement it:
`HttpInstanceHost` (the real client), `FakeInstanceHost` (in memory) and, as a service, the fake
orchestrator in `contracts/mocks/fake-orchestrator/`. It is not a Docker driver: the orchestrator
accepts instance ids, allow-listed template names, flags, digests and limits, and never an image,
command, volume, port, network or environment value (NFR-SEC-04), so the request types below have
no such field.

Secrets (flags, decoys, digests, event key, seed) are marked `repr=False` so they do not leak into logs
or test output. A status answer never holds one.
"""
from __future__ import annotations

from dataclasses import dataclass
from dataclasses import field as dc_field
from enum import StrEnum
from typing import Protocol, runtime_checkable

# Labels a list call may filter on (instance contract labels). Anything else is ORCH-LABEL-UNKNOWN.
LIST_LABELS = frozenset({"instance", "epoch", "component", "template", "kind"})


class InstanceState(StrEnum):
    REQUESTED = "requested"
    PROVISIONING = "provisioning"
    STARTING = "starting"
    READY = "ready"
    ACTIVE = "active"
    IDLE = "idle"
    RESETTING = "resetting"
    STOPPING = "stopping"
    DESTROYED = "destroyed"
    FAILED = "failed"


# States from which a reset is allowed (FR-INS-07).
RESETTABLE = frozenset({InstanceState.READY, InstanceState.ACTIVE, InstanceState.IDLE})


class Access(StrEnum):
    OPEN = "open"
    FROZEN = "frozen"
    CLOSED = "closed"


class Health(StrEnum):
    UNKNOWN = "unknown"
    HEALTHY = "healthy"
    UNHEALTHY = "unhealthy"


class HostHealth(StrEnum):
    OK = "ok"
    DEGRADED = "degraded"
    DOWN = "down"


@dataclass(frozen=True, slots=True)
class Limits:
    memory_mb: int
    cpu_limit: float
    pids_limit: int
    idle_minutes: int
    max_minutes: int


@dataclass(frozen=True, slots=True)
class FlagEntry:
    challenge_key: str
    flag: str = dc_field(repr=False)


@dataclass(frozen=True, slots=True)
class DecoyEntry:
    challenge_key: str
    index: int
    value: str = dc_field(repr=False)


@dataclass(frozen=True, slots=True)
class DigestEntry:
    challenge_key: str
    sha256: str = dc_field(repr=False)


@dataclass(frozen=True, slots=True)
class FlagMaterial:
    """The secrets of one epoch (create and reset)."""

    flags: tuple[FlagEntry, ...] = dc_field(repr=False)
    decoys: tuple[DecoyEntry, ...] = dc_field(repr=False)
    flag_digests: tuple[DigestEntry, ...] = dc_field(repr=False)
    event_key: str = dc_field(repr=False)
    seed: str = dc_field(repr=False)

    def to_json(self) -> dict:
        return {
            "flags": [{"challenge_key": f.challenge_key, "flag": f.flag} for f in self.flags],
            "decoys": [{"challenge_key": d.challenge_key, "index": d.index, "value": d.value} for d in self.decoys],
            "flag_digests": [{"challenge_key": d.challenge_key, "sha256": d.sha256} for d in self.flag_digests],
            "event_key": self.event_key,
            "seed": self.seed,
        }


@dataclass(frozen=True, slots=True)
class CreateRequest:
    instance_id: str
    template_id: str
    epoch: int
    material: FlagMaterial = dc_field(repr=False)
    hostname: str
    limits: Limits
    # Opaque vm.owner label value: 64 lowercase hex characters (never an email). Stored by the orchestrator,
    # applied as the label, never returned. A reset keeps it.
    owner_hash: str = dc_field(repr=False)
    # First event sequence number of the new sidecar: highest stored seq of the instance plus one, 1 at first create.
    first_seq: int

    def to_json(self) -> dict:
        return {
            "instance_id": self.instance_id,
            "template_id": self.template_id,
            "epoch": self.epoch,
            "owner_hash": self.owner_hash,
            "first_seq": self.first_seq,
            **self.material.to_json(),
            "hostname": self.hostname,
            "limits": {
                "memory_mb": self.limits.memory_mb,
                "cpu_limit": self.limits.cpu_limit,
                "pids_limit": self.limits.pids_limit,
                "idle_minutes": self.limits.idle_minutes,
                "max_minutes": self.limits.max_minutes,
            },
        }


@dataclass(frozen=True, slots=True)
class ResetRequest:
    """New epoch (current plus one), its new secrets and the first sequence number of the new sidecar.

    Template, limits and owner stay: there is no owner_hash here.
    """

    epoch: int
    material: FlagMaterial = dc_field(repr=False)
    first_seq: int

    def to_json(self) -> dict:
        return {"epoch": self.epoch, "first_seq": self.first_seq, **self.material.to_json()}


@dataclass(frozen=True, slots=True)
class InstanceStatus:
    """What a GET may say. No secret field exists, so none can be carried."""

    instance_id: str
    template_id: str
    epoch: int
    state: InstanceState
    access: Access
    access_epoch: int
    health: Health
    error_code: str | None
    host_id: str
    hostname: str
    created_at: str
    updated_at: str

    @classmethod
    def from_json(cls, d: dict) -> InstanceStatus:
        return cls(
            instance_id=d["instance_id"], template_id=d["template_id"], epoch=d["epoch"],
            state=InstanceState(d["state"]), access=Access(d["access"]), access_epoch=d["access_epoch"],
            health=Health(d["health"]), error_code=d["error_code"], host_id=d["host_id"],
            hostname=d["hostname"], created_at=d["created_at"], updated_at=d["updated_at"],
        )


@dataclass(frozen=True, slots=True)
class Outcome:
    """Result of a call that starts work. `changed` is True for 202 (new work), False for 200 (repeat)."""

    status: InstanceStatus
    changed: bool


@dataclass(frozen=True, slots=True)
class InstancePage:
    items: tuple[InstanceStatus, ...]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class HostStatus:
    host_id: str
    kind: str
    capacity_memory_mb: int
    used_memory_mb: int
    instances: int
    health: HostHealth


# ---- errors: one class per code of the contract (placeholders until IF-8) ----

class OrchestratorError(Exception):
    """Base of every orchestrator error. `code` is the ORCH-* code, `http_status` the HTTP status."""

    code = "ORCH-ERROR"
    http_status = 500

    def __init__(
        self, message: str = "", *, field: str | None = None, request_id: str | None = None,
        retry_after: float | None = None,
    ):
        super().__init__(message or self.code)
        self.message = message or self.code
        self.field = field
        self.request_id = request_id
        # Seconds from a Retry-After header (Busy and RateLimited only); None when the server sent none.
        self.retry_after = retry_after


class BadSignature(OrchestratorError):
    code, http_status = "ORCH-BAD-SIGNATURE", 401


class InstanceNotFound(OrchestratorError):
    code, http_status = "ORCH-INSTANCE-NOT-FOUND", 404


class RequestMismatch(OrchestratorError):
    code, http_status = "ORCH-REQUEST-MISMATCH", 409


class InstanceExists(OrchestratorError):
    code, http_status = "ORCH-INSTANCE-EXISTS", 409


class InvalidState(OrchestratorError):
    code, http_status = "ORCH-INVALID-STATE", 409


class StaleEpoch(OrchestratorError):
    code, http_status = "ORCH-STALE-EPOCH", 409


class StaleAccessEpoch(OrchestratorError):
    code, http_status = "ORCH-STALE-ACCESS-EPOCH", 409


class BodyTooLarge(OrchestratorError):
    code, http_status = "ORCH-BODY-TOO-LARGE", 413


class FieldForbidden(OrchestratorError):
    code, http_status = "ORCH-FIELD-FORBIDDEN", 422


class TemplateUnknown(OrchestratorError):
    code, http_status = "ORCH-TEMPLATE-UNKNOWN", 422


class LabelUnknown(OrchestratorError):
    code, http_status = "ORCH-LABEL-UNKNOWN", 422


class ValidationFailed(OrchestratorError):
    code, http_status = "ORCH-VALIDATION", 422


class Busy(OrchestratorError):
    code, http_status = "ORCH-BUSY", 429


class RateLimited(OrchestratorError):
    code, http_status = "ORCH-RATE-LIMITED", 429


class MethodNotAllowed(OrchestratorError):
    code, http_status = "ORCH-METHOD-NOT-ALLOWED", 405


class OrchestratorUnavailable(OrchestratorError):
    """Not an answer of the contract: the orchestrator could not be reached or answered nonsense."""

    code, http_status = "ORCH-UNAVAILABLE", 503


ERRORS_BY_CODE: dict[str, type[OrchestratorError]] = {
    cls.code: cls
    for cls in (
        BadSignature, InstanceNotFound, RequestMismatch, InstanceExists, InvalidState, StaleEpoch,
        StaleAccessEpoch, BodyTooLarge, FieldForbidden, TemplateUnknown, LabelUnknown, ValidationFailed,
        Busy, RateLimited, MethodNotAllowed, OrchestratorUnavailable,
    )
}


@runtime_checkable
class InstanceHost(Protocol):
    """The seven calls of IF-5, as the platform sees them. Every method raises an `OrchestratorError`.

    `@runtime_checkable` only checks that the method names exist; it says nothing about behaviour. The real
    conformance check is the protocol suite (`apps/api/tests/test_protocol.py`), which every implementation
    must pass.
    """

    def create(self, request: CreateRequest) -> Outcome:
        """Create from an allow-listed template. Idempotent on (instance_id, epoch).

        Returns changed=True (202) for a new request and changed=False (200) for an identical repeat.
        Raises RequestMismatch (same id and epoch, other body), InstanceExists (other epoch),
        TemplateUnknown, ValidationFailed, Busy (no capacity, nothing created).
        """
        ...

    def get(self, instance_id: str) -> InstanceStatus:
        """Current state, health and error code. Raises InstanceNotFound."""
        ...

    def reset(self, instance_id: str, request: ResetRequest) -> Outcome:
        """Destroy and recreate with the next epoch. Allowed in ready, active or idle only.

        Raises InstanceNotFound, InvalidState (other states), StaleEpoch (epoch is not current plus one),
        RequestMismatch (same new epoch, other body).
        """
        ...

    def set_access(self, instance_id: str, access: Access, access_epoch: int) -> InstanceStatus:
        """Set open, frozen or closed. The access epoch only grows.

        Raises InstanceNotFound, StaleAccessEpoch (older epoch, or equal with another value), InvalidState (destroyed).
        """
        ...

    def destroy(self, instance_id: str) -> Outcome:
        """Remove everything. changed=False (200) when already stopping or destroyed. Raises InstanceNotFound."""
        ...

    def list_instances(
        self, labels: dict[str, str] | None = None, *, cursor: str | None = None, limit: int = 100
    ) -> InstancePage:
        """List by label (`LIST_LABELS`), ordered by instance id. Raises LabelUnknown for any other label."""
        ...

    def host_status(self) -> HostStatus:
        """Capacity and health of the host."""
        ...
