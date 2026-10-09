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
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.http_instance_host import HttpInstanceHost, signed_headers
from vulnmart.ports.instance_host import (
    CreateRequest, DecoyEntry, DigestEntry, FlagEntry, FlagMaterial, InstanceHost, InstanceState, InstanceStatus,
    Limits, ResetRequest,
)

ROOT = Path(__file__).resolve().parents[3]
SERVER = ROOT / "contracts" / "mocks" / "fake-orchestrator" / "server.mjs"
CONTRACT_DIR = ROOT / "contracts" / "orchestrator"
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
                   tag: str = "A", owner_tag: str = "O", first_seq: int = 1) -> CreateRequest:
    iid = instance_id or new_id()
    return CreateRequest(
        instance_id=iid, template_id=template, epoch=epoch, material=material(tag),
        owner_hash=owner_hash(owner_tag), first_seq=first_seq,
        hostname=f"{iid.lower()}.instances.example.invalid",
        limits=Limits(memory_mb=memory_mb, cpu_limit=1.5, pids_limit=512, idle_minutes=30, max_minutes=120),
    )


def reset_request(epoch: int = 2, tag: str = "D", first_seq: int = 41) -> ResetRequest:
    return ResetRequest(epoch=epoch, material=material(tag), first_seq=first_seq)


def openssl_path() -> str | None:
    """The `openssl` command, or None when it is not installed."""
    return shutil.which("openssl")


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


class ServiceProcess:
    """The fake orchestrator as a separate Node process."""

    def __init__(self, *, capacity_mb: int = 8192, step_delay_ms: int = 0, report_url: str | None = None,
                 extra_args: tuple[str, ...] = (), tls: "Pki | None" = None) -> None:
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("node is required for the fake orchestrator tests")
        args = [node, str(SERVER), "--port", "0", "--capacity-mb", str(capacity_mb), "--step-delay-ms", str(step_delay_ms),
                "--key", PLATFORM_KEY.decode(), "--report-key", ORCH_KEY.decode()]
        if report_url:
            args += ["--report-url", report_url]
        if tls is not None:
            args += ["--tls-cert", str(tls.server_cert), "--tls-key", str(tls.server_key), "--tls-ca", str(tls.ca_cert)]
        if extra_args:
            args += list(extra_args)
        # stderr goes to a file, never to an undrained pipe (a full pipe would stall the service)
        self._stderr = tempfile.TemporaryFile(mode="w+", encoding="utf-8")
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=self._stderr, text=True)
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


@dataclass
class Harness:
    kind: str
    host: InstanceHost
    settle: Callable[[str, InstanceState], InstanceStatus]
    set_activity: Callable[[str, InstanceState], None]
    held: bool
    service: ServiceProcess | None = None


def make_harness(kind: str, *, capacity_mb: int = 8192, hold: bool = False) -> Harness:
    if kind == "fake":
        fake = FakeInstanceHost(capacity_memory_mb=capacity_mb, auto_advance=not hold)
        return Harness("fake", fake, lambda i, s: _poll(fake, i, s), fake.set_activity, hold)
    svc = ServiceProcess(capacity_mb=capacity_mb, step_delay_ms=600_000 if hold else 0)
    host = HttpInstanceHost(svc.url, PLATFORM_KEY)

    def activity(instance_id: str, state: InstanceState) -> None:
        status, data, _ = raw_call(svc.url, "POST", f"/_fake/v1/instances/{instance_id}/activity",
                                   json.dumps({"state": state.value}).encode(), sign=False)
        assert status == 200, data

    return Harness("http", host, lambda i, s: _poll(host, i, s), activity, hold, svc)


def _poll(host: InstanceHost, instance_id: str, state: InstanceState, timeout: float = 10.0) -> InstanceStatus:
    deadline = time.monotonic() + timeout
    while True:
        st = host.get(instance_id)
        if st.state is state:
            return st
        if time.monotonic() > deadline:
            raise AssertionError(f"{instance_id} did not reach {state.value}, last state {st.state.value}")
        time.sleep(0.005)
