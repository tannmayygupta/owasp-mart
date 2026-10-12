"""Template to container, network and volume specs (D1 of story L-13).

Containers are built only from a validated template (IF-6) and the fixed runtime profile of IF-6 section 7. Images come only from
the allowlist. A create request supplies values (ids, epoch, host, secrets) and never an image, command, entrypoint, volume, port
or environment variable: `parse_create` refuses those names and the builder has no input from the request except `CreateSpec`.
Nothing here talks to Docker.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from dataclasses import field as dc_field
from datetime import datetime, timezone

from .images import ImageAllowlist
from .states import EngineError, ErrorCode, FieldForbidden, ValidationFailed

SCHEMA_VERSION = "0.1"
RUN_USER = "65532:65532"
UID = GID = 65532
INSTANCE_ID = re.compile(r"^i-[A-Z2-7]{16}$")
OWNER_HASH = re.compile(r"^[0-9a-f]{64}$")
CHALLENGE_KEY = re.compile(r"^C(0[1-9]|10|11)$")
FLAG = re.compile(r"^VM\{[A-Z2-7]{24}\}$")
SEED = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
EVENT_KEY = re.compile(r"^[!-~]{32,128}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
HOST = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$")
MOUNT_TARGETS = frozenset({"/tmp", "/data", "/run/vm", "/run/import", "/run/placement/import", "/run/placement/mock"})
ENV_NAMES = frozenset({
    "VM_INSTANCE_ID", "VM_EPOCH", "VM_PUBLIC_HOST", "VM_SIDECAR_EVENTS_URL", "VM_MOCK_URL", "VM_IMPORT_SOCKET", "VM_DB_PATH",
    "VM_CATALOG_DB_PATH", "VM_SNAPSHOT_PATH", "VM_FLAGS_PATH", "PORT", "TZ", "VM_LOG_LEVEL",
})
TOKEN = re.compile(r"\{[a-z_]+\}")
LABELS = ("vm.schema", "vm.instance", "vm.epoch", "vm.component", "vm.template", "vm.expires", "vm.host", "vm.kind", "vm.owner")
# Names a request may never carry (H-71: a top-level forbidden name is ORCH-FIELD-FORBIDDEN, anything else unknown is ORCH-VALIDATION).
FORBIDDEN_FIELDS = frozenset({
    "image", "images", "command", "cmd", "entrypoint", "args", "env", "environment", "volumes", "volume", "mounts", "mount",
    "ports", "port", "network", "networks", "network_mode", "privileged", "user", "cap_add", "cap_drop", "devices", "labels",
    "security_opt", "binds", "tmpfs", "components", "healthcheck", "restart", "pid", "ipc", "extra_hosts", "dns",
})
ALLOWED_FIELDS = frozenset({
    "instance_id", "template_id", "epoch", "owner_hash", "hostname", "limits", "flags", "decoys", "flag_digests", "event_key", "seed",
})
KEEPER_ROLE = "volume-keeper"


class TemplateInvalid(EngineError):
    """The template breaks the fixed runtime profile (it should have failed the schema and the contract validator)."""

    code = ErrorCode.TEMPLATE_UNKNOWN


@dataclass(frozen=True, slots=True)
class CreateSpec:
    """The only data a create request gives the builder. Secrets are hidden from repr."""

    instance_id: str
    template_id: str
    epoch: int
    owner_hash: str = dc_field(repr=False)
    hostname: str
    flags: tuple[tuple[str, str], ...] = dc_field(repr=False)  # (challenge_key, flag)
    decoys: tuple[tuple[str, int, str], ...] = dc_field(repr=False)  # (challenge_key, index, value)
    flag_digests: tuple[tuple[str, str], ...] = dc_field(repr=False)  # (challenge_key, sha256) of the real flags
    event_key: str = dc_field(repr=False)
    seed: str = dc_field(repr=False)
    max_minutes: int = 120

    def fingerprint(self) -> str:
        """Hash of every field, so an identical repeat is recognised and nothing secret is kept in clear."""
        body = json.dumps(
            [self.instance_id, self.template_id, self.epoch, self.owner_hash, self.hostname, self.flags, self.decoys,
             self.flag_digests, self.event_key, self.seed, self.max_minutes],
            separators=(",", ":"),
        )
        return hashlib.sha256(body.encode()).hexdigest()


def _is_int(v: object, lo: int = 0) -> bool:
    return type(v) is int and lo <= v <= 2**53 - 1


def parse_create(body: object) -> CreateSpec:
    """Validate a create body (the IF-5 field names) into a `CreateSpec`. Refuses any field that is not data."""
    if not isinstance(body, dict):
        raise ValidationFailed("the create body must be an object")
    forbidden = sorted(k for k in body if k in FORBIDDEN_FIELDS)
    if forbidden:
        raise FieldForbidden(f"fields not allowed in a request: {', '.join(forbidden)}")
    unknown = sorted(set(body) - ALLOWED_FIELDS)
    if unknown:
        raise ValidationFailed(f"unknown fields: {', '.join(unknown)}")
    missing = sorted(ALLOWED_FIELDS - set(body))
    if missing:
        raise ValidationFailed(f"missing fields: {', '.join(missing)}")

    def need(cond: bool, msg: str) -> None:
        if not cond:
            raise ValidationFailed(msg)

    iid, tpl = body["instance_id"], body["template_id"]
    need(isinstance(iid, str) and INSTANCE_ID.match(iid) is not None, "instance_id has the wrong shape")
    need(isinstance(tpl, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", tpl) is not None, "template_id has the wrong shape")
    need(_is_int(body["epoch"], 1), "epoch must be an integer of at least 1")
    need(isinstance(body["owner_hash"], str) and OWNER_HASH.match(body["owner_hash"]) is not None, "owner_hash has the wrong shape")
    need(isinstance(body["hostname"], str) and HOST.match(body["hostname"]) is not None, "hostname has the wrong shape")
    need(isinstance(body["seed"], str) and SEED.match(body["seed"]) is not None, "seed has the wrong shape")
    need(isinstance(body["event_key"], str) and EVENT_KEY.match(body["event_key"]) is not None, "event_key has the wrong shape")
    limits = body["limits"]
    need(isinstance(limits, dict) and _is_int(limits.get("max_minutes"), 1), "limits.max_minutes must be a positive integer")

    flags, decoys, digests = body["flags"], body["decoys"], body["flag_digests"]
    need(isinstance(flags, list) and 1 <= len(flags) <= 11, "flags must hold 1 to 11 entries")
    need(isinstance(decoys, list) and len(decoys) <= 64, "decoys must be a list")
    need(isinstance(digests, list) and 1 <= len(digests) <= 11, "flag_digests must hold 1 to 11 entries")
    f_out, d_out, g_out = [], [], []
    for f in flags:
        need(isinstance(f, dict) and set(f) == {"challenge_key", "flag"}, "a flag entry has the wrong fields")
        need(isinstance(f["challenge_key"], str) and CHALLENGE_KEY.match(f["challenge_key"]) is not None, "a challenge_key is invalid")
        need(isinstance(f["flag"], str) and FLAG.match(f["flag"]) is not None, "a flag has the wrong shape")
        f_out.append((f["challenge_key"], f["flag"]))
    for d in decoys:
        need(isinstance(d, dict) and set(d) == {"challenge_key", "index", "value"}, "a decoy entry has the wrong fields")
        need(isinstance(d["challenge_key"], str) and CHALLENGE_KEY.match(d["challenge_key"]) is not None, "a challenge_key is invalid")
        need(_is_int(d["index"]), "a decoy index is invalid")
        need(isinstance(d["value"], str) and FLAG.match(d["value"]) is not None, "a decoy has the wrong shape")
        d_out.append((d["challenge_key"], d["index"], d["value"]))
    for g in digests:
        need(isinstance(g, dict) and set(g) == {"challenge_key", "sha256"}, "a digest entry has the wrong fields")
        need(isinstance(g["challenge_key"], str) and CHALLENGE_KEY.match(g["challenge_key"]) is not None, "a challenge_key is invalid")
        need(isinstance(g["sha256"], str) and SHA256.match(g["sha256"]) is not None, "a digest has the wrong shape")
        g_out.append((g["challenge_key"], g["sha256"]))
    need(len({k for k, _ in f_out}) == len(f_out), "one flag per challenge_key")
    need(len({k for k, _ in g_out}) == len(g_out), "one digest per challenge_key")
    return CreateSpec(
        instance_id=iid, template_id=tpl, epoch=body["epoch"], owner_hash=body["owner_hash"], hostname=body["hostname"],
        flags=tuple(f_out), decoys=tuple(d_out), flag_digests=tuple(g_out), event_key=body["event_key"], seed=body["seed"],
        max_minutes=limits["max_minutes"],
    )


@dataclass(frozen=True, slots=True)
class NetworkSpec:
    name: str
    labels: dict[str, str]
    internal: bool = True  # no egress (IF-6 section 7)


@dataclass(frozen=True, slots=True)
class VolumeSpec:
    name: str
    size_mb: int
    labels: dict[str, str]

    @property
    def driver_opts(self) -> dict[str, str]:
        return {"type": "tmpfs", "device": "tmpfs", "o": f"size={self.size_mb}m,uid={UID},gid={GID},mode=0750"}


@dataclass(frozen=True, slots=True)
class MountSpec:
    volume: str
    target: str
    read_only: bool


@dataclass(frozen=True, slots=True)
class HealthSpec:
    test: tuple[str, ...]
    interval_s: int
    timeout_s: int
    retries: int


@dataclass(frozen=True, slots=True)
class ContainerSpec:
    name: str
    component: str
    role: str
    image: str
    entrypoint: tuple[str, ...] | None
    command: tuple[str, ...] | None
    network: str  # network name, or "none"
    aliases: tuple[str, ...]
    memory_mb: int
    cpu_limit: float
    pids_limit: int
    tmpfs: tuple[tuple[str, str], ...]  # (target, options)
    mounts: tuple[MountSpec, ...]
    labels: dict[str, str]
    env: dict[str, str] = dc_field(repr=False)  # no secret, except the one flag-in-env variable of the shop (IF-6 section 2)
    healthcheck: HealthSpec | None
    stdin: str | None  # None, or the document the container reads once on standard input: "injection" or "sidecar"
    # fixed runtime profile (IF-6 section 7), constants, never read from the template or a request
    user: str = RUN_USER
    read_only: bool = True
    privileged: bool = False
    cap_drop: tuple[str, ...] = ("ALL",)
    security_opt: tuple[str, ...] = ("no-new-privileges:true",)


@dataclass(frozen=True, slots=True)
class InstancePlan:
    instance_id: str
    epoch: int
    network: NetworkSpec
    volumes: tuple[VolumeSpec, ...]
    keeper: ContainerSpec
    injector: ContainerSpec
    others: tuple[ContainerSpec, ...]  # started only after the injector exited 0

    @property
    def containers(self) -> tuple[ContainerSpec, ...]:
        return (self.keeper, self.injector, *self.others)


def _prefix(spec: CreateSpec) -> str:
    return f"vm-{spec.instance_id.lower()}-e{spec.epoch}"


def _expires(now: datetime, minutes: int) -> str:
    from datetime import timedelta

    return (now.astimezone(timezone.utc) + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


def instance_labels(spec: CreateSpec, component: str, template_id: str, expires: str) -> dict[str, str]:
    """The nine labels of IF-6 section 4. No secret, flag, seed or key is ever a label value."""
    return {
        "vm.schema": SCHEMA_VERSION, "vm.instance": spec.instance_id, "vm.epoch": str(spec.epoch), "vm.component": component,
        "vm.template": template_id, "vm.expires": expires, "vm.host": spec.hostname, "vm.kind": "inst", "vm.owner": spec.owner_hash,
    }


def _health_test(hc: dict) -> tuple[str, ...]:
    kind = hc.get("kind")
    if kind == "http":
        return ("CMD", "wget", "-q", "-O", "/dev/null", f"http://127.0.0.1:{int(hc['port'])}{hc['path']}")
    if kind == "tcp":
        return ("CMD", "nc", "-z", "127.0.0.1", str(int(hc["port"])))
    if kind == "socket":
        return ("CMD", "test", "-S", str(hc["path"]))
    raise TemplateInvalid(f"unknown healthcheck kind {kind!r}")


def _tmpfs_opts(target: str, size_mb: int) -> str:
    mode = "0700" if target == "/data" else "1777"
    return f"rw,noexec,nosuid,size={size_mb}m,uid={UID},gid={GID},mode={mode}"


def _fill(value: str, tokens: dict[str, str]) -> str:
    out = value
    for k, v in tokens.items():
        out = out.replace("{" + k + "}", v)
    if TOKEN.search(out):
        raise TemplateInvalid("an unknown placeholder is left in a template value")
    return out


def _check_profile(t: dict) -> None:
    if t.get("schema_version") != SCHEMA_VERSION:
        raise TemplateInvalid("template schema_version is not 0.1")
    declared = {v["name"] for v in t.get("volumes", [])}
    comps = t.get("components", [])
    names = [c.get("name") for c in comps]
    if len(set(names)) != len(names):
        raise TemplateInvalid("component names must be unique")
    if sum(1 for c in comps if c.get("role") == "injector") != 1:
        raise TemplateInvalid("a template needs exactly one injector")
    for c in comps:
        if c.get("name") != c.get("role"):
            raise TemplateInvalid("a component name must equal its role")
        if c.get("privileged") or c.get("user") != RUN_USER or c.get("read_only") is not True or c.get("cap_drop") != ["ALL"]:
            raise TemplateInvalid("a component breaks the fixed runtime profile")
        if c.get("no_new_privileges") is not True or c.get("egress") is not False:
            raise TemplateInvalid("a component breaks the fixed runtime profile")
        if c.get("network_mode") not in ("instance", "none"):
            raise TemplateInvalid("network_mode must be instance or none")
        if c.get("role") == "injector" and c.get("network_mode") != "none":
            raise TemplateInvalid("the injector must have no network")
        targets = [m.get("target") for m in c.get("mounts", [])]
        if len(set(targets)) != len(targets) or not set(targets) <= MOUNT_TARGETS:
            raise TemplateInvalid("mount targets must be unique and one of the six allowed")
        for m in c.get("mounts", []):
            if m.get("type") == "volume" and m.get("source") not in declared:
                raise TemplateInvalid("a mounted volume is not declared")
            if m.get("type") not in ("tmpfs", "volume"):
                raise TemplateInvalid("only tmpfs and named volume mounts are allowed")
        bad = [n for n in c.get("env", {}) if n not in ENV_NAMES]
        if bad:
            raise TemplateInvalid(f"environment names not allowed: {', '.join(bad)}")


def build_plan(template: dict, spec: CreateSpec, images: ImageAllowlist, *, now: datetime | None = None) -> InstancePlan:
    """The plan for one instance. Raises before anything exists if the template or an image is not acceptable."""
    if template.get("template_id") != spec.template_id:
        raise TemplateInvalid("template id does not match the request")
    _check_profile(template)
    now = now or datetime.now(timezone.utc)
    expires = _expires(now, spec.max_minutes)
    pre = _prefix(spec)
    net_name = f"{pre}-net"
    tokens = {
        "instance_id": spec.instance_id, "epoch": str(spec.epoch), "host": spec.hostname, "expires": expires,
        "owner_hash": spec.owner_hash,
    }
    flag_of = dict(spec.flags)
    sizes = {v["name"]: v["size_mb"] for v in template["volumes"]}
    vol_names = {n: f"{n}-{spec.instance_id.lower()}-e{spec.epoch}" for n in sizes}
    net_labels = instance_labels(spec, "network", spec.template_id, expires)
    network = NetworkSpec(net_name, net_labels)
    volumes = tuple(VolumeSpec(vol_names[n], sizes[n], instance_labels(spec, f"volume-{n}", spec.template_id, expires)) for n in sizes)

    def make(c: dict) -> ContainerSpec:
        role = c["role"]
        image = images.resolve(c["image"])
        if images.role_of(c["image"]) != role:
            raise TemplateInvalid("a role may only use its own image")
        env = {k: _fill(v, tokens) for k, v in c.get("env", {}).items()}
        fde = c.get("flag_delivery_env")
        if fde:
            if role != "shop":
                raise TemplateInvalid("only the shop may receive a flag in the environment")
            key = fde["challenge_key"]
            if fde["env_name"] != f"VM_FLAG_{key}" or key not in flag_of:
                raise TemplateInvalid("flag_delivery_env does not match a flag of this request")
            env[fde["env_name"]] = flag_of[key]
        tmpfs = tuple((m["target"], _tmpfs_opts(m["target"], m["size_mb"])) for m in c["mounts"] if m["type"] == "tmpfs")
        mounts = tuple(MountSpec(vol_names[m["source"]], m["target"], bool(m.get("read_only"))) for m in c["mounts"] if m["type"] == "volume")
        labels = {k: _fill(v, tokens) for k, v in c["labels"].items()}
        if set(labels) != set(LABELS) or labels["vm.component"] != c["name"]:
            raise TemplateInvalid("a component must carry exactly the nine labels")
        hc = c.get("healthcheck")
        health = HealthSpec(_health_test(hc), int(hc["interval_s"]), int(hc["timeout_s"]), int(hc["retries"])) if hc else None
        return ContainerSpec(
            name=f"{pre}-{c['name']}", component=c["name"], role=role, image=image,
            entrypoint=images.entrypoints.get(role), command=images.commands.get(role),
            network=net_name if c["network_mode"] == "instance" else "none",
            aliases=(c["name"],) if c["network_mode"] == "instance" else (),
            memory_mb=int(c["memory_mb"]), cpu_limit=float(c["cpu_limit"]), pids_limit=int(c["pids_limit"]),
            tmpfs=tmpfs, mounts=mounts, labels=labels, env=env, healthcheck=health,
            stdin="injection" if role == "injector" else "sidecar" if role == "sidecar" else None,
        )

    built = [make(c) for c in template["components"]]
    injector = next(c for c in built if c.role == "injector")
    others = tuple(c for c in built if c.role != "injector")
    keeper = ContainerSpec(
        name=f"{pre}-{KEEPER_ROLE}", component=KEEPER_ROLE, role=KEEPER_ROLE, image=images.resolve_role(KEEPER_ROLE),
        entrypoint=images.entrypoints.get(KEEPER_ROLE), command=images.commands.get(KEEPER_ROLE), network="none", aliases=(),
        memory_mb=64, cpu_limit=0.5, pids_limit=32, tmpfs=(("/tmp", _tmpfs_opts("/tmp", 1)),),
        mounts=tuple(MountSpec(vol_names[n], t, True) for n, t in _keeper_targets(template, vol_names)),
        labels=instance_labels(spec, KEEPER_ROLE, spec.template_id, expires), env={}, healthcheck=None, stdin=None,
    )
    return InstancePlan(spec.instance_id, spec.epoch, network, volumes, keeper, injector, others)


_TARGET_OF_VOLUME = {"vm-run": "/run/vm", "vm-import": "/run/import", "vm-placement-import": "/run/placement/import", "vm-placement-mock": "/run/placement/mock"}


def _keeper_targets(template: dict, vol_names: dict[str, str]) -> list[tuple[str, str]]:
    """The keeper mounts every declared volume read-only at the target the template uses for it (so each volume stays mounted)."""
    seen: dict[str, str] = {}
    for c in template["components"]:
        for m in c["mounts"]:
            if m["type"] == "volume":
                seen.setdefault(m["source"], m["target"])
    return [(n, seen.get(n, _TARGET_OF_VOLUME.get(n, "/run/vm"))) for n in vol_names]


def injection_document(spec: CreateSpec, issued_at: str | None = None) -> bytes:
    doc: dict = {
        "schema_version": SCHEMA_VERSION, "instance_id": spec.instance_id, "epoch": spec.epoch, "seed": spec.seed,
        "flags": [{"challenge_key": k, "flag": f} for k, f in spec.flags],
        "decoys": [{"challenge_key": k, "index": i, "value": v} for k, i, v in spec.decoys],
    }
    if issued_at:
        doc["issued_at"] = issued_at
    return json.dumps(doc, separators=(",", ":")).encode()


def sidecar_document(spec: CreateSpec) -> bytes:
    digests = [{"challenge_key": k, "kind": "real", "sha256": s} for k, s in spec.flag_digests]
    digests += [
        {"challenge_key": k, "kind": "decoy", "sha256": hashlib.sha256(v.encode()).hexdigest()} for k, _i, v in spec.decoys
    ]
    doc = {"schema_version": SCHEMA_VERSION, "instance_id": spec.instance_id, "epoch": spec.epoch, "event_key": spec.event_key,
           "flag_digests": digests}
    return json.dumps(doc, separators=(",", ":")).encode()
