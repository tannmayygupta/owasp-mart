"""The lab runtime's stores on Postgres (stream L, migration 0010, models in `vulnmart.lab.models`).

Every class here implements the Protocol of its in-memory twin and keeps its rules (idempotent writes, the better milestone wins, a
replay stores nothing, no flag and no pasted text is ever written). Each call is one short transaction on its own connection, so any
number of API processes can share the database; the two spots that need a decision from the database itself (the attempt's
compare-and-set on `version`, the one-per-key inserts) are single statements.

`build_pg_stores(engine)` returns the whole bundle for `LabRuntime(stores=...)`.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import fields
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import Engine, and_, delete, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from vulnmart_attempts import AttemptRecord, AttemptState, Conflict, Rules
from vulnmart_attempts import Milestone as ScoreMilestone
from vulnmart_attempts.attempt_log import EngineBridge, validate_event
from vulnmart_attempts.review import AuditRecord, HeldItem, NotHeld
from vulnmart_attempts.store import select_due

from vulnmart.ingest.activity import ActivityBucket as BucketView
from vulnmart.ingest.activity import _Bucket, _TYPES, minute_of
from vulnmart.ingest.bots import BotVisit
from vulnmart.ingest.engine import is_countable
from vulnmart.ingest.evidence import EvidenceRow
from vulnmart.ingest.store import PutResult
from vulnmart.ingest.stores import MAX_RECENT_INSTANCES, FlagAlreadyDecided, InstanceInfo, IntegrityRow, StoredEvent
from vulnmart.lab import models as m
from vulnmart.lab.stores import LabStores
from vulnmart.ports.keys import Sealed
from vulnmart.ports.reports import IntegrityType, Milestone

_ATTEMPT_DATETIMES = {f.name for f in fields(AttemptRecord) if f.name.endswith("_at") or f.name in ("frozen_until", "delete_after")}


# ---- the attempt record as JSON ----

def record_to_json(rec: AttemptRecord) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in fields(rec):
        if f.name == "version":
            continue
        v = getattr(rec, f.name)
        if f.name == "rules":
            v = v.to_dict()
        elif f.name == "state":
            v = v.value
        elif f.name == "warnings_sent":
            v = list(v)
        elif isinstance(v, datetime):
            v = v.isoformat()
        out[f.name] = v
    return out


def record_from_json(data: Mapping[str, Any], version: int) -> AttemptRecord:
    kw: dict[str, Any] = {}
    for f in fields(AttemptRecord):
        if f.name == "version" or f.name not in data:
            continue
        v = data[f.name]
        if f.name == "rules":
            v = Rules.from_dict(v)
        elif f.name == "state":
            v = AttemptState(v)
        elif f.name == "warnings_sent":
            v = tuple(v)
        elif f.name in _ATTEMPT_DATETIMES and v is not None:
            v = datetime.fromisoformat(v)
        kw[f.name] = v
    return AttemptRecord(version=version, **kw)


class _Base:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine


# ---- attempts ----

class PgAttemptStore(_Base):
    persistent = True

    def get(self, attempt_id: str) -> AttemptRecord | None:
        with self._engine.connect() as c:
            row = c.execute(select(m.Attempt.record, m.Attempt.version).where(m.Attempt.id == attempt_id)).one_or_none()
        return record_from_json(row.record, row.version) if row else None

    def find(self, user_id: str, template_id: str) -> AttemptRecord | None:
        with self._engine.connect() as c:
            row = c.execute(select(m.Attempt.record, m.Attempt.version).where(
                m.Attempt.user_id == user_id, m.Attempt.template_id == template_id)).one_or_none()
        return record_from_json(row.record, row.version) if row else None

    def add(self, record: AttemptRecord) -> AttemptRecord:
        try:
            with self._engine.begin() as c:
                c.execute(m.Attempt.__table__.insert().values(
                    id=record.id, user_id=record.user_id, template_id=record.template_id, org_id=record.org_id,
                    state=record.state.value, version=0, record=record_to_json(record)))
        except IntegrityError:
            raise Conflict("attempt already exists") from None
        return _with_version(record, 0)

    def put_if_version(self, record: AttemptRecord, expected_version: int) -> AttemptRecord:
        with self._engine.begin() as c:
            done = c.execute(
                update(m.Attempt).where(m.Attempt.id == record.id, m.Attempt.version == expected_version)
                .values(record=record_to_json(record), state=record.state.value, org_id=record.org_id,
                        version=expected_version + 1, updated_at=func.now())
                .returning(m.Attempt.version)).one_or_none()
        if done is None:
            raise Conflict("attempt version moved")
        return _with_version(record, expected_version + 1)

    def ids(self) -> list[str]:
        with self._engine.connect() as c:
            return list(c.execute(select(m.Attempt.id).order_by(m.Attempt.created_at, m.Attempt.id)).scalars())

    def in_states(self, *states: AttemptState) -> list[AttemptRecord]:
        with self._engine.connect() as c:
            rows = c.execute(select(m.Attempt.record, m.Attempt.version).where(m.Attempt.state.in_([s.value for s in states]))
                             .order_by(m.Attempt.created_at, m.Attempt.id)).all()
        return [record_from_json(r.record, r.version) for r in rows]

    def for_user(self, user_id: str) -> list[AttemptRecord]:
        with self._engine.connect() as c:
            rows = c.execute(select(m.Attempt.record, m.Attempt.version).where(m.Attempt.user_id == user_id)
                             .order_by(m.Attempt.created_at.desc(), m.Attempt.id.desc())).all()
        return [record_from_json(r.record, r.version) for r in rows]

    def due(self, now: datetime) -> list[AttemptRecord]:
        wanted = [s.value for s in (AttemptState.RUNNING, AttemptState.EXPIRED, AttemptState.SUBMITTED, AttemptState.REPORTED,
                                    AttemptState.CANCELLED, AttemptState.WITHDRAWN)]
        with self._engine.connect() as c:
            rows = c.execute(select(m.Attempt.record, m.Attempt.version).where(m.Attempt.state.in_(wanted))).all()
        return select_due((record_from_json(r.record, r.version) for r in rows), now)


def _with_version(record: AttemptRecord, version: int) -> AttemptRecord:
    from dataclasses import replace

    return replace(record, version=version)


class PgAttemptLog(_Base, EngineBridge):
    def append(self, event: Mapping[str, Any]) -> None:
        clean = validate_event(event)
        with self._engine.begin() as c:
            c.execute(m.AttemptEvent.__table__.insert().values(attempt_id=clean["attempt_id"], event=clean))

    def read(self, attempt_id: str) -> tuple[dict[str, Any], ...]:
        return tuple(e for _, e in self.read_keyed(attempt_id))

    def read_keyed(self, attempt_id: str) -> tuple[tuple[int, dict[str, Any]], ...]:
        with self._engine.connect() as c:
            rows = c.execute(select(m.AttemptEvent.id, m.AttemptEvent.event).where(m.AttemptEvent.attempt_id == attempt_id)
                             .order_by(m.AttemptEvent.id))
            return tuple((r.id, dict(r.event)) for r in rows)


# ---- hints, milestones, held captures, review ----

class PgHintLedger(_Base):
    def levels(self, attempt_id: str, challenge_key: str) -> tuple[int, ...]:
        with self._engine.connect() as c:
            return tuple(c.execute(select(m.HintUnlock.level).where(
                m.HintUnlock.attempt_id == attempt_id, m.HintUnlock.challenge_key == challenge_key).order_by(m.HintUnlock.level)).scalars())

    def add(self, attempt_id: str, challenge_key: str, level: int, at: datetime) -> bool:
        with self._engine.begin() as c:
            row = c.execute(pg_insert(m.HintUnlock).values(attempt_id=attempt_id, challenge_key=challenge_key, level=level, at=at)
                            .on_conflict_do_nothing().returning(m.HintUnlock.level)).one_or_none()
        return row is not None


class PgMilestoneStore(_Base):
    def best(self, attempt_id: str, challenge_key: str) -> Milestone:
        with self._engine.connect() as c:
            level = c.execute(select(m.Milestone.level).where(
                m.Milestone.attempt_id == attempt_id, m.Milestone.challenge_key == challenge_key)).scalar_one_or_none()
        return Milestone(level) if level else Milestone.NONE

    def credit(self, attempt_id: str, challenge_key: str, milestone: Milestone, at: datetime) -> bool:
        if milestone is Milestone.NONE:
            return False
        stmt = pg_insert(m.Milestone).values(attempt_id=attempt_id, challenge_key=challenge_key, level=milestone.value, reached_at=at)
        stmt = stmt.on_conflict_do_update(index_elements=["attempt_id", "challenge_key"],
                                          set_={"level": stmt.excluded.level, "reached_at": stmt.excluded.reached_at},
                                          where=m.Milestone.level < stmt.excluded.level)  # 'M1' < 'M2' < 'M3'
        with self._engine.begin() as c:
            return c.execute(stmt.returning(m.Milestone.attempt_id)).one_or_none() is not None

    def hold(self, attempt_id: str, challenge_key: str, at: datetime) -> bool:
        with self._engine.begin() as c:
            fallback = c.execute(select(m.Milestone.level).where(
                m.Milestone.attempt_id == attempt_id, m.Milestone.challenge_key == challenge_key)).scalar_one_or_none() or "none"
            row = c.execute(pg_insert(m.HeldCapture).values(attempt_id=attempt_id, challenge_key=challenge_key, held_at=at,
                                                           milestone="M3", fallback=fallback)
                            .on_conflict_do_nothing().returning(m.HeldCapture.attempt_id)).one_or_none()
        return row is not None

    def is_held(self, attempt_id: str, challenge_key: str) -> bool:
        with self._engine.connect() as c:
            return c.execute(select(m.HeldCapture.status).where(
                m.HeldCapture.attempt_id == attempt_id, m.HeldCapture.challenge_key == challenge_key)).scalar_one_or_none() == "open"

    def held_for(self, attempt_id: str) -> dict[str, datetime]:
        with self._engine.connect() as c:
            rows = c.execute(select(m.HeldCapture.challenge_key, m.HeldCapture.held_at).where(
                m.HeldCapture.attempt_id == attempt_id, m.HeldCapture.status == "open"))
            return {r.challenge_key: r.held_at for r in rows}

    def clear_held(self, attempt_id: str, challenge_key: str) -> None:
        """Nothing to do: the decision (`PgHeldStore.release_held` or `keep_held`) already moved the row out of `open`."""

    def captures(self, attempt_id: str) -> dict[str, datetime]:
        with self._engine.connect() as c:
            rows = c.execute(select(m.Milestone.challenge_key, m.Milestone.reached_at).where(
                m.Milestone.attempt_id == attempt_id, m.Milestone.level == "M3"))
            return {r.challenge_key: r.reached_at for r in rows}


def _held_item(row: Any) -> HeldItem:
    return HeldItem(
        attempt_id=row.attempt_id, challenge_key=row.challenge_key, milestone=ScoreMilestone.M3,
        fallback=ScoreMilestone[(row.fallback or "none").upper()], held_at=row.held_at,
        evidence_ids=tuple(row.evidence_ids or ()), status=row.status, reminded=row.reminded)


_HELD_COLUMNS = (m.HeldCapture.attempt_id, m.HeldCapture.challenge_key, m.HeldCapture.held_at, m.HeldCapture.fallback,
                 m.HeldCapture.evidence_ids, m.HeldCapture.status, m.HeldCapture.reminded)


class PgHeldStore(_Base):
    def add(self, item: HeldItem) -> None:
        with self._engine.begin() as c:
            c.execute(pg_insert(m.HeldCapture).values(
                attempt_id=item.attempt_id, challenge_key=item.challenge_key, held_at=item.held_at, milestone="M3",
                fallback=item.fallback.name if item.fallback.name != "NONE" else "none",
                evidence_ids=list(item.evidence_ids), status=item.status, reminded=item.reminded).on_conflict_do_nothing())

    def get(self, attempt_id: str, challenge_key: str) -> HeldItem | None:
        with self._engine.connect() as c:
            row = c.execute(select(*_HELD_COLUMNS).where(
                m.HeldCapture.attempt_id == attempt_id, m.HeldCapture.challenge_key == challenge_key)).one_or_none()
        return _held_item(row) if row else None

    def items(self, attempt_id: str) -> tuple[HeldItem, ...]:
        with self._engine.connect() as c:
            rows = c.execute(select(*_HELD_COLUMNS).where(m.HeldCapture.attempt_id == attempt_id).order_by(m.HeldCapture.challenge_key))
            return tuple(_held_item(r) for r in rows)

    def open_items(self) -> tuple[HeldItem, ...]:
        with self._engine.connect() as c:
            rows = c.execute(select(*_HELD_COLUMNS).where(m.HeldCapture.status == "open")
                             .order_by(m.HeldCapture.attempt_id, m.HeldCapture.challenge_key))
            return tuple(_held_item(r) for r in rows)

    def _decide(self, attempt_id: str, challenge_key: str, status: str) -> HeldItem:
        with self._engine.begin() as c:
            row = c.execute(update(m.HeldCapture).where(
                m.HeldCapture.attempt_id == attempt_id, m.HeldCapture.challenge_key == challenge_key)
                .values(status=status, decided_at=func.now()).returning(*_HELD_COLUMNS)).one_or_none()
        if row is None:
            raise NotHeld((attempt_id, challenge_key))
        return _held_item(row)

    def release_held(self, attempt_id: str, challenge_key: str) -> HeldItem:
        return self._decide(attempt_id, challenge_key, "accepted")

    def keep_held(self, attempt_id: str, challenge_key: str) -> HeldItem:
        return self._decide(attempt_id, challenge_key, "rejected")

    def mark_reminded(self, attempt_id: str, challenge_key: str) -> bool:
        with self._engine.begin() as c:
            row = c.execute(update(m.HeldCapture).where(
                m.HeldCapture.attempt_id == attempt_id, m.HeldCapture.challenge_key == challenge_key, m.HeldCapture.reminded.is_(False))
                .values(reminded=True).returning(m.HeldCapture.attempt_id)).one_or_none()
        return row is not None


class PgAudit(_Base):
    def record(self, entry: AuditRecord) -> None:
        with self._engine.begin() as c:
            c.execute(m.ReviewAudit.__table__.insert().values(
                attempt_id=entry.attempt_id, challenge_key=entry.challenge_key, reviewer=entry.reviewer, decision=entry.decision,
                at=entry.at, note_id=entry.note_id, note=entry.note))

    def rows(self, attempt_id: str) -> list[AuditRecord]:
        with self._engine.connect() as c:
            rows = c.execute(select(m.ReviewAudit).where(m.ReviewAudit.attempt_id == attempt_id).order_by(m.ReviewAudit.id))
            return [AuditRecord(r.reviewer, r.decision, r.at, r.attempt_id, r.challenge_key, r.note_id, r.note) for r in rows]


# ---- integrity flags and flag submissions ----

class PgIntegritySink(_Base):
    def add(self, attempt_id: str, kind: IntegrityType, explanation: str, dedupe_key: str, challenge_key: str | None = None,
            at: datetime | None = None) -> bool:
        values: dict[str, Any] = dict(attempt_id=attempt_id, kind=kind.value, explanation=explanation, dedupe_key=dedupe_key,
                                      challenge_key=challenge_key)
        if at is not None:
            values["created_at"] = at
        with self._engine.begin() as c:
            row = c.execute(pg_insert(m.IntegrityFlag).values(**values)
                            .on_conflict_do_nothing(index_elements=["attempt_id", "dedupe_key"]).returning(m.IntegrityFlag.id)).one_or_none()
        return row is not None

    _COLUMNS = (m.IntegrityFlag.id, m.IntegrityFlag.attempt_id, m.IntegrityFlag.kind, m.IntegrityFlag.explanation,
                m.IntegrityFlag.challenge_key, m.IntegrityFlag.status, m.IntegrityFlag.created_at, m.IntegrityFlag.decided_at,
                m.IntegrityFlag.decision_note, m.IntegrityFlag.decided_by)

    @staticmethod
    def _row(r: Any) -> IntegrityRow:
        return IntegrityRow(r.attempt_id, IntegrityType(r.kind), r.explanation, r.challenge_key, flag_id=r.id, status=r.status,
                            created_at=r.created_at, decided_at=r.decided_at, decision_note=r.decision_note, decided_by=r.decided_by)

    def of(self, attempt_id: str, kind: IntegrityType | None = None) -> list[IntegrityRow]:
        stmt = select(*self._COLUMNS).where(m.IntegrityFlag.attempt_id == attempt_id).order_by(m.IntegrityFlag.id)
        if kind is not None:
            stmt = stmt.where(m.IntegrityFlag.kind == kind.value)
        with self._engine.connect() as c:
            return [self._row(r) for r in c.execute(stmt)]

    def decide(self, attempt_id: str, flag_id: int, decision: str, note: str, by: str, at: datetime) -> IntegrityRow:
        with self._engine.begin() as c:
            row = c.execute(update(m.IntegrityFlag).where(
                m.IntegrityFlag.attempt_id == attempt_id, m.IntegrityFlag.id == flag_id, m.IntegrityFlag.status == "open")
                .values(status="accepted" if decision == "accept" else "rejected", decided_at=at, decision_note=note, decided_by=by)
                .returning(*self._COLUMNS)).one_or_none()
            if row is not None:
                return self._row(row)
            exists = c.execute(select(m.IntegrityFlag.id).where(m.IntegrityFlag.attempt_id == attempt_id,
                                                                 m.IntegrityFlag.id == flag_id)).one_or_none()
        if exists is None:
            raise KeyError(flag_id)
        raise FlagAlreadyDecided(flag_id)


class PgFlagSubmissionLog(_Base):
    def incorrect_since(self, attempt_id: str, challenge_key: str, since: datetime) -> list[datetime]:
        """The instants of the incorrect pastes after `since`, oldest first (the flag rate limit counts them)."""
        with self._engine.connect() as c:
            return list(c.execute(select(m.FlagSubmission.at).where(
                m.FlagSubmission.attempt_id == attempt_id, m.FlagSubmission.challenge_key == challenge_key,
                m.FlagSubmission.result == "incorrect", m.FlagSubmission.at > since).order_by(m.FlagSubmission.at)).scalars())

    def record(self, attempt_id: str, challenge_key: str, result: str, at: datetime) -> None:
        with self._engine.begin() as c:
            c.execute(m.FlagSubmission.__table__.insert().values(attempt_id=attempt_id, challenge_key=challenge_key, result=result, at=at))


# ---- instances and epochs ----

def _drop_instances(c: Any, instance_ids: list[str]) -> None:
    """Delete instance rows and the rows kept per instance (events, activity, bot visits, epochs): nothing may outlive the instance row, or the purge of
    the attempt (which finds instances through this table) could never reach it."""
    if not instance_ids:
        return
    for model in (m.ActivityBucket, m.Event, m.BotVisit, m.InstanceEpoch):
        c.execute(delete(model).where(model.instance_id.in_(instance_ids)))
    c.execute(delete(m.Instance).where(m.Instance.id.in_(instance_ids)))

class PgInstanceDirectory(_Base):
    def add(self, info: InstanceInfo) -> InstanceInfo:
        stmt = pg_insert(m.Instance).values(id=info.instance_id, attempt_id=info.attempt_id, template_id=info.template_id,
                                            epoch=info.epoch, challenge_keys=list(info.challenge_keys))
        stmt = stmt.on_conflict_do_update(index_elements=["id"], set_={"epoch": stmt.excluded.epoch, "updated_at": func.now(),
                                                                       "challenge_keys": stmt.excluded.challenge_keys})
        with self._engine.begin() as c:
            # one instance per attempt: a replacement for a lost instance takes the place of the old one, and what the old one left goes with it
            old = list(c.execute(select(m.Instance.id).where(m.Instance.attempt_id == info.attempt_id, m.Instance.id != info.instance_id)).scalars())
            _drop_instances(c, old)
            c.execute(stmt)
        return info

    @staticmethod
    def _info(r: Any) -> InstanceInfo:
        return InstanceInfo(r.id, r.attempt_id, r.template_id, r.epoch, tuple(r.challenge_keys))

    def get(self, instance_id: str) -> InstanceInfo | None:
        with self._engine.connect() as c:
            r = c.execute(select(m.Instance).where(m.Instance.id == instance_id)).one_or_none()
        return self._info(r) if r else None

    def remove(self, instance_id: str) -> None:
        with self._engine.begin() as c:
            _drop_instances(c, [instance_id])

    def for_attempt(self, attempt_id: str) -> InstanceInfo | None:
        with self._engine.connect() as c:
            r = c.execute(select(m.Instance).where(m.Instance.attempt_id == attempt_id)).one_or_none()
        return self._info(r) if r else None

    def recent(self, challenge_key: str, template_id: str, within_s: int) -> Mapping[str, int]:
        """Live instances (their attempt is ready or running) and instances touched in the last `within_s` seconds."""
        cutoff = datetime.now(UTC) - timedelta(seconds=within_s)
        stmt = (select(m.Instance.id, m.Instance.epoch, m.Instance.challenge_keys)
                .join(m.Attempt, m.Attempt.id == m.Instance.attempt_id)
                .where(m.Instance.template_id == template_id,
                       or_(m.Attempt.state.in_(("ready", "running")), m.Instance.updated_at >= cutoff))
                .order_by(m.Instance.created_at.desc()))
        with self._engine.connect() as c:
            rows = [r for r in c.execute(stmt) if challenge_key in (r.challenge_keys or ())]
        return {r.id: r.epoch for r in rows[:MAX_RECENT_INSTANCES]}


class PgInstanceEpochs(_Base):
    def set(self, instance_id: str, epoch: int) -> None:
        if type(epoch) is not int or epoch < 1:
            raise ValueError("epoch must be an integer of at least 1")
        with self._engine.begin() as c:
            c.execute(pg_insert(m.InstanceEpoch).values(instance_id=instance_id, epoch=epoch).on_conflict_do_nothing())

    def current(self, instance_id: str) -> int | None:
        with self._engine.connect() as c:
            return c.execute(select(func.max(m.InstanceEpoch.epoch)).where(m.InstanceEpoch.instance_id == instance_id)).scalar_one()


# ---- events ----

def _stored(event: Mapping[str, Any]) -> dict[str, Any]:
    """The event as the `events` table keeps it (FR-DET-03: metadata only). A capture's request body and headers are sealed under the attempt key in
    `evidence`; they must not also sit here in clear, where a shredded key and a purge would not reach them."""
    out = dict(event)
    data = out.get("data")
    if out.get("type") == "evidence.capture" and isinstance(data, Mapping):
        data = dict(data)
        body = data.pop("body", None)
        data.pop("headers_redacted", None)
        if isinstance(body, str):
            data["body_bytes"] = len(body.encode("utf-8", errors="surrogatepass"))
        out["data"] = data
    return out


class PgEventStore(_Base):
    """The receiver's idempotent store (`IngestHandler`): one row per `(instance_id, epoch, seq)` with the body's digest."""

    def put(self, event: Mapping[str, Any], digest: str, received_at: datetime) -> PutResult:
        key = dict(instance_id=event["instance_id"], epoch=event["epoch"], seq=event["seq"])
        with self._engine.begin() as c:
            row = c.execute(pg_insert(m.Event).values(**key, digest=digest, event=_stored(event), received_at=received_at)
                            .on_conflict_do_nothing(index_elements=["instance_id", "epoch", "seq"]).returning(m.Event.id)).one_or_none()
            if row is not None:
                return PutResult.ACCEPTED
            old = c.execute(select(m.Event.digest).where(*(getattr(m.Event, k) == v for k, v in key.items()))).scalar_one()
            if old is None:  # written first by the engine log: adopt this digest
                c.execute(update(m.Event).where(*(getattr(m.Event, k) == v for k, v in key.items()), m.Event.digest.is_(None))
                          .values(digest=digest))
                return PutResult.DUPLICATE
            return PutResult.DUPLICATE if old == digest else PutResult.MISMATCH


class PgEventLog(_Base):
    """The milestone engine's log. A row the receiver already stored counts as new until the engine has seen it (`engine_seen`)."""

    def append(self, event: Mapping[str, Any], received_at: datetime) -> bool:
        stmt = pg_insert(m.Event).values(instance_id=event["instance_id"], epoch=event["epoch"], seq=event["seq"], event=_stored(event),
                                         received_at=received_at, engine_seen=True)
        stmt = stmt.on_conflict_do_update(index_elements=["instance_id", "epoch", "seq"], set_={"engine_seen": True},
                                          where=m.Event.engine_seen.is_(False))
        with self._engine.begin() as c:
            return c.execute(stmt.returning(m.Event.id)).one_or_none() is not None

    def read(self, instance_id: str, epoch: int | None = None) -> list[StoredEvent]:
        stmt = select(m.Event.event, m.Event.received_at).where(m.Event.instance_id == instance_id, m.Event.engine_seen.is_(True))
        if epoch is not None:
            stmt = stmt.where(m.Event.epoch == epoch)
        with self._engine.connect() as c:
            return [StoredEvent(dict(r.event), r.received_at) for r in c.execute(stmt.order_by(m.Event.epoch, m.Event.seq))]


