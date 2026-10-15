from __future__ import annotations

import pytest

from support import PYTHON_SERVICE, make_harness

NEEDS_RESET_REASON = "story 3.4: reset and idle detection are not in the Python service yet"


def pytest_configure(config):
    config.addinivalue_line("markers", "needs_reset: uses reset or the activity control; skipped for the Python service (story 3.4)")
    config.addinivalue_line("markers", "node_only: tests the Node fake itself (its command line, its launcher); skipped for the Python service")


def pytest_collection_modifyitems(config, items):
    """With VM_ORCH_SERVICE=python the HTTP side talks to the Python service. A test that needs reset or the activity control is
    skipped on the HTTP side (the in-memory side of a `kind` test still runs), with the reason `story 3.4`."""
    if not PYTHON_SERVICE:
        return
    for item in items:
        callspec = getattr(item, "callspec", None)
        on_http_side = callspec is None or callspec.params.get("kind", "http") == "http"
        if item.get_closest_marker("needs_reset") and on_http_side:
            item.add_marker(pytest.mark.skip(reason=NEEDS_RESET_REASON))
        if item.get_closest_marker("node_only"):
            item.add_marker(pytest.mark.skip(reason="tests the Node fake, not the Python service"))


@pytest.fixture
def make(request):
    """Factory of harnesses. Everything it starts is stopped at the end of the test."""
    started = []

    def factory(kind: str, **kw):
        h = make_harness(kind, **kw)
        started.append(h)
        return h

    yield factory
    for h in started:
        if h.service:
            h.service.stop()
        if h.receiver:
            h.receiver.stop()


@pytest.fixture(params=["fake", "http"])
def kind(request):
    """Every protocol test runs against FakeInstanceHost and against HttpInstanceHost plus the fake service."""
    return request.param


@pytest.fixture
def harness(kind, make):
    return make(kind)


@pytest.fixture
def held(kind, make):
    """A host whose instances never leave their first transitional state."""
    return make(kind, hold=True)
