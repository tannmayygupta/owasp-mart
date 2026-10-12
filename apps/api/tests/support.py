"""Test helpers: request builders, the fake orchestrator process, a raw signed HTTP caller, harnesses."""
from __future__ import annotations

import base64
import hashlib
import itertools
import json
import os
import queue
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.http_instance_host import (
    HttpInstanceHost, NonceCache, parse_state_report, signed_headers, verify_request,
)
from vulnmart.ports.instance_host import (
    BadSignature, CreateRequest, DecoyEntry, DigestEntry, FlagEntry, FlagMaterial, InstanceHost, InstanceState,
    InstanceStatus, Limits, ReportIngest, RequestMismatch, ResetRequest, StateReport, ValidationFailed,
)

ROOT = Path(__file__).resolve().parents[3]
SERVER = ROOT / "contracts" / "mocks" / "fake-orchestrator" / "server.mjs"
CONTRACT_DIR = ROOT / "contracts" / "orchestrator"
# Which service the HTTP side of the suites talks to: the Node fake of the contract (default) or the Python service of story 3.2
# (`VM_ORCH_SERVICE=python`, started with `--backend fake`). The reset and activity cases are skipped for the Python service until
# story 3.4 (see conftest.py).
SERVICE_KIND = os.environ.get("VM_ORCH_SERVICE", "node").strip().lower()
PYTHON_SERVICE = SERVICE_KIND == "python"
ORCH_SRC = ROOT / "apps" / "orchestrator" / "src"
TEMPLATE_SCHEMA = ROOT / "contracts" / "instance" / "instance-template.schema.json"
SHOP_TEMPLATE = ROOT / "contracts" / "instance" / "examples" / "valid" / "instance-template" / "shop-template.json"
PLATFORM_KEY = b"FAKE-SIGNING-KEY-NOT-REAL-0000000000"
ORCH_KEY = b"FAKE-ORCHESTRATOR-KEY-NOT-REAL-0000000"
WRONG_KEY = b"FAKE-WRONG-KEY-NOT-REAL-0000000000000"

START_TIMEOUT_SECONDS = 15

_counter = itertools.count(1)


def new_id() -> str:
    """A unique, valid instance id (i- plus 16 Base32 characters)."""
    return "i-" + base64.b32encode(next(_counter).to_bytes(10, "big")).decode()


def b32(ch: str) -> str:
    return ch * 24


def material(tag: str = "A") -> FlagMaterial:
    """Fake secrets, distinct per tag. Tag is one Base32 letter (A to Z, 2 to 7)."""
    return FlagMaterial(
        flags=(FlagEntry("C01", f"VM{{{b32(tag)}}}"),),
        decoys=(DecoyEntry("C01", 0, f"VM{{{b32('B' if tag != 'B' else 'C')}}}"),),
        flag_digests=(DigestEntry("C01", ("%02x" % (ord(tag) % 256)) * 32),),
        event_key=f"FAKE-EVENT-KEY-{tag}-" + "0" * 24,
        seed=f"FAKE-SEED-{tag}-" + "0" * 24,
    )


def owner_hash(tag: str = "A") -> str:
    """A fake opaque owner hash (64 lowercase hex characters), distinct per tag."""
    return hashlib.sha256(b"FAKE-OWNER-NOT-REAL-" + tag.encode()).hexdigest()


def create_request(instance_id: str | None = None, *, epoch: int = 1, template: str = "shop-v0", memory_mb: int = 256,
                   tag: str = "A", owner_tag: str = "O") -> CreateRequest:
    iid = instance_id or new_id()
    return CreateRequest(
        instance_id=iid, template_id=template, epoch=epoch, material=material(tag),
        owner_hash=owner_hash(owner_tag),
        hostname=f"{iid.lower()}.instances.example.invalid",
        limits=Limits(memory_mb=memory_mb, cpu_limit=1.5, pids_limit=512, idle_minutes=30, max_minutes=120),
    )


def reset_request(epoch: int = 2, tag: str = "D") -> ResetRequest:
    return ResetRequest(epoch=epoch, material=material(tag))


def openssl_path() -> str | None:
    """The `openssl` command, or None when it is not installed."""
    return shutil.which("openssl")


def flag_on(value: str | None) -> bool:
    """The rule for environment switches (twin of `flagOn` in scripts/env-flag.mjs): on only for `true` or `1`, any case.
    `false`, `0`, empty and unset are off."""
    return (value or "").strip().lower() in ("true", "1")


