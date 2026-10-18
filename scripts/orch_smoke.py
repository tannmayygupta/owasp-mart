"""Create one instance through a running orchestrator over mutual TLS, watch its state, destroy it, print the states.

A live-check helper for the developer (docs/runbooks/edge-vm-i.md part 3b), run inside the api image:
  docker run --rm --network host -v <certs folder>:/certs:ro vulnmart-api:lab python /scripts/orch_smoke.py ...
It uses the platform client `HttpInstanceHost` (IF-5) with throwaway flag material from a FAKE key port with random keys, so no flag of
a real run is involved. Output holds the instance id, states and error codes only: never a key, flag, address or certificate.
"""
from __future__ import annotations

import argparse
import base64
import secrets
import ssl
import sys
import time
from pathlib import Path

from vulnmart.flags.material import CHALLENGE_KEYS, build_material
from vulnmart.ports.fakes import FakeKeyPort
from vulnmart.ports.http_instance_host import HttpInstanceHost
from vulnmart.ports.instance_host import Access, CreateRequest, InstanceNotFound, InstanceState, Limits, OrchestratorError

TERMINAL = {InstanceState.READY, InstanceState.FAILED, InstanceState.DESTROYED}


def short(instance_id: str) -> str:
    return instance_id[:6] + "..."


def wait_for(host: HttpInstanceHost, instance_id: str, states: set[InstanceState], seconds: float) -> InstanceState | None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            state = host.get(instance_id).state
        except InstanceNotFound:
            return InstanceState.DESTROYED
        if state in states:
            return state
        time.sleep(1)
    return None


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--url", required=True, help="https base URL of the orchestrator, for example https://<private address>:9443")
    p.add_argument("--key-file", required=True, help="the platform signing key file")
    p.add_argument("--ca", required=True, help="CA that signed the orchestrator server certificate")
    p.add_argument("--cert", required=True, help="client certificate")
    p.add_argument("--key", required=True, help="client private key")
    p.add_argument("--template", default="shop-v0")
    p.add_argument("--zone", default="labs.example.invalid", help="the host name zone of the gate")
    p.add_argument("--wait", type=float, default=60.0, help="seconds to wait for a resting state")
    args = p.parse_args(argv)

    context = ssl.create_default_context(cafile=args.ca)
    context.load_cert_chain(args.cert, args.key)
    host = HttpInstanceHost(args.url, Path(args.key_file).read_bytes().strip(), ssl_context=context, timeout=15.0)

    instance_id = "i-" + base64.b32encode(secrets.token_bytes(10)).decode("ascii")
    keys = FakeKeyPort(event_master=secrets.token_bytes(32), flag_key=secrets.token_bytes(32), owner_key=secrets.token_bytes(32))
    request = CreateRequest(
        instance_id=instance_id, template_id=args.template, epoch=1, material=build_material(keys, instance_id, 1, CHALLENGE_KEYS),
        hostname=f"{instance_id.lower()}.{args.zone}", limits=Limits(memory_mb=256, cpu_limit=1.0, pids_limit=256, idle_minutes=30, max_minutes=60),
        owner_hash=keys.owner_hash("orch-smoke"),
    )
    code = 0
    try:
        outcome = host.create(request)
        print(f"create {instance_id}: accepted, state {outcome.status.state.value}")
        state = wait_for(host, instance_id, TERMINAL, args.wait)
        print(f"resting state: {state.value if state else 'not reached in time'}")
        if state is None:
            code = 1
    except OrchestratorError as exc:
        print(f"create refused: {type(exc).__name__}")
        code = 1
    try:
        host.set_access(instance_id, Access.CLOSED, 1)
    except OrchestratorError:
        pass  # a failed instance may refuse access changes; the destroy below is what matters
    try:
        host.destroy(instance_id)
        final = wait_for(host, instance_id, {InstanceState.DESTROYED}, args.wait)
        print(f"destroy: {final.value if final else 'not destroyed in time'}")
        if final is None:
            code = 1
    except OrchestratorError as exc:
        print(f"destroy refused: {type(exc).__name__}")
        code = 1
    return code


if __name__ == "__main__":
    sys.exit(main())
