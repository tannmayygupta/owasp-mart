"""No Docker needed (story 4.2): what `SdkBackend.create_container` would send for every component of the plan of the shop template never has the
rights the socket proxy cannot filter (it does not read request bodies): no privileged mode, no host bind, no host pid or network mode, no added capability."""
from __future__ import annotations

from support import allowlist, body, template

from vulnmart_orchestrator.backend import SdkBackend
from vulnmart_orchestrator.builder import build_plan, parse_create


class StubApi:
    def __init__(self):
        self.host_configs: list[dict] = []
        self.configs: list[dict] = []
        self.created: list[tuple[dict, str]] = []

    def create_host_config(self, **kw):
        self.host_configs.append(kw)
        return kw

    def create_networking_config(self, d):
        return d

    def create_endpoint_config(self, **kw):
        return kw

    def create_container_config(self, image, command, **kw):
        cfg = {"Image": image, "Cmd": command, **kw}
        self.configs.append(cfg)
        return cfg

    def create_container_from_config(self, cfg, name):
        self.created.append((cfg, name))


class StubClient:
    def __init__(self):
        self.api = StubApi()


def test_no_component_of_the_shop_plan_asks_for_a_privileged_host_bound_or_host_namespace_container():
    client = StubClient()
    backend = SdkBackend(client)
    plan = build_plan(template(), parse_create(body()), allowlist())
    assert plan.containers
    for spec in plan.containers:
        backend.create_container(spec)
    api = client.api
    assert len(api.created) == len(plan.containers) == len(api.host_configs)
    for (_, name), hc in zip(api.created, api.host_configs, strict=True):
        assert name.startswith("vm-"), name  # the proxy lets create through only for names that start with vm-
        assert hc["privileged"] is False, name
        assert not hc.get("binds") and not hc.get("volumes_from") and not hc.get("devices"), name
        assert not hc.get("cap_add") and hc["cap_drop"] == ["ALL"], name
        assert not hc.get("pid_mode") and not hc.get("ipc_mode") and not hc.get("userns_mode") and not hc.get("uts_mode"), name
        assert hc["network_mode"] != "host" and not str(hc["network_mode"]).startswith("container:"), name
        assert not any("unconfined" in o for o in hc["security_opt"]), name
        for m in hc["mounts"]:  # volumes only, never a host path
            assert m["Type"] == "volume" and m["Source"].startswith("vm-"), (name, m)
    for cfg in api.configs:
        assert not cfg["host_config"].get("privileged")
