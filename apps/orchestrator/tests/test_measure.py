"""The S-4 measurement tool: its helpers and its argument checks (the real run needs Docker and is the developer's)."""
import pytest

from vulnmart_orchestrator import measure
from vulnmart_orchestrator.engine import Orchestrator
from vulnmart_orchestrator.images import ImageAllowlist
from vulnmart_orchestrator.backend import FakeBackend, ServiceFakeBackend
from support import allowlist, template


def test_summary_numbers():
    s = measure.summary([1.0, 2.0, 3.0, 4.0, 10.0])
    assert (s["n"], s["min"], s["median"], s["max"]) == (5, 1.0, 3.0, 10.0)


def test_each_body_is_new_random_and_accepted_by_the_engine():
    a, b = measure.make_body(measure._iid(), 256), measure.make_body(measure._iid(), 256)
    assert a["seed"] != b["seed"] and a["flags"][0]["flag"] != b["flags"][0]["flag"]
    rec = Orchestrator(FakeBackend(), {"shop-v0": template()}, allowlist()).create(a)
    assert rec.state.value == "ready"


def test_concurrent_burst_starts_all_at_once_under_the_cap_and_removes_everything(capsys):
    be = ServiceFakeBackend()
    orch = Orchestrator(be, {"shop-v0": template()}, allowlist(), poll_s=0.01)
    result = measure.concurrent_burst(orch, 6, 256)
    assert (result["requested"], result["ready"], result["failures"], result["busy"]) == (6, 6, 0, 0)
    assert 1 <= result["most_builds_together"] <= 4 and result["ready_after_s"]["n"] == 6
    assert not (be.containers or be.networks or be.volumes), "nothing is left behind"
    out = capsys.readouterr().out
    assert "VM{" not in out and "i-" not in out, "no secret and no instance id is printed"


def test_concurrent_burst_counts_a_failed_start(capsys):
    be = ServiceFakeBackend()
    be.fail_on = ("create_container", "-shop")  # every try fails, retries included
    orch = Orchestrator(be, {"shop-v0": template()}, allowlist(), poll_s=0.01)
    result = measure.concurrent_burst(orch, 3, 256)
    assert (result["ready"], result["failures"]) == (0, 3) and result["ready_after_s"] is None
    assert not (be.containers or be.networks or be.volumes)


@pytest.mark.parametrize("argv", [[], ["--stub-image", "x", "--manifest", "y"], ["--stub-image", "x", "--count", "0"], ["--stub-image", "x", "--memory-mb", "8"],
                                  ["--stub-image", "x", "--concurrent", "41"], ["--stub-image", "x", "--concurrent", "-1"]])
def test_bad_arguments_exit_2(argv):
    with pytest.raises(SystemExit) as e:
        measure.main(argv)
    assert e.value.code == 2
