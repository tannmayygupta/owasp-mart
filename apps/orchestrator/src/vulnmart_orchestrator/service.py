"""The IF-5 service: the orchestrator API over the engine (story 3.2, L-13 part 2).

A FastAPI application with one catch-all route, because the contract fixes an order of checks that a router would break (a wrong method
or an unknown path must be answered only after the signature, a body over 64 KiB before everything). Order, as in IF-5 section 6:

    413 body over 64 KiB (not read further, the connection is closed)
    401 signature, timestamp, nonce                  (every request, a GET too; mTLS is the transport, see `serve`)
    429 rate limit (20 per second per client, burst 40)
    404 / 405 the call exists
    415 a body that is not application/json
    422 path id and body shape (strict JSON, closed schemas, forbidden fields)
    422 template allow-list, 404 existence, 409 state and epoch, 429 capacity   (the engine)

`create` and `destroy` answer at once (202) and a worker thread does the Docker work; the state reports of the engine go to the
platform through `ReportPusher`. `reset` answers at once too (202, or 200 for the same body) and a worker runs the create path again for
the new epoch (story 3.4). Before it serves, the service runs one reconciler pass (story 3.5: Docker against the records) and then repeats it
about every minute; until a pass has worked, create and reset answer 429 ORCH-BUSY. A reaper thread (`Reaper`) ends instances at their total limit or after inactivity through the normal destroy
path. With `--backend fake` only, an unsigned loopback call `POST /_fake/v1/instances/{id}/activity` moves an instance between ready,
active and idle for the test suites. No answer and no log line holds a secret, an exception message or a stack trace.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import copy
import ipaddress
import json
import os
import re
import ssl
import sys
import threading
import time
import urllib.parse
from collections.abc import Callable, Mapping

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import Response
from starlette.routing import request_response

from .auth import MIN_KEY_LENGTH, Verifier, body_sha256
from .backend import FAIL_TEMPLATE, BackendError, ServiceFakeBackend
from .builder import INSTANCE_ID, TemplateInvalid, parse_access, parse_activity, parse_create, parse_reset
from .capacity import DEFAULT_CAPACITY_MB
from .engine import Orchestrator
from .gate import GatePort, NullGate
from .images import ImageAllowlist, ImageNotAllowed, fake_allowlist
from .jsonstrict import JsonStrictError, loads_strict
from .problems import (
    INTERNAL, MEDIA_TYPE, RETRY_AFTER_BUSY, ROUTE_UNKNOWN, ProblemError, new_request_id, pointer, problem_body,
)
from .ratelimit import BURST, RATE_PER_SECOND, RateLimiter
from .reconcile import TombstoneStore
from .reports import ReportPusher, check_report_url
from .states import Busy, CursorInvalid, EngineError, FieldForbidden, LabelUnknown, ValidationFailed
from .templates import load_templates

MAX_BODY = 64 * 1024
BODY_READ_TIMEOUT_S = 10.0  # L13: the whole request body is due within this time (slow-body clients are cut)
MAX_CONCURRENCY = 64  # L13: uvicorn answers 503 above this many requests in flight
JSON_TYPE = re.compile(r"application/json\s*(;.*)?", re.IGNORECASE)
LABELS = ("instance", "epoch", "component", "template", "kind")
CURSOR = re.compile(r"[A-Za-z0-9_-]{24}")  # base64url, no padding, of an 18-character instance id
LIMIT = re.compile(r"[1-9][0-9]{0,2}")
EPOCH = re.compile(r"[1-9][0-9]*")
FAKE_ACTIVITY = re.compile(r"/_fake/v1/instances/([^/]+)/activity")
LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1")

# (path pattern, methods in the order the Allow header lists them, route name)
ROUTES: list[tuple[re.Pattern[str], tuple[str, ...], str]] = [
    (re.compile(r"/v1/instances"), ("GET", "POST"), "collection"),
    (re.compile(r"/v1/host"), ("GET",), "host"),
    (re.compile(r"/v1/instances/([^/]+)"), ("GET",), "get"),
    (re.compile(r"/v1/instances/([^/]+)/(reset|access|destroy|activity)"), ("POST",), "action"),
]


def log_line(**fields: object) -> None:
    print(json.dumps(fields, separators=(",", ":")), file=sys.stderr, flush=True)


def spawn(fn: Callable[[], None], what: str) -> None:
    """Run slow work on a daemon thread. A failure is logged by class name only."""

    def run() -> None:
        try:
            fn()
        except Exception as e:  # never let a worker die loudly with a message that may hold a document
            log_line(event="worker-failed", what=what, error=type(e).__name__)

    threading.Thread(target=run, name=what, daemon=True).start()


def destroy_worker(work: Callable[[], None], attempts: int = 5, pause_s: float = 2.0) -> Callable[[], None]:
    """A destroy that cannot remove everything (Docker refused) is tried again a few times; the instance stays `stopping` meanwhile,
    and a repeated destroy call starts it again. `work` is safe to call again: it sweeps, then moves to destroyed once."""

    def run() -> None:
        for n in range(attempts):
            try:
                work()
                return
            except BackendError:
                log_line(event="destroy-incomplete", attempt=n + 1)
                time.sleep(pause_s * (n + 1))

    return run

class Reaper:
    """The background pass that ends instances at the total limit or after inactivity (FR-INS-04). It wakes every
    `reaper_interval_s` (from the settings port), asks the engine for one pass and runs each destroy on a worker thread. A failed pass is
    logged by class name and tried again at the next wake-up. `stop` ends the thread at shutdown."""

    def __init__(self, engine: Orchestrator, *, spawn_work: Callable[[Callable[[], None], str], None] = spawn) -> None:
        self.engine, self._spawn = engine, spawn_work
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="reaper", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=5)

    def run_once(self) -> list[str]:
        return self.engine.reap_due(execute=lambda work: self._spawn(destroy_worker(work), "reap-destroy"))

    def _interval(self) -> float:
        try:
            return self.engine.settings.get().reaper_interval_s
        except Exception as e:  # a failing settings port must not end the thread
            log_line(event="reaper-settings-failed", error=type(e).__name__)
            return 30.0

    def _loop(self) -> None:
        while not self._stop.wait(self._interval()):
            try:
                ids = self.run_once()
                if ids:
                    log_line(event="reaped", count=len(ids))
            except Exception as e:
                log_line(event="reaper-failed", error=type(e).__name__)


class ReconcileLoop:
    """The first pass of the reconciler runs before the service answers (`first_pass`); this thread then repeats it every
    `reconcile_interval_s` (from the settings port). A failed pass is logged by class name and tried again at the next wake-up."""

    RETRY_S = 5.0  # while the engine is closed to creates (no pass has worked yet) the next pass is tried after this long

    def __init__(self, engine: Orchestrator, *, spawn_work: Callable[[Callable[[], None], str], None] = spawn, retry_s: float | None = None) -> None:
        self.engine, self._spawn = engine, spawn_work
        self.retry_s = self.RETRY_S if retry_s is None else retry_s
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="reconciler", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=5)

    def run_once(self):
        return self.engine.reconcile(execute=lambda work: self._spawn(destroy_worker(work), "reconcile-destroy"))

    def first_pass(self) -> bool:
        """The pass before serving. True when it worked; otherwise the service still starts and stays busy until a later pass works."""
        try:
            result = self.run_once()
            self._report(result)
            return not (result.safe_mode or result.errors)
        except Exception as e:
            log_line(event="reconcile-failed", error=type(e).__name__)
            return False

    @staticmethod
    def _report(r) -> None:
        if r.safe_mode:
            log_line(event="reconcile-safe-mode", detail="the desired state cannot be read: nothing is destroyed for being unwanted, creates are refused")
        if r.adopted or r.failed or r.destroyed or r.swept or r.errors:
            log_line(event="reconciled", adopted=len(r.adopted), failed=len(r.failed), destroyed=len(r.destroyed), swept=len(r.swept),
                     errors=len(r.errors))

    def _interval(self) -> float:
        if self.engine.gate_closed:
            return self.retry_s
        try:
            return self.engine.settings.get().reconcile_interval_s
        except Exception as e:
            log_line(event="reconcile-settings-failed", error=type(e).__name__)
            return 60.0

    def _loop(self) -> None:
        while not self._stop.wait(self._interval()):
            try:
                self._report(self.run_once())
            except Exception as e:
                log_line(event="reconcile-failed", error=type(e).__name__)


def _encode_cursor(instance_id: str) -> str:
    return base64.urlsafe_b64encode(instance_id.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> str | None:
    """The instance id inside a cursor this service handed out, else None (wrong length or characters, not an id, not canonical)."""
    if not CURSOR.fullmatch(cursor):
        return None
    try:
        text = base64.urlsafe_b64decode(cursor).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    return text if INSTANCE_ID.fullmatch(text) and _encode_cursor(text) == cursor else None


def _problem_of(exc: Exception) -> ProblemError:
    """The answer for an error of the engine or of the request reading. Anything unknown is a plain internal error."""
    if isinstance(exc, ProblemError):
        return exc
    if isinstance(exc, (TemplateInvalid, ImageNotAllowed)):  # the deployment is wrong, not the request: say nothing about it
        log_line(event="template-fault", error=type(exc).__name__)
        return ProblemError(INTERNAL, "internal error")
    if isinstance(exc, FieldForbidden):
        return ProblemError(exc.code, "the orchestrator accepts no container fields", exc.field)
    if isinstance(exc, EngineError):
        headers = {"Retry-After": RETRY_AFTER_BUSY} if isinstance(exc, Busy) else {}
        return ProblemError(exc.code, str(exc), exc.field, headers)
    log_line(event="internal-error", error=type(exc).__name__)
    return ProblemError(INTERNAL, "internal error")


def _loads(buf: bytes) -> object:
    try:
        return loads_strict(buf)
    except JsonStrictError:
        raise ValidationFailed("the body is not valid JSON with integer tokens", field="") from None


def _id(raw: str) -> str:
    if not INSTANCE_ID.fullmatch(raw):
        raise ValidationFailed("bad instance id", field=pointer("path", "instance_id"))
    return raw


class _AllMethods:
    def __init__(self, app: Callable) -> None:
        self._app = app

    async def __call__(self, scope, receive, send) -> None:
        await self._app(scope, receive, send)


class Service:
    """The handlers, with the engine and the checks they use. `app` is the ASGI application."""

    def __init__(
        self, engine: Orchestrator, verifier: Verifier, limiter: RateLimiter, *, spawn_work: Callable[[Callable[[], None], str], None] = spawn,
        fake_controls: bool = False,
    ) -> None:
        self.engine, self.verifier, self.limiter, self._spawn = engine, verifier, limiter, spawn_work
        self.fake_controls = fake_controls  # the unsigned activity control: only with `--backend fake`
        self.app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)  # no unauthenticated page about the API
        # An object with `__call__`, not a function: Starlette gives a function route only the GET method, an ASGI object all methods.
        # So an odd method is refused in the contract's order (after the signature) and as a problem body, not by the router.
        self.app.add_route("/{path:path}", _AllMethods(request_response(self._endpoint)), include_in_schema=False)

    # ------------------------------------------------------------ one request

    async def _endpoint(self, request: Request) -> Response:
        request_id = new_request_id()
        route = "unknown"
        failed = False
        try:
            status, body, headers, route = await self._handle(request, request_id)
        except Exception as e:
            failed = True
            p = _problem_of(e)
            status, body, _ = problem_body(p.code, p.field, request_id)
            detail = p.detail[:200]  # for the log only: the answer holds no free text (IF-8)
            headers = {"Content-Type": MEDIA_TYPE, **p.headers}
            if p.code == "ORCH-BODY-TOO-LARGE":
                headers["Connection"] = "close"  # the rest of the body is not read: drop the connection
        log_line(event="request", request_id=request_id, method=request.method[:16], route=route, status=status, **({"code": p.code, "detail": detail} if failed else {}))
        return Response(content=body, status_code=status, headers={"Cache-Control": "no-store", **headers})

    async def _handle(self, request: Request, request_id: str) -> tuple[int, bytes, dict[str, str], str]:
        # 1. body size: not read further, not hashed
        declared = request.headers.get("content-length")
        if declared is not None and declared.isascii() and declared.isdigit() and int(declared) > MAX_BODY:
            raise ProblemError("ORCH-BODY-TOO-LARGE", f"the body is larger than {MAX_BODY} bytes")
        chunks: list[bytes] = []
        size = 0
        try:
            # a client that sends its body one byte a minute would hold a connection for ever: the whole body is due within a deadline
            async with asyncio.timeout(BODY_READ_TIMEOUT_S):
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_BODY:
                        raise ProblemError("ORCH-BODY-TOO-LARGE", f"the body is larger than {MAX_BODY} bytes")
                    chunks.append(chunk)
        except TimeoutError:
            raise ProblemError("ORCH-VALIDATION", "the body did not arrive in time", "", {"Connection": "close"}) from None
        buf = b"".join(chunks)

        # 2. signature (the request target as sent: path plus query string)
        raw_path = request.scope.get("raw_path") or request.scope["path"].encode()
        if self.fake_controls:  # test control of the fake backend: before the signature, unsigned by design (loopback only)
            ctl = FAKE_ACTIVITY.fullmatch(raw_path.decode("latin-1"))
            if ctl:
                status, answer = self._fake_activity(request, ctl.group(1), buf)
                return status, json.dumps(answer, separators=(",", ":")).encode(), {"Content-Type": "application/json"}, "fake-activity"
        target = raw_path.decode("latin-1")
        query = request.scope.get("query_string", b"")
        if query:
            target += "?" + query.decode("latin-1")
        if not self.verifier.verify(request.method, target, request.headers, body_sha256(buf)):
            raise ProblemError("ORCH-BAD-SIGNATURE", "bad signature")

        # 3. rate limit, counted for authenticated requests only
        client = request.client.host if request.client else "unknown"
        wait = self.limiter.check(client)
        if wait is not None:
            raise ProblemError("ORCH-RATE-LIMITED", "too many requests", headers={"Retry-After": str(wait)})

        # 4. the call exists: 404 for an unknown path, 405 for a known path with another method
        path = raw_path.decode("latin-1")
        matched = [(pattern.fullmatch(path), methods, name) for pattern, methods, name in ROUTES]
        matched = [m for m in matched if m[0] is not None]
        if not matched:
            raise ProblemError(ROUTE_UNKNOWN, "no such call")
        hit = next(((m, methods, name) for m, methods, name in matched if request.method in methods), None)
        if hit is None:
            raise ProblemError("ORCH-METHOD-NOT-ALLOWED", f"{request.method[:16]} is not allowed here", headers={"Allow": ", ".join(matched[0][1])})
        m, _, name = hit

        # 5. media type of a body
        if buf and not JSON_TYPE.fullmatch(request.headers.get("content-type", "")):
            raise ProblemError("ORCH-UNSUPPORTED-MEDIA-TYPE", "the body must be sent as application/json")

        # 6. the call itself: shape (422), template (422), existence (404), state (409), capacity (429)
        if name == "collection":
            status, answer = (self._create(buf) if request.method == "POST" else self._list(query))
            route = "create" if request.method == "POST" else "list"
        elif name == "host":
            status, answer, route = 200, self.engine.host_status(), "host"
        elif name == "get":
            status, answer, route = 200, self.engine.view(_id(m.group(1))), "get"
        else:
            route = m.group(2)
            status, answer = getattr(self, "_" + route)(_id(m.group(1)), buf)
        return status, json.dumps(answer, separators=(",", ":")).encode(), {"Content-Type": "application/json"}, route

    # ------------------------------------------------------------ the calls

    def _create(self, buf: bytes) -> tuple[int, dict]:
        accepted = self.engine.accept_create(parse_create(_loads(buf)))
        if accepted.work is not None:
            try:
                self._spawn(accepted.work, "create")
            except Exception as e:  # no thread could be started (M10): the instance fails with a code, it does not stay `requested`
                log_line(event="spawn-failed", what="create", error=type(e).__name__)
                self.engine.abandon_create(accepted.record)
                raise ProblemError(INTERNAL, "the worker could not be started") from None
        return (202 if accepted.changed else 200), accepted.view

    def _access(self, instance_id: str, buf: bytes) -> tuple[int, dict]:
        access, epoch = parse_access(_loads(buf))
        return 200, self.engine.set_access(instance_id, access, epoch)

    def _destroy(self, instance_id: str, buf: bytes) -> tuple[int, dict]:
        accepted = self.engine.accept_destroy(instance_id)
        if accepted.work is not None:
            try:
                self._spawn(destroy_worker(accepted.work), "destroy")
            except Exception as e:  # M10: the flag is cleared, so a repeated destroy starts the work again
                log_line(event="spawn-failed", what="destroy", error=type(e).__name__)
                self.engine.release_destroy(accepted.record)
                raise ProblemError(INTERNAL, "the worker could not be started") from None
        return (202 if accepted.changed else 200), accepted.view

    def _reset(self, instance_id: str, buf: bytes) -> tuple[int, dict]:
        accepted = self.engine.accept_reset(instance_id, parse_reset(_loads(buf)))
        if accepted.work is not None:
            try:
                self._spawn(accepted.work, "reset")
            except Exception as e:  # no thread could be started: the instance fails with a code, it does not stay `resetting`
                log_line(event="spawn-failed", what="reset", error=type(e).__name__)
                self.engine.abandon_create(accepted.record)
                raise ProblemError(INTERNAL, "the worker could not be started") from None
        return (202 if accepted.changed else 200), accepted.view

    def _activity(self, instance_id: str, buf: bytes) -> tuple[int, dict]:
        """IF-5 `reportActivity`: the platform tells the orchestrator that a player did something (it forwards what the edge and the sidecar saw), so the idle
        limit counts from the last activity and not from the moment the instance became ready (audit of 2026-10-18, blocker B1)."""
        return 200, self.engine.record_activity(instance_id, parse_activity(_loads(buf)))

    def _fake_activity(self, request: Request, instance_id: str, buf: bytes) -> tuple[int, dict]:
        """Test control of `--backend fake` only, not part of IF-5: unsigned and loopback only, like the Node fake."""
        if request.method != "POST" or not request.client or request.client.host not in LOOPBACK:
            raise ProblemError(ROUTE_UNKNOWN, "not available")
        try:
            data = _loads(buf)
        except ValidationFailed:
            data = None
        state = data.get("state") if isinstance(data, dict) else None
        if not isinstance(state, str):
            raise ValidationFailed("state is ready, active or idle", field="/state")
        return 200, self.engine.force_activity(_id(instance_id), state)

    def _list(self, query: bytes) -> tuple[int, dict]:
        pairs = urllib.parse.parse_qsl(query.decode("latin-1"), keep_blank_values=True)
        names = [k for k, _ in pairs]
        for name in names:
            if name not in LABELS and name not in ("cursor", "limit"):
                raise LabelUnknown("not a label filter", field=pointer("query", name[:64]))
        for name in dict.fromkeys(names):
            if names.count(name) > 1:
                raise ValidationFailed("a query parameter is given more than once", field=pointer("query", name[:64]))
        q = dict(pairs)
        limit = 100
        if "limit" in q:
            if not LIMIT.fullmatch(q["limit"]) or int(q["limit"]) > 500:
                raise ValidationFailed("limit is 1 to 500", field=pointer("query", "limit"))
            limit = int(q["limit"])
        if "epoch" in q and not EPOCH.fullmatch(q["epoch"]):
            raise ValidationFailed("epoch is a positive integer", field=pointer("query", "epoch"))
        if "instance" in q and not INSTANCE_ID.fullmatch(q["instance"]):
            raise ValidationFailed("bad instance id", field=pointer("query", "instance"))
        after = None
        if "cursor" in q:
            after = _decode_cursor(q["cursor"])
            if after is None:
                raise CursorInvalid("the cursor is not one this orchestrator handed out", field=pointer("query", "cursor"))
        items, last = self.engine.list_views(
            instance=q.get("instance"), epoch=int(q["epoch"]) if "epoch" in q else None, template=q.get("template"),
            component=q.get("component"), kind=q.get("kind"), after=after, limit=limit,
        )
        return 200, {"items": items, "next_cursor": _encode_cursor(last) if last else None}


# ---------------------------------------------------------------- command line

class _Parser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, allow_abbrev=False, **kwargs)  # "--key" must not mean "--key-file"

    def error(self, message: str):  # exit code 2, like the Node fake
        self.exit(2, f"{self.prog}: {message}\n")


def build_parser() -> argparse.ArgumentParser:
    p = _Parser(prog="vulnmart_orchestrator", description="VulnMart orchestrator service (IF-5)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8443)
    # No signing key on the command line (it would show in `ps`): the environment variables, or a file that only the owner can read.
    p.add_argument("--key-file", help="file with the platform signing key (or the environment variable VM_ORCH_PLATFORM_KEY); on POSIX the file must not be readable by group or others")
    p.add_argument("--report-key-file", help="file with the orchestrator signing key for state reports (or VM_ORCH_REPORT_KEY); same file rule")
    p.add_argument("--insecure-no-tls", action="store_true", help="test and local demo only: allow a listen address that is not loopback without TLS")
    p.add_argument("--allow-fake-backend", action="store_true", help="test switch: required for --backend fake")
    p.add_argument("--report-url", help="platform base URL for state reports")
    p.add_argument("--report-timeout-ms", type=int, default=5000)
    p.add_argument("--capacity-mb", type=int, default=DEFAULT_CAPACITY_MB)
    p.add_argument("--step-delay-ms", type=int, default=0, help="test aid: pause before each step of a create and of a destroy")
    p.add_argument("--state-dir", help="directory for the tombstone file of destroyed instance ids (kept in memory only when not given)")
    p.add_argument("--host-id", default="orch-host-1")
    p.add_argument("--host-kind", choices=("vm", "laptop", "fake"), default=None)
    p.add_argument("--backend", choices=("docker", "fake"), default="docker")
    p.add_argument("--docker-host", help="Docker API URL (default: the environment)")
    p.add_argument("--templates-dir", required=True)
    p.add_argument("--template-schema", required=True)
    p.add_argument("--images-manifest", help="release manifest (required with --backend docker)")
    p.add_argument("--allow-local-images", action="store_true", help="local demo and tests only: accept bare local image ids (sha256:<hex>) in the manifest")
    p.add_argument("--health-timeout-s", type=float, default=None)
    p.add_argument("--injector-timeout-s", type=float, default=None)
    p.add_argument("--rate-per-s", type=float, default=RATE_PER_SECOND, help="requests per second per client; 0 switches the limit off")
    p.add_argument("--rate-burst", type=float, default=BURST)
    p.add_argument("--edge-container", help="name of the edge container that is connected to every instance network (off when not given)")
    p.add_argument("--gate-url", help="base URL of the gate admin API (https, or http for a loopback host or a network alias); needs --gate-admin-key-file")
    p.add_argument("--gate-admin-key-file", help="file with the gate admin secret (same file rule as the other key files); needs --gate-url")
    p.add_argument("--tls-cert")
    p.add_argument("--tls-key")
    p.add_argument("--tls-ca")
    return p


def is_loopback(host: str) -> bool:
    """True for localhost and the loopback addresses. Anything else (0.0.0.0, a LAN address, a name) is reachable from the network."""
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def read_key_file(path: str, label: str) -> str:
    """The key in a file. On POSIX a file readable or writable by group or others is refused (like an ssh private key); Windows has no
    such mode bits, so the check is skipped there."""
    st = os.stat(path)
    if os.name != "nt" and st.st_mode & 0o077:
        raise ValueError(f"{label} file {path} has mode {st.st_mode & 0o777:03o}: it must be 0600 or stricter (chmod 600)")
    with open(path, encoding="utf-8") as f:
        return f.read().strip()


def _key(file: str | None, env: str, label: str) -> bytes:
    raw = read_key_file(file, label) if file else (os.environ.get(env) or "")
    if len(raw) < MIN_KEY_LENGTH:
        raise ValueError(f"{label} must be given (--{label.split()[0]}-file or the environment variable {env}) and be at least {MIN_KEY_LENGTH} characters")
    return raw.encode()


def fail_variant(template: dict) -> dict:
    """The test template `shop-fail-v0`: the example shop under another name, so the test backend can make its health fail."""
    t = copy.deepcopy(template)
    t["template_id"] = FAIL_TEMPLATE
    for c in t["components"]:
        c["labels"]["vm.template"] = FAIL_TEMPLATE
    return t


def build_engine(args: argparse.Namespace, on_transition: Callable | None) -> Orchestrator:
    templates = load_templates(args.templates_dir, args.template_schema)
    if not templates:
        raise ValueError(f"no template (*.json) found in {args.templates_dir}")
    common = dict(
        capacity_mb=args.capacity_mb, host_id=args.host_id, step_delay_s=args.step_delay_ms / 1000, on_transition=on_transition,
        tombstones=TombstoneStore(args.state_dir), reconcile_gate=True, edge_container=args.edge_container,
        gate=GatePort(args.gate_url, args.gate_admin_key_file) if args.gate_url else NullGate(),
    )
    if args.backend == "fake":
        if "shop-v0" in templates and FAIL_TEMPLATE not in templates:
            templates[FAIL_TEMPLATE] = fail_variant(templates["shop-v0"])
        return Orchestrator(
            ServiceFakeBackend(), templates, fake_allowlist(), health_timeout_s=args.health_timeout_s or 5.0,
            injector_timeout_s=args.injector_timeout_s or 5.0, poll_s=0.01, host_kind=args.host_kind or "fake", **common,
        )
    if not args.images_manifest:
        raise ValueError("--images-manifest is required with --backend docker")
    if not args.state_dir:
        log_line(event="no-state-dir", detail="destroyed instance ids are only kept in memory and are forgotten when the service restarts")
    from .backend import SdkBackend

    return Orchestrator(
        SdkBackend(base_url=args.docker_host), templates, ImageAllowlist.load(args.images_manifest, allow_local_ids=args.allow_local_images),
        health_timeout_s=args.health_timeout_s or 60.0, injector_timeout_s=args.injector_timeout_s or 30.0,
        host_kind=args.host_kind or "vm", **common,
    )


def tls_context(cert: str, key: str, ca: str) -> ssl.SSLContext:
    """Mutual TLS (D6): TLS 1.2 or higher, a client certificate is required and must be signed by `ca`."""
    for path in (cert, key, ca):
        if not os.path.isfile(path):
            raise ValueError(f"cannot read the TLS file {path}")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key)
    ctx.load_verify_locations(ca)
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def apply_env_fallbacks(args: argparse.Namespace, environ: Mapping[str, str] | None = None) -> argparse.Namespace:
    """`--report-url` and `--report-key-file` fall back to VM_ORCH_REPORT_URL and VM_ORCH_REPORT_KEY_FILE (a flag wins; an empty variable is
    unset). Compose cannot leave a flag out conditionally, so the container passes these two as environment entries that are empty by default
    (state reports are then off, as before). The key is still read from a file: the environment variable holds a path, never the key."""
    env = os.environ if environ is None else environ
    if not args.report_url:
        args.report_url = env.get("VM_ORCH_REPORT_URL") or None
    if not args.report_key_file:
        args.report_key_file = env.get("VM_ORCH_REPORT_KEY_FILE") or None
    return args


def main(argv: list[str] | None = None) -> int:
    args = apply_env_fallbacks(build_parser().parse_args(argv))
    try:
        tls = [args.tls_cert, args.tls_key, args.tls_ca]
        if any(tls) and not all(tls):
            raise ValueError("--tls-cert, --tls-key and --tls-ca must be given together")
        if not all(tls) and not is_loopback(args.host) and not args.insecure_no_tls:
            raise ValueError(f"refusing to listen on {args.host} without TLS: give --tls-cert, --tls-key and --tls-ca, or listen on 127.0.0.1 "
                             "(--insecure-no-tls is for tests and the local demo only)")
        if args.backend == "fake" and not args.allow_fake_backend:
            raise ValueError("--backend fake is a test backend: it needs --allow-fake-backend")
        if args.report_url:
            check_report_url(args.report_url)
        if bool(args.gate_url) != bool(args.gate_admin_key_file):
            raise ValueError("--gate-url and --gate-admin-key-file must be given together")
        platform_key = _key(args.key_file, "VM_ORCH_PLATFORM_KEY", "key (platform signing key)")
        pusher = None
        if args.report_url:
            pusher = ReportPusher(args.report_url, _key(args.report_key_file, "VM_ORCH_REPORT_KEY", "report-key (orchestrator signing key)"),
                                  timeout_s=args.report_timeout_ms / 1000)
        engine = build_engine(args, pusher.submit if pusher else None)
        ctx = tls_context(args.tls_cert, args.tls_key, args.tls_ca) if all(tls) else None
    except ssl.SSLError as e:
        print(f"vulnmart_orchestrator: the TLS files are not usable ({e.reason or 'SSLError'})", file=sys.stderr)
        return 2
    except OSError as e:
        print(f"vulnmart_orchestrator: cannot read {e.filename or 'a file'}: {e.strerror or type(e).__name__}", file=sys.stderr)
        return 2
    except ValueError as e:  # the text of our own checks; no key is ever in these messages
        print(f"vulnmart_orchestrator: {e}", file=sys.stderr)
        return 2
    service = Service(engine, Verifier(platform_key), RateLimiter(args.rate_per_s, args.rate_burst), fake_controls=args.backend == "fake")
    reaper = Reaper(engine)
    reconciler = ReconcileLoop(engine)
    if pusher:
        pusher.start()
    reconciler.first_pass()  # before the service answers; a failure leaves create and reset busy until a later pass works
    reconciler.start()
    reaper.start()
    try:
        asyncio.run(serve(service.app, args.host, args.port, ctx))
    except KeyboardInterrupt:
        pass
    finally:
        reaper.stop()
        reconciler.stop()
        if pusher:
            pusher.stop()
    return 0


class _AnnouncingServer(uvicorn.Server):
    """uvicorn's server that prints `{"listening":true,"port":N}` once the socket is bound (the test harness waits for the line)."""

    async def startup(self, sockets=None) -> None:
        await super().startup(sockets)
        if self.started and self.servers:
            print(json.dumps({"listening": True, "port": self.servers[0].sockets[0].getsockname()[1]}), flush=True)


async def serve(app: FastAPI, host: str, port: int, ssl_context: ssl.SSLContext | None) -> None:
    config = uvicorn.Config(
        app, host=host, port=port, access_log=False, log_level="warning", server_header=False, date_header=False, lifespan="off",
        timeout_keep_alive=5, limit_concurrency=MAX_CONCURRENCY,
        # uvicorn would build its own context from file names; ours (TLS 1.2 or higher, client certificate required) replaces it
        ssl_context_factory=(lambda _config, _default: ssl_context) if ssl_context is not None else None,
    )
    await _AnnouncingServer(config).serve()


def run() -> None:
    sys.exit(main())