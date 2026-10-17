"""The orchestrator's push of the access state to the edge gate (story edge-3, D-61, D-63, D-66; gate admin API of contracts/edge/gate-ticket.md).

The orchestrator is the only writer of gate state; the platform never talks to the gate. `GatePort` is a small HTTP client of the gate's
admin API: `PUT /internal/v1/gate/instances/{id}`, `DELETE ...` and `PUT /internal/v1/gate/sync`, header `X-VM-Gate-Admin` with the shared
secret. One call, 3 s timeout, no retry inside the call (the caller decides what a failure means), no redirect, no proxy. The secret is
read from a file on every call (so a rotated file takes effect, like the gate does), and it is never logged and never in an error text.

Status handling: 204 is success. 409 (an older epoch than the gate holds) is a failure: the admin API has no read call, so a client cannot
tell "the gate already holds the same or a newer state" from a real conflict, and a push that cannot be confirmed must fail closed (D-63).
Every other answer and every network error is a failure (`GateError`, a `BackendError`, so the engine treats it like a Docker refusal).
`NullGate` is the default: no edge, nothing is pushed.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Protocol

from .backend import BackendError

ADMIN_HEADER = "X-VM-Gate-Admin"
PREFIX = "/internal/v1/gate/"
TIMEOUT_S = 3.0
MIN_SECRET_CHARS = 16  # the gate refuses a shorter secret
OWNER = re.compile(r"^[0-9a-f]{64}$")
RECORD_FIELDS = ("hostname", "instance_id", "epoch", "owner", "access", "access_epoch")


class GateError(BackendError):
    """The gate did not take a push. The text holds a status or a class name, never the secret or a body."""


class GateLike(Protocol):
    def put(self, record: dict) -> None: ...
    def delete(self, instance_id: str) -> None: ...
    def sync(self, records: list[dict]) -> None: ...


class NullGate:
    """No edge configured: every push is a no-op."""

    enabled = False

    def put(self, record: dict) -> None:
        return None

    def delete(self, instance_id: str) -> None:
        return None

    def sync(self, records: list[dict]) -> None:
        return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # the admin secret must not be replayed elsewhere
        return None


def check_gate_url(url: str) -> None:
    """https always; plain http only for a loopback host or a single-label name (a compose network alias such as `edge-gate-admin`)."""
    import ipaddress

    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    if parts.scheme == "https" and host:
        return
    if parts.scheme == "http" and host:
        if host == "localhost" or "." not in host and ":" not in host:
            return
        try:
            if ipaddress.ip_address(host).is_loopback:
                return
        except ValueError:
            pass
    raise ValueError("the gate URL must be https (plain http for a loopback host or a network alias only)")


def read_secret(path: str) -> str:
    """The admin secret in a file. On POSIX a file readable or writable by group or others is refused (like the other key files)."""
    st = os.stat(path)
    if os.name != "nt" and st.st_mode & 0o077:
        raise ValueError(f"gate admin key file {path} has mode {st.st_mode & 0o777:03o}: it must be 0600 or stricter (chmod 600)")
    with open(path, encoding="utf-8") as f:
        secret = f.read().strip()
    if len(secret) < MIN_SECRET_CHARS:
        raise ValueError(f"the gate admin key must be at least {MIN_SECRET_CHARS} characters")
    return secret


def http_send(method: str, url: str, body: bytes | None, headers: dict[str, str], timeout: float) -> int:
    """Send and return the HTTP status (an error status included). Raises on a network error. No redirect, no proxy."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
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


class GatePort:
    """The HTTP client of the gate admin API."""

    enabled = True

    def __init__(
        self, url: str, key_file: str, *, timeout_s: float = TIMEOUT_S,
        send: Callable[[str, str, bytes | None, dict[str, str], float], int] = http_send,
    ) -> None:
        check_gate_url(url)
        self._base = url.rstrip("/")
        self._key_file, self._timeout, self._send = key_file, timeout_s, send
        read_secret(key_file)  # fail at start, not at the first push

    def _call(self, method: str, path: str, body: bytes | None) -> None:
        try:
            secret = read_secret(self._key_file)
        except (OSError, ValueError):
            raise GateError("the gate admin key cannot be read") from None
        headers = {ADMIN_HEADER: secret}
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            status = self._send(method, self._base + PREFIX + path, body, headers, self._timeout)
        except (http.client.HTTPException, urllib.error.URLError, OSError, ValueError) as e:
            raise GateError(f"the gate is not reachable: {type(e).__name__}") from None
        if status != 204:
            raise GateError(f"the gate refused the push: HTTP {status}")

    def put(self, record: dict) -> None:
        self._call("PUT", "instances/" + record["instance_id"], _body(record))

    def delete(self, instance_id: str) -> None:
        self._call("DELETE", "instances/" + instance_id, None)

    def sync(self, records: list[dict]) -> None:
        self._call("PUT", "sync", json.dumps({"instances": [_shape(r) for r in records]}, separators=(",", ":")).encode())


def _shape(record: dict) -> dict:
    """The story-1 body shape exactly: these six fields and no other."""
    if set(record) != set(RECORD_FIELDS):
        raise GateError("the gate record has the wrong fields")
    return {k: record[k] for k in RECORD_FIELDS}


def _body(record: dict) -> bytes:
    return json.dumps(_shape(record), separators=(",", ":")).encode()
