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
platform through `ReportPusher`. The reset call is a marked placeholder until story 3.4: it validates and answers 501. No answer
and no log line holds a secret, an exception message or a stack trace.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import copy
import json
import os
import re
import ssl
import sys
import threading
import time
import urllib.parse
from collections.abc import Callable

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import Response
from starlette.routing import request_response

from .auth import MIN_KEY_LENGTH, Verifier, body_sha256
from .backend import FAIL_TEMPLATE, BackendError, ServiceFakeBackend
from .builder import INSTANCE_ID, TemplateInvalid, parse_access, parse_create, parse_reset
from .capacity import DEFAULT_CAPACITY_MB
from .engine import Orchestrator
from .images import ImageAllowlist, ImageNotAllowed, fake_allowlist
from .jsonstrict import JsonStrictError, loads_strict
from .problems import (
    INTERNAL, MEDIA_TYPE, NOT_IMPLEMENTED, RETRY_AFTER_BUSY, ROUTE_UNKNOWN, ProblemError, new_request_id, problem_body,
)
from .ratelimit import BURST, RATE_PER_SECOND, RateLimiter
from .reports import ReportPusher, check_report_url
from .states import (
    Busy, CursorInvalid, EngineError, FieldForbidden, InvalidState, LabelUnknown, StaleEpoch, ValidationFailed,
)
from .templates import load_templates

MAX_BODY = 64 * 1024
JSON_TYPE = re.compile(r"application/json\s*(;.*)?", re.IGNORECASE)
LABELS = ("instance", "epoch", "component", "template", "kind")
CURSOR = re.compile(r"[A-Za-z0-9_-]{24}")  # base64url, no padding, of an 18-character instance id
LIMIT = re.compile(r"[1-9][0-9]{0,2}")
EPOCH = re.compile(r"[1-9][0-9]*")
PLACEHOLDER_RESET = "reset is not built yet (story 3.4); nothing was changed"

# (path pattern, methods in the order the Allow header lists them, route name)
ROUTES: list[tuple[re.Pattern[str], tuple[str, ...], str]] = [
    (re.compile(r"/v1/instances"), ("GET", "POST"), "collection"),
    (re.compile(r"/v1/host"), ("GET",), "host"),
    (re.compile(r"/v1/instances/([^/]+)"), ("GET",), "get"),
    (re.compile(r"/v1/instances/([^/]+)/(reset|access|destroy)"), ("POST",), "action"),
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
        raise ValidationFailed("bad instance id", field="/instance_id")
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
    ) -> None:
        self.engine, self.verifier, self.limiter, self._spawn = engine, verifier, limiter, spawn_work
        self.app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)  # no unauthenticated page about the API
        # An object with `__call__`, not a function: Starlette gives a function route only the GET method, an ASGI object all methods.
        # So an odd method is refused in the contract's order (after the signature) and as a problem body, not by the router.
        self.app.add_route("/{path:path}", _AllMethods(request_response(self._endpoint)), include_in_schema=False)

    # ------------------------------------------------------------ one request

    async def _endpoint(self, request: Request) -> Response:
        request_id = new_request_id()
        route = "unknown"
        try:
            status, body, headers, route = await self._handle(request, request_id)
        except Exception as e:
            p = _problem_of(e)
            status, body, _ = problem_body(p.code, p.detail, p.field, request_id)
            headers = {"Content-Type": MEDIA_TYPE, **p.headers}
            if p.code == "ORCH-BODY-TOO-LARGE":
                headers["Connection"] = "close"  # the rest of the body is not read: drop the connection
        log_line(event="request", request_id=request_id, method=request.method[:16], route=route, status=status)
        return Response(content=body, status_code=status, headers={"Cache-Control": "no-store", **headers})

    async def _handle(self, request: Request, request_id: str) -> tuple[int, bytes, dict[str, str], str]:
        # 1. body size: not read further, not hashed
        declared = request.headers.get("content-length")
        if declared is not None and declared.isascii() and declared.isdigit() and int(declared) > MAX_BODY:
            raise ProblemError("ORCH-BODY-TOO-LARGE", f"the body is larger than {MAX_BODY} bytes")
        chunks: list[bytes] = []
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BODY:
                raise ProblemError("ORCH-BODY-TOO-LARGE", f"the body is larger than {MAX_BODY} bytes")
            chunks.append(chunk)
        buf = b"".join(chunks)

        # 2. signature (the request target as sent: path plus query string)
        raw_path = request.scope.get("raw_path") or request.scope["path"].encode()
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
            self._spawn(accepted.work, "create")
        return (202 if accepted.changed else 200), accepted.view

    def _access(self, instance_id: str, buf: bytes) -> tuple[int, dict]:
        access, epoch = parse_access(_loads(buf))
        return 200, self.engine.set_access(instance_id, access, epoch)

    def _destroy(self, instance_id: str, buf: bytes) -> tuple[int, dict]:
        accepted = self.engine.accept_destroy(instance_id)
        if accepted.work is not None:
            self._spawn(destroy_worker(accepted.work), "destroy")
        return (202 if accepted.changed else 200), accepted.view

    def _reset(self, instance_id: str, buf: bytes) -> tuple[int, dict]:
        # PLACEHOLDER (story 3.4): the body is checked like the real call, then nothing happens.
        spec = parse_reset(_loads(buf))
        current = self.engine.view(instance_id)  # 404 for an unknown instance
        if current["state"] not in ("ready", "active", "idle"):
            raise InvalidState(f"reset is not allowed in state {current['state']}")
        if spec.epoch != current["epoch"] + 1:
            raise StaleEpoch("the new epoch must be the current epoch plus one")
        raise ProblemError(NOT_IMPLEMENTED, PLACEHOLDER_RESET)

    def _list(self, query: bytes) -> tuple[int, dict]:
        pairs = urllib.parse.parse_qsl(query.decode("latin-1"), keep_blank_values=True)
        names = [k for k, _ in pairs]
        for name in names:
            if name not in LABELS and name not in ("cursor", "limit"):
                raise LabelUnknown(f"{name[:64]} is not a label filter", field=name[:64])
        for name in dict.fromkeys(names):
            if names.count(name) > 1:
                raise ValidationFailed(f"{name[:64]} is given more than once", field=name[:64])
        q = dict(pairs)
        limit = 100
        if "limit" in q:
            if not LIMIT.fullmatch(q["limit"]) or int(q["limit"]) > 500:
                raise ValidationFailed("limit is 1 to 500", field="limit")
            limit = int(q["limit"])
        if "epoch" in q and not EPOCH.fullmatch(q["epoch"]):
            raise ValidationFailed("epoch is a positive integer", field="epoch")
        if "instance" in q and not INSTANCE_ID.fullmatch(q["instance"]):
            raise ValidationFailed("bad instance id", field="instance")
        after = None
        if "cursor" in q:
            after = _decode_cursor(q["cursor"])
            if after is None:
                raise CursorInvalid("the cursor is not one this orchestrator handed out", field="cursor")
        items, last = self.engine.list_views(
            instance=q.get("instance"), epoch=int(q["epoch"]) if "epoch" in q else None, template=q.get("template"),
            component=q.get("component"), kind=q.get("kind"), after=after, limit=limit,
        )
        return 200, {"items": items, "next_cursor": _encode_cursor(last) if last else None}


