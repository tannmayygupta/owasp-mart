"""OutboxPort: publish a domain event and queue an email, in the same transaction as their cause (IF-9).

Provided by stream P, used by both streams. The event is an IF-3 event (`contracts/domain-events/`): what the
browser reads as the `data` of a Server-Sent Event. The publisher never names an audience: the relay resolves
user, org and admin from the attempt (`contracts/domain-events/audiences.json`). Emails go to
`email_outbox` and are sent by the worker; the publisher names a template and a user id, never an address.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from .errors import EventInvalid

SCHEMA_VERSION = 1

# The types of IF-3 0.1.0 a publisher may hand over (`stream.resync` is the hub's own control event, never published).
EVENT_TYPES = frozenset({
    "instance.state_changed",
    "attempt.state_changed",
    "attempt.milestone_reached",
    "attempt.flag_captured",
    "attempt.score_updated",
    "attempt.hint_unlocked",
})


# Who receives each type, by attempt mode: a copy of `contracts/domain-events/audiences.json` (a test keeps them equal).
AUDIENCES: dict[str, dict[str, tuple[str, ...]]] = {
    "instance.state_changed": {"learner": ("user", "admin"), "candidate": ("user", "admin")},
    "attempt.state_changed": {"learner": ("user",), "candidate": ("user", "org")},
    "attempt.milestone_reached": {"learner": ("user",), "candidate": ("org",)},
    "attempt.flag_captured": {"learner": ("user",), "candidate": ("org",)},
    "attempt.score_updated": {"learner": ("user",), "candidate": ("org",)},
    "attempt.hint_unlocked": {"learner": ("user",), "candidate": ("user", "org")},
}


# The members of `data` per type (IF-3: every member is required and no other is allowed).
DATA_MEMBERS: dict[str, frozenset[str]] = {
    "instance.state_changed": frozenset({"instance_id", "attempt_id", "state", "access", "health", "epoch", "error_code"}),
    "attempt.state_changed": frozenset({"attempt_id", "mode", "state", "previous_state", "deadline_at"}),
    "attempt.milestone_reached": frozenset({"attempt_id", "mode", "challenge_key", "milestone"}),
    "attempt.flag_captured": frozenset({"attempt_id", "mode", "challenge_key"}),
    "attempt.score_updated": frozenset({"attempt_id", "mode", "score", "computed_at", "per_challenge"}),
    "attempt.hint_unlocked": frozenset({"attempt_id", "mode", "challenge_key", "level"}),
}


def audiences_for(event: Mapping[str, Any]) -> tuple[str, ...]:
    """The audience kinds of a checked event, from its type and the attempt mode. An attempt event always carries its mode;
    an instance event has none and goes to the same kinds in both modes. The relay turns the kinds into streams
    (`live:user:<id>`, `live:org:<id>`, `live:admin`)."""
    by_mode = AUDIENCES[event["type"]]
    mode = event["data"].get("mode")
    if mode is None:
        first, *rest = by_mode.values()
        if any(r != first for r in rest):
            raise ValueError(f"{event['type']} needs the attempt mode to resolve its audiences")
        return first
    return by_mode[mode]


def check_event(event: Any) -> None:
    """Refuse anything that is not an IF-3 event a publisher may hand over (EventInvalid, naming the member). Shared by the in-memory outbox and the database one, so both
    accept exactly the same events."""
    if not isinstance(event, Mapping):
        raise EventInvalid("an event is a JSON object")
    extra = set(event) - {"schema_version", "type", "occurred_at", "data"}
    if extra:
        raise EventInvalid(f"an IF-3 event has no member {sorted(extra)[0]!r} (the relay resolves audiences)", field=f"/{sorted(extra)[0]}")
    if event.get("schema_version") != SCHEMA_VERSION:
        raise EventInvalid("schema_version must be 1", field="/schema_version")
    if event.get("type") not in EVENT_TYPES:
        raise EventInvalid(f"unknown event type {event.get('type')!r}", field="/type")
    if not isinstance(event.get("occurred_at"), str) or not isinstance(event.get("data"), Mapping):
        raise EventInvalid("occurred_at and data are required", field="/data")
    members = set(event["data"])
    wanted = DATA_MEMBERS[event["type"]]
    if members != wanted:
        name = sorted(members - wanted or wanted - members)[0]
        raise EventInvalid(f"data of {event['type']} {'has no member' if name in members else 'needs the member'} {name!r}", field=f"/data/{name}")
    mode = event["data"].get("mode", None)
    if "mode" in wanted and mode not in AUDIENCES[event["type"]]:
        raise EventInvalid(f"unknown attempt mode {mode!r}", field="/data/mode")


@dataclass(frozen=True, slots=True)
class OutboxEntry:
    id: int  # the outbox order, which the relay keeps
    event: Mapping[str, Any]
    audiences: tuple[str, ...]  # resolved on the server (audiences.json), never named by the publisher
    created_at: str


@dataclass(frozen=True, slots=True)
class EmailJob:
    id: int
    template: str
    to_user_id: str
    params: Mapping[str, Any]
    created_at: str


@runtime_checkable
class OutboxPort(Protocol):
    def publish(self, event: Mapping[str, Any]) -> OutboxEntry:
        """Queue one IF-3 event (`schema_version`, `type`, `occurred_at`, `data`). Raises EventInvalid for an unknown
        type, another schema version, a missing member or a member IF-3 does not have (an audience, for example)."""
        ...

    def enqueue_email(self, *, template: str, to_user_id: str, params: Mapping[str, Any] | None = None) -> EmailJob:
        """Queue one email. Raises ValueError for an empty template or user id, or an address in `params`."""
        ...
