"""The S-4 measurement tool: its helpers and its argument checks (the real run needs Docker and is the developer's)."""
import pytest

from vulnmart_orchestrator import measure
from vulnmart_orchestrator.engine import Orchestrator
from vulnmart_orchestrator.images import ImageAllowlist
from vulnmart_orchestrator.backend import FakeBackend
from support import allowlist, template


def test_summary_numbers():
    s = measure.summary([1.0, 2.0, 3.0, 4.0, 10.0])
    assert (s["n"], s["min"], s["median"], s["max"]) == (5, 1.0, 3.0, 10.0)


def test_each_body_is_new_random_and_accepted_by_the_engine():
    a, b = measure.make_body(measure._iid(), 256), measure.make_body(measure._iid(), 256)
    assert a["seed"] != b["seed"] and a["flags"][0]["flag"] != b["flags"][0]["flag"]
    rec = Orchestrator(FakeBackend(), {"shop-v0": template()}, allowlist()).create(a)
    assert rec.state.value == "ready"


@pytest.mark.parametrize("argv", [[], ["--stub-image", "x", "--manifest", "y"], ["--stub-image", "x", "--count", "0"], ["--stub-image", "x", "--memory-mb", "8"]])
def test_bad_arguments_exit_2(argv):
    with pytest.raises(SystemExit) as e:
        measure.main(argv)
    assert e.value.code == 2