# ---------------------------------------------------------------- command line

class _Parser(argparse.ArgumentParser):
    def error(self, message: str):  # exit code 2, like the Node fake
        self.exit(2, f"{self.prog}: {message}\n")


def build_parser() -> argparse.ArgumentParser:
    p = _Parser(prog="vulnmart_orchestrator", description="VulnMart orchestrator service (IF-5)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8443)
    p.add_argument("--key", help="platform signing key (or VM_ORCH_PLATFORM_KEY)")
    p.add_argument("--report-key", help="orchestrator signing key for state reports (or VM_ORCH_REPORT_KEY)")
    p.add_argument("--report-url", help="platform base URL for state reports")
    p.add_argument("--report-timeout-ms", type=int, default=5000)
    p.add_argument("--capacity-mb", type=int, default=DEFAULT_CAPACITY_MB)
    p.add_argument("--step-delay-ms", type=int, default=0, help="test aid: pause before each step of a create and of a destroy")
    p.add_argument("--host-id", default="orch-host-1")
    p.add_argument("--host-kind", choices=("vm", "laptop", "fake"), default=None)
    p.add_argument("--backend", choices=("docker", "fake"), default="docker")
    p.add_argument("--docker-host", help="Docker API URL (default: the environment)")
    p.add_argument("--templates-dir", required=True)
    p.add_argument("--template-schema", required=True)
    p.add_argument("--images-manifest", help="release manifest (required with --backend docker)")
    p.add_argument("--health-timeout-s", type=float, default=None)
    p.add_argument("--injector-timeout-s", type=float, default=None)
    p.add_argument("--rate-per-s", type=float, default=RATE_PER_SECOND, help="requests per second per client; 0 switches the limit off")
    p.add_argument("--rate-burst", type=float, default=BURST)
    p.add_argument("--tls-cert")
    p.add_argument("--tls-key")
    p.add_argument("--tls-ca")
    return p


def _key(value: str | None, env: str, label: str) -> bytes:
    raw = value or os.environ.get(env) or ""
    if len(raw) < MIN_KEY_LENGTH:
        raise ValueError(f"{label} must be given (--{label.split()[0]} or {env}) and be at least {MIN_KEY_LENGTH} characters")
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
    from .backend import SdkBackend

    return Orchestrator(
        SdkBackend(base_url=args.docker_host), templates, ImageAllowlist.load(args.images_manifest),
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


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        tls = [args.tls_cert, args.tls_key, args.tls_ca]
        if any(tls) and not all(tls):
            raise ValueError("--tls-cert, --tls-key and --tls-ca must be given together")
        if args.report_url:
            check_report_url(args.report_url)
        platform_key = _key(args.key, "VM_ORCH_PLATFORM_KEY", "key (platform signing key)")
        pusher = None
        if args.report_url:
            pusher = ReportPusher(args.report_url, _key(args.report_key, "VM_ORCH_REPORT_KEY", "report-key (orchestrator signing key)"),
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
    service = Service(engine, Verifier(platform_key), RateLimiter(args.rate_per_s, args.rate_burst))
    if pusher:
        pusher.start()
    try:
        asyncio.run(serve(service.app, args.host, args.port, ctx))
    except KeyboardInterrupt:
        pass
    finally:
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
        timeout_keep_alive=5,
        # uvicorn would build its own context from file names; ours (TLS 1.2 or higher, client certificate required) replaces it
        ssl_context_factory=(lambda _config, _default: ssl_context) if ssl_context is not None else None,
    )
    await _AnnouncingServer(config).serve()


def run() -> None:
    sys.exit(main())