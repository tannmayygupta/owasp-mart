"""Story edge-3, real Docker: the engine with a real edge-stand-in container, the real `GatePort` and a small real HTTP gate that writes down every
push. The same matrix rows as `test_edge_fake.py`, run on the Docker daemon: create, open, freeze, reset, destroy, and a gate that is down."""
from __future__ import annotations

import json

import pytest
from support import OWNER, body
from test_docker_integration import (  # noqa: F401  (fixtures are used by name)
    IID, S, Recording, _attached, clean, docker_client, leftovers, reduced_template, stub_allowlist, stub_image_id, throwaway_edge,
)
from test_gate_port import SECRET, Server

from vulnmart_orchestrator.engine import Orchestrator
from vulnmart_orchestrator.gate import GatePort


@pytest.fixture
def gate_server():
    s = Server()
    yield s
    s.close()


@pytest.fixture
def key_file(tmp_path):
    f = tmp_path / "gate.key"
    f.write_text(SECRET + "\n", encoding="utf-8")
    return str(f)


def summary(server):
    out = []
    for r in server.requests:
        if r["method"] == "DELETE":
            out.append(("delete", r["path"].rsplit("/", 1)[1]))
        else:
            b = json.loads(r["body"])
            out.append(("put", b["instance_id"], b["epoch"], b["access"], b["access_epoch"], b["owner"]))
    return out


def test_create_open_freeze_reset_destroy_with_the_edge_and_a_real_gate_leave_nothing(docker_client, stub_image_id, gate_server, key_file, clean):
    with throwaway_edge(docker_client, stub_image_id) as edge:
        orch = Orchestrator(Recording(docker_client), {"shop-v0": reduced_template()}, stub_allowlist(stub_image_id), health_timeout_s=60,
                            injector_timeout_s=60, edge_container=edge.name, gate=GatePort(gate_server.url, key_file))
        rec = orch.create(body(iid=IID))
        assert rec.state is S.READY, [(t.to_state.value, t.reason, t.error_code) for t in rec.transitions]
        net1 = f"vm-{IID.lower()}-e1-net"
        assert _attached(docker_client, net1, edge)
        assert summary(gate_server) == [("put", IID, 1, "closed", 0, OWNER)]
        assert all(r["headers"]["x-vm-gate-admin"] == SECRET for r in gate_server.requests)

        orch.set_access(IID, "open", 1)
        orch.set_access(IID, "frozen", 2)
        reset = {k: body()[k] for k in ("flags", "decoys", "flag_digests", "event_key", "seed")}
        reset["epoch"] = 2
        assert orch.reset(IID, reset).state is S.READY
        assert _attached(docker_client, f"vm-{IID.lower()}-e2-net", edge)
        assert not [n for n in docker_client.networks.list() if n.name == net1]
        assert summary(gate_server) == [
            ("put", IID, 1, "closed", 0, OWNER), ("put", IID, 1, "open", 1, OWNER), ("put", IID, 1, "frozen", 2, OWNER),
            ("put", IID, 2, "frozen", 2, OWNER),
        ]
        # a gate that is down: the access call fails and the record does not change
        gate_server.close()
        before = (orch.records[IID].access, orch.records[IID].access_epoch)
        with pytest.raises(Exception):
            orch.set_access(IID, "open", 9)
        assert (orch.records[IID].access, orch.records[IID].access_epoch) == before
        # the gate is back for the destroy
        gate_server.__init__()
        orch.gate = GatePort(gate_server.url, key_file)
        assert orch.destroy(IID).state is S.DESTROYED
        assert leftovers(docker_client, IID) == ([], [], [])
        assert not [n.name for n in docker_client.networks.list() if n.name.startswith("vm-") and _attached(docker_client, n.name, edge)]
        assert summary(gate_server)[-1] == ("delete", IID)
    # the pushes before the outage, in order (the new server only saw the destroy: the close push of an instance that is frozen, then the delete)

