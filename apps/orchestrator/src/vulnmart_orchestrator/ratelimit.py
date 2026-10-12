"""Rate limit of IF-5 (contract section 7, D7 of story 3.2): a token bucket per client, 20 requests per second, burst 40. Over the limit the
answer is 429 `ORCH-RATE-LIMITED` with a `Retry-After` in whole seconds. A rate of 0 switches the limit off (the test harness does that,
because a test polls faster than any real platform)."""
from __future__ import annotations

import math
import threading
import time
from collections.abc import Callable

RATE_PER_SECOND = 20.0
BURST = 40.0
MAX_CLIENTS = 1024


class RateLimiter:
    def __init__(self, rate: float = RATE_PER_SECOND, burst: float = BURST, clock: Callable[[], float] = time.monotonic) -> None:
        self.rate, self.burst, self._clock = float(rate), float(burst), clock
        self._buckets: dict[str, tuple[float, float]] = {}  # client -> (tokens, time of the last refill)
        self._lock = threading.Lock()

    def check(self, client: str) -> int | None:
        """None when the request may go on, else the whole seconds to wait (at least 1)."""
        if self.rate <= 0:
            return None
        with self._lock:
            now = self._clock()
            tokens, last = self._buckets.get(client, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.rate)
            if tokens >= 1.0:
                self._buckets[client] = (tokens - 1.0, now)
                self._prune(now)
                return None
            self._buckets[client] = (tokens, now)
            return max(1, math.ceil((1.0 - tokens) / self.rate))

    def _prune(self, now: float) -> None:
        if len(self._buckets) <= MAX_CLIENTS:
            return
        full_after = self.burst / self.rate
        for k in [k for k, (_, t) in self._buckets.items() if now - t >= full_after]:
            del self._buckets[k]
