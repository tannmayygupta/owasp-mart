"""Mutual TLS between HttpInstanceHost and the fake orchestrator started with --tls-cert, --tls-key and --tls-ca.

Certificates are made at test time with the `openssl` command in a temporary folder that is deleted afterwards.
mTLS stays outside the OpenAPI contract; these tests prove that the client transport behaves as the contract
section 4 expects: the signing rule still applies on top, and every refused handshake is `OrchestratorUnavailable`.
Without `openssl` the tests skip locally and fail when the `CI` variable is set.
"""
from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from support import PLATFORM_KEY, SERVER, WRONG_KEY, Pki, ServiceProcess, create_request, openssl_path, reset_request
from support import _poll
from vulnmart.ports.http_instance_host import HttpInstanceHost
from vulnmart.ports.instance_host import BadSignature, InstanceNotFound, InstanceState, OrchestratorUnavailable


@pytest.fixture(scope="module")
def pki():
    if openssl_path() is None:
        message = "openssl is not installed, the mTLS tests cannot make certificates"
        if os.environ.get("CI"):
            pytest.fail(message)
        pytest.skip(message)
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
