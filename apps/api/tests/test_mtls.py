"""Mutual TLS between HttpInstanceHost and the fake orchestrator started with --tls-cert, --tls-key and --tls-ca.

Certificates are made at test time with the `openssl` command in a temporary folder that is deleted afterwards.
mTLS stays outside the OpenAPI contract; these tests prove that the client transport behaves as the contract
section 4 expects: the signing rule still applies on top, and every refused handshake is `OrchestratorUnavailable`.
Without `openssl` the tests skip locally and fail when the `CI` variable is `true` or `1` (support.require_openssl).
"""
from __future__ import annotations

import shutil
import ssl
import subprocess

import pytest

import support
from support import PLATFORM_KEY, SERVER, WRONG_KEY, Pki, ServiceProcess, create_request, require_openssl, reset_request
from support import _poll
from vulnmart.ports.http_instance_host import HttpInstanceHost
from vulnmart.ports.instance_host import BadSignature, InstanceNotFound, InstanceState, OrchestratorUnavailable


@pytest.fixture(scope="module")
def pki():
    require_openssl()
    p = Pki()
    yield p
    p.close()


@pytest.fixture(scope="module")
def tls_svc(pki):
    s = ServiceProcess(tls=pki)
    yield s
    s.stop()


def good(pki, tls_svc, **kw) -> HttpInstanceHost:
    return HttpInstanceHost(tls_svc.url, PLATFORM_KEY, ssl_context=pki.client_context(**kw))


def assert_nothing_created(pki, tls_svc, instance_id: str) -> None:
    """The fake recorded no change: a correct client finds no such instance."""
    with pytest.raises(InstanceNotFound):
        good(pki, tls_svc).get(instance_id)


def test_the_full_lifecycle_works_over_mtls(pki, tls_svc):
    host = good(pki, tls_svc)
    req = create_request()
    host.create(req)
    assert host.get(req.instance_id).epoch == 1
    _poll(host, req.instance_id, InstanceState.READY)
    host.reset(req.instance_id, reset_request())
    assert _poll(host, req.instance_id, InstanceState.READY).epoch == 2
    host.destroy(req.instance_id)
    _poll(host, req.instance_id, InstanceState.DESTROYED)


def test_no_client_certificate_is_refused(pki, tls_svc):
    req = create_request()
    host = HttpInstanceHost(tls_svc.url, PLATFORM_KEY, ssl_context=pki.client_context(cert=None))
    with pytest.raises(OrchestratorUnavailable):
        host.create(req)
    assert_nothing_created(pki, tls_svc, req.instance_id)


def test_a_client_certificate_from_another_ca_is_refused(pki, tls_svc):
    req = create_request()
    ctx = pki.client_context(cert=(pki.other_client_cert, pki.other_client_key))
    with pytest.raises(OrchestratorUnavailable):
        HttpInstanceHost(tls_svc.url, PLATFORM_KEY, ssl_context=ctx).create(req)
    assert_nothing_created(pki, tls_svc, req.instance_id)


def test_a_server_certificate_that_is_not_trusted_is_refused(pki, tls_svc):
    req = create_request()
    with pytest.raises(OrchestratorUnavailable):
        HttpInstanceHost(tls_svc.url, PLATFORM_KEY, ssl_context=pki.untrusting_context()).create(req)
    assert_nothing_created(pki, tls_svc, req.instance_id)


def test_a_wrong_host_name_is_refused(pki, tls_svc):
    req = create_request()
    url = f"https://127.0.0.1:{tls_svc.port}"  # the certificate names only localhost
    with pytest.raises(OrchestratorUnavailable):
        HttpInstanceHost(url, PLATFORM_KEY, ssl_context=pki.client_context()).create(req)
    assert_nothing_created(pki, tls_svc, req.instance_id)


def test_valid_certificates_with_a_wrong_signing_key_still_get_bad_signature(pki, tls_svc):
    req = create_request()
    host = HttpInstanceHost(tls_svc.url, WRONG_KEY, ssl_context=pki.client_context())
    with pytest.raises(BadSignature):
        host.create(req)
    assert_nothing_created(pki, tls_svc, req.instance_id)


def test_a_plain_http_client_cannot_use_a_tls_fake(pki, tls_svc):
    req = create_request()
    with pytest.raises(OrchestratorUnavailable):
        HttpInstanceHost(f"http://127.0.0.1:{tls_svc.port}", PLATFORM_KEY).create(req)
    assert_nothing_created(pki, tls_svc, req.instance_id)


