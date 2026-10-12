"""Test helpers: fake requests, the shop template, an allowlist and the real-Docker switch."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path

from vulnmart_orchestrator.images import ImageAllowlist

ROOT = Path(__file__).resolve().parents[3]
TEMPLATE_FILE = ROOT / "contracts" / "instance" / "examples" / "valid" / "instance-template" / "shop-template.json"
TEMPLATE_SCHEMA = ROOT / "contracts" / "instance" / "instance-template.schema.json"
OPENAPI = ROOT / "contracts" / "orchestrator" / "orchestrator.openapi.yaml"

IID = "i-ABCDEFGHIJKLMNOP"
FLAG_A = "VM{" + "A" * 24 + "}"
FLAG_B = "VM{" + "B" * 24 + "}"
DECOY = "VM{" + "C" * 24 + "}"
SEED = "FAKE-SEED-NOT-REAL-" + "0" * 24
EVENT_KEY = "FAKE-EVENT-KEY-NOT-REAL-" + "0" * 24
OWNER = hashlib.sha256(b"FAKE-OWNER-NOT-REAL").hexdigest()


def digest(tag: str) -> str:
    return "sha256:" + hashlib.sha256(tag.encode()).hexdigest()


def allowlist(*, roles=("shop", "sidecar", "injector", "import-service", "mock-services", "bot-controller", "volume-keeper")) -> ImageAllowlist:
    return ImageAllowlist({r: "registry.invalid/vm/" + r + "@" + digest(r) for r in roles})


def template() -> dict:
    return json.loads(TEMPLATE_FILE.read_text(encoding="utf-8"))


def body(iid: str = IID, epoch: int = 1, **over) -> dict:
    b = {
        "instance_id": iid, "template_id": "shop-v0", "epoch": epoch, "owner_hash": OWNER,
        "hostname": f"{iid.lower()}.instances.example.invalid",
        "limits": {"memory_mb": 256, "cpu_limit": 1.5, "pids_limit": 512, "idle_minutes": 30, "max_minutes": 120},
        "flags": [{"challenge_key": "C01", "flag": FLAG_A}, {"challenge_key": "C02", "flag": FLAG_B}],
        "decoys": [{"challenge_key": "C01", "index": 0, "value": DECOY}],
        "flag_digests": [{"challenge_key": "C01", "sha256": hashlib.sha256(FLAG_A.encode()).hexdigest()},
                         {"challenge_key": "C02", "sha256": hashlib.sha256(FLAG_B.encode()).hexdigest()}],
        "event_key": EVENT_KEY, "seed": SEED,
    }
    b.update(copy.deepcopy(over))
    return b


def is_ci() -> bool:
    return (os.environ.get("CI") or "").strip().lower() in ("true", "1")
