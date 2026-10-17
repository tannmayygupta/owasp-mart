"""Real-Docker tests (D5). They run when a Docker daemon is available. Without one they are skipped on a developer machine and
FAIL in CI (`CI=true` or `1`), like `require_openssl` in the API tests. They use the stub instance image of story L-06 (test only)."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import time

import pytest
from support import EVENT_KEY, FLAG_A, ROOT, SEED, body, is_ci, template

from vulnmart_orchestrator.backend import SdkBackend
from vulnmart_orchestrator.builder import build_plan, parse_create
from vulnmart_orchestrator.engine import Orchestrator
from vulnmart_orchestrator.images import ImageAllowlist
from vulnmart_orchestrator.reconcile import FakeDesiredState
from vulnmart_orchestrator.states import ErrorCode, InstanceState

S = InstanceState
STUB_TAG = "vulnmart-stub-instance:local"
IID = "i-DOCKERTESTAAAAAA"


def _require_docker():
    if (os.environ.get("VULNMART_SKIP_DOCKER_TESTS") or "").strip().lower() in ("true", "1"):
        pytest.skip("VULNMART_SKIP_DOCKER_TESTS is set (the ci:linux container has no Docker daemon)")
    message = "no Docker daemon is available, the real-Docker tests cannot run"
    try:
        import docker

        client = docker.from_env()
        client.ping()
        return client
    except Exception:
        if is_ci():
            pytest.fail(message)
        pytest.skip(message)


@pytest.fixture(scope="module")
def docker_client():
    return _require_docker()


@pytest.fixture(scope="module")
def stub_image_id(docker_client):
    import docker

    try:
        img = docker_client.images.get(STUB_TAG)
    except docker.errors.ImageNotFound:
        r = subprocess.run(["docker", "build", "-q", "-f", "contracts/mocks/stub-instance/Dockerfile", "-t", STUB_TAG, "."],
                           cwd=ROOT, capture_output=True, text=True, timeout=600)
        assert r.returncode == 0, r.stderr[-500:]
        img = docker_client.images.get(STUB_TAG)
    return img.id  # sha256:<64 hex>, a digest-pinned local reference


class Recording(SdkBackend):
    """The real backend that also writes down the order of its calls."""

    def __init__(self, client):
        super().__init__(client)
        self.log: list[tuple[str, str]] = []
        self.documents: dict[str, bytes] = {}  # what each container got on standard input

    def start(self, name):
        self.log.append(("start", name))
        return super().start(name)

    def start_with_stdin(self, name, data):
        self.log.append(("start_with_stdin", name))
        self.documents[name] = data
        return super().start_with_stdin(name, data)

    def wait_exit(self, name, timeout_s):
        code = super().wait_exit(name, timeout_s)
        self.log.append(("exited", f"{name}:{code}"))
        return code

    def state(self, name):
        st = super().state(name)
        if st.health == "healthy":
            self.log.append(("healthy", name))
        return st


def reduced_template() -> dict:
    """The shop template cut down to the two components the stub can run (injector and shop), same volumes."""
    t = copy.deepcopy(template())
    t["components"] = [c for c in t["components"] if c["role"] in ("injector", "shop")]
    return t


def stub_allowlist(image_id: str, injector_command=("inject",)) -> ImageAllowlist:
    roles = ("shop", "injector", "volume-keeper")
    return ImageAllowlist(
        {r: image_id for r in roles},
        entrypoints={"volume-keeper": ("node", "-e", "setInterval(()=>{},1<<30)")},
        commands={"shop": ("shop",), "injector": tuple(injector_command)}, allow_local_ids=True,  # the stub is a local image id
    )


def leftovers(client, iid):
    flt = {"label": f"vm.instance={iid}"}
    return (
        [c.name for c in client.containers.list(all=True, filters=flt)],
        [n.name for n in client.networks.list(filters=flt)],
        [v.name for v in client.volumes.list(filters=flt)],
    )


@pytest.fixture
def clean(docker_client):
    yield
    Orchestrator(SdkBackend(docker_client), {}, ImageAllowlist({})).destroy(IID)


def make(docker_client, image_id, **kw):
    be = Recording(docker_client)
    orch = Orchestrator(be, {"shop-v0": reduced_template()}, stub_allowlist(image_id, **kw), health_timeout_s=60, injector_timeout_s=60)
    return orch, be


def test_create_reaches_ready_only_after_the_injector_exit_and_destroy_leaves_nothing(docker_client, stub_image_id, clean):
    orch, be = make(docker_client, stub_image_id)
    rec = orch.create(body(iid=IID))
    assert rec.state is S.READY, [(t.to_state.value, t.reason, t.error_code) for t in rec.transitions]
    assert [t.to_state for t in rec.transitions] == [S.REQUESTED, S.PROVISIONING, S.STARTING, S.READY]

    names = [n for _, n in be.log]
    keeper = next(n for o, n in be.log if o == "start")
    assert keeper.endswith("-volume-keeper") and be.log[0][1] == keeper
    inj_start = next(i for i, (o, n) in enumerate(be.log) if o == "start_with_stdin" and n.endswith("-injector"))
    inj_exit = next(i for i, (o, n) in enumerate(be.log) if o == "exited" and n.endswith("-injector:0"))
    shop_start = next(i for i, (o, n) in enumerate(be.log) if o == "start" and n.endswith("-shop"))
    shop_healthy = next(i for i, (o, n) in enumerate(be.log) if o == "healthy" and n.endswith("-shop"))
    assert 0 < inj_start < inj_exit < shop_start < shop_healthy, names

    cs, ns, vs = leftovers(docker_client, IID)
    assert len(cs) == 2 and len(ns) == 1 and len(vs) == 4  # keeper and shop; the injector was removed at once
    shop = docker_client.containers.get(next(c for c in cs if c.endswith("-shop")))
    assert shop.attrs["State"]["Health"]["Status"] == "healthy"
    hc = shop.attrs["HostConfig"]
    assert hc["ReadonlyRootfs"] is True and hc["Privileged"] is False and hc["CapDrop"] == ["ALL"] and shop.attrs["Config"]["User"] == "65532:65532"
    assert hc["NetworkMode"] != "host" and not hc.get("Binds")
    # no flag, seed or event key in any container setting or label (docker inspect)
    for c in cs:
        raw = json.dumps(docker_client.api.inspect_container(c))
        assert FLAG_A not in raw and SEED not in raw and EVENT_KEY not in raw
    net = docker_client.networks.get(ns[0])
    assert net.attrs["Internal"] is True and net.attrs["Labels"]["vm.instance"] == IID

    done = orch.destroy(IID)
    assert done.state is S.DESTROYED
    assert leftovers(docker_client, IID) == ([], [], [])
    assert orch.destroy(IID).state is S.DESTROYED  # a second destroy succeeds


def test_reset_gives_a_new_epoch_removes_the_old_objects_and_the_new_flags_only_reach_the_injector(docker_client, stub_image_id, clean):
    new_flag, new_seed, new_key = "VM{" + "D" * 24 + "}", "RESET-SEED-NOT-REAL-" + "D" * 24, "RESET-EVENT-KEY-NOT-REAL-" + "D" * 24
    orch, be = make(docker_client, stub_image_id)
    assert orch.create(body(iid=IID)).state is S.READY
    used = orch.host_status()["used_memory_mb"]
    old_names = set(leftovers(docker_client, IID)[0] + leftovers(docker_client, IID)[1] + leftovers(docker_client, IID)[2])
    assert old_names and all("-e1" in n for n in old_names)

    reset = {k: body()[k] for k in ("flags", "decoys", "flag_digests", "event_key", "seed")}
    reset["flags"] = [{"challenge_key": "C01", "flag": new_flag}, reset["flags"][1]]
    reset.update(epoch=2, event_key=new_key, seed=new_seed)
    rec = orch.reset(IID, reset)
    assert rec.state is S.READY and rec.epoch == 2, [(t.to_state.value, t.reason, t.error_code) for t in rec.transitions]

    cs, ns, vs = leftovers(docker_client, IID)
    assert not (old_names & set(cs + ns + vs))  # every object of epoch 1 is gone, the volumes included (H-61)
    assert len(cs) == 2 and len(ns) == 1 and len(vs) == 4 and all("-e2" in n for n in cs + ns + vs)
    assert orch.host_status()["used_memory_mb"] == used  # the memory of the instance is unchanged
    doc = json.loads(next(d for n, d in be.documents.items() if "-e2-" in n and n.endswith("-injector")))
    assert doc["epoch"] == 2 and doc["seed"] == new_seed and doc["flags"][0]["flag"] == new_flag  # the new flags reached the injector
    for c in cs:  # and nowhere else: no container setting or label holds them
        raw = json.dumps(docker_client.api.inspect_container(c))
        assert new_flag not in raw and new_seed not in raw and new_key not in raw and FLAG_A not in raw
    assert new_flag not in json.dumps(orch.view(IID))
    assert orch.destroy(IID).state is S.DESTROYED and leftovers(docker_client, IID) == ([], [], [])


def test_a_failing_injector_gives_failed_and_leaves_nothing(docker_client, stub_image_id, clean):
    orch, be = make(docker_client, stub_image_id, injector_command=("no-such-command",))  # the stub exits 2: a crash
    rec = orch.create(body(iid=IID))
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.INJECT_FAILED
    assert leftovers(docker_client, IID) == ([], [], [])
    assert not any(o == "start" and n.endswith("-shop") for o, n in be.log)  # the shop never started


def test_a_shop_that_is_never_healthy_times_out_and_leaves_nothing(docker_client, stub_image_id, clean):
    orch, be = make(docker_client, stub_image_id)
    orch.health_timeout_s = 3
    t = reduced_template()
    shop = next(c for c in t["components"] if c["role"] == "shop")
    shop["healthcheck"] = {**shop["healthcheck"], "port": 3999}  # nothing listens there
    orch.templates = {"shop-v0": t}
    start = time.monotonic()
    rec = orch.create(body(iid=IID))
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.HEALTH_TIMEOUT
    assert time.monotonic() - start < 60
    assert leftovers(docker_client, IID) == ([], [], [])


def test_a_process_killed_during_a_real_create_leaves_nothing_after_the_first_pass_of_a_new_engine(docker_client, stub_image_id, clean, tmp_path):
    """FR-INS-05, S-13: a child process creates an instance and stalls at its first start, is killed with its objects in Docker, and a new engine's
    first pass removes every object and records the id as failed."""
    import sys

    script = tmp_path / "child_create.py"  # outside the package and the tests: only this file is in its own directory
    script.write_text(
        "import sys\n"
        "from support import body\n"
        "import test_docker_integration as t\n"
        "import docker\n"
        "from vulnmart_orchestrator.backend import SdkBackend\n"
        "from vulnmart_orchestrator.engine import Orchestrator\n"
        "image = sys.argv[1]\n"
        "import time\n"
        "class Slow(SdkBackend):\n"
        "    def start(self, name):\n"
        "        time.sleep(300)  # the objects exist and nothing has started: the parent kills this process here\n"
        "orch = Orchestrator(Slow(docker.from_env()), {'shop-v0': t.reduced_template()}, t.stub_allowlist(image))\n"
        f"orch.create(body(iid={IID!r}))\n",
        encoding="utf-8",
    )
    tests_dir = os.path.dirname(os.path.abspath(__file__))
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([tests_dir, str(ROOT / "apps" / "orchestrator" / "src")])}
    plan = build_plan(reduced_template(), parse_create(body(iid=IID)), stub_allowlist(stub_image_id))
    want = (len(plan.containers), 1, len(plan.volumes))
    child = subprocess.Popen([sys.executable, str(script), stub_image_id], env=env, cwd=tmp_path, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        end = time.monotonic() + 90
        while True:
            cs, ns, vs = leftovers(docker_client, IID)
            if (len(cs), len(ns), len(vs)) == want:  # everything of the plan is created, the worker now sits at its first start
                break
            assert child.poll() is None, "the child ended before it created its objects"
            assert time.monotonic() < end, "the child never created its objects"
            time.sleep(0.2)
    finally:
        child.kill()
        child.wait(30)
    assert leftovers(docker_client, IID) != ([], [], [])  # the kill left the objects behind

    seen = []
    new = Orchestrator(SdkBackend(docker_client), {"shop-v0": reduced_template()}, stub_allowlist(stub_image_id), on_transition=seen.append,
                       reconcile_gate=True)
    result = new.reconcile()
    assert not result.errors and result.failed == [IID], result
    assert leftovers(docker_client, IID) == ([], [], [])
    rec = new.get(IID)
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.START_FAILED and len(seen) == 1


def test_a_complete_running_instance_is_adopted_ready_by_a_second_engine_and_its_objects_stay(docker_client, stub_image_id, clean):
    first, _ = make(docker_client, stub_image_id)
    assert first.create(body(iid=IID)).state is S.READY
    before = [sorted(x) for x in leftovers(docker_client, IID)]
    seen = []
    second = Orchestrator(SdkBackend(docker_client), {"shop-v0": reduced_template()}, stub_allowlist(stub_image_id), on_transition=seen.append,
                          desired=FakeDesiredState({IID}), reconcile_gate=True)
    result = second.reconcile()
    rec = second.get(IID)
    assert result.adopted == [IID] and not result.errors and rec.state is S.READY and (rec.access, rec.access_epoch) == ("closed", 0), result
    assert [sorted(x) for x in leftovers(docker_client, IID)] == before and len(seen) == 1
    assert second.destroy(IID).state is S.DESTROYED and leftovers(docker_client, IID) == ([], [], [])

# ---------------------------------------------------------------- through the Docker socket proxy (story 4.2, ADR 0010, D-58)

PROXY_URL = "tcp://127.0.0.1:2375"
COMPOSE_FILE = ROOT / "infra" / "compose" / "compose.yaml"


def _compose(*args, timeout=300):
    return subprocess.run(["docker", "compose", "-f", str(COMPOSE_FILE), "--profile", "lab", *args], cwd=ROOT, capture_output=True, text=True,
                          timeout=timeout)


@pytest.fixture(scope="module")
def socket_proxy(docker_client):
    """Starts the `docker-proxy` service of the lab profile and waits until it is healthy; stops it afterwards if this fixture started it."""
    was_running = bool(_compose("ps", "--status", "running", "-q", "docker-proxy").stdout.strip())
    up = _compose("up", "-d", "--wait", "docker-proxy")
    if up.returncode != 0:
        message = "the docker-proxy service did not start: " + up.stderr[-400:]
        if is_ci():
            pytest.fail(message)
        pytest.skip(message)
    yield PROXY_URL
    if not was_running:
        _compose("down")


def _status(method, path):
    import http.client

    conn = http.client.HTTPConnection("127.0.0.1", 2375, timeout=10)
    try:
        conn.request(method, path)
        resp = conn.getresponse()
        resp.read()
        resp.close()
        return resp.status
    finally:
        conn.close()


def test_the_proxy_answers_403_for_every_section_the_orchestrator_does_not_use(socket_proxy):
    for method, path in [
        ("POST", "/containers/anything/exec"), ("POST", "/v1.43/containers/anything/exec"), ("POST", "/exec/anything/start"), ("GET", "/images/json"),
        ("POST", "/build"), ("POST", "/commit"), ("GET", "/info"), ("GET", "/system/df"), ("POST", "/swarm/init"), ("GET", "/secrets"),
        ("GET", "/services"), ("GET", "/plugins"), ("POST", "/auth"), ("GET", "/events"), ("POST", "/containers/anything/stop"),
        ("POST", "/containers/anything/kill"), ("GET", "/containers/anything/archive?path=/"), ("PUT", "/containers/anything/archive?path=/"),
    ]:
        assert _status(method, path) == 403, (method, path)
    for method, path in [("GET", "/_ping"), ("GET", "/version"), ("GET", "/containers/json"), ("GET", "/networks"), ("GET", "/volumes")]:
        assert _status(method, path) == 200, (method, path)


def test_create_reset_and_destroy_work_through_the_proxy_and_leave_nothing(docker_client, stub_image_id, socket_proxy, clean):
    be = _recording_via(socket_proxy)  # the same real backend class, pointed at the proxy
    orch = Orchestrator(be, {"shop-v0": reduced_template()}, stub_allowlist(stub_image_id), health_timeout_s=60, injector_timeout_s=60)
    rec = orch.create(body(iid=IID))
    assert rec.state is S.READY, [(t.to_state.value, t.reason, t.error_code) for t in rec.transitions]
    cs, ns, vs = leftovers(docker_client, IID)
    assert len(cs) == 2 and len(ns) == 1 and len(vs) == 4

    reset = {k: body()[k] for k in ("flags", "decoys", "flag_digests", "event_key", "seed")}
    reset["epoch"] = 2
    rec = orch.reset(IID, reset)
    assert rec.state is S.READY and rec.epoch == 2, [(t.to_state.value, t.reason, t.error_code) for t in rec.transitions]
    cs, ns, vs = leftovers(docker_client, IID)
    assert len(cs) == 2 and len(ns) == 1 and len(vs) == 4 and all("-e2" in n for n in cs + ns + vs)

    assert orch.destroy(IID).state is S.DESTROYED
    assert leftovers(docker_client, IID) == ([], [], [])


def _recording_via(url):
    import docker

    return Recording(docker.DockerClient(base_url=url))


def test_a_proxy_that_is_down_gives_failed_with_a_start_error_and_leaves_nothing(docker_client, stub_image_id, socket_proxy, clean):
    be = _recording_via(socket_proxy)  # connected while the proxy is up, so the client is built
    orch = Orchestrator(be, {"shop-v0": reduced_template()}, stub_allowlist(stub_image_id), health_timeout_s=60, injector_timeout_s=60)
    assert _compose("stop", "docker-proxy").returncode == 0
    try:
        rec = orch.create(body(iid=IID))
    finally:
        assert _compose("up", "-d", "--wait", "docker-proxy").returncode == 0
    assert rec.state is S.FAILED and rec.error_code == ErrorCode.START_FAILED, [(t.to_state.value, t.reason, t.error_code) for t in rec.transitions]
    assert leftovers(docker_client, IID) == ([], [], [])


def _raw(method, path):
    """Sends the request line exactly as written (no normalising) and returns the status."""
    import socket

    with socket.create_connection(("127.0.0.1", 2375), timeout=10) as s:
        s.sendall(f"{method} {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".encode())
        s.settimeout(10)
        data = b""
        while b"\r\n" not in data:
            chunk = s.recv(256)
            if not chunk:
                break
            data += chunk
    return int(data.split(b" ", 2)[1])


def test_odd_paths_and_methods_are_refused_by_the_proxy(socket_proxy):
    for method, path in [
        ("GET", "//containers/json"), ("GET", "/containers/x/../exec"), ("POST", "/containers/x/../exec"), ("POST", "/containers/x/%2e%2e/exec"),
        ("POST", "/containers/x/%2E%2E/exec"), ("GET", "/containers/../info"), ("GET", "/containers/%2e%2e/info"), ("GET", "/containers/../containers/json"),
        ("get", "/containers/json"), ("Get", "/_ping"), ("HEAD", "/_ping"), ("DELETE", "/containers/.."), ("DELETE", "/containers/vm-x/.."),
        ("DELETE", "/containers/%2e%2e"), ("GET", "/v1/_ping"), ("GET", "/v1.43.1/_ping"), ("GET", "/containers/./json"),
    ]:
        assert _raw(method, path) == 403, (method, path)
    assert _raw("GET", "/v1.43/_ping") == 200 and _raw("GET", "/_ping") == 200


def test_the_proxy_only_drives_objects_named_vm_and_a_foreign_object_stays(docker_client, stub_image_id, socket_proxy):
    import uuid

    import docker

    name = "foreign-probe-" + uuid.uuid4().hex[:10]
    container = volume = network = None
    try:
        volume = docker_client.volumes.create(name=name)
        network = docker_client.networks.create(name, driver="bridge")
        container = docker_client.containers.create(stub_image_id, name=name, command=["shop"])
        for method, path in [
            ("DELETE", f"/containers/{name}"), ("DELETE", f"/containers/{name}?force=1&v=1"), ("POST", f"/containers/{name}/start"),
            ("POST", f"/containers/{name}/attach?stdin=1&stream=1"), ("DELETE", f"/volumes/{name}"), ("DELETE", f"/volumes/{name}?force=1"),
            ("DELETE", f"/networks/{name}"), ("POST", f"/containers/{container.id}/start"), ("DELETE", f"/containers/{container.id}"),
            ("DELETE", f"/networks/{network.id}"), ("POST", f"/containers/create?name={name}-2"), ("POST", "/containers/create"),
        ]:
            assert _status(method, path) == 403, (method, path)
        # through the real backend client the refusal is a backend error, not a silent success
        be = _recording_via(socket_proxy)
        with pytest.raises(docker.errors.APIError):
            be.api.remove_container(name, force=True)
        # the foreign objects are all still there, and the container never started
        assert docker_client.containers.get(name).status == "created"
        docker_client.volumes.get(name)
        docker_client.networks.get(name)
        assert not [c for c in docker_client.containers.list(all=True) if c.name == f"{name}-2" or c.name == f"{name}-3"]
    finally:
        for obj in (container, network, volume):
            if obj is not None:
                try:
                    obj.remove(force=True) if obj is container else obj.remove()
                except docker.errors.DockerException:
                    pass
