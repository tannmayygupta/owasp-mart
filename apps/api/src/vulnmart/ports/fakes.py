"""In-memory fakes of the six ports stream P provides (IF-9): audit, outbox, keys, scope, settings, quota.

For tests of either stream. Each fake behaves like the real service in what a caller can observe (sequence
numbers, hash chain, refusals, the typed errors) and keeps everything in memory. Every fake that records a time takes
an injectable clock (`now`, returning an RFC 3339 UTC string), and every fake is safe to share between threads.

The key fake does no encryption: a sealed value is an opaque handle to the plaintext it keeps in memory, so a test
can still prove that a shredded key makes the value unreadable. Its keys are FAKE constants, never real keys; the
event key master is the one of the H-105 test vector, so the fake reproduces it.
"""
from __future__ import annotations

import json
import secrets
import threading
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from .audit import GENESIS_HASH, AuditRecord, chain_hash
from .audit import canonical_json as canonical_json_strict
from .errors import AttemptNotFound, EventInvalid, KeyIntegrity, KeyShredded, ScopeMissing, UnknownSetting
from .keys import AttemptKey, Sealed, derive_event_key, derive_flag, derive_owner_hash
from .outbox import EmailJob, OutboxEntry, audiences_for, check_event
from .quota import DEFAULT_COMPANY_MAX, DEFAULT_MAX_INSTANCES, DEFAULT_TOTAL_MAX, QuotaLimits
from .scope import Scope
from .settings import SETTINGS

FAKE_EVENT_MASTER = bytes(range(32))  # the master of contracts/events/examples/event-key-vector.json (fake)
FAKE_FLAG_KEY = b"FAKE-FLAG-KEY-NOT-REAL-0000000000"
FAKE_OWNER_KEY = b"FAKE-OWNER-LABEL-KEY-NOT-REAL-000"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


Clock = Callable[[], str]


# ---- audit ----

class FakeAuditPort:
    """Append-only, hash-chained list. `records` is the log in order; `tamper` exists for tests of `verify_chain`."""

    def __init__(self, *, now: Clock = utc_now):
        self._now = now
        self._lock = threading.Lock()
        self.records: list[AuditRecord] = []

    def append(self, *, actor: str, action: str, subject: str | None = None, details: Mapping[str, Any] | None = None) -> AuditRecord:
        if not actor or not action:
            raise ValueError("actor and action are required")
        try:
            # a deep copy through JSON: the caller cannot change a stored record afterwards; mixed key types fail here too
            details = json.loads(canonical_json_strict(details or {}))
        except (TypeError, ValueError) as e:
            raise ValueError(f"details must be JSON values with string keys: {e}") from None
        with self._lock:
            prev = self.records[-1].row_hash if self.records else GENESIS_HASH
            seq = len(self.records) + 1
            body = {"seq": seq, "at": self._now(), "actor": actor, "action": action, "subject": subject, "details": details}
            record = AuditRecord(**body, prev_hash=prev, row_hash=chain_hash(prev, body))
            self.records.append(record)
            return record


# ---- outbox ----

class FakeOutboxPort:
    """Keeps published events and queued emails in order (`events`, `emails`), as the relay and the worker would read them."""

    def __init__(self, *, now: Clock = utc_now):
        self._now = now
        self._lock = threading.Lock()
        self.events: list[OutboxEntry] = []
        self.emails: list[EmailJob] = []

    def publish(self, event: Mapping[str, Any]) -> OutboxEntry:
        check_event(event)
        with self._lock:
            entry = OutboxEntry(id=len(self.events) + 1, event=json.loads(json.dumps(event)), audiences=audiences_for(event),
                                created_at=self._now())
            self.events.append(entry)
            return entry

    def enqueue_email(self, *, template: str, to_user_id: str, params: Mapping[str, Any] | None = None) -> EmailJob:
        if not template or not to_user_id:
            raise ValueError("template and to_user_id are required")
        params = dict(params or {})
        if any(isinstance(v, str) and "@" in v for v in params.values()):
            raise ValueError("an email address never goes into params; the worker looks it up from to_user_id")
        with self._lock:
            job = EmailJob(id=len(self.emails) + 1, template=template, to_user_id=to_user_id, params=params, created_at=self._now())
            self.emails.append(job)
            return job


# ---- keys ----

