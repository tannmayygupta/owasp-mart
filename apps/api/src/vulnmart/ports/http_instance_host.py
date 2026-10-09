"""HttpInstanceHost: the real HTTP client of the orchestrator API (IF-5).

Implements the `InstanceHost` protocol over HTTP with only the standard library. Every request,
also a GET, is signed (contract section 4): HMAC-SHA256 over a signing string made of the method,
the request target, the timestamp, the nonce and the SHA-256 of the body. mTLS, which the contract
requires in production, is the job of the TLS context handed in (`ssl_context`); the fake service in
tests speaks plain HTTP on localhost.

`sign_request` and `verify_request` are the two halves of the signing scheme; the verifier is what the
platform API uses on state reports and what the tests use to check what the client sent.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import ipaddress
import json
import re
import secrets
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from datetime import UTC, datetime

from .instance_host import (
    ERRORS_BY_CODE, Access, BadSignature, CreateRequest, HostHealth, HostStatus, InstancePage, InstanceStatus,
    Outcome, OrchestratorError, OrchestratorUnavailable, ResetRequest, ValidationFailed,
)

SIGNATURE_VERSION = "v1"
MAX_RESPONSE_BYTES = 1024 * 1024
MIN_KEY_LENGTH = 32
_INSTANCE_ID = re.compile(r"^i-[A-Z2-7]{16}$")
MAX_SKEW_SECONDS = 60
NONCE_TTL_SECONDS = 300
_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
_NONCE = re.compile(r"^[0-9a-f]{32}$")
_SIG = re.compile(r"^v1=[0-9a-f]{64}$")


def utc_timestamp(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_nonce() -> str:
    return secrets.token_hex(16)


def signing_string(method: str, target: str, timestamp: str, nonce: str, body: bytes) -> str:
    return "\n".join([SIGNATURE_VERSION, method.upper(), target, timestamp, nonce, hashlib.sha256(body).hexdigest()])


def sign_request(key: bytes, method: str, target: str, timestamp: str, nonce: str, body: bytes) -> str:
    digest = hmac.new(key, signing_string(method, target, timestamp, nonce, body).encode(), hashlib.sha256).hexdigest()
    return f"{SIGNATURE_VERSION}={digest}"


def signed_headers(key: bytes, method: str, target: str, body: bytes, *, timestamp: str | None = None, nonce: str | None = None) -> dict[str, str]:
    timestamp = timestamp or utc_timestamp()
    nonce = nonce or new_nonce()
    return {
        "X-VM-Timestamp": timestamp,
        "X-VM-Nonce": nonce,
        "X-VM-Signature": sign_request(key, method, target, timestamp, nonce, body),
    }


class NonceCache:
    """Remembers nonces for 5 minutes. A second use is a replay."""

    def __init__(self, ttl_seconds: int = NONCE_TTL_SECONDS, clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._seen: dict[str, float] = {}  # insertion order is time order, so expiry only looks at the front
        self._lock = threading.Lock()

    def check_and_add(self, nonce: str) -> bool:
        with self._lock:
            now = self._clock()
            while self._seen:
                oldest = next(iter(self._seen))
                if now - self._seen[oldest] < self._ttl:
                    break
                del self._seen[oldest]
            if nonce in self._seen:
                return False
            self._seen[nonce] = now
            return True


def verify_request(
    key: bytes, method: str, target: str, headers: Mapping[str, str], body: bytes, *,
    nonces: NonceCache, now: datetime | None = None,
) -> None:
    """Raise BadSignature unless the request is correctly signed, fresh and not replayed.

    The message never says which check failed (contract section 4).
    """
    lower = {k.lower(): v for k, v in headers.items()}
    ts, nonce, sig = lower.get("x-vm-timestamp", ""), lower.get("x-vm-nonce", ""), lower.get("x-vm-signature", "")
    if not (_TS.match(ts) and _NONCE.match(nonce) and _SIG.match(sig)):
        raise BadSignature("bad signature")
    expected = sign_request(key, method, target, ts, nonce, body)
    if not hmac.compare_digest(expected, sig):
        raise BadSignature("bad signature")
    try:
        signed_at = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except ValueError as exc:
        raise BadSignature("bad signature") from exc
    current = now or datetime.now(UTC)
    if current.tzinfo is None:  # a naive datetime is taken as UTC
        current = current.replace(tzinfo=UTC)
    if abs((current - signed_at).total_seconds()) > MAX_SKEW_SECONDS:
        raise BadSignature("bad signature")
    if not nonces.check_and_add(nonce):
        raise BadSignature("bad signature")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # a signed request must not be replayed elsewhere
        return None


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _retry_after(headers) -> float | None:
    value = headers.get("Retry-After") if headers is not None else None
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    return seconds if seconds >= 0 else None


def _path_id(instance_id: str) -> str:
    if not isinstance(instance_id, str) or not _INSTANCE_ID.match(instance_id):
        raise ValidationFailed("bad instance id", field="/instance_id")
    return urllib.parse.quote(instance_id, safe="")


class HttpInstanceHost:
    def __init__(
        self, base_url: str, signing_key: bytes, *, timeout: float = 10.0, ssl_context: ssl.SSLContext | None = None,
        clock: Callable[[], datetime] | None = None, nonce: Callable[[], str] = new_nonce,
    ) -> None:
        if len(signing_key) < MIN_KEY_LENGTH:
            raise ValueError(f"the signing key must be at least {MIN_KEY_LENGTH} characters")
        parts = urllib.parse.urlsplit(base_url)
        if parts.scheme == "https":
            if ssl_context is None:
                raise ValueError("an https base URL needs an explicit ssl_context (mTLS in production)")
        elif parts.scheme == "http":
            if not _is_loopback(parts.hostname or ""):
                raise ValueError("a plain http base URL is allowed for a loopback host only")
        else:
            raise ValueError("the base URL must be http (loopback only) or https")
        self._base = base_url.rstrip("/")
        self._key = signing_key
        self._timeout = timeout
        self._clock = clock
        self._nonce = nonce
        handlers: list = [urllib.request.ProxyHandler({}), _NoRedirect()]
        if ssl_context is not None:
            handlers.append(urllib.request.HTTPSHandler(context=ssl_context))
        self._opener = urllib.request.build_opener(*handlers)

    # ---- transport ----
    def _call(
        self, method: str, path: str, *, query: Mapping[str, str | int] | None = None, body: dict | None = None,
        ok: tuple[int, ...] = (200,),
    ) -> tuple[int, dict]:
        target = path
        if query:
            target += "?" + urllib.parse.urlencode(query)
        raw = json.dumps(body, separators=(",", ":")).encode() if body is not None else b""
        headers = {"Accept": "application/json, application/problem+json"}
        headers.update(signed_headers(self._key, method, target, raw, timestamp=utc_timestamp(self._clock() if self._clock else None), nonce=self._nonce()))
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self._base + target, data=raw if body is not None else None, method=method, headers=headers)
        retry_after = None
        try:
            try:
                with self._opener.open(req, timeout=self._timeout) as resp:
                    status, payload = resp.status, resp.read(MAX_RESPONSE_BYTES + 1)
            except urllib.error.HTTPError as err:
                try:
                    status, payload = err.code, err.read(MAX_RESPONSE_BYTES + 1)
                    retry_after = _retry_after(err.headers)
                finally:
                    err.close()
        except (http.client.HTTPException, urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
            raise OrchestratorUnavailable(f"orchestrator unreachable or answered badly: {type(exc).__name__}") from exc
        if len(payload) > MAX_RESPONSE_BYTES:
            raise OrchestratorUnavailable("the answer is larger than 1 MiB")
        try:
            data = json.loads(payload) if payload else {}
        except ValueError as exc:
            raise OrchestratorUnavailable(f"orchestrator answered {status} with a body that is not JSON") from exc
        if not isinstance(data, dict):
            raise OrchestratorUnavailable(f"orchestrator answered {status} with JSON that is not an object")
        if status >= 400:
            code = data.get("code")
            cls = ERRORS_BY_CODE.get(code) if isinstance(code, str) else None
            if cls is None:
                raise OrchestratorUnavailable(f"unexpected answer {status}")
            field = data.get("field")
            raise cls(
                str(data.get("message", ""))[:500], field=field if isinstance(field, str) else None,
                request_id=str(data["request_id"]) if "request_id" in data else None, retry_after=retry_after,
            )
        if status not in ok:
            raise OrchestratorUnavailable(f"unexpected status {status}")
        return status, data

    @staticmethod
    def _status(data: dict) -> InstanceStatus:
        try:
            return InstanceStatus.from_json(data)
        except (KeyError, ValueError, TypeError) as exc:
            raise OrchestratorUnavailable("the answer is not an instance status") from exc

    def _outcome(self, status: int, data: dict) -> Outcome:
        if status not in (200, 202):
            raise OrchestratorUnavailable(f"unexpected status {status}")
        return Outcome(self._status(data), status == 202)

    # ---- the contract ----
    def create(self, request: CreateRequest) -> Outcome:
        return self._outcome(*self._call("POST", "/v1/instances", body=request.to_json(), ok=(200, 202)))

    def get(self, instance_id: str) -> InstanceStatus:
        return self._status(self._call("GET", f"/v1/instances/{_path_id(instance_id)}")[1])

    def reset(self, instance_id: str, request: ResetRequest) -> Outcome:
        path = f"/v1/instances/{_path_id(instance_id)}/reset"
        return self._outcome(*self._call("POST", path, body=request.to_json(), ok=(200, 202)))

    def set_access(self, instance_id: str, access: Access, access_epoch: int) -> InstanceStatus:
        path = f"/v1/instances/{_path_id(instance_id)}/access"
        try:
            value = Access(access).value
        except ValueError as exc:
            raise ValidationFailed("access is open, frozen or closed", field="/access") from exc
        return self._status(self._call("POST", path, body={"access": value, "access_epoch": access_epoch})[1])

    def destroy(self, instance_id: str) -> Outcome:
        return self._outcome(*self._call("POST", f"/v1/instances/{_path_id(instance_id)}/destroy", ok=(200, 202)))

    def list_instances(
        self, labels: dict[str, str] | None = None, *, cursor: str | None = None, limit: int = 100
    ) -> InstancePage:
        query: dict[str, str | int] = dict(labels or {})
        if cursor is not None:
            query["cursor"] = cursor
        if limit != 100:
            query["limit"] = limit
        data = self._call("GET", "/v1/instances", query=query)[1]
        try:
            return InstancePage(tuple(InstanceStatus.from_json(i) for i in data["items"]), data["next_cursor"])
        except (KeyError, ValueError, TypeError) as exc:
            raise OrchestratorUnavailable("the answer is not an instance page") from exc

    def host_status(self) -> HostStatus:
        d = self._call("GET", "/v1/host")[1]
        try:
            return HostStatus(d["host_id"], d["kind"], d["capacity_memory_mb"], d["used_memory_mb"], d["instances"], HostHealth(d["health"]))
        except (KeyError, ValueError, TypeError) as exc:
            raise OrchestratorUnavailable("the answer is not a host status") from exc


__all__ = [
    "HttpInstanceHost", "NonceCache", "OrchestratorError", "sign_request", "signed_headers", "signing_string",
    "verify_request",
]
