"""Spike S-4 tool (story 3.3): cold-start time and memory per instance, measured with the real engine and the real Docker backend.

Run on the labs host by the developer (never in CI):

    uv run --package vulnmart-orchestrator python -m vulnmart_orchestrator.measure --stub-image <image id> --out <dir>

Cold start = create accepted until the instance is `ready` (images are already on the host; a pull is not counted).
Memory = sum of the container memory of one instance (docker stats, cache excluded) and the drop of host `MemAvailable`
while N instances run. The flags, seed and event key are random values made for the run; nothing real is used or printed.
The report holds numbers, the host kernel/CPU/RAM class and the Docker version, no address, name or account.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import platform
import secrets
import statistics
import time
from pathlib import Path

from .backend import SdkBackend
from .engine import Orchestrator
from .images import ImageAllowlist
from .states import InstanceState

ROOT = Path(__file__).resolve().parents[4]
TEMPLATE_FILE = ROOT / "contracts" / "instance" / "examples" / "valid" / "instance-template" / "shop-template.json"
LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"


def _iid() -> str:
    return "i-" + "".join(secrets.choice(LETTERS) for _ in range(16))


def _flag() -> str:
    return "VM{" + "".join(secrets.choice(LETTERS) for _ in range(24)) + "}"


def make_body(iid: str, memory_mb: int) -> dict:
    flags = [_flag(), _flag()]
    return {
        "instance_id": iid, "template_id": "shop-v0", "epoch": 1,
        "owner_hash": hashlib.sha256(secrets.token_bytes(16)).hexdigest(),
        "hostname": f"{iid.lower()}.instances.example.invalid",
        "limits": {"memory_mb": memory_mb, "cpu_limit": 1.5, "pids_limit": 512, "idle_minutes": 30, "max_minutes": 120},
        "flags": [{"challenge_key": "C01", "flag": flags[0]}, {"challenge_key": "C02", "flag": flags[1]}],
        "decoys": [{"challenge_key": "C01", "index": 0, "value": _flag()}],
        "flag_digests": [{"challenge_key": "C01", "sha256": hashlib.sha256(flags[0].encode()).hexdigest()},
                         {"challenge_key": "C02", "sha256": hashlib.sha256(flags[1].encode()).hexdigest()}],
        "event_key": secrets.token_hex(32), "seed": secrets.token_hex(32),
    }


def mem_available_mb() -> float | None:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / 1024
    except OSError:
        pass
    return None


def host_class() -> dict:
    total = None
    try:
        total = next(int(x.split()[1]) / 1024 for x in Path("/proc/meminfo").read_text().splitlines() if x.startswith("MemTotal:"))
    except (OSError, StopIteration):
        pass
    return {"os": platform.system(), "kernel": platform.release(), "machine": platform.machine(), "cpus": os.cpu_count(),
            "mem_total_mb": round(total) if total else None}


def container_mb(client, instance_id: str) -> float:
    """Memory of all running containers of one instance: usage minus page cache (what `docker stats` shows)."""
    total = 0.0
    for c in client.containers.list(filters={"label": f"vm.instance={instance_id}"}):
        m = c.stats(stream=False).get("memory_stats", {})
        stats = m.get("stats", {})
        total += (m.get("usage", 0) - stats.get("inactive_file", stats.get("cache", 0))) / 1048576
    return total


def summary(values: list[float]) -> dict:
    s = sorted(values)
    return {"n": len(s), "min": round(s[0], 2), "median": round(statistics.median(s), 2),
            "p95": round(s[min(len(s) - 1, int(0.95 * len(s)))], 2), "max": round(s[-1], 2)}


def leftovers(client) -> int:
    flt = {"label": "vm.instance"}
    return len(client.containers.list(all=True, filters=flt)) + len(client.networks.list(filters=flt)) + len(client.volumes.list(filters=flt))


def run(args: argparse.Namespace) -> dict:
    import docker

    client = docker.from_env()
    client.ping()
    if args.manifest:
        allow = ImageAllowlist.load(args.manifest, allow_local_ids=args.allow_local_images)
        template = json.loads(TEMPLATE_FILE.read_text(encoding="utf-8"))
        image_note = "release manifest"
    else:
        ref = client.images.get(args.stub_image).id
        allow = ImageAllowlist({r: ref for r in ("shop", "injector", "volume-keeper")},
                               entrypoints={"volume-keeper": ("node", "-e", "setInterval(()=>{},1<<30)")},
                               commands={"shop": ("shop",), "injector": ("inject",)}, allow_local_ids=True)  # a local image id, so local ids are allowed here
        template = json.loads(TEMPLATE_FILE.read_text(encoding="utf-8"))
        template["components"] = [c for c in template["components"] if c["role"] in ("injector", "shop")]
        image_note = "stub instance image (L-06), two components (injector and shop)"
    if leftovers(client):
        raise SystemExit("there are already containers, networks or volumes labelled vm.instance on this host; remove them first")
    orch = Orchestrator(SdkBackend(client), {"shop-v0": template}, allow, health_timeout_s=args.health_timeout, injector_timeout_s=args.health_timeout)

    cold, failures = [], 0
    for i in range(args.rounds):
        iid = _iid()
        t0 = time.monotonic()
        rec = orch.create(make_body(iid, args.memory_mb))
        dt = time.monotonic() - t0
        if rec.state is InstanceState.READY:
            cold.append(dt)
        else:
            failures += 1
        orch.destroy(iid)
        print(f"round {i + 1}/{args.rounds}: {rec.state.value} in {dt:.2f}s", flush=True)

    ids, per_instance, create_times = [], [], []
    base = mem_available_mb()
    try:
        for i in range(args.count):
            iid = _iid()
            ids.append(iid)
            t0 = time.monotonic()
            rec = orch.create(make_body(iid, args.memory_mb))
            create_times.append(time.monotonic() - t0)
            if rec.state is not InstanceState.READY:
                failures += 1
            print(f"instance {i + 1}/{args.count}: {rec.state.value} in {create_times[-1]:.2f}s", flush=True)
        time.sleep(args.settle)
        per_instance = [container_mb(client, i) for i in ids]
        after = mem_available_mb()
    finally:
        for iid in ids:
            orch.destroy(iid)
    drop = (base - after) if base is not None and after is not None else None
    result = {
        "date": time.strftime("%Y-%m-%d", time.gmtime()), "images": image_note, "host": host_class(),
        "docker": client.version().get("Version"), "memory_limit_mb": args.memory_mb,
        "cold_start_s": summary(cold) if cold else None,
        "create_while_n_running_s": summary(create_times) if create_times else None,
        "instances_running": len(ids),
        "container_memory_mb_per_instance": summary(per_instance) if per_instance else None,
        "host_mem_available_drop_mb_total": round(drop, 1) if drop is not None else None,
        "host_mem_available_drop_mb_per_instance": round(drop / len(ids), 1) if drop is not None and ids else None,
        "failures": failures, "leftovers_after": leftovers(client),
    }
    return result


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="vulnmart_orchestrator.measure", description=__doc__.split("\n")[0])
    p.add_argument("--stub-image", help="image id or tag of the stub instance image (contracts/mocks/stub-instance)")
    p.add_argument("--manifest", help="release manifest of L-12 (real images) instead of the stub image")
    p.add_argument("--allow-local-images", action="store_true", help="accept bare local image ids (sha256:<hex>) in --manifest (a local run only)")
    p.add_argument("--rounds", type=int, default=5, help="cold-start repeats, one instance at a time")
    p.add_argument("--count", type=int, default=5, help="instances running together for the memory numbers")
    p.add_argument("--memory-mb", type=int, default=256)
    p.add_argument("--health-timeout", type=float, default=60)
    p.add_argument("--settle", type=float, default=10, help="seconds to wait before reading memory")
    p.add_argument("--out", help="folder for measure-result.json (default: print only)")
    a = p.parse_args(argv)
    if bool(a.stub_image) == bool(a.manifest):
        p.error("give exactly one of --stub-image and --manifest")
    if not (1 <= a.rounds <= 50 and 1 <= a.count <= 40 and 64 <= a.memory_mb <= 8192):
        p.error("rounds 1..50, count 1..40, memory-mb 64..8192")
    result = run(a)
    text = json.dumps(result, indent=2)
    print(text)
    if a.out:
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "measure-result.json").write_text(text + "\n", encoding="utf-8")
    return 0 if not result["failures"] and not result["leftovers_after"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
