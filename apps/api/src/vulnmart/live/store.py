"""The replay buffer of the live updates (story P-22, FR-LIV-01, FR-LIV-06, ADR 0052): one stream per audience, written by the relay and read by the hub.

`StreamWriter.append` is the relay's side (synchronous, runs in the worker): it adds one event to the stream of one audience (`live:user:<id>`, `live:org:<id>`,
`live:admin`) and returns the id the entry got, or None when this outbox row was already appended to that stream (an at-least-once relay never makes a duplicate
entry). `StreamReader` is the hub's side (asynchronous): a blocking read over the streams of one connection, and the three facts a reconnect is judged by.

Ids are `<milliseconds>-<sequence>`: the milliseconds are the later of the clock and the newest id given out, the sequence comes from one counter for all streams. So an
id is unique over every stream, ids only grow in the order the relay appended, and an id from one of a user's streams can be compared with the entries of another.

Trimming keeps `MAX_LEN` entries and `MAX_AGE_MS` of history per stream (placeholders: OI-25, ADR 0052). Each trim records the id of the newest entry it removed
(`trimmed`), so a client whose last id is older than that is told to resync (`id_too_old`) instead of silently missing events. Two global facts are kept with the
entries: `latest` (the newest id given out) and `barrier` (the first id given out since the store was empty). A Valkey reset loses them together with the entries,
which is how a reset is noticed (`buffer_reset`).

`ValkeyStreamStore` is the real one; `MemoryStreamStore` has the same behaviour for tests and for a process with no Valkey (and is checked against the real one by the
same tests).
"""
from __future__ import annotations

import asyncio
import re
import threading
import time
from datetime import datetime
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

MAX_LEN = 1000
MAX_AGE_MS = 3_600_000
READ_COUNT = 200
_ID = re.compile(r"^([0-9]{1,15})-([0-9]{1,9})$")  # ASCII digits only: \d would also take the digits of other scripts

Id = tuple[int, int]


def parse_id(text: str | None) -> Id | None:
    """`<ms>-<seq>` as numbers, or None when it is not that shape (the contract's pattern)."""
    if not isinstance(text, str):
        return None
    match = _ID.fullmatch(text)
    return None if match is None else (int(match.group(1)), int(match.group(2)))


def format_id(value: Id) -> str:
    return f"{value[0]}-{value[1]}"


@dataclass(frozen=True, slots=True)
class Entry:
    stream: str
    id: str
    event: str  # the IF-3 event as JSON, exactly what the browser reads as `data`


@dataclass(frozen=True, slots=True)
class Facts:
    """What a reconnect is judged by: the newest id given out, the first id since the store was empty, and per stream the newest id a trim removed."""
    latest: str | None
    barrier: str | None
    trimmed: Mapping[str, str | None]


class StreamWriter(Protocol):
    def append(self, stream: str, oid: int, event: str) -> str | None:
        """Add `event` (JSON text) from outbox row `oid` to `stream`. Returns the new id, or None when `oid` was already appended to this stream (or an older one was)."""
        ...

    def sweep(self, now: datetime) -> int:
        """Clear every stream whose newest entry is older than the maximum age (a trim only happens when a stream is appended to, so an idle stream would keep its
        entries): the id of the newest entry is recorded as trimmed, so a client behind it is told to resync. Returns how many streams were cleared (story P-24)."""
        ...


class StreamReader(Protocol):
    async def newest(self, streams: Sequence[str]) -> dict[str, str]:
        """The newest id of each stream (`0-0` for an empty or missing one): where a connection without Last-Event-ID starts."""
        ...

    async def facts(self, streams: Sequence[str]) -> Facts: ...

    async def read(self, after: Mapping[str, str], block_ms: int) -> list[Entry]:
        """The entries after the given id of each stream, oldest id first, waiting up to `block_ms` for one to arrive. Empty when none did."""
        ...

    async def close(self) -> None: ...


def _later(a: Id, b: Id) -> Id:
    return a if a >= b else b