def require_openssl(env=None) -> str:
    """The `openssl` path. When it is missing: fail the test if CI is on (`true` or `1`), skip it otherwise."""
    import pytest

    exe = openssl_path()
    if exe is not None:
        return exe
    message = "openssl is not installed, the mTLS tests cannot make certificates"
    if flag_on((os.environ if env is None else env).get("CI")):
        pytest.fail(message)
    pytest.skip(message)


class Pki:
    """Throwaway certificates for mutual TLS tests, made with the `openssl` command in a temporary folder.

    One CA signs the server certificate (name `localhost` only) and a client certificate (`clientAuth`); a second CA
    signs a client certificate that the server must refuse. Everything is deleted by `close()`; nothing is committed.
    """

    def __init__(self) -> None:
        exe = openssl_path()
        if exe is None:
            raise RuntimeError("openssl is not installed")
        self._exe = exe
        self.dir = Path(tempfile.mkdtemp(prefix="vm-mtls-"))
        try:
            self.ca_cert, ca_key = self._ca("ca", "Test CA one")
            self._ca_key = ca_key
            self.other_ca_cert, other_key = self._ca("other-ca", "Test CA two")
            self.server_cert, self.server_key = self._leaf("server", "localhost", self.ca_cert, ca_key,
                                                           "serverAuth", "subjectAltName=DNS:localhost")
            self.client_cert, self.client_key = self._leaf("client", "test-client", self.ca_cert, ca_key,
                                                           "clientAuth", None)
            self.other_client_cert, self.other_client_key = self._leaf("other-client", "other-client",
                                                                      self.other_ca_cert, other_key, "clientAuth", None)
        except BaseException:
            self.close()
            raise

    def _run(self, *args: str) -> None:
        # a minimal config keeps the Windows build of openssl from looking for a config file of its own
        env = {**os.environ, "OPENSSL_CONF": str(self._conf())}
        res = subprocess.run([self._exe, *args], cwd=self.dir, env=env, capture_output=True, text=True, timeout=60)
        if res.returncode != 0:
            raise RuntimeError(f"openssl {args[0]} failed: {res.stderr.strip()}")

    def _conf(self) -> Path:
        conf = self.dir / "openssl.cnf"
        if not conf.exists():
            conf.write_text("[req]\ndistinguished_name = dn\n[dn]\n", encoding="utf-8")
        return conf

    def _ca(self, name: str, cn: str) -> tuple[Path, Path]:
        key, cert = self.dir / f"{name}.key", self.dir / f"{name}.pem"
        self._run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                  "-keyout", key.name, "-out", cert.name, "-days", "1", "-subj", f"/CN={cn}",
                  "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        return cert, key

    def _leaf(self, name: str, cn: str, ca_cert: Path, ca_key: Path, usage: str, san: str | None) -> tuple[Path, Path]:
        key, csr, cert, ext = (self.dir / f"{name}.key", self.dir / f"{name}.csr", self.dir / f"{name}.pem",
                               self.dir / f"{name}.ext")
        self._run("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                  "-keyout", key.name, "-out", csr.name, "-subj", f"/CN={cn}")
        lines = ["basicConstraints=CA:FALSE", "keyUsage=digitalSignature", f"extendedKeyUsage={usage}"]
        if san:
            lines.append(san)
        ext.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self._run("x509", "-req", "-in", csr.name, "-CA", ca_cert.name, "-CAkey", ca_key.name, "-CAcreateserial",
                  "-out", cert.name, "-days", "1", "-extfile", ext.name)
        return cert, key

    def issue(self, name: str, cn: str, usage: str, san: str | None, *, valid: tuple[str, str] | None = None) -> tuple[Path, Path]:
        """A certificate signed by the main test CA. `valid` is (start, end) as YYMMDDHHMMSSZ, for an expired or not-yet-valid one;
        it is made with `openssl ca` (the plain `x509 -req` command cannot set the start date before OpenSSL 3.4)."""
        if valid is None:
            return self._leaf(name, cn, self.ca_cert, self._ca_key, usage, san)
        key, csr, cert, ext = (self.dir / f"{name}.key", self.dir / f"{name}.csr", self.dir / f"{name}.pem", self.dir / f"{name}.ext")
        self._run("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                  "-keyout", key.name, "-out", csr.name, "-subj", f"/CN={cn}")
        lines = ["basicConstraints=CA:FALSE", "keyUsage=digitalSignature", f"extendedKeyUsage={usage}"]
        if san:
            lines.append(san)
        ext.write_text("\n".join(lines) + "\n", encoding="utf-8")
        for fname, content in (("index.txt", ""), ("serial", "1000\n")):
            if not (self.dir / fname).exists():
                (self.dir / fname).write_text(content, encoding="utf-8")
        (self.dir / "ca.cnf").write_text("[ca]\ndefault_ca = c\n[c]\ndatabase = index.txt\nnew_certs_dir = .\nserial = serial\n"
                                         "default_md = sha256\npolicy = p\nunique_subject = no\n[p]\ncommonName = supplied\n", encoding="utf-8")
        self._run("ca", "-batch", "-config", "ca.cnf", "-cert", self.ca_cert.name, "-keyfile", self._ca_key.name, "-in", csr.name,
                  "-out", cert.name, "-startdate", valid[0], "-enddate", valid[1], "-extfile", ext.name, "-notext")
        return cert, key

    def client_context(self, *, trust: Path | None = None, cert: tuple[Path, Path] | None = ...,
                       check_hostname: bool = True) -> ssl.SSLContext:
        """A client TLS context. By default it trusts the test CA and presents the good client certificate;
        pass `cert=None` to present none, or `trust` to trust another CA file."""
        ctx = ssl.create_default_context(cafile=str(trust or self.ca_cert))
        ctx.check_hostname = check_hostname
        if cert is ...:
            cert = (self.client_cert, self.client_key)
        if cert is not None:
            ctx.load_cert_chain(str(cert[0]), str(cert[1]))
        return ctx

    def untrusting_context(self) -> ssl.SSLContext:
        """Presents the good client certificate but trusts only the other CA, so the server certificate is refused."""
        return self.client_context(trust=self.other_ca_cert)

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


_templates_dir: Path | None = None


def python_templates_dir() -> Path:
    """A folder with the one example template (the Python service loads every *.json of a folder, and the examples folder holds two)."""
    global _templates_dir
    if _templates_dir is None or not _templates_dir.exists():
        _templates_dir = Path(tempfile.mkdtemp(prefix="vm-templates-"))
        shutil.copy(SHOP_TEMPLATE, _templates_dir / "shop-template.json")
    return _templates_dir


class ServiceProcess:
    """The orchestrator service as a separate process: the Node fake, or the Python service when `VM_ORCH_SERVICE=python`."""

    def __init__(self, *, capacity_mb: int = 8192, step_delay_ms: int = 0, report_url: str | None = None,
                 extra_args: tuple[str, ...] = (), tls: "Pki | None" = None,
                 tls_server: tuple[Path, Path] | None = None) -> None:
        env = None
        if PYTHON_SERVICE:
            # the rate limit is off: a test polls far faster than the 20 requests per second a platform client is allowed
            args = [sys.executable, "-m", "vulnmart_orchestrator", "--backend", "fake", "--port", "0", "--capacity-mb", str(capacity_mb),
                    "--step-delay-ms", str(step_delay_ms), "--key", PLATFORM_KEY.decode(), "--report-key", ORCH_KEY.decode(),
                    "--templates-dir", str(python_templates_dir()), "--template-schema", str(TEMPLATE_SCHEMA), "--rate-per-s", "0"]
            env = {**os.environ, "PYTHONPATH": str(ORCH_SRC)}
        else:
            node = shutil.which("node")
            if node is None:
                raise RuntimeError("node is required for the fake orchestrator tests")
            args = [node, str(SERVER), "--port", "0", "--capacity-mb", str(capacity_mb), "--step-delay-ms", str(step_delay_ms),
                    "--key", PLATFORM_KEY.decode(), "--report-key", ORCH_KEY.decode()]
        if report_url:
            args += ["--report-url", report_url]
        if tls is not None:
            cert, key = tls_server or (tls.server_cert, tls.server_key)  # tls_server: another server certificate, for the refusal tests
            args += ["--tls-cert", str(cert), "--tls-key", str(key), "--tls-ca", str(tls.ca_cert)]
        if extra_args:
            args += list(extra_args)
        # stderr goes to a file, never to an undrained pipe (a full pipe would stall the service)
        self._stderr = tempfile.TemporaryFile(mode="w+", encoding="utf-8")
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=self._stderr, text=True, env=env)
        lines: queue.Queue[str] = queue.Queue()
        threading.Thread(target=lambda: lines.put(self.proc.stdout.readline()), daemon=True).start()
        try:
            line = lines.get(timeout=START_TIMEOUT_SECONDS)
        except queue.Empty:
            self.stop()
            raise RuntimeError(f"the fake orchestrator printed no port within {START_TIMEOUT_SECONDS} s") from None
        if not line:
            self.stop()
            raise RuntimeError("the fake orchestrator did not start: " + self.stderr_text())
        self.port = json.loads(line)["port"]
        # with TLS the server certificate names only "localhost", so the URL uses that name
        self.url = f"https://localhost:{self.port}" if tls is not None else f"http://127.0.0.1:{self.port}"

    def stderr_text(self) -> str:
        self._stderr.flush()
        self._stderr.seek(0)
        return self._stderr.read()

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        if self.proc.stdout:
            self.proc.stdout.close()


def raw_call(url: str, method: str, target: str, body: bytes | None = None, *, key: bytes = PLATFORM_KEY,
             headers: dict[str, str] | None = None, sign: bool = True) -> tuple[int, bytes, dict[str, str]]:
    """A signed request by hand, for the cases the client cannot produce. `headers` override the signed ones."""
    payload = body if body is not None else b""
    hdrs: dict[str, str] = {}
    if sign:
        hdrs.update(signed_headers(key, method, target, payload))
    if body is not None:
        hdrs["Content-Type"] = "application/json"
    hdrs.update(headers or {})
    req = urllib.request.Request(url + target, data=body, method=method, headers=hdrs)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=10) as resp:
            return resp.status, resp.read(), {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as err:
        data = err.read()
        hdr = {k.lower(): v for k, v in err.headers.items()}
        err.close()
        return err.code, data, hdr


class ReportReceiver:
    """A stand-in for the platform API: checks the signature of every state report (orchestrator key), parses it strictly,
    feeds it to a `ReportIngest` and answers 204 (new), 200 (identical repeat), 409 (same identity, other body) or 422.
    `reports` holds the parsed new reports in arrival order (a repeat is not added again), `bodies` the raw bytes."""

    def __init__(self) -> None:
        self.reports: list[StateReport] = []
        self.bodies: list[bytes] = []
        self.refused = 0
        self.ingest = ReportIngest()
        nonces = NonceCache()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self, status: int, body: bytes = b"", ctype: str = "application/problem+json") -> None:
                self.send_response(status)
                if body:
                    self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):  # noqa: N802
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                try:
                    verify_request(ORCH_KEY, "POST", self.path, dict(self.headers), body, nonces=nonces)
                except BadSignature:
                    outer.refused += 1
                    return self._answer(401)
                try:
                    report = parse_state_report(body)
                    new = outer.ingest.accept(report)
                except RequestMismatch:
                    return self._answer(409, b"{}")
                except ValidationFailed:
                    return self._answer(422, b"{}")
                if new:  # an identical repeat is answered 200 and kept once
                    outer.bodies.append(body)
                    outer.reports.append(report)
                self._answer(204 if new else 200)

            def log_message(self, *a):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@dataclass
