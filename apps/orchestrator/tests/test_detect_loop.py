"""Story 6.4: the skip and cleanup paths of `scripts/detect_loop.py`, without Docker (the loop itself is run by hand on Docker Desktop
and its output is saved under docs/assets/story-6-4-evidence-and-loop/)."""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def loop():
    spec = importlib.util.spec_from_file_location("detect_loop_under_test", ROOT / "scripts" / "detect_loop.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def done(stdout="", code=0):
    return subprocess.CompletedProcess([], code, stdout, "")


def test_without_a_docker_daemon_it_prints_skip_and_exits_zero(loop, monkeypatch, capsys):
    monkeypatch.setattr(loop, "docker_ok", lambda: False)
    monkeypatch.setattr(loop, "docker", lambda *a, **k: pytest.fail("no docker call without a daemon"))
    assert loop.main() == 0
    assert capsys.readouterr().out.startswith("SKIP detect_loop")
    assert loop.FAILED == []


def test_a_failure_exits_one_and_still_cleans_up_and_counts_leftovers(loop, monkeypatch, capsys):
    calls: list[tuple] = []

    def fake_docker(*args, **kw):
        calls.append(args)
        if args[:3] == ("ps", "-a", "-q") and any(a == f"label={loop.LOOP_LABEL}" for a in args) and ("rm", "-f", "abc123") not in calls:
            return done("abc123\n")  # one loop container exists until it is removed
        return done("")

    fake_sdk = types.SimpleNamespace(from_env=lambda: types.SimpleNamespace(ping=lambda: True))
    monkeypatch.setitem(sys.modules, "docker", fake_sdk)
    monkeypatch.setattr(loop, "docker_ok", lambda: True)
    monkeypatch.setattr(loop, "docker", fake_docker)
    monkeypatch.setattr(loop, "build_images", lambda: (_ for _ in ()).throw(RuntimeError("build broke")))
    assert loop.main() == 1
    out = capsys.readouterr().out
    assert "FAIL loop-error - RuntimeError: build broke" in out and "PASS nothing-left-over" in out and "detect_loop: FAIL" in out
    assert ("rm", "-f", "abc123") in calls  # the labelled container was removed in the finally block


def test_leftovers_count_only_the_loop_label_and_the_loop_id_prefix(loop, monkeypatch):
    def fake_docker(*args, **kw):
        if "--format" in args:
            return done(f"{loop.IID_PREFIX}AAAAAAAA\ni-OTHERINSTANCEXXX\n{loop.IID_PREFIX}BBBBBBBB\n")
        return done("c1\nc2\n")

    monkeypatch.setattr(loop, "docker", fake_docker)
    assert loop.my_leftovers() == {"loop containers": 2, "instance containers": 2, "instance networks": 2, "instance volumes": 2}


def test_ids_labels_and_scripts_are_valid_for_the_orchestrator_and_the_command_line(loop):
    import re

    assert re.fullmatch(r"i-[A-Z2-7]{16}", loop.new_iid())
    assert '"' not in loop.REFLECTOR_JS and '"' not in loop.PLAYER_JS  # they travel as one argument through the Windows command line
    assert loop.LOOP_LABEL == "vm.loop=detect-loop"