class MemoryStreamStore:
    """Both sides in memory. Safe to use from the relay's thread and the hub's event loop at once."""

    def __init__(self, *, max_len: int = MAX_LEN, max_age_ms: int = MAX_AGE_MS, clock: Callable[[], float] = time.time):
        self._lock = threading.Lock()
        self._max_len, self._max_age_ms, self._clock = max_len, max_age_ms, clock
        self._entries: dict[str, list[tuple[Id, str]]] = {}
        self._last_oid: dict[str, int] = {}
        self._trimmed: dict[str, Id] = {}
        self._counter = 0
        self._latest: Id | None = None
        self._barrier: Id | None = None

    def reset(self) -> None:
        """What a Valkey flush does: every entry and fact is gone."""
        with self._lock:
            self._entries.clear(), self._last_oid.clear(), self._trimmed.clear()
            self._counter, self._latest, self._barrier = 0, None, None

    def append(self, stream: str, oid: int, event: str) -> str | None:
        with self._lock:
            if self._last_oid.get(stream, 0) >= oid:
                return None
            now_ms = int(self._clock() * 1000)
            ms = _later((now_ms, 0), self._latest or (0, 0))[0]
            self._counter += 1
            new: Id = (ms, self._counter)
            rows = self._entries.setdefault(stream, [])
            rows.append((new, event))
            self._last_oid[stream] = oid
            self._latest = new
            if self._barrier is None:
                self._barrier = new
            if len(rows) > self._max_len:
                cut = len(rows) - self._max_len
                self._trimmed[stream] = rows[cut - 1][0]
                del rows[:cut]
            cutoff = ms - self._max_age_ms
            old = [r for r in rows if r[0][0] < cutoff]
            if old:
                self._trimmed[stream] = old[-1][0]
                del rows[:len(old)]
            return format_id(new)

    def sweep(self, now: datetime) -> int:
        cutoff = int(now.timestamp() * 1000) - self._max_age_ms
        cleared = 0
        with self._lock:
            for stream, rows in self._entries.items():
                if rows and rows[-1][0][0] < cutoff:
                    self._trimmed[stream] = rows[-1][0]
                    rows.clear()
                    cleared += 1
        return cleared

    async def newest(self, streams: Sequence[str]) -> dict[str, str]:
        with self._lock:
            return {s: format_id(self._entries[s][-1][0]) if self._entries.get(s) else "0-0" for s in streams}

    async def facts(self, streams: Sequence[str]) -> Facts:
        with self._lock:
            return Facts(format_id(self._latest) if self._latest else None, format_id(self._barrier) if self._barrier else None,
                         {s: format_id(self._trimmed[s]) if s in self._trimmed else None for s in streams})

    def _collect(self, after: Mapping[str, str]) -> list[Entry]:
        found: list[tuple[Id, Entry]] = []
        with self._lock:
            for stream, last in after.items():
                floor = parse_id(last) or (0, 0)
                for ident, event in self._entries.get(stream, ()):
                    if ident > floor:
                        found.append((ident, Entry(stream, format_id(ident), event)))
        found.sort(key=lambda pair: pair[0])
        return [entry for _, entry in found[:READ_COUNT]]

    async def read(self, after: Mapping[str, str], block_ms: int) -> list[Entry]:
        deadline = time.monotonic() + block_ms / 1000
        while True:
            got = self._collect(after)
            if got or time.monotonic() >= deadline:
                return got
            await asyncio.sleep(0.01)

    async def close(self) -> None:
        return None


# The relay's append, in one script so that the duplicate check, the id, the facts and the trim happen together (nothing can interleave): a relay that dies
# half way and starts again never makes a duplicate entry and never leaves an id without its facts.
_APPEND = """
local last = redis.call('GET', KEYS[2])
if last and tonumber(last) >= tonumber(ARGV[2]) then return false end
local now_ms = tonumber(ARGV[5])
local latest = redis.call('HGET', KEYS[4], 'latest')
if latest then
  local lms = tonumber(string.match(latest, '^(%d+)-'))
  if lms > now_ms then now_ms = lms end
end
local seq = redis.call('INCR', KEYS[5])
local id = now_ms .. '-' .. seq
redis.call('XADD', KEYS[1], id, 'event', ARGV[1], 'oid', ARGV[2])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('HSETNX', KEYS[4], 'barrier', id)
redis.call('HSET', KEYS[4], 'latest', id)
local len = redis.call('XLEN', KEYS[1])
local maxlen = tonumber(ARGV[3])
if len > maxlen then
  local excess = len - maxlen
  local r = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', excess + 1)
  redis.call('HSET', KEYS[3], KEYS[1], r[excess][1])
  redis.call('XTRIM', KEYS[1], 'MINID', r[excess + 1][1])
end
local cutoff = now_ms - tonumber(ARGV[4])
if cutoff > 0 then
  local old = redis.call('XREVRANGE', KEYS[1], '(' .. cutoff .. '-0', '-', 'COUNT', 1)
  if #old > 0 then
    redis.call('HSET', KEYS[3], KEYS[1], old[1][1])
    redis.call('XTRIM', KEYS[1], 'MINID', cutoff .. '-0')
  end
end
return id
"""

