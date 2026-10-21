"""The spec-versus-route check (scripts/check_spec_routes.py): the real contract and the real routes agree, and each kind of drift is named."""
from __future__ import annotations

import importlib.util

import pytest

from support import ROOT


@pytest.fixture(scope="module")
def check():
    spec = importlib.util.spec_from_file_location("check_spec_routes", ROOT / "scripts" / "check_spec_routes.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_real_contract_and_the_real_routes_agree(check):
    import json

    bundle = json.loads((ROOT / "contracts" / "api" / "bundle" / "openapi.json").read_text(encoding="utf-8"))
    assert check.compare(check.spec_operations(bundle), check.route_operations()) == []


def test_each_kind_of_drift_is_named(check):
    spec = {("GET", "/api/v1/a"): ("getA", False), ("POST", "/api/v1/b"): ("postB", False), ("GET", "/api/v1/live/ticket"): ("createLiveTicket", True),
            ("POST", "/api/v1/attempts/{attempt_id}/start"): ("startAttempt", False)}
    routes = {("GET", "/api/v1/a"): "otherName", ("GET", "/api/v1/extra"): "extra"}
    problems = check.compare(spec, routes)
    assert any("in the contract, not served: POST /api/v1/b" in p for p in problems)
    assert any("operationId differs for GET /api/v1/a" in p for p in problems)
    assert any("served, not in the contract: GET /api/v1/extra" in p for p in problems)
    assert not any("createLiveTicket" in p or "startAttempt" in p for p in problems), "the two pending operations are exempt while unrouted"


def test_an_exemption_that_is_no_longer_needed_fails(check):
    served = {("POST", "/api/v1/live/ticket"): "createLiveTicket"}
    assert any("is served now" in p for p in check.compare({("POST", "/api/v1/live/ticket"): ("createLiveTicket", True)}, served))
    # the contract dropped the pending mark and nothing serves it
    assert any("no longer marks it x-pending" in p for p in check.compare({("POST", "/api/v1/live/ticket"): ("createLiveTicket", False)}, {}))
    # the contract dropped the operation altogether
    assert any("is not in the contract any more" in p for p in check.compare({}, {}))
