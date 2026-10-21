"""WP-A (wiring audit section 3, `lab/runtime.py` environment typo): a deployed API refuses to run the lab on fakes.

A staging or production process must not start with the fake instance host (a mistyped VULNMART_ORCH_URL used to fall back to it silently), with in-memory attempt state (random
per-process keys, everything lost at a restart) or without the admin's quotas, unless the explicit dev flag `VULNMART_ALLOW_FAKE_LAB=1` is set. Dev and test are unchanged."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI

from vulnmart.lab.runtime import ALLOW_FAKES_FLAG, LabRuntime, build_lab_runtime, check_deployable
from vulnmart.main import _mount_lab
from vulnmart.ports.fake_instance_host import FakeInstanceHost
from vulnmart.ports.http_instance_host import HttpInstanceHost
from vulnmart.ports.fakes import FakeSettingsPort
from vulnmart.ports.lab_fakes import FakeQuotaPort


@pytest.mark.parametrize("env", ["staging", "production"])
def test_a_deployed_env_refuses_the_fake_host_memory_state_and_missing_quotas_and_names_each_problem(env):
    rt = LabRuntime(host=FakeInstanceHost())
    with pytest.raises(RuntimeError) as why:
        check_deployable(rt, env, {})
    text = str(why.value)
    assert env in text and "fake" in text and "in memory" in text and "quotas" in text and ALLOW_FAKES_FLAG in text


@pytest.mark.parametrize("env", ["dev", "test"])
def test_dev_and_test_run_on_fakes_as_before(env):
    check_deployable(LabRuntime(host=FakeInstanceHost()), env, {})


def test_the_explicit_dev_flag_allows_it_in_a_deployed_env_and_only_the_exact_value_counts():
    rt = LabRuntime(host=FakeInstanceHost())
    check_deployable(rt, "production", {ALLOW_FAKES_FLAG: "1"})
    for wrong in ("", "0", "true", "yes"):
        with pytest.raises(RuntimeError):
            check_deployable(rt, "production", {ALLOW_FAKES_FLAG: wrong})


def test_a_missing_orchestrator_address_is_the_typo_case_and_is_refused_in_production(monkeypatch):
    monkeypatch.delenv(ALLOW_FAKES_FLAG, raising=False)
    env = {"VULNMART_ORCH_URL_TYPO": "https://10.0.0.1:9443", "VULNMART_ORCH_KEY_FILE": "/nonexistent"}
    rt = build_lab_runtime(env)  # building it is fine (dev and test do it); the deploy check is what refuses
    assert isinstance(rt.host, FakeInstanceHost)
    with pytest.raises(RuntimeError, match="fake"):
        check_deployable(rt, "production", env)


def test_a_real_host_a_persistent_store_and_quotas_pass_the_check(monkeypatch):
    rt = LabRuntime(host=HttpInstanceHost("http://127.0.0.1:1", b"k" * 32), quota=FakeQuotaPort())
    rt.stores.attempts.persistent = True  # the in-memory store of this test stands in for the Postgres one, which declares the same marker
    check_deployable(rt, "production", {})


def test_mounting_the_lab_in_a_production_app_is_refused_before_any_route_is_added():
    app = FastAPI()
    app.state.settings = SimpleNamespace(env="production")
    app.state.ports = SimpleNamespace(quota=FakeQuotaPort(), settings=FakeSettingsPort({}))
    rt = LabRuntime(host=FakeInstanceHost())
    with pytest.raises(RuntimeError, match="refuses to start the lab"):
        _mount_lab(app, rt, None)
    assert rt.quota is not None, "the quota port was wired before the check"
    assert not [r for r in app.routes if getattr(r, "path", "").startswith("/api/v1/attempts")]


def test_mounting_in_dev_wires_the_platforms_quota_port_into_the_lab():
    app = FastAPI()
    app.state.settings = SimpleNamespace(env="dev")
    quota = FakeQuotaPort()
    app.state.ports = SimpleNamespace(quota=quota, settings=FakeSettingsPort({}))
    rt = LabRuntime(host=FakeInstanceHost())
    _mount_lab(app, rt, None)
    assert rt.quota is quota