class PgSecuritySink(_Base):
    def raise_event(self, kind: str, instance_id: str, epoch: int, seq: int) -> None:
        with self._engine.begin() as c:
            c.execute(m.SecurityEvent.__table__.insert().values(kind=kind, instance_id=instance_id, epoch=epoch, seq=seq))


# ---- evidence, activity, bots ----

class PgEvidenceStore(_Base):
    def add(self, row: EvidenceRow) -> None:
        with self._engine.begin() as c:
            c.execute(m.Evidence.__table__.insert().values(
                id=row.evidence_id, attempt_id=row.attempt_id, challenge_key=row.challenge_key, captured_at=row.captured_at, size=row.size,
                dek_id=row.sealed.dek_id, kek_version=row.sealed.kek_version, nonce=row.sealed.nonce, ciphertext=row.sealed.ciphertext,
                aad=row.aad, held_empty=row.held_empty))

    def rows(self, attempt_id: str) -> list[EvidenceRow]:
        with self._engine.connect() as c:
            rows = c.execute(select(m.Evidence).where(m.Evidence.attempt_id == attempt_id).order_by(m.Evidence.captured_at, m.Evidence.id))
            return [EvidenceRow(r.id, r.attempt_id, r.challenge_key, r.captured_at, r.size,
                                Sealed(r.dek_id, r.kek_version, r.nonce, bytes(r.ciphertext)), bytes(r.aad), r.held_empty) for r in rows]


