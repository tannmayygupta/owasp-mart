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
from vulnmart_orchestrator.engine import Orchestrator
from vulnmart_orchestrator.images import ImageAllowlist
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