@pytest.mark.parametrize("flags", [["--tls-cert", "a.pem"], ["--tls-cert", "a.pem", "--tls-key", "a.key"],
                                   ["--tls-ca", "ca.pem"], ["--tls-key", "a.key", "--tls-ca", "ca.pem"]])
def test_incomplete_tls_flags_exit_with_code_2(flags):
    node = shutil.which("node")
    assert node, "node is required for the fake orchestrator tests"
    res = subprocess.run([node, str(SERVER), "--port", "0", *flags], capture_output=True, text=True, timeout=30)
    assert res.returncode == 2
    assert "--tls-cert, --tls-key and --tls-ca must be given together" in res.stderr


# ---- certificates that must be refused, and the openssl-missing rule ----
LONG_AGO = ("200101000000Z", "200102000000Z")      # expired years ago
NOT_YET = ("490101000000Z", "490102000000Z")       # starts in the year 2049


def _refused(pki, tls_svc, *, client_cert=..., ctx=None, url=None):
    req = create_request()
    ctx = ctx or pki.client_context(cert=client_cert)
    with pytest.raises(OrchestratorUnavailable):
        HttpInstanceHost(url or tls_svc.url, PLATFORM_KEY, ssl_context=ctx).create(req)
    return req


@pytest.mark.parametrize("name,valid", [("expired-client", LONG_AGO), ("future-client", NOT_YET)])
def test_a_client_certificate_that_is_expired_or_not_yet_valid_is_refused(pki, tls_svc, name, valid):
    cert = pki.issue(name, name, "clientAuth", None, valid=valid)
    req = _refused(pki, tls_svc, client_cert=cert)
    assert_nothing_created(pki, tls_svc, req.instance_id)


def test_a_server_only_certificate_used_as_a_client_certificate_is_refused(pki, tls_svc):
    cert = pki.issue("server-as-client", "server-as-client", "serverAuth", None)  # extendedKeyUsage serverAuth, not clientAuth
    req = _refused(pki, tls_svc, client_cert=cert)
    assert_nothing_created(pki, tls_svc, req.instance_id)


@pytest.mark.parametrize("name,usage,valid", [("expired-server", "serverAuth", LONG_AGO), ("future-server", "serverAuth", NOT_YET),
                                              ("client-usage-server", "clientAuth", None)])
def test_a_server_certificate_that_is_expired_not_yet_valid_or_for_the_wrong_use_is_refused(pki, name, usage, valid):
    pair = pki.issue(name, "localhost", usage, "subjectAltName=DNS:localhost", valid=valid)
    svc = ServiceProcess(tls=pki, tls_server=pair)
    try:
        _refused(pki, svc)
    finally:
        svc.stop()


@pytest.mark.filterwarnings("ignore::DeprecationWarning")  # the old protocol versions are named on purpose
def test_a_tls_1_1_client_is_refused(pki, tls_svc):
    ctx = pki.client_context()
    ctx.minimum_version = ssl.TLSVersion.TLSv1
    ctx.maximum_version = ssl.TLSVersion.TLSv1_1
    ctx.set_ciphers("DEFAULT:@SECLEVEL=0")  # let the client really offer TLS 1.1, so the refusal is the server's
    req = _refused(pki, tls_svc, ctx=ctx)
    assert_nothing_created(pki, tls_svc, req.instance_id)


@pytest.mark.parametrize("value,fails", [("true", True), ("TRUE", True), ("1", True), ("false", False), ("0", False), ("", False), (None, False)])
def test_a_missing_openssl_fails_only_when_ci_is_true_or_1(monkeypatch, value, fails):
    monkeypatch.setattr(support, "openssl_path", lambda: None)
    env = {} if value is None else {"CI": value}
    expected = pytest.fail.Exception if fails else pytest.skip.Exception
    with pytest.raises(expected):
        require_openssl(env)


def test_openssl_present_is_returned_whatever_ci_says(monkeypatch):
    monkeypatch.setattr(support, "openssl_path", lambda: "/usr/bin/openssl")
    assert require_openssl({"CI": "true"}) == "/usr/bin/openssl"

def test_control_a_certificate_made_the_same_way_with_valid_dates_is_accepted(pki, tls_svc):
    """Without this, the refusals above could be caused by the way the dated certificates are made rather than by their dates or use."""
    cert = pki.issue("control-client", "control-client", "clientAuth", None, valid=("200101000000Z", "490101000000Z"))
    host = HttpInstanceHost(tls_svc.url, PLATFORM_KEY, ssl_context=pki.client_context(cert=cert))
    req = create_request()
    host.create(req)
    assert host.get(req.instance_id).epoch == 1