class Harness:
    kind: str
    host: InstanceHost
    settle: Callable[[str, InstanceState], InstanceStatus]
    set_activity: Callable[[str, InstanceState], None]
    held: bool
    service: ServiceProcess | None = None
    # the state reports the orchestrator side produced so far (the fake: its own list; HTTP: what the platform stand-in received)
    reports: Callable[[], list[StateReport]] = field(default=lambda: [])
    receiver: ReportReceiver | None = None


def make_harness(kind: str, *, capacity_mb: int = 8192, hold: bool = False, now: Callable | None = None) -> Harness:
    if kind == "fake":
        kw = {"now": now} if now is not None else {}
        fake = FakeInstanceHost(capacity_memory_mb=capacity_mb, auto_advance=not hold, **kw)
        return Harness("fake", fake, lambda i, s: _poll(fake, i, s), fake.set_activity, hold, reports=lambda: list(fake.reports))
    rx = ReportReceiver()
    svc = ServiceProcess(capacity_mb=capacity_mb, step_delay_ms=600_000 if hold else 0, report_url=rx.url)
    host = HttpInstanceHost(svc.url, PLATFORM_KEY)

    def activity(instance_id: str, state: InstanceState) -> None:
        status, data, _ = raw_call(svc.url, "POST", f"/_fake/v1/instances/{instance_id}/activity",
                                   json.dumps({"state": state.value}).encode(), sign=False)
        assert status == 200, data

    return Harness("http", host, lambda i, s: _poll(host, i, s), activity, hold, svc, reports=lambda: list(rx.reports), receiver=rx)


def _poll(host: InstanceHost, instance_id: str, state: InstanceState, timeout: float = 10.0) -> InstanceStatus:
    deadline = time.monotonic() + timeout
    while True:
        st = host.get(instance_id)
        if st.state is state:
            return st
        if time.monotonic() > deadline:
            raise AssertionError(f"{instance_id} did not reach {state.value}, last state {st.state.value}")
        time.sleep(0.005)