class PgActivityStore(_Base):
    def record(self, event: Mapping[str, Any], received_at: datetime) -> bool:
        etype = event.get("type")
        if etype not in _TYPES or not is_countable(event):
            return False
        key = dict(instance_id=event["instance_id"], epoch=event["epoch"], minute=minute_of(received_at))
        where = [getattr(m.ActivityBucket, k) == v for k, v in key.items()]
        with self._engine.begin() as c:
            c.execute(pg_insert(m.ActivityBucket).values(**key).on_conflict_do_nothing())
            row = c.execute(select(m.ActivityBucket).where(*where).with_for_update()).one()  # the row lock serialises writers
            b = _Bucket(requests=row.requests, by_status_class=dict(row.by_status_class), by_method=dict(row.by_method),
                        crs_by_tag=dict(row.crs_by_tag), routes=set(row.routes))
            b.apply(etype, event["data"])
            c.execute(update(m.ActivityBucket).where(*where).values(
                requests=b.requests, by_status_class=b.by_status_class, by_method=b.by_method, crs_by_tag=b.crs_by_tag,
                routes=sorted(b.routes)))
        return True

    def buckets(self, instance_id: str, epoch: int | None = None) -> list[BucketView]:
        stmt = select(m.ActivityBucket).where(m.ActivityBucket.instance_id == instance_id)
        if epoch is not None:
            stmt = stmt.where(m.ActivityBucket.epoch == epoch)
        with self._engine.connect() as c:
            rows = c.execute(stmt.order_by(m.ActivityBucket.minute, m.ActivityBucket.epoch))
            return [BucketView(r.instance_id, r.epoch, r.minute, r.requests, dict(r.by_status_class), dict(r.by_method),
                               dict(r.crs_by_tag), len(r.routes)) for r in rows]

    def last_activity(self, instance_id: str) -> datetime | None:
        with self._engine.connect() as c:
            return c.execute(select(func.max(m.ActivityBucket.minute)).where(m.ActivityBucket.instance_id == instance_id)).scalar_one()


