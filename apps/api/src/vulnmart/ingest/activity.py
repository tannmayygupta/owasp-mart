"""Activity metadata and the label rule (story 6.4, FR-DET-08 and FR-DET-07, D-78).

Buckets keyed `(instance_id, epoch, minute)` hold counts only: requests, per status class, per method class, `crs_match` per tag and
the number of distinct route templates. No body, no query, no user text; UTC; the minute is the platform's arrival minute (never the
instance clock). `last_activity(instance_id)` is the input for the orchestrator's idle rule (H-122 is still open: this module only
offers the value). The stores are a Protocol with an in-memory fake until Akshay's `activity_buckets` table exists (H-330).

`attribution_label` and `per_challenge_time_allowed` read the setting `classifier_accuracy_verified`. Until the classifier accuracy
measurement (story 5) is accepted by the developer the setting is false (or missing), the label reads `estimated` and per-challenge
active time is not allowed (assessment-level only). Neither function changes a score.
"""
from __future__ import annotations

import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol, runtime_checkable

from vulnmart.ingest.engine import is_countable
from vulnmart.ports.errors import UnknownSetting

VERIFIED_SETTING = "classifier_accuracy_verified"
MAX_ROUTES_PER_BUCKET = 64
_TYPES = ("proxy.request", "proxy.crs_match")


def minute_of(at: datetime) -> datetime:
    """The UTC minute (seconds and below cut off). A naive time is taken as UTC."""
    at = at.replace(tzinfo=UTC) if at.tzinfo is None else at.astimezone(UTC)
    return at.replace(second=0, microsecond=0)


@dataclass(frozen=True, slots=True)
class ActivityBucket:
    """A read-only copy of one bucket. Counts and fixed words only."""

    instance_id: str
    epoch: int
    minute: datetime
    requests: int
    by_status_class: Mapping[str, int]
    by_method: Mapping[str, int]
    crs_by_tag: Mapping[str, int]
    distinct_routes: int


@dataclass(slots=True)
class _Bucket:
    requests: int = 0
    by_status_class: dict[str, int] = field(default_factory=dict)
    by_method: dict[str, int] = field(default_factory=dict)
    crs_by_tag: dict[str, int] = field(default_factory=dict)
    routes: set[str] = field(default_factory=set)

    def apply(self, etype: str, d: Mapping[str, Any]) -> None:
        """Add one countable event (`proxy.request` or `proxy.crs_match`) to this bucket. Counts and fixed words only."""
        route = d.get("route_template")
        if isinstance(route, str) and (route in self.routes or len(self.routes) < MAX_ROUTES_PER_BUCKET):
            self.routes.add(route)
        if etype == "proxy.request":
            n = d.get("count") if type(d.get("count")) is int and d.get("count") >= 1 else 1  # one aggregated event stands for `count`
            self.requests += n
            status = d.get("status")
            sc = f"{status // 100}xx" if type(status) is int else "other"
            self.by_status_class[sc] = self.by_status_class.get(sc, 0) + n
            m = d.get("method") if d.get("method") in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} else "other"
            self.by_method[m] = self.by_method.get(m, 0) + n
        else:
            for tag in d.get("tags") or ():
                if isinstance(tag, str):
                    self.crs_by_tag[tag] = self.crs_by_tag.get(tag, 0) + 1


@runtime_checkable
class ActivityStore(Protocol):
    def record(self, event: Mapping[str, Any], received_at: datetime) -> bool:
        """Add one `proxy.request` or `proxy.crs_match` to its bucket. False when the event is not one of those."""
        ...

    def buckets(self, instance_id: str, epoch: int | None = None) -> list[ActivityBucket]:
        """Oldest minute first."""
        ...

    def last_activity(self, instance_id: str) -> datetime | None: ...


class InMemoryActivityStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._items: dict[tuple[str, int, datetime], _Bucket] = {}

    def record(self, event: Mapping[str, Any], received_at: datetime) -> bool:
        etype = event.get("type")
        if etype not in _TYPES or not is_countable(event):
            return False
        d = event["data"]
        key = (event["instance_id"], event["epoch"], minute_of(received_at))
        with self._lock:
            self._items.setdefault(key, _Bucket()).apply(etype, d)
        return True

    def buckets(self, instance_id: str, epoch: int | None = None) -> list[ActivityBucket]:
        with self._lock:
            rows = [(k, b) for k, b in self._items.items() if k[0] == instance_id and (epoch is None or k[1] == epoch)]
            rows.sort(key=lambda kv: (kv[0][2], kv[0][1]))
            return [ActivityBucket(k[0], k[1], k[2], b.requests, dict(b.by_status_class), dict(b.by_method), dict(b.crs_by_tag),
                                   len(b.routes)) for k, b in rows]

    def last_activity(self, instance_id: str) -> datetime | None:
        with self._lock:
            times = [k[2] for k in self._items if k[0] == instance_id]
            return max(times) if times else None


class ActivityRecorder:
    def __init__(self, store: ActivityStore) -> None:
        self.store = store

    def observe(self, event: Mapping[str, Any], received_at: datetime) -> bool:
        return self.store.record(event, received_at)

    def last_activity(self, instance_id: str) -> datetime | None:
        return self.store.last_activity(instance_id)


# ---- the label rule (FR-DET-07, D-78) ----

def _verified(settings: Any) -> bool:
    try:
        return settings.get(VERIFIED_SETTING) is True
    except (UnknownSetting, KeyError, AttributeError):
        return False  # a missing setting is the same as false


def attribution_label(settings: Any) -> str:
    """`estimated` until `classifier_accuracy_verified` is true; then `measured`."""
    return "measured" if _verified(settings) else "estimated"


def per_challenge_time_allowed(settings: Any) -> bool:
    """False until the classifier accuracy is verified: active time is shown at assessment level only (FR-DET-07)."""
    return _verified(settings)