_SWEEP = """
local rows = redis.call('XREVRANGE', KEYS[1], '+', '-', 'COUNT', 1)
if #rows == 0 then return 0 end
local id = rows[1][1]
local ms = tonumber(string.match(id, '^(%d+)-'))
if ms < tonumber(ARGV[1]) then
  redis.call('HSET', KEYS[2], KEYS[1], id)
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
"""

META = "live:meta"
TRIM = "live:trim"
SEQ = "live:seq"


class ValkeyStreamStore:
    """The streams in Valkey: a synchronous client for the relay and an asynchronous one for the hub (each created on first use)."""

    def __init__(self, url: str, *, max_len: int = MAX_LEN, max_age_ms: int = MAX_AGE_MS, clock: Callable[[], float] = time.time):
        self._url, self._max_len, self._max_age_ms, self._clock = url, max_len, max_age_ms, clock
        self._sync: Any = None
        self._script: Any = None
        self._async: Any = None

    def _writer(self):
        if self._sync is None:
            import valkey

            self._sync = valkey.Valkey.from_url(self._url, decode_responses=True, socket_timeout=5, socket_connect_timeout=2, max_connections=32)
            self._script = self._sync.register_script(_APPEND)
        return self._script

    def append(self, stream: str, oid: int, event: str) -> str | None:
        script = self._writer()
        got = script(keys=[stream, f"live:oid:{stream}", TRIM, META, SEQ], args=[event, oid, self._max_len, self._max_age_ms, int(self._clock() * 1000)])
        return got or None

    def sweep(self, now: datetime) -> int:
        self._writer()
        cutoff = int(now.timestamp() * 1000) - self._max_age_ms
        script = self._sync.register_script(_SWEEP)
        cleared = 0
        for key in self._sync.scan_iter(match="live:*", count=200, _type="stream"):
            cleared += int(script(keys=[key, TRIM], args=[cutoff]))
        return cleared

    def _client(self):
        if self._async is None:
            import valkey.asyncio as avalkey

            # Reads block for up to the heartbeat interval, so the socket timeout must be longer than any block (the hub never blocks longer than 60 s).
            self._async = avalkey.Valkey.from_url(self._url, decode_responses=True, socket_timeout=75, socket_connect_timeout=2, max_connections=2000)
        return self._async

    async def newest(self, streams: Sequence[str]) -> dict[str, str]:
        client = self._client()
        out: dict[str, str] = {}
        for stream in streams:
            rows = await client.xrevrange(stream, "+", "-", count=1)
            out[stream] = rows[0][0] if rows else "0-0"
        return out

    async def facts(self, streams: Sequence[str]) -> Facts:
        client = self._client()
        latest, barrier = await client.hmget(META, "latest", "barrier")
        trimmed = await client.hmget(TRIM, list(streams)) if streams else []
        return Facts(latest, barrier, dict(zip(streams, trimmed, strict=True)))

    async def read(self, after: Mapping[str, str], block_ms: int) -> list[Entry]:
        client = self._client()
        got = await client.xread(dict(after), count=READ_COUNT, block=max(1, int(block_ms)))
        found: list[tuple[Id, Entry]] = []
        for stream, rows in got or []:
            for ident, fields in rows:
                parsed = parse_id(ident)
                if parsed is not None:
                    found.append((parsed, Entry(stream, ident, fields["event"])))
        found.sort(key=lambda pair: pair[0])
        return [entry for _, entry in found]

    async def close(self) -> None:
        if self._async is not None:
            await self._async.aclose()
            self._async = None
        if self._sync is not None:
            self._sync.close()
            self._sync = None
