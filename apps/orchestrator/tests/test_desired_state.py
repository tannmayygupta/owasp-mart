"""Handoff H-123 (contract section 8a): the platform's list of wanted instances reaches the reconciler. The HTTP source signs a GET with the report key and fails
closed (an exception, so safe mode) on anything but a good 200; an unlisted instance is destroyed only after two passes in a row (a create accepted a moment before
the platform noted its id is never removed by one pass)."""
from __future__ import annotations

import json

import pytest
from support import IID
from test_reconcile import IID2, engine, everything_gone, ready_instance

from vulnmart_orchestrator.auth import body_sha256, sign
from vulnmart_orchestrator.backend import FakeBackend
from vulnmart_orchestrator.reconcile import DESIRED_TARGET, FakeDesiredState, HttpDesiredState
from vulnmart_orchestrator.states import InstanceState as S

KEY = b"report-key-for-the-test-0123456789abcdef"
URL = "https://api.internal.invalid:9444"


def source(status=200, body=None, *, key=KEY, seen=None):
    def get(url, headers, timeout):
        if seen is not None:
            seen.append((url, headers))
        if status == "boom":
            raise OSError("network")
        return status, body if isinstance(body, bytes) else json.dumps(body).encode()

    return HttpDesiredState(URL, key, get=get)


def test_the_request_is_a_signed_get_of_the_desired_route_with_the_empty_body_hash():
    seen: list = []
    ids = source(body={"instance_ids": [IID]}, seen=seen).desired()
    assert ids == frozenset({IID})
    url, h = seen[0]
    assert url == URL + DESIRED_TARGET
    expected = sign(KEY, "GET", DESIRED_TARGET, h["X-VM-Timestamp"], h["X-VM-Nonce"], body_sha256(b""))
    assert h["X-VM-Signature"] == expected and len(h["X-VM-Nonce"]) == 32


@pytest.mark.parametrize("status,body", [
    (500, b""), (401, b""), (302, b""), ("boom", b""), (200, b"not json"), (200, {"instance_ids": "i-AAAAAAAAAAAAAAAA"}),
    (200, {"instance_ids": ["shop-1"]}), (200, {"instance_ids": [], "extra": 1}), (200, [IID]), (200, {}),
])
def test_anything_but_a_good_200_raises_so_the_reconciler_goes_to_safe_mode(status, body):
    with pytest.raises(Exception):
        source(status, body).desired()


def test_an_empty_list_is_a_valid_answer_and_means_nothing_is_wanted():
    assert source(body={"instance_ids": []}).desired() == frozenset()


def test_a_plain_http_url_is_refused_unless_it_is_loopback():
    with pytest.raises(ValueError):
        HttpDesiredState("http://10.0.0.5:9444", KEY)
    HttpDesiredState("http://127.0.0.1:9444", KEY)


def test_unlisted_instance_is_destroyed_only_on_the_second_pass_in_a_row():
    be = FakeBackend()
    ready_instance(be, IID)
    new, _, _ = engine(be, desired=FakeDesiredState({IID2}))
    new.reconciler.unwanted_passes = 2
    new.reconcile()  # adopted, first time unlisted
    assert new.get(IID).state is S.READY and not everything_gone(be)
    result = new.reconcile()  # second time in a row
    assert result.destroyed == [IID] and everything_gone(be)


def test_listed_in_between_resets_the_count():
    be = FakeBackend()
    ready_instance(be, IID)
    port = FakeDesiredState({IID2})
    new, _, _ = engine(be, desired=port)
    new.reconciler.unwanted_passes = 2
    new.reconcile()
    port.ids = frozenset({IID})  # the platform now lists it
    new.reconcile()
    port.ids = frozenset({IID2})  # unlisted again: this is the first miss again
    result = new.reconcile()
    assert result.destroyed == [] and new.get(IID).state is S.READY


def test_safe_mode_destroys_nothing_and_forgets_the_count():
    be = FakeBackend()
    ready_instance(be, IID)
    port = FakeDesiredState({IID2})
    new, _, _ = engine(be, desired=port)
    new.reconciler.unwanted_passes = 2
    new.reconcile()
    port.ids, port.error = None, RuntimeError("platform down")
    result = new.reconcile()
    assert result.safe_mode and result.destroyed == []
    port.ids, port.error = frozenset({IID2}), None
    assert new.reconcile().destroyed == []  # count restarted: only one miss so far
