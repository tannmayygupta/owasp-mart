"""Story edge-7: the report URL and the report key file may come from the environment (compose passes them as empty-by-default
variables), and the pusher trusts a private CA through the standard `SSL_CERT_FILE` variable (no extra option is needed)."""
import argparse
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from support import ROOT, TEMPLATE_FILE, TEMPLATE_SCHEMA

from vulnmart_orchestrator.reports import http_post
from vulnmart_orchestrator.service import apply_env_fallbacks, build_parser

SRC = ROOT / "apps" / "orchestrator" / "src"
KEY = "FAKE-SIGNING-KEY-NOT-REAL-0000000000"


def parsed(*argv: str) -> argparse.Namespace:
    return build_parser().parse_args(["--templates-dir", "t", "--template-schema", "s", *argv])


def test_the_flags_alone_are_unchanged_and_nothing_set_means_reports_off():
    args = apply_env_fallbacks(parsed(), {})
    assert args.report_url is None and args.report_key_file is None


def test_the_environment_fills_a_missing_flag():
    env = {"VM_ORCH_REPORT_URL": "https://vm-p.example.invalid:8444", "VM_ORCH_REPORT_KEY_FILE": "/run/secrets/report_key"}
    args = apply_env_fallbacks(parsed(), env)
    assert (args.report_url, args.report_key_file) == ("https://vm-p.example.invalid:8444", "/run/secrets/report_key")


def test_a_flag_wins_over_the_environment():
    env = {"VM_ORCH_REPORT_URL": "https://env.example.invalid", "VM_ORCH_REPORT_KEY_FILE": "/env/key"}
    args = apply_env_fallbacks(parsed("--report-url", "https://flag.example.invalid", "--report-key-file", "/flag/key"), env)
    assert (args.report_url, args.report_key_file) == ("https://flag.example.invalid", "/flag/key")


def test_an_empty_variable_is_unset():
    """The compose default `${VULNMART_ORCH_REPORT_URL:-}` is an empty string: reports stay off."""
    args = apply_env_fallbacks(parsed(), {"VM_ORCH_REPORT_URL": "", "VM_ORCH_REPORT_KEY_FILE": ""})
    assert args.report_url is None and args.report_key_file is None


def _run(env_extra: dict[str, str]) -> subprocess.CompletedProcess:
    templates = Path(tempfile.mkdtemp(prefix="vm-env-templates-"))
    shutil.copy(TEMPLATE_FILE, templates / "shop-template.json")
    try:
        env = {k: v for k, v in os.environ.items() if not k.startswith("VM_ORCH_")}
        env.update({"PYTHONPATH": str(SRC), "VM_ORCH_PLATFORM_KEY": KEY, **env_extra})
        return subprocess.run(
            [sys.executable, "-m", "vulnmart_orchestrator", "--backend", "fake", "--allow-fake-backend", "--port", "0",
             "--templates-dir", str(templates), "--template-schema", str(TEMPLATE_SCHEMA)],
            capture_output=True, text=True, timeout=60, env=env)
    finally:
        shutil.rmtree(templates, ignore_errors=True)


def test_the_process_checks_the_url_from_the_environment():
    res = _run({"VM_ORCH_REPORT_URL": "http://platform.example.invalid"})
    assert res.returncode == 2 and "https" in res.stderr and res.stdout == ""


def test_the_process_wants_a_key_when_the_url_comes_from_the_environment():
    res = _run({"VM_ORCH_REPORT_URL": "http://127.0.0.1:1"})
    assert res.returncode == 2 and "report-key" in res.stderr and res.stdout == ""


def test_the_process_refuses_a_missing_key_file_from_the_environment():
    res = _run({"VM_ORCH_REPORT_URL": "http://127.0.0.1:1", "VM_ORCH_REPORT_KEY_FILE": "no-such-key-file"})
    assert res.returncode == 2 and "no-such-key-file" in res.stderr and res.stdout == ""


# ---- trusting a private CA: the pusher uses urllib's default context, which honours SSL_CERT_FILE ----
def _openssl() -> str | None:
    return shutil.which("openssl")


@pytest.fixture
def tls_server():
    exe = _openssl()
    if exe is None:
        pytest.skip("openssl is not installed")
    d = Path(tempfile.mkdtemp(prefix="vm-ca-"))
    conf = d / "openssl.cnf"
    conf.write_text("[req]\ndistinguished_name = dn\n[dn]\n", encoding="utf-8")
    env = {**os.environ, "OPENSSL_CONF": str(conf)}

    def run(*a: str) -> None:
        r = subprocess.run([exe, *a], cwd=d, env=env, capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr

    ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"]
    run("req", "-x509", *ec, "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=test CA",
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    run("req", "-new", *ec, "-keyout", "s.key", "-out", "s.csr", "-subj", "/CN=server")
    (d / "s.ext").write_text("basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n", encoding="utf-8")
    run("x509", "-req", "-in", "s.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "s.pem", "-days", "1", "-extfile", "s.ext")

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(d / "s.pem"), str(d / "s.key"))
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"https://127.0.0.1:{server.server_port}/internal/v1/orch/state", d / "ca.pem"
    server.shutdown()
    server.server_close()
    shutil.rmtree(d, ignore_errors=True)


def test_the_pusher_refuses_a_private_ca_it_was_not_told_about(tls_server, monkeypatch):
    url, _ = tls_server
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    with pytest.raises(urllib.error.URLError):
        http_post(url, b"{}", {"Content-Type": "application/json"}, 5)


def test_ssl_cert_file_makes_the_pusher_trust_the_private_ca(tls_server, monkeypatch):
    url, ca = tls_server
    monkeypatch.setenv("SSL_CERT_FILE", str(ca))
    assert http_post(url, b"{}", {"Content-Type": "application/json"}, 5) == 204