class PgBotVisitStore(_Base):
    def add(self, visit: BotVisit) -> bool:
        with self._engine.begin() as c:
            row = c.execute(pg_insert(m.BotVisit).values(
                instance_id=visit.instance_id, epoch=visit.epoch, visit_id=visit.visit_id, ticket_id=visit.ticket_id, phase=visit.phase,
                at=visit.at).on_conflict_do_nothing().returning(m.BotVisit.id)).one_or_none()
        return row is not None

    def visits(self, instance_id: str) -> list[BotVisit]:
        with self._engine.connect() as c:
            rows = c.execute(select(m.BotVisit).where(m.BotVisit.instance_id == instance_id).order_by(m.BotVisit.id))
            return [BotVisit(r.instance_id, r.epoch, r.visit_id, r.ticket_id, r.phase, r.at) for r in rows]

    def count(self, instance_id: str, phase: str | None = None) -> int:
        stmt = select(func.count()).select_from(m.BotVisit).where(m.BotVisit.instance_id == instance_id)
        if phase is not None:
            stmt = stmt.where(m.BotVisit.phase == phase)
        with self._engine.connect() as c:
            return c.execute(stmt).scalar_one()


# ---- purge ----

def purge_attempt_data(engine: Engine, attempt_id: str) -> dict[str, int]:
    """Delete everything the lab keeps about an attempt except the attempt row itself (state and times, no personal data) and the review
    audit (a reviewer's decision stays on record). Used after the undo window of a withdrawal (FR-SES-10) and by the platform's
    deletion workflow. Returns the number of rows removed per table."""
    removed: dict[str, int] = {}
    with engine.begin() as c:
        instances = list(c.execute(select(m.Instance.id).where(m.Instance.attempt_id == attempt_id)).scalars())
        keyed = (m.HintUnlock, m.Milestone, m.HeldCapture, m.FlagSubmission, m.IntegrityFlag, m.Evidence, m.AttemptEvent)
        for model in keyed:
            removed[model.__tablename__] = c.execute(delete(model).where(model.attempt_id == attempt_id)).rowcount
        if instances:
            for model in (m.ActivityBucket, m.Event, m.BotVisit, m.InstanceEpoch):
                col = model.instance_id
                removed[model.__tablename__] = c.execute(delete(model).where(col.in_(instances))).rowcount
            removed["instances"] = c.execute(delete(m.Instance).where(m.Instance.attempt_id == attempt_id)).rowcount
    return removed


def build_pg_stores(engine: Engine) -> LabStores:
    return LabStores(
        attempts=PgAttemptStore(engine), attempt_log=PgAttemptLog(engine), hints=PgHintLedger(engine),
        milestones=PgMilestoneStore(engine), integrity=PgIntegritySink(engine), directory=PgInstanceDirectory(engine),
        epochs=PgInstanceEpochs(engine), events=PgEventLog(engine), event_store=PgEventStore(engine), security=PgSecuritySink(engine),
        evidence=PgEvidenceStore(engine), activity=PgActivityStore(engine), bots=PgBotVisitStore(engine),
        flag_log=PgFlagSubmissionLog(engine), held=PgHeldStore(engine), audit=PgAudit(engine),
        purge=lambda attempt_id: purge_attempt_data(engine, attempt_id),
    )
