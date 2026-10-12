"""State reports to the platform (contract section 8, D5 of story 3.2).

Every transition of the engine becomes one report: `POST <report_url>/internal/v1/orch/state`, signed with the orchestrator key (the same
signing scheme as a request, a new nonce and timestamp on every attempt). Delivery is at least once and in order per instance: the
reports of one instance are sent one after the other, and a report that is not accepted is tried again (with a growing pause, 0.2 s up to
5 s) before the next report of that instance is sent. Only 204 (new) and 200 (the platform already has this identical report) mean
delivered; every other answer, a 409 included, and every network error is tried again. The reports of other instances are not held up.
The queue is bounded: when it is full the oldest report that is not being sent is dropped and a line says so (the platform treats a
gap as history, section 8). Nothing secret is logged: a line holds an HTTP status or an exception class name.
"""
from __future__ import annotations

import http.client
import json
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass

from .auth import body_sha256, sign
from .states import Transition

TARGET = "/internal/v1/orch/state"
MAX_PENDING = 10_000
BACKOFF_FIRST_S, BACKOFF_MAX_S = 0.2, 5.0
DELIVERED = (200, 204)


def report_body(t: Transition) -> bytes:
    """The wire form of a transition (the `StateReport` schema of the OpenAPI file)."""
    return json.dumps({
        "instance_id": t.instance_id, "epoch": t.epoch, "transition": t.transition, "from_state": t.from_state.value if t.from_state else None,
        "to_state": t.to_state.value, "at": t.at, "reason": t.reason, "error_code": t.error_code, "health": t.health,
    }, separators=(",", ":")).encode()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # a signed request must not be replayed elsewhere
        return None


def _is_loopback(host: str) -> bool:
    import ipaddress

    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def check_report_url(url: str) -> None:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme == "https":
        return
    if parts.scheme == "http" and _is_loopback(parts.hostname or ""):
        return
    raise ValueError("the report URL must be https (plain http for a loopback host only)")


def http_post(url: str, body: bytes, headers: dict[str, str], timeout: float) -> int:
    """POST and return the HTTP status (an error status included). Raises on a network error. No redirect, no proxy."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with opener.open(req, timeout=timeout) as resp:
            resp.read(65536)
            return resp.status
    except urllib.error.HTTPError as err:
        try:
            err.read(65536)
            return err.code
        finally:
            err.close()


@dataclass
class _Item:
    seq: int
    instance_id: str
    body: bytes
    attempts: int = 0
    not_before: float = 0.0


class ReportPusher:
    def __init__(
        self, url: str, key: bytes, *, timeout_s: float = 5.0, max_pending: int = MAX_PENDING,
        post: Callable[[str, bytes, dict[str, str], float], int] = http_post, clock: Callable[[], float] = time.monotonic,
        log: Callable[[str], None] | None = None,
    ) -> None:
        check_report_url(url)
        self._base = url.rstrip("/")
        self._target = urllib.parse.urlsplit(url).path.rstrip("/") + TARGET  # the request target that is signed
        self._key, self._timeout, self._max, self._post, self._clock = key, timeout_s, max_pending, post, clock
        self._log = log or (lambda line: print(line, file=sys.stderr, flush=True))
        self._queues: dict[str, deque[_Item]] = {}
        self._cond = threading.Condition()
        self._seq = 0
        self._pending = 0
        self._sending: str | None = None  # the instance whose head is on the wire
        self._stop = False
        self._thread = threading.Thread(target=self._run, name="state-reports", daemon=True)

    # ------------------------------------------------------------ queue

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        with self._cond:
            self._stop = True
            self._cond.notify_all()
        if self._thread.is_alive():
            self._thread.join(timeout=self._timeout + 1)

    def submit(self, t: Transition) -> None:
        """Called by the engine for every transition, in the order the transitions happen. Never blocks on the network."""
        with self._cond:
            if self._pending >= self._max:
                self._drop_oldest()
            self._seq += 1
            self._queues.setdefault(t.instance_id, deque()).append(_Item(self._seq, t.instance_id, report_body(t)))
            self._pending += 1
            self._cond.notify_all()

    def _drop_oldest(self) -> None:
        candidates = [(q[0].seq, i) for i, q in self._queues.items() if q and i != self._sending]
        if not candidates:
            return
        _, instance = min(candidates)
        self._queues[instance].popleft()
        self._pending -= 1
        self._log("state report queue is full: the oldest report was dropped")

    def pending(self) -> int:
        with self._cond:
            return self._pending

    def flush(self, timeout: float = 10.0) -> bool:
        """Wait until every queued report is delivered (for tests and a clean stop). False on timeout."""
        end = time.monotonic() + timeout
        with self._cond:
            while self._pending:
                left = end - time.monotonic()
                if left <= 0:
                    return False
                self._cond.wait(min(left, 0.05))
        return True

    # ------------------------------------------------------------ delivery

    def _next(self) -> _Item | None:
        """The due head with the smallest sequence number, or None (wait). Called with the condition held."""
        now = self._clock()
        due = [q[0] for q in self._queues.values() if q and q[0].not_before <= now]
        return min(due, key=lambda it: it.seq) if due else None

    def _wait_time(self) -> float:
        heads = [q[0].not_before for q in self._queues.values() if q]
        return max(0.01, min(heads) - self._clock()) if heads else 1.0

    def _run(self) -> None:
        while True:
            with self._cond:
                item = None
                while not self._stop:
                    item = self._next()
                    if item is not None:
                        break
                    self._cond.wait(self._wait_time())
                if self._stop:
                    return
                self._sending = item.instance_id
            delivered = self._deliver(item)
            with self._cond:
                self._sending = None
                q = self._queues.get(item.instance_id)
                if delivered:
                    if q and q[0] is item:
                        q.popleft()
                        self._pending -= 1
                    if q is not None and not q:
                        del self._queues[item.instance_id]
                else:
                    item.attempts += 1
                    item.not_before = self._clock() + min(BACKOFF_MAX_S, BACKOFF_FIRST_S * 2 ** min(item.attempts - 1, 6))
                self._cond.notify_all()

    def _deliver(self, item: _Item) -> bool:
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        nonce = secrets.token_hex(16)
        headers = {
            "Content-Type": "application/json", "X-VM-Timestamp": ts, "X-VM-Nonce": nonce,
            "X-VM-Signature": sign(self._key, "POST", self._target, ts, nonce, body_sha256(item.body)),
        }
        try:
            status = self._post(self._base + TARGET, item.body, headers, self._timeout)
        except (http.client.HTTPException, urllib.error.URLError, OSError, ValueError) as e:
            self._log(f"state report failed: {type(e).__name__}")
            return False
        if status in DELIVERED:
            return True
        self._log(f"state report refused: HTTP {status}")
        return False
