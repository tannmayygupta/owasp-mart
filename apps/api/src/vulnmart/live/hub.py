"""The SSE hub (story P-22, FR-LIV-01, FR-LIV-02, FR-LIV-05, ADR 0052): what one open `GET /api/v1/live` connection does.

`LiveHub.stream` turns the entries of a user's streams (the audiences come from the session, never from the client) into SSE frames:

- a connection **without** `Last-Event-ID` receives only the events appended after it connects (the page reads its snapshot first);
- with one, the events after it are replayed first; an id that is not an id, is newer than any given out (`id_unknown`), is older than the first the store has
  kept since a reset (`buffer_reset`), or is older than something a trim removed from one of the user's streams (`id_too_old`) gets one `stream.resync` event and the
  connection ends, so the client reloads its snapshot and opens a new connection (contracts/domain-events/README.md);
- a heartbeat comment every `heartbeat_s` (15 s) while nothing arrives, which is also what keeps the connection through the proxies' idle timeouts;
- every `recheck_s` the session is looked at again and the connection ends when it is gone or its audiences changed (the client reconnects with a fresh session);
- a connection ends after `max_age_s` (the client reconnects and resumes with `Last-Event-ID`), and one whose client does not read (`slow_s` with a full queue) is
  dropped instead of holding memory.

At most `per_user` connections per user and `total` per process (`full`). Nothing here reads the database: the streams are the replay buffer.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from .store import Entry, StreamReader, parse_id

logger = logging.getLogger("vulnmart.live")

HEARTBEAT = b": heartbeat\n\n"
OPEN = b": stream open\n\n"
_END = object()


@dataclass(frozen=True, slots=True)
class HubConfig:
    heartbeat_s: float = 15.0
    recheck_s: float = 30.0
    max_age_s: float = 900.0
    queue_max: int = 100
    slow_s: float = 10.0
    per_user: int = 6
    total: int = 2000


def frame(entry: Entry) -> bytes:
    """One SSE message: the stream id as `id`, the event type as `event`, the IF-3 event as `data` (one line)."""
    kind = json.loads(entry.event)["type"]
    return f"id: {entry.id}\nevent: {kind}\ndata: {entry.event}\n\n".encode()


def resync_frame(reason: str) -> bytes:
    """The control event: no `id` (it is never stored), the time the hub sent it."""
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = json.dumps({"schema_version": 1, "type": "stream.resync", "occurred_at": now, "data": {"reason": reason}}, separators=(",", ":"))
    return f"event: stream.resync\ndata: {body}\n\n".encode()


class LiveHub:
    def __init__(self, reader: StreamReader, config: HubConfig | None = None):
        self._reader, self._config = reader, config or HubConfig()
        self._by_user: dict[str, int] = {}
        self._open = 0

    @property
    def config(self) -> HubConfig:
        return self._config

    @property
    def connections(self) -> int:
        return self._open

    def full(self, user_id: str) -> bool:
        return self._open >= self._config.total or self._by_user.get(user_id, 0) >= self._config.per_user

    async def resync_reason(self, streams: Sequence[str], last_event_id: str) -> str | None:
        """Why a reconnect with this `Last-Event-ID` cannot be replayed, or None when it can."""
        last = parse_id(last_event_id)
        if last is None:
            return "id_unknown"
        facts = await self._reader.facts(streams)
        if facts.latest is None or facts.barrier is None:
            return "buffer_reset"  # the store holds nothing it ever gave out: it was reset (or never had an event, and then no client holds an id)
        if last > (parse_id(facts.latest) or (0, 0)):
            return "id_unknown"
        if last < (parse_id(facts.barrier) or (0, 0)):
            return "buffer_reset"
        for trimmed in facts.trimmed.values():
            if trimmed is not None and last < (parse_id(trimmed) or (0, 0)):
                return "id_too_old"
        return None

    async def stream(self, user_id: str, streams: Sequence[str], last_event_id: str | None,
                     still_allowed: Callable[[], Awaitable[bool]]) -> AsyncIterator[bytes]:
        self._open += 1
        self._by_user[user_id] = self._by_user.get(user_id, 0) + 1
        queue: asyncio.Queue[object] = asyncio.Queue(maxsize=self._config.queue_max)
        producer = asyncio.create_task(self._produce(queue, streams, last_event_id, still_allowed))
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), 1.0)
                except TimeoutError:
                    if producer.done() and queue.empty():
                        break
                    continue
                if item is _END:
                    break
                yield item  # type: ignore[misc]
        finally:
            producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)
            self._open -= 1
            left = self._by_user.get(user_id, 1) - 1
            if left <= 0:
                self._by_user.pop(user_id, None)
            else:
                self._by_user[user_id] = left

    async def _put(self, queue: asyncio.Queue[object], item: object) -> bool:
        try:
            await asyncio.wait_for(queue.put(item), self._config.slow_s)
            return True
        except TimeoutError:
            logger.warning("live connection dropped: the client does not read")
            return False

    async def _produce(self, queue: asyncio.Queue[object], streams: Sequence[str], last_event_id: str | None,
                       still_allowed: Callable[[], Awaitable[bool]]) -> None:
        cfg = self._config
        try:
            if last_event_id is None:
                after = await self._reader.newest(streams)
            else:
                reason = await self.resync_reason(streams, last_event_id)
                if reason is not None:
                    await self._put(queue, resync_frame(reason))
                    return
                after = {s: last_event_id for s in streams}
            if not await self._put(queue, OPEN):
                return
            clock = time.monotonic
            started = last_beat = last_check = clock()
            while True:
                now = clock()
                if now - started >= cfg.max_age_s:
                    return
                if now - last_check >= cfg.recheck_s:
                    if not await still_allowed():
                        return
                    last_check = now
                wait = min(cfg.heartbeat_s - (now - last_beat), cfg.recheck_s - (now - last_check), cfg.max_age_s - (now - started))
                entries = await self._reader.read(after, max(1, int(wait * 1000)))
                for entry in entries:
                    if not await self._put(queue, frame(entry)):
                        return
                    after[entry.stream] = entry.id
                if entries:
                    last_beat = clock()
                elif clock() - last_beat >= cfg.heartbeat_s:
                    if not await self._put(queue, HEARTBEAT):
                        return
                    last_beat = clock()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a store failure ends this connection; the client reconnects and resumes
            logger.exception("live stream ended by a store failure")
        finally:
            try:
                queue.put_nowait(_END)
            except asyncio.QueueFull:
                pass  # the consumer notices that the producer is done once the queue is empty
