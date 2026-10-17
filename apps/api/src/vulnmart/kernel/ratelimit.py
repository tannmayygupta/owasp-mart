"""Rate limits for the public endpoints (FR-ACC-10): a fixed window counter per key, in Valkey in production.

A limit is `N requests per window seconds` for one key such as `signup:ip:203.0.113.7` or `signup:email:<hash>`. The caller names the
limits (they are settings, `SETTINGS`), asks `hit` once per request and answers 429 with `Retry-After` when it says no.

Choices, each with the reason:
- Fixed window, not sliding: one INCR and one EXPIRE, easy to reason about, and a burst of at most twice the limit around a window
  edge is acceptable for abuse control (the limits are placeholders to be tuned).
- The key never holds an email address: callers pass a hash (`email_key`), so Valkey holds no personal data beyond a short-lived IP.
- Valkey errors are not swallowed: `hit` raises `RateLimiterUnavailable` and the route answers an error. An abuse control that turns
  itself off when its store is down would make an outage the moment to attack; the readiness check already needs Valkey.
"""
from __future__ import annotations

import hashlib
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable


class RateLimiterUnavailable(RuntimeError):
    """The store behind the limiter did not answer."""


@dataclass(frozen=True, slots=True)
class RateDecision:
    allowed: bool
    retry_after: int  # seconds until the window ends; 0 when allowed


@runtime_checkable
class RateLimiter(Protocol):
    def hit(self, key: str, limit: int, window_seconds: int) -> RateDecision:
        """Count one request under `key`. Allowed while the count in the current window is at most `limit`."""
        ...

    def peek(self, key: str, limit: int) -> RateDecision:
        """Without counting: denied when the current window already holds `limit` or more under `key` (used for failed-login counters)."""
        ...

    def reset(self, key: str) -> None:
        """Forget the count under `key` (a successful login clears the failures of that address)."""
        ...


def email_key(normalized_email: str) -> str:
    """A key part for an address: a hash, so no address is ever a Valkey key."""
    return hashlib.sha256(normalized_email.encode("utf-8")).hexdigest()[:32]


class InMemoryRateLimiter:
    """The same rule in process memory: tests and a laptop run with no Valkey. Not shared between processes."""

    def __init__(self, *, now: Callable[[], float] = time.time):
        self._now = now
        self._lock = threading.Lock()
        self._windows: dict[str, tuple[int, float]] = {}  # key -> (count, window end)

    def hit(self, key: str, limit: int, window_seconds: int) -> RateDecision:
        now = self._now()
        with self._lock:
            count, end = self._windows.get(key, (0, 0.0))
            if now >= end:
                count, end = 0, now + window_seconds
            count += 1
            self._windows[key] = (count, end)
            if count <= limit:
                return RateDecision(True, 0)
            return RateDecision(False, max(1, int(end - now + 0.999)))

    def peek(self, key: str, limit: int) -> RateDecision:
        now = self._now()
        with self._lock:
            count, end = self._windows.get(key, (0, 0.0))
            if now >= end or count < limit:
                return RateDecision(True, 0)
            return RateDecision(False, max(1, int(end - now + 0.999)))

    def reset(self, key: str) -> None:
        with self._lock:
            self._windows.pop(key, None)


class ValkeyRateLimiter:
    """Fixed window counters in Valkey. One Lua call per hit (INCR, set the expiry on the first hit, read the remaining time), so a
    crash between two commands can never leave a counter that never expires."""

    SCRIPT = """
    local n = redis.call('INCR', KEYS[1])
    if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
    local ttl = redis.call('TTL', KEYS[1])
    if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
    return {n, ttl}
    """

    def __init__(self, client: Any, *, prefix: str = "vm:rl:"):
        self._client = client  # a valkey.Valkey (sync) client
        self._prefix = prefix
        self._script = client.register_script(self.SCRIPT)

    def hit(self, key: str, limit: int, window_seconds: int) -> RateDecision:
        try:
            count, ttl = self._script(keys=[self._prefix + key], args=[window_seconds])
        except Exception as exc:  # noqa: BLE001 - any store failure means "cannot count"
            raise RateLimiterUnavailable(type(exc).__name__) from exc
        if int(count) <= limit:
            return RateDecision(True, 0)
        return RateDecision(False, max(1, int(ttl)))

    def peek(self, key: str, limit: int) -> RateDecision:
        try:
            pipe = self._client.pipeline()
            pipe.get(self._prefix + key)
            pipe.ttl(self._prefix + key)
            raw, ttl = pipe.execute()
        except Exception as exc:  # noqa: BLE001
            raise RateLimiterUnavailable(type(exc).__name__) from exc
        count = int(raw) if raw is not None else 0
        if count < limit:
            return RateDecision(True, 0)
        return RateDecision(False, max(1, int(ttl)))

    def reset(self, key: str) -> None:
        try:
            self._client.delete(self._prefix + key)
        except Exception as exc:  # noqa: BLE001
            raise RateLimiterUnavailable(type(exc).__name__) from exc
