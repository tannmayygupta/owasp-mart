"""Client side of `node scripts/dev.mjs demo` (story 17).

Drives the real orchestrator service with the PLATFORM's own client, `HttpInstanceHost` of apps/api (IF-5).
Run through uv so the api package is installed:

    uv run --locked --package vulnmart-api python scripts/demo_client.py --url http://127.0.0.1:PORT --key-file FILE --mode stub|shop [--probe]

Every flag, seed, event key and owner is a random fake made for the run (like `vulnmart_orchestrator.measure`). Nothing real is
used. One line per step on stdout: `STEP {"name": ..., "ok": true|false, "detail": ...}`. Details hold numbers, states and codes
only: no address, key or flag. The exit code is 0 when the script ran to the end; the caller reads the STEP lines.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import secrets
import subprocess
import sys
import time
from pathlib import Path

from vulnmart.ports.http_instance_host import HttpInstanceHost
from vulnmart.ports.instance_host import (
    Access, CreateRequest, DecoyEntry, DigestEntry, FlagEntry, FlagMaterial, InstanceNotFound, InstanceState, Limits,
    OrchestratorError,
)

LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"
TERMINAL = (InstanceState.READY, InstanceState.FAILED, InstanceState.DESTROYED)


def step(name: str, ok: bool, detail: str) -> bool:
    print("STEP " + json.dumps({"name": name, "ok": bool(ok), "detail": detail}), flush=True)
    return bool(ok)


def new_iid() -> str:
    iid = "i-" + "".join(secrets.choice(LETTERS) for _ in range(16))
    print(f"IID {iid}", flush=True)  # the demo removes only the instances this client made (L17 of the audit)
    return iid


def fake_flag() -> str:
    return "VM{" + "".join(secrets.choice(LETTERS) for _ in range(24)) + "}"


def make_request(iid: str, template_id: str = "shop-v0") -> tuple[CreateRequest, list[str]]:
    """A create request with random fake secrets. Also returns the secret strings, to prove they never come back."""
    f1, f2, decoy = fake_flag(), fake_flag(), fake_flag()
    event_key, seed = secrets.token_hex(32), secrets.token_hex(32)
    digests = [hashlib.sha256(f.encode()).hexdigest() for f in (f1, f2)]
    material = FlagMaterial(
        flags=(FlagEntry("C01", f1), FlagEntry("C02", f2)),
        decoys=(DecoyEntry("C01", 0, decoy),),
        flag_digests=(DigestEntry("C01", digests[0]), DigestEntry("C02", digests[1])),
        event_key=event_key, seed=seed,
    )
    req = CreateRequest(
        instance_id=iid, template_id=template_id, epoch=1, material=material,
        hostname=f"{iid.lower()}.instances.example.invalid",
        limits=Limits(memory_mb=256, cpu_limit=1.5, pids_limit=512, idle_minutes=30, max_minutes=120),
        owner_hash=hashlib.sha256(secrets.token_bytes(16)).hexdigest(),
    )
    return req, [f1, f2, decoy, event_key, seed, *digests]


def wait_state(host, iid: str, states, timeout_s: float):
    deadline = time.monotonic() + timeout_s
    while True:
        st = host.get(iid)
        if st.state in states or time.monotonic() > deadline:
            return st
        time.sleep(0.5)


def docker(*args: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)


def leftovers() -> dict[str, int]:
    flt = "label=vm.instance"
    out = {}
    for kind, cmd in (("containers", ["ps", "-a", "-q"]), ("networks", ["network", "ls", "-q"]), ("volumes", ["volume", "ls", "-q"])):
        r = docker(*cmd, "--filter", flt)
        out[kind] = len([x for x in r.stdout.split() if x])
    return out


def shop_container(iid: str) -> str | None:
    r = docker("ps", "-q", "--filter", f"label=vm.instance={iid}", "--filter", "label=vm.component=shop")
    ids = r.stdout.split()
    return ids[0] if ids else None


def exec_readyz(cid: str, mode: str) -> tuple[bool, str]:
    if mode == "shop":  # the real shop image is distroless: no wget, so use its own node
        r = docker("exec", cid, "/nodejs/bin/node", "-e",
                   "fetch('http://127.0.0.1:3000/readyz').then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))")
        return r.returncode == 0, f"node fetch exit {r.returncode}, HTTP {r.stdout.strip() or 'none'}"
    r = docker("exec", cid, "wget", "-q", "-O", "-", "http://127.0.0.1:3000/readyz")
    return r.returncode == 0, f"wget exit {r.returncode}, answer of {len(r.stdout)} bytes"


def probe(host, mode: str, wait_s: float) -> int:
    """Create one instance, report whether it reaches ready, destroy it. Used to test the real shop in the shop role."""
    iid = new_iid()
    req, _ = make_request(iid)
    ok, detail = False, ""
    try:
        host.create(req)
        st = wait_state(host, iid, TERMINAL, wait_s)
        ok = st.state is InstanceState.READY
        detail = f"state {st.state.value}, health {st.health.value}, error {st.error_code or 'none'}"
        if ok:
            cid = shop_container(iid)
            if cid is None:
                ok, detail = False, "ready but no shop container found"
            else:
                ok, d2 = exec_readyz(cid, mode)
                detail += "; " + d2
    except OrchestratorError as exc:
        detail = f"error {exc.code}"
    finally:
        try:
            host.destroy(iid)
            wait_state(host, iid, (InstanceState.DESTROYED,), 60)
        except OrchestratorError:
            pass
    step("probe", ok, detail)
    return 0


def full(host, mode: str, wait_s: float) -> int:
    iid = new_iid()
    req, secrets_list = make_request(iid)
    created = False
    try:
        hs = host.host_status()
        step("host-status", hs.health.value == "ok",
             f"kind {hs.kind}, capacity {hs.capacity_memory_mb} MB, used {hs.used_memory_mb} MB, instances {hs.instances}, health {hs.health.value}")

        out = host.create(req)
        created = True
        st = wait_state(host, iid, TERMINAL, wait_s)
        step("create-and-ready", out.changed and st.state is InstanceState.READY,
             f"accepted new work {out.changed}, first state {out.status.state.value}, then {st.state.value}, health {st.health.value}, error {st.error_code or 'none'}")

        got = host.get(iid)
        blob = json.dumps(dataclasses.asdict(got), default=str)
        leaked = [i for i, s in enumerate(secrets_list) if s in blob]
        step("get-has-no-secrets", not leaked,
             f"{len(dataclasses.fields(got))} fields ({', '.join(f.name for f in dataclasses.fields(got))}); {len(secrets_list)} secret values checked, {len(leaked)} found")

        cid = shop_container(iid)
        if cid is None:
            step("shop-readyz-inside", False, "no shop container found for the instance")
        else:
            ok, detail = exec_readyz(cid, mode)
            step("shop-readyz-inside", ok, detail)

        acc = host.set_access(iid, Access.OPEN, got.access_epoch + 1)
        step("open-access", acc.access is Access.OPEN, f"access {acc.access.value}, access_epoch {acc.access_epoch}")

        page = host.list_instances()
        step("list", any(i.instance_id == iid for i in page.items), f"{len(page.items)} instance(s) listed, next_cursor {'set' if page.next_cursor else 'none'}")

        again = host.create(req)
        step("create-again-is-idempotent", not again.changed and again.status.instance_id == iid and again.status.epoch == 1,
             f"changed {again.changed} (200 means a repeat), state {again.status.state.value}, epoch {again.status.epoch}")

        bad_req, _ = make_request(new_iid(), template_id="no-such-template")
        try:
            host.create(bad_req)
            step("error-format-if8", False, "an unknown template was accepted")
        except OrchestratorError as exc:
            step("error-format-if8", exc.code == "ORCH-TEMPLATE-UNKNOWN",
                 f"code {exc.code}, HTTP {exc.http_status}, request_id {'present' if exc.request_id else 'absent'}, field {exc.field or 'none'}")

        d1 = host.destroy(iid)
        final = wait_state(host, iid, (InstanceState.DESTROYED,), 90)
        step("destroy", d1.changed and final.state is InstanceState.DESTROYED,
             f"accepted new work {d1.changed}, final state {final.state.value}")

        try:
            d2 = host.destroy(iid)
            step("destroy-again-is-idempotent", not d2.changed and d2.status.state is InstanceState.DESTROYED,
                 f"changed {d2.changed}, state {d2.status.state.value}")
        except InstanceNotFound as exc:
            step("destroy-again-is-idempotent", True, f"answered {exc.code} (the record is already gone)")
        created = False
    except OrchestratorError as exc:
        step("client-error", False, f"{exc.code}: {exc.message}")
    finally:
        if created:
            try:
                host.destroy(iid)
                wait_state(host, iid, (InstanceState.DESTROYED,), 60)
            except OrchestratorError:
                pass
    left = leftovers()
    step("nothing-left-over", not any(left.values()), ", ".join(f"{v} {k}" for k, v in left.items()) + " labelled vm.instance")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Demo client for the orchestrator (IF-5)")
    p.add_argument("--url", required=True)
    p.add_argument("--key-file", required=True)
    p.add_argument("--mode", choices=("stub", "shop"), default="stub")
    p.add_argument("--probe", action="store_true")
    p.add_argument("--wait-s", type=float, default=120)
    a = p.parse_args(argv)
    key = Path(a.key_file).read_text(encoding="utf-8").strip().encode()
    host = HttpInstanceHost(a.url, key, timeout=30)
    try:
        return probe(host, a.mode, a.wait_s) if a.probe else full(host, a.mode, a.wait_s)
    except Exception as exc:  # never print a traceback with request data
        step("client-crash", False, type(exc).__name__)
        return 0


if __name__ == "__main__":
    sys.exit(main())
