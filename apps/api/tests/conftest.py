from __future__ import annotations

import pytest

from support import make_harness


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
