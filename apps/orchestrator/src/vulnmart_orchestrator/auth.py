"""Request signing for IF-5 (contract section 4, D1 of story 3.2): HMAC-SHA256 over a signing string, a 60 second skew, a nonce
that is remembered for 5 minutes. Every request is signed, a GET too. A failure is always the same answer (401 `ORCH-BAD-SIGNATURE`),
so the answer never tells which of the checks failed. The nonce memory is per process (open point 27 of the contract).
"""
from __future__ import annotations

import hashlib
import hmac
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from datetime import datetime, timezone

VERSION = "v1"
MAX_SKEW_SECONDS = 60
NONCE_TTL_SECONDS = 300
MIN_KEY_LENGTH = 32
MAX_NONCES = 200_000  # memory bound: at the rate limit this is hours of traffic; over it the oldest are forgotten
_TS = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
_NONCE = re.compile(r"[0-9a-f]{32}")
_SIG = re.compile(r"v1=[0-9a-f]{64}")


def body_sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def signing_string(method: str, target: str, timestamp: str, nonce: str, body_hash: str) -> str:
    return "\n".join([VERSION, method.upper(), target, timestamp, nonce, body_hash])


def sign(key: bytes, method: str, target: str, timestamp: str, nonce: str, body_hash: str) -> str:
    digest = hmac.new(key, signing_string(method, target, timestamp, nonce, body_hash).encode(), hashlib.sha256).hexdigest()
    return f"{VERSION}={digest}"


class NonceMemory:
    """Nonces seen in the last `ttl` seconds. `add` is False for a nonce that is already there (a replay)."""

    def __init__(self, ttl: float = NONCE_TTL_SECONDS, clock: Callable[[], float] = time.monotonic, limit: int = MAX_NONCES) -> None:
        self._ttl, self._clock, self._limit = ttl, clock, limit
        self._seen: OrderedDict[str, float] = OrderedDict()  # insertion order is time order
        self._lock = threading.Lock()

    def add(self, nonce: str) -> bool:
        with self._lock:
            now = self._clock()
            while self._seen:
                oldest, at = next(iter(self._seen.items()))
                if now - at < self._ttl and len(self._seen) < self._limit:
                    break
                del self._seen[oldest]
            if nonce in self._seen:
                return False
            self._seen[nonce] = now
            return True


class Verifier:
    """Checks a request the way the contract says: shape of the headers, signature (constant time), timestamp, nonce."""

    def __init__(self, key: bytes, *, nonces: NonceMemory | None = None, now: Callable[[], datetime] | None = None) -> None:
        if len(key) < MIN_KEY_LENGTH:
            raise ValueError(f"the signing key must be at least {MIN_KEY_LENGTH} characters")
        self._key = key
        self._nonces = nonces or NonceMemory()
        self._now = now or (lambda: datetime.now(timezone.utc))

    def verify(self, method: str, target: str, headers: Mapping[str, str], body_hash: str) -> bool:
        ts = headers.get("x-vm-timestamp", "")
        nonce = headers.get("x-vm-nonce", "")
        sig = headers.get("x-vm-signature", "")
        if not (_TS.fullmatch(ts) and _NONCE.fullmatch(nonce) and _SIG.fullmatch(sig)):
            return False
        expected = sign(self._key, method, target, ts, nonce, body_hash)
        if not hmac.compare_digest(expected.encode(), sig.encode()):
            return False
        try:
            signed_at = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)  # a date that does not exist fails
        except ValueError:
            return False
        if abs((self._now() - signed_at).total_seconds()) > MAX_SKEW_SECONDS:
            return False
        return self._nonces.add(nonce)
