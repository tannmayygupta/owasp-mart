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

    def remove_network(self, name):
        pass

    def connect_container_to_network(self, container, network, **kw):
        self.connected = (container, network, kw)


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


def test_the_sandbox_runtime_is_asked_of_the_daemon_for_every_container_only_when_set_and_only_from_the_two_known_names():
    """S-8, story L-29: `runsc` (gVisor) for every instance container when configured, the daemon default otherwise, nothing else accepted."""
    import pytest

    plan = build_plan(template(), parse_create(body()), allowlist())
    plain = StubClient()
    for spec in plan.containers:
        SdkBackend(plain).create_container(spec)
    assert all("runtime" not in hc for hc in plain.api.host_configs), "no runtime is sent unless one is configured"
    sandboxed = StubClient()
    backend = SdkBackend(sandboxed, runtime="runsc")
    for spec in plan.containers:
        backend.create_container(spec)
    assert len(sandboxed.api.host_configs) == len(plan.containers)
    assert all(hc["runtime"] == "runsc" for hc in sandboxed.api.host_configs), "every container of the instance, the injector and the volume keeper included"
    from vulnmart_orchestrator.backend import SANDBOX_MEMORY_OVERHEAD_MB, SANDBOX_PIDS_OVERHEAD

    for spec, hc, base in zip(plan.containers, sandboxed.api.host_configs, plain.api.host_configs, strict=True):
        assert hc["pids_limit"] == spec.pids_limit + SANDBOX_PIDS_OVERHEAD and base["pids_limit"] == spec.pids_limit, "gVisor's own threads get their own room (found live)"
        assert hc["mem_limit"] == f"{spec.memory_mb + SANDBOX_MEMORY_OVERHEAD_MB}m" and base["mem_limit"] == f"{spec.memory_mb}m"
    assert SdkBackend(StubClient(), runtime="runc").runtime == "runc"
    for bad in ("kata", "RUNSC", "runsc --debug", "/usr/bin/runsc", "nvidia"):
        with pytest.raises(ValueError):
            SdkBackend(StubClient(), runtime=bad)


class _Net:
    def __init__(self, subnet):
        self.attrs = {"IPAM": {"Config": [{"Subnet": subnet, "Gateway": subnet.split("/")[0][:-1] + "1"}]}}


class _Nets:
    def __init__(self, subnet="172.30.7.0/24"):
        self.subnet, self.removed = subnet, []

    def get(self, name):
        return _Net(self.subnet)


class NetStubClient(StubClient):
    def __init__(self):
        super().__init__()
        self.networks = _Nets()


def test_under_gvisor_every_container_of_the_instance_network_gets_a_fixed_address_and_a_hosts_file_naming_the_others():
    """Found live on vm-i (2026-10-20): gVisor cannot use Docker's embedded name server, so an alias such as `sidecar` never resolves. The fix is the one the
    sandbox needs and runc does not: fixed addresses (from .10, below the edge container's dynamic ones) and extra_hosts."""
    plan = build_plan(template(), parse_create(body()), allowlist())
    client = NetStubClient()
    backend = SdkBackend(client, runtime="runsc")
    backend.prepare_plan(plan)
    for spec in plan.containers:
        backend.create_container(spec)
    on_net = [s for s in plan.containers if s.network == plan.network.name]
    assert on_net and len(on_net) < len(plan.containers), "the keeper and the injector have no network and need no address"
    addresses = {}
    for spec, (cfg, _), hc in zip(plan.containers, client.api.created, client.api.host_configs, strict=True):
        if spec.network == plan.network.name:
            endpoint = cfg["networking_config"][spec.network]
            addresses[spec.name] = endpoint["ipv4_address"]
            assert endpoint["ipv4_address"].startswith("172.30.7.") and int(endpoint["ipv4_address"].rsplit(".", 1)[1]) >= 10
            assert set(hc["extra_hosts"]) == {a for s in on_net for a in s.aliases}, "every member names every alias"
        else:
            assert "extra_hosts" not in hc and spec.network == "none"
    assert len(set(addresses.values())) == len(addresses), "no two containers share an address"
    first_hc = next(hc for hc in client.api.host_configs if "extra_hosts" in hc)
    assert set(first_hc["extra_hosts"].values()) == set(addresses.values())
    backend.remove_network(plan.network.name)
    assert not backend._addr and not backend._hosts and not backend._members, "forgotten with the network"


def test_the_default_runtime_changes_nothing_no_fixed_address_no_hosts_file_no_network_lookup():
    plan = build_plan(template(), parse_create(body()), allowlist())
    client = StubClient()  # has no `networks` at all: runc must not look at the network
    backend = SdkBackend(client)
    backend.prepare_plan(plan)
    for spec in plan.containers:
        backend.create_container(spec)
    assert all("extra_hosts" not in hc for hc in client.api.host_configs)
    assert all("ipv4_address" not in (cfg.get("networking_config") or {}).get(s.network, {}) for s, (cfg, _) in zip(plan.containers, client.api.created, strict=True) if s.network != "none")


def test_under_gvisor_the_edge_container_has_a_reserved_address_that_every_hosts_file_names():
    """Found live: the sidecar posts its events to `vulnmart-edge-gate` by name; under gVisor that name only resolves from the hosts file."""
    plan = build_plan(template(), parse_create(body()), allowlist())
    client = NetStubClient()
    backend = SdkBackend(client, runtime="runsc", edge_container="vulnmart-edge-gate")
    backend.prepare_plan(plan)
    for spec in plan.containers:
        backend.create_container(spec)
    hosts = next(hc["extra_hosts"] for hc in client.api.host_configs if "extra_hosts" in hc)
    assert hosts["vulnmart-edge-gate"] == "172.30.7.2", "reserved below the containers' own addresses, which start at .10"
    assert all(ip != "172.30.7.2" for name, ip in hosts.items() if name != "vulnmart-edge-gate")
    backend.connect_edge(plan.network.name)
    assert client.api.connected == ("vulnmart-edge-gate", plan.network.name, {"ipv4_address": "172.30.7.2"})
    other = NetStubClient()
    SdkBackend(other, edge_container="vulnmart-edge-gate").connect_edge(plan.network.name)
    assert other.api.connected == ("vulnmart-edge-gate", plan.network.name, {}), "runc: the edge keeps a dynamic address, as before"