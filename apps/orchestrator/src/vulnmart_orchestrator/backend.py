"""The Docker backend interface, a fake for unit tests and the Docker SDK implementation (D3 and D5 of story L-13).

The engine only talks to `Backend`. `FakeBackend` keeps everything in memory and records every call in order. `SdkBackend` uses the
Docker SDK (docker-py) and does what `scripts/harness.mjs` does with the Docker CLI. Truth is Docker: every object carries the
`vm.instance` label, and `find` / destroy work from labels alone.
"""
from __future__ import annotations

import contextlib
import ipaddress
import socket
import threading
import time
from dataclasses import dataclass
from dataclasses import field as dc_field
from typing import Protocol

from .builder import ContainerSpec, NetworkSpec, VolumeSpec


class BackendError(Exception):
    """Docker refused or failed. The text is safe to log: it never holds a document, flag, seed or key."""


@dataclass(frozen=True, slots=True)
class ContainerState:
    status: str  # created, running, exited, dead, ... (Docker names)
    exit_code: int | None
    health: str  # healthy, unhealthy, starting, or none (no healthcheck)


@dataclass(frozen=True, slots=True)
class Found:
    containers: tuple[str, ...]
    networks: tuple[str, ...]
    volumes: tuple[str, ...]

    @property
    def empty(self) -> bool:
        return not (self.containers or self.networks or self.volumes)


@dataclass(frozen=True, slots=True)
class Seen:
    """One Docker object found by `scan`: its kind (container, network or volume), name, labels and, for a container, its status and its
    health (None when it has no healthcheck)."""

    kind: str
    name: str
    labels: dict[str, str]
    status: str = ""
    health: str | None = None


class Backend(Protocol):
    def scan(self) -> tuple[Seen, ...]:
        """Every container, network and volume that carries the label `vm.kind=inst` (the reconciler's view of the truth)."""
    def create_network(self, spec: NetworkSpec) -> None: ...
    def create_volume(self, spec: VolumeSpec) -> None: ...
    def create_container(self, spec: ContainerSpec) -> None: ...
    def start(self, name: str) -> None: ...
    def start_with_stdin(self, name: str, data: bytes) -> None:
        """Start, write `data` once on standard input and close it (StdinOnce). Does not wait for the container to end."""
    def state(self, name: str) -> ContainerState: ...
    def wait_exit(self, name: str, timeout_s: float) -> int | None:
        """The exit code, or None if the container is still running after `timeout_s`."""
    def find(self, instance_id: str, epoch: int | None = None) -> Found:
        """Every object with the `vm.instance` label; with `epoch` only those that also carry that `vm.epoch` label."""
    def remove_container(self, name: str) -> None: ...
    def remove_network(self, name: str) -> None: ...
    def remove_volume(self, name: str) -> None: ...
    def connect_edge(self, network: str) -> None:
        """Attach the configured edge container to the network (no alias: the edge is addressed by its container name)."""
    def disconnect_edge(self, network: str) -> None:
        """Detach the configured edge container from the network; nothing happens when it is not attached (a network with an endpoint
        cannot be removed, so the engine calls this before `remove_network`)."""


# ---------------------------------------------------------------- fake

@dataclass
class FakeBackend:
    """In-memory backend. Configure the behaviour with the attributes, read `calls` and `stdin` afterwards.

    injector_exit: exit code of the injector (None: it never exits). healthy_after: polls until a started healthy container
    reports healthy (None: never). healthy_always: report healthy from the moment of creation, even before start (a test aid
    for the "shop healthy before the injector exited" row). fail_on: (operation, name part) that raises BackendError.
    """

    injector_exit: int | None = 0
    healthy_after: int | None = 1
    healthy_always: bool = False
    fail_on: tuple[str, str] | None = None
    calls: list[tuple[str, str]] = dc_field(default_factory=list)
    stdin: dict[str, list[bytes]] = dc_field(default_factory=dict)
    containers: dict[str, ContainerSpec] = dc_field(default_factory=dict)
    networks: dict[str, NetworkSpec] = dc_field(default_factory=dict)
    volumes: dict[str, VolumeSpec] = dc_field(default_factory=dict)
    statuses: dict[str, str] = dc_field(default_factory=dict)  # test aid for `scan`: a status or health other than the computed one
    healths: dict[str, str | None] = dc_field(default_factory=dict)
    _started: set[str] = dc_field(default_factory=set)
    _polls: dict[str, int] = dc_field(default_factory=dict)
    edge_container: str | None = None  # set by the engine when an edge is configured
    edge_attached: set[str] = dc_field(default_factory=set)  # the networks the fake edge is connected to

    def _call(self, op: str, name: str) -> None:
        self.calls.append((op, name))
        if self.fail_on and self.fail_on[0] == op and self.fail_on[1] in name:
            raise BackendError(f"fake failure on {op}")

    def create_network(self, spec: NetworkSpec) -> None:
        self._call("create_network", spec.name)
        self.networks[spec.name] = spec

    def create_volume(self, spec: VolumeSpec) -> None:
        self._call("create_volume", spec.name)
        self.volumes[spec.name] = spec

    def create_container(self, spec: ContainerSpec) -> None:
        self._call("create_container", spec.name)
        self.containers[spec.name] = spec

    def start(self, name: str) -> None:
        self._call("start", name)
        self._started.add(name)

    def start_with_stdin(self, name: str, data: bytes) -> None:
        self._call("start_with_stdin", name)
        self.stdin.setdefault(name, []).append(data)
        self._started.add(name)

    def _is_injector(self, name: str) -> bool:
        return self.containers[name].role == "injector"

    def state(self, name: str) -> ContainerState:
        if name not in self.containers:
            raise BackendError("no such container")
        spec = self.containers[name]
        started = name in self._started
        if self._is_injector(name):
            if started and self.injector_exit is not None:
                return ContainerState("exited", self.injector_exit, "none")
            return ContainerState("running" if started else "created", None, "none")
        if spec.healthcheck is None:
            return ContainerState("running" if started else "created", None, "none")
        if self.healthy_always:
            return ContainerState("running" if started else "created", None, "healthy")
        if not started:
            return ContainerState("created", None, "none")
        self._polls[name] = self._polls.get(name, 0) + 1
        ok = self.healthy_after is not None and self._polls[name] > self.healthy_after
        return ContainerState("running", None, "healthy" if ok else "starting")

    def wait_exit(self, name: str, timeout_s: float) -> int | None:
        self._call("wait_exit", name)
        st = self.state(name)
        return st.exit_code if st.status == "exited" else None

    def find(self, instance_id: str, epoch: int | None = None) -> Found:
        def mine(labels: dict[str, str]) -> bool:
            return labels.get("vm.instance") == instance_id and (epoch is None or labels.get("vm.epoch") == str(epoch))

        return Found(
            tuple(n for n, s in self.containers.items() if mine(s.labels)),
            tuple(n for n, s in self.networks.items() if mine(s.labels)),
            tuple(n for n, s in self.volumes.items() if mine(s.labels)),
        )

    def _status(self, name: str) -> str:
        if name in self.statuses:
            return self.statuses[name]
        if name not in self._started:
            return "created"
        if self.containers[name].role == "injector" and self.injector_exit is not None:
            return "exited"
        return "running"

    def scan(self) -> tuple[Seen, ...]:
        def inst(labels: dict[str, str]) -> bool:
            return labels.get("vm.kind") == "inst"

        return (
            *(Seen("container", n, dict(s.labels), self._status(n), self.healths.get(n)) for n, s in self.containers.items() if inst(s.labels)),
            *(Seen("network", n, dict(s.labels)) for n, s in self.networks.items() if inst(s.labels)),
            *(Seen("volume", n, dict(s.labels)) for n, s in self.volumes.items() if inst(s.labels)),
        )

    def remove_container(self, name: str) -> None:
        self._call("remove_container", name)
        self.containers.pop(name, None)
        self._started.discard(name)

    def remove_network(self, name: str) -> None:
        self._call("remove_network", name)
        if name in self.edge_attached:  # like Docker: a network with an endpoint cannot be removed
            raise BackendError("fake: network has an active endpoint")
        self.networks.pop(name, None)

    def remove_volume(self, name: str) -> None:
        self._call("remove_volume", name)
        self.volumes.pop(name, None)

    def connect_edge(self, network: str) -> None:
        self._call("connect_edge", network)
        if network not in self.networks:
            raise BackendError("fake: no such network")
        self.edge_attached.add(network)

    def disconnect_edge(self, network: str) -> None:
        self._call("disconnect_edge", network)
        self.edge_attached.discard(network)


# ---------------------------------------------------------------- test backend of the service

FAIL_TEMPLATE = "shop-fail-v0"  # the template whose shop never becomes healthy (the fake orchestrator has the same one)


class ServiceFakeBackend(FakeBackend):
    """The in-memory backend for `--backend fake` (D9 of story 3.2): what the protocol suites run the Python service against, with no
    Docker. Safe for the worker threads of the service (one lock around every call). An instance of the template `shop-fail-v0`
    reports its healthchecks `unhealthy`, so it ends in `failed` with `INST-HEALTH-TIMEOUT`, like the fake orchestrator."""

    def __init__(self) -> None:
        super().__init__(injector_exit=0, healthy_after=1)
        self._mu = threading.RLock()

    def state(self, name: str) -> ContainerState:
        with self._mu:
            st = super().state(name)
            spec = self.containers[name]
            if spec.labels.get("vm.template") == FAIL_TEMPLATE and spec.healthcheck is not None and st.status == "running":
                return ContainerState("running", None, "unhealthy")
            return st


def _locked(name: str):
    parent = getattr(FakeBackend, name)

    def call(self, *args, **kwargs):
        with self._mu:
            return parent(self, *args, **kwargs)

    call.__name__ = name
    return call


for _name in ("create_network", "create_volume", "create_container", "start", "start_with_stdin", "wait_exit", "find", "scan",
              "remove_container", "remove_network", "remove_volume", "connect_edge", "disconnect_edge"):
    setattr(ServiceFakeBackend, _name, _locked(_name))
del _name

# ---------------------------------------------------------------- Docker SDK

SANDBOX_RUNTIMES = ("runc", "runsc")  # the two runtimes the orchestrator may ask the daemon for
# gVisor's own processes and threads (the sentry and the gofer) count against the container's pids and memory limits. Found live on vm-i (2026-10-20): with a pids limit
# of 32 the sandbox of the volume keeper died while starting ("failed to create new OS thread, errno=11") in most tries. The template's limits are for the workload, so the
# overhead is added on top: the workload keeps exactly the room the template gives it.
SANDBOX_PIDS_OVERHEAD = 96
SANDBOX_MEMORY_OVERHEAD_MB = 64

class SdkBackend:
    """Docker SDK backend. Images are used as given (no pull): the release manifest pins them by digest."""

    def __init__(self, client=None, *, base_url: str | None = None, edge_container: str | None = None, runtime: str | None = None) -> None:
        import docker

        if runtime not in (None, *SANDBOX_RUNTIMES):
            raise ValueError(f"the container runtime must be one of {', '.join(SANDBOX_RUNTIMES)}, not {runtime!r}")
        # The OCI runtime of every instance container (S-8, story L-29): None means the daemon's default (runc); `runsc` is gVisor, a user-space kernel between the
        # instance and the host kernel. Never read from a template or a request. A daemon that does not know the runtime refuses the create, so an instance
        # never starts un-sandboxed by accident.
        self.runtime = runtime or None
        # Under gVisor the container cannot use Docker's embedded name server (it lives in the network namespace that the sandbox replaces: every lookup of an alias
        # fails, found live on vm-i 2026-10-20). So with runsc every container of the instance gets a fixed address and a hosts file that names the others.
        self._addr: dict[str, str] = {}  # container name -> its fixed address
        self._hosts: dict[str, tuple[tuple[str, str], ...]] = {}  # network name -> (alias, address) of every member
        self._members: dict[str, list[str]] = {}  # network name -> its fixed-address containers (forgotten with the network)
        self._edge_addr: dict[str, str] = {}  # network name -> the fixed address kept for the edge container (the sidecar posts events to it by name)
        self.edge_container = edge_container  # the one container connect_edge may attach (the engine sets it from --edge-container)
        self._docker = docker
        self.client = client or (docker.DockerClient(base_url=base_url) if base_url else docker.from_env())
        self.api = self.client.api

    def _wrap(self, fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except Exception as e:  # docker.errors.DockerException, requests errors: reduced to a safe message
            if isinstance(e, self._docker.errors.NotFound):
                raise
            raise BackendError(f"{type(e).__name__}: {str(e)[:200]}") from None

    def create_network(self, spec: NetworkSpec) -> None:
        self._wrap(self.client.networks.create, spec.name, driver="bridge", internal=spec.internal, labels=dict(spec.labels))

    def prepare_plan(self, plan) -> None:
        """Called by the engine once the instance network exists, before any container is created. Only with a sandbox runtime that cannot use the embedded name server:
        reads the subnet Docker chose, gives each container on the instance network a fixed address from .10 on (low addresses stay free for the edge container that is
        attached later) and remembers the hosts file every member gets."""
        if self.runtime != "runsc":
            return
        info = self._wrap(self.client.networks.get, plan.network.name).attrs
        configs = (info.get("IPAM") or {}).get("Config") or []
        if not configs or not configs[0].get("Subnet"):
            raise BackendError("the instance network has no subnet to place the containers in")
        subnet = ipaddress.ip_network(configs[0]["Subnet"])
        members = [c for c in plan.containers if c.network == plan.network.name]
        if len(members) > subnet.num_addresses - 14:
            raise BackendError("the instance network is too small for its containers")
        hosts: list[tuple[str, str]] = []
        if self.edge_container:  # the sidecar relays its events to the edge by the edge's container name: it needs that name in its hosts file too (found live)
            edge_ip = str(subnet.network_address + 2)
            self._edge_addr[plan.network.name] = edge_ip
            hosts.append((self.edge_container, edge_ip))
        for i, c in enumerate(members):
            ip = str(subnet.network_address + 10 + i)
            self._addr[c.name] = ip
            self._members.setdefault(plan.network.name, []).append(c.name)
            hosts.extend((alias, ip) for alias in c.aliases)
        self._hosts[plan.network.name] = tuple(hosts)

    def create_volume(self, spec: VolumeSpec) -> None:
        self._wrap(self.client.volumes.create, name=spec.name, driver="local", driver_opts=spec.driver_opts, labels=dict(spec.labels))

    def create_container(self, spec: ContainerSpec) -> None:
        d = self._docker
        sandboxed = self.runtime == "runsc"
        memory_mb = spec.memory_mb + (SANDBOX_MEMORY_OVERHEAD_MB if sandboxed else 0)
        pids_limit = spec.pids_limit + (SANDBOX_PIDS_OVERHEAD if sandboxed else 0)
        mounts = [d.types.Mount(m.target, m.volume, type="volume", read_only=m.read_only) for m in spec.mounts]
        host_config = self.api.create_host_config(
            mem_limit=f"{memory_mb}m", memswap_limit=f"{memory_mb}m", nano_cpus=int(spec.cpu_limit * 1_000_000_000),
            pids_limit=pids_limit, read_only=spec.read_only, privileged=spec.privileged, cap_drop=list(spec.cap_drop),
            security_opt=list(spec.security_opt), tmpfs=dict(spec.tmpfs), mounts=mounts, network_mode=spec.network,
            restart_policy={"Name": "no"}, **({"runtime": self.runtime} if self.runtime else {}),
            **({"extra_hosts": dict(self._hosts[spec.network])} if spec.name in self._addr and self._hosts.get(spec.network) else {}),
        )
        networking = None
        if spec.network != "none":
            fixed = {"ipv4_address": self._addr[spec.name]} if spec.name in self._addr else {}
            networking = self.api.create_networking_config({spec.network: self.api.create_endpoint_config(aliases=list(spec.aliases), **fixed)})
        hc = None
        if spec.healthcheck:
            h = spec.healthcheck
            hc = {"Test": list(h.test), "Interval": h.interval_s * 10**9, "Timeout": h.timeout_s * 10**9, "Retries": h.retries,
                  "StartPeriod": 10**9}
        cfg = self.api.create_container_config(
            spec.image, list(spec.command) if spec.command is not None else None, user=spec.user, environment=dict(spec.env),
            labels=dict(spec.labels), entrypoint=list(spec.entrypoint) if spec.entrypoint is not None else None, healthcheck=hc,
            stdin_open=spec.stdin is not None, host_config=host_config, networking_config=networking, stop_timeout=1,
        )
        if spec.stdin is not None:
            cfg["StdinOnce"] = True  # Docker closes standard input when the one writer is done (H-60)
        self._wrap(self.api.create_container_from_config, cfg, spec.name)

    def start(self, name: str) -> None:
        self._wrap(self.api.start, name)

    def start_with_stdin(self, name: str, data: bytes) -> None:
        sock = self._wrap(self.api.attach_socket, name, params={"stdin": 1, "stream": 1})
        try:
            self._wrap(self.api.start, name)
            raw = getattr(sock, "_sock", sock)
            try:
                raw.sendall(data)
            except OSError as e:
                raise BackendError("could not write the start document") from e
            with contextlib.suppress(Exception):
                raw.shutdown(socket.SHUT_WR)
        finally:
            with contextlib.suppress(Exception):
                sock.close()

    def state(self, name: str) -> ContainerState:
        try:
            info = self.api.inspect_container(name)
        except self._docker.errors.NotFound as e:
            raise BackendError("no such container") from e
        except Exception as e:
            raise BackendError(f"{type(e).__name__}") from None
        st = info["State"]
        health = (st.get("Health") or {}).get("Status", "none")
        code = st.get("ExitCode") if st.get("Status") in ("exited", "dead") else None
        return ContainerState(st.get("Status", "unknown"), code, health)

    def wait_exit(self, name: str, timeout_s: float) -> int | None:
        end = time.monotonic() + timeout_s
        while True:
            st = self.state(name)
            if st.status in ("exited", "dead"):
                return st.exit_code if st.exit_code is not None else 1
            if time.monotonic() >= end:
                return None
            time.sleep(0.2)

    def find(self, instance_id: str, epoch: int | None = None) -> Found:
        labels = [f"vm.instance={instance_id}"] + ([f"vm.epoch={epoch}"] if epoch is not None else [])  # several label filters are ANDed
        flt = {"label": labels}
        return Found(
            tuple(c.name for c in self._wrap(self.client.containers.list, all=True, filters=flt)),
            tuple(n.name for n in self._wrap(self.client.networks.list, filters=flt)),
            tuple(v.name for v in self._wrap(self.client.volumes.list, filters=flt)),
        )

    def scan(self) -> tuple[Seen, ...]:
        flt = {"label": ["vm.kind=inst"]}
        # Networks and volumes first, containers last: an instance that is being built has its network and volumes before its containers,
        # so a container is never seen without them (the three lists are not one snapshot).
        out: list[Seen] = []
        for n in self._wrap(self.client.networks.list, filters=flt):
            out.append(Seen("network", n.name, dict((n.attrs or {}).get("Labels") or {})))
        for v in self._wrap(self.client.volumes.list, filters=flt):
            out.append(Seen("volume", v.name, dict((v.attrs or {}).get("Labels") or {})))
        for c in self._wrap(self.client.containers.list, all=True, filters=flt):
            state = (c.attrs or {}).get("State")
            if not isinstance(state, dict):  # the list call only gives a text: inspect for the state and the health
                try:
                    state = self._wrap(self.api.inspect_container, c.id)["State"]
                except self._docker.errors.NotFound:
                    continue  # removed since the list
            out.append(Seen("container", c.name, dict(c.labels or {}), state.get("Status") or "", (state.get("Health") or {}).get("Status")))
        return tuple(out)
    def remove_container(self, name: str) -> None:
        with contextlib.suppress(self._docker.errors.NotFound):
            self._wrap(self.api.remove_container, name, v=True, force=True)

    def remove_network(self, name: str) -> None:
        self._hosts.pop(name, None)
        self._edge_addr.pop(name, None)
        for member in self._members.pop(name, []):
            self._addr.pop(member, None)
        with contextlib.suppress(self._docker.errors.NotFound):
            self._wrap(self.api.remove_network, name)

    def remove_volume(self, name: str) -> None:
        with contextlib.suppress(self._docker.errors.NotFound):
            self._wrap(self.api.remove_volume, name, force=True)

    def _edge(self) -> str:
        if not self.edge_container:
            raise BackendError("no edge container is configured")
        return self.edge_container

    def connect_edge(self, network: str) -> None:
        # Docker API POST /networks/{network}/connect, no aliases. The network is given by name (`vm-...`), which the socket proxy checks.
        fixed = {"ipv4_address": self._edge_addr[network]} if network in self._edge_addr else {}  # the address the instance's hosts files name for the edge
        try:
            self._wrap(self.api.connect_container_to_network, self._edge(), network, **fixed)
        except self._docker.errors.NotFound:
            raise BackendError("the edge container or the network does not exist") from None

    def disconnect_edge(self, network: str) -> None:
        edge = self._edge()
        try:
            info = self._wrap(self.api.inspect_network, network)
        except self._docker.errors.NotFound:
            return  # the network is gone already
        if not any((c or {}).get("Name") == edge for c in (info.get("Containers") or {}).values()):
            return  # not attached: nothing to do (a disconnect of an unattached container is an error in Docker)
        with contextlib.suppress(self._docker.errors.NotFound):
            self._wrap(self.api.disconnect_container_from_network, edge, network, force=True)