class FakeKeyPort:
    """DEKs per attempt, a shred list, and the real derivations over FAKE keys."""

    def __init__(self, *, event_master: bytes = FAKE_EVENT_MASTER, flag_key: bytes = FAKE_FLAG_KEY, owner_key: bytes = FAKE_OWNER_KEY,
                 kek_version: int = 1):
        self._event_master, self._flag_key, self._owner_key = event_master, flag_key, owner_key
        self._kek_version = kek_version
        self._lock = threading.Lock()
        self._keys: dict[str, AttemptKey] = {}
        self._shredded: set[str] = set()
        self._sealed: dict[tuple[str, str], tuple[bytes, bytes]] = {}  # (dek_id, nonce) -> (plaintext, aad)

    def _key(self, attempt_id: str) -> AttemptKey:
        if attempt_id in self._shredded:
            raise KeyShredded(f"the key of {attempt_id} was shredded")
        key = self._keys.get(attempt_id)
        if key is None:
            raise AttemptNotFound(f"no key for {attempt_id}")
        return key

    def create_attempt_key(self, attempt_id: str) -> AttemptKey:
        with self._lock:
            if attempt_id in self._shredded:
                raise KeyShredded(f"the key of {attempt_id} was shredded")
            if attempt_id not in self._keys:
                self._keys[attempt_id] = AttemptKey(attempt_id, f"dek-{secrets.token_hex(8)}", self._kek_version)
            return self._keys[attempt_id]

    def encrypt(self, attempt_id: str, plaintext: bytes, aad: bytes = b"") -> Sealed:
        with self._lock:
            key = self._key(attempt_id)
            nonce = secrets.token_hex(12)
            self._sealed[(key.dek_id, nonce)] = (bytes(plaintext), bytes(aad))
            return Sealed(key.dek_id, key.kek_version, nonce, b"FAKE-SEALED:" + nonce.encode())

    def decrypt(self, attempt_id: str, sealed: Sealed, aad: bytes = b"") -> bytes:
        with self._lock:
            key = self._key(attempt_id)
            stored = self._sealed.get((sealed.dek_id, sealed.nonce))
            if sealed.dek_id != key.dek_id or stored is None or stored[1] != aad:
                raise KeyIntegrity("the sealed value is not this attempt's, or its associated data differs")
            return stored[0]

    def shred(self, attempt_id: str) -> bool:
        with self._lock:
            key = self._keys.pop(attempt_id, None)
            if key is None:
                return False  # nothing to delete; a key created later is a new key
            self._shredded.add(attempt_id)
            for k in [k for k in self._sealed if k[0] == key.dek_id]:
                del self._sealed[k]
            return True

    def event_key(self, instance_id: str, epoch: int) -> str:
        return derive_event_key(self._event_master, instance_id, epoch)

    def flag(self, instance_id: str, challenge_key: str, epoch: int) -> str:
        return derive_flag(self._flag_key, instance_id, challenge_key, epoch)

    def decoy(self, instance_id: str, challenge_key: str, epoch: int, index: int) -> str:
        return derive_flag(self._flag_key, instance_id, challenge_key, epoch, decoy_index=index)

    def owner_hash(self, user_id: str) -> str:
        return derive_owner_hash(self._owner_key, user_id)


# ---- scope ----

class FakeScopePort:
    """Holds one scope, per thread. `acting_as(scope)` sets it for a block; `set(None)` clears it."""

    def __init__(self, scope: Scope | None = None):
        self._local = threading.local()
        self._default = scope

    def set(self, scope: Scope | None) -> None:
        self._local.scope = scope

    @contextmanager
    def acting_as(self, scope: Scope):
        before = getattr(self._local, "scope", self._default)
        self._local.scope = scope
        try:
            yield scope
        finally:
            self._local.scope = before

    def current(self) -> Scope:
        scope = getattr(self._local, "scope", self._default)
        if scope is None:
            raise ScopeMissing("no user in scope")
        return scope

    def require_org(self) -> str:
        org = self.current().org_id
        if org is None:
            raise ScopeMissing("no organisation in scope")
        return org


# ---- settings and quota ----

class FakeSettingsPort:
    """The defaults of `SETTINGS`, with overrides checked against the closed list and the type of the default."""

    def __init__(self, overrides: Mapping[str, int | bool | str] | None = None):
        self._lock = threading.Lock()
        self._values = dict(SETTINGS)
        for name, value in (overrides or {}).items():
            self.set(name, value)

    def set(self, name: str, value: int | bool | str) -> None:
        if name not in SETTINGS:
            raise UnknownSetting(f"unknown setting {name!r}")
        if type(value) is not type(SETTINGS[name]):
            raise ValueError(f"{name} is a {type(SETTINGS[name]).__name__}")
        with self._lock:
            self._values[name] = value

    def get(self, name: str) -> int | bool | str:
        with self._lock:
            if name not in self._values:
                raise UnknownSetting(f"unknown setting {name!r}")
            return self._values[name]


class FakeQuotaPort:
    """User quota, else organisation quota, else the per-user default `user_max`. Tests set `users`, `orgs` and `user_max` directly.
    `global_max` is the older name of `user_max` (it never meant the platform-wide limit, that is `total_max`) and stays as an alias."""

    def __init__(self, *, user_max: int | None = None, global_max: int | None = None, company_max: int = DEFAULT_COMPANY_MAX,
                 total_max: int = DEFAULT_TOTAL_MAX):
        self.user_max = user_max if user_max is not None else global_max if global_max is not None else DEFAULT_MAX_INSTANCES
        self.company_max = company_max  # live instances one company may hold together (story 3.6)
        self.total_max = total_max  # live instances on the whole platform (story 3.6)
        self.users: dict[str, int] = {}
        self.orgs: dict[str, int] = {}
        self.companies: dict[str, int] = {}  # a company with its own cap

    @property
    def global_max(self) -> int:
        return self.user_max

    @global_max.setter
    def global_max(self, value: int) -> None:
        self.user_max = value

    def limits(self, user_id: str, org_id: str | None = None) -> QuotaLimits:
        # without an `org_id` the user has no company: the company check is skipped, by design (None)
        company = None if org_id is None else dict(self.companies).get(org_id, self.company_max)
        return QuotaLimits(self.max_instances(user_id, org_id), company, self.total_max)

    def max_instances(self, user_id: str, org_id: str | None = None) -> int:
        users, orgs = dict(self.users), dict(self.orgs)  # a snapshot, so a test changing them in another thread is read whole
        if user_id in users:
            return users[user_id]
        if org_id is not None and org_id in orgs:
            return orgs[org_id]
        return self.user_max
