"""Template to container, network and volume specs (D1 of story L-13).

Containers are built only from a validated template (IF-6) and the fixed runtime profile of IF-6 section 7. Images come only from
the allowlist. A create request supplies values (ids, epoch, host, secrets) and never an image, command, entrypoint, volume, port
or environment variable: `parse_create` refuses those names and the builder has no input from the request except `CreateSpec`.
Nothing here talks to Docker.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from dataclasses import field as dc_field
from datetime import datetime, timezone

from .images import ImageAllowlist
from .problems import pointer
from .states import EngineError, ErrorCode, FieldForbidden, ValidationFailed

SCHEMA_VERSION = "0.1"
RUN_USER = "65532:65532"
UID = GID = 65532
INSTANCE_ID = re.compile(r"^i-[A-Z2-7]{16}$")
OWNER_HASH = re.compile(r"^[0-9a-f]{64}$")
CHALLENGE_KEY = re.compile(r"^C(0[1-9]|10|11)$")
FLAG = re.compile(r"^VM\{[A-Z2-7]{24}\}$")
SEED = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
EVENT_KEY = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
HOST = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$")
TEMPLATE_ID = re.compile(r"^[a-z][a-z0-9-]{2,31}$")
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
    memory_mb: int = 256
    cpu_limit: float = 1.0
    pids_limit: int = 512
    idle_minutes: int = 30

    def fingerprint(self) -> str:
        """Hash of every field (the limits included; `cpu_limit` by value, so 2 and 2.0 are one request), so an identical repeat is\n        recognised and nothing secret is kept in clear."""
        body = json.dumps(
            [self.instance_id, self.template_id, self.epoch, self.owner_hash, self.hostname, self.flags, self.decoys,
             self.flag_digests, self.event_key, self.seed, self.max_minutes, self.memory_mb, float(self.cpu_limit), self.pids_limit,
             self.idle_minutes],
            separators=(",", ":"),
        )
        return hashlib.sha256(body.encode()).hexdigest()


MAX_INT = 2**53 - 1  # I-JSON: the largest integer every language reads back exactly (IF-5 section 2a)


def _is_int(v: object, lo: int = 0, hi: int = MAX_INT) -> bool:
    """An integer token: a real `int` (not a bool, not a float, not the out-of-range marker of `jsonstrict`) inside the range."""
    return type(v) is int and lo <= v <= hi


def _is_number(v: object) -> bool:
    """`cpu_limit` is the one non-integer: any JSON number (int, float, or the float token of `jsonstrict`), never a boolean."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _pointer(name: object) -> str:
    """A JSON Pointer segment (RFC 6901) for a member name; a name from the client is cut to 64 characters."""
    return "/" + str(name).replace("~", "~0").replace("/", "~1")[:64]


def _check_keys(body: object, allowed: tuple[str, ...]) -> dict:
    """The closed-schema rules of IF-5 section 2: an object, no forbidden name (ORCH-FIELD-FORBIDDEN), no unknown or missing name."""
    if not isinstance(body, dict):
        raise ValidationFailed("the body must be a JSON object", field="")
    for k in body:
        if isinstance(k, str) and k.lower() in FORBIDDEN_FIELDS:
            raise FieldForbidden("the orchestrator accepts no container fields", field=pointer(k[:64]))
    for k in body:
        if k not in allowed:
            raise ValidationFailed("unknown field", field=_pointer(k))
    for k in allowed:
        if k not in body:
            raise ValidationFailed(f"{k} is required", field="/" + k)
    return body


def _need(cond: bool, field: str, msg: str) -> None:
    if not cond:
        raise ValidationFailed(msg, field=field)


def _check_entry(item: object, i: int, group: str, keys: set[str]) -> dict:
    _need(isinstance(item, dict) and set(item) == keys, f"/{group}/{i}", "an entry has the wrong fields")
    return item  # type: ignore[return-value]


def _parse_material(body: dict) -> tuple[tuple, tuple, tuple, str, str]:
    """flags, decoys, flag_digests, event_key and seed of a create or reset body (IF-5 `FlagMaterial`)."""
    flags, decoys, digests = body["flags"], body["decoys"], body["flag_digests"]
    _need(isinstance(flags, list) and 1 <= len(flags) <= 11, "/flags", "flags: 1 to 11 entries")
    f_out, d_out, g_out = [], [], []
    for i, f in enumerate(flags):
        _check_entry(f, i, "flags", {"challenge_key", "flag"})
        _need(isinstance(f["challenge_key"], str) and CHALLENGE_KEY.fullmatch(f["challenge_key"]) is not None, f"/flags/{i}/challenge_key", "bad challenge key")
        _need(isinstance(f["flag"], str) and FLAG.fullmatch(f["flag"]) is not None, f"/flags/{i}/flag", "bad flag format")
        f_out.append((f["challenge_key"], f["flag"]))
    _need(isinstance(decoys, list) and len(decoys) <= 64, "/decoys", "decoys: at most 64 entries")
    for i, d in enumerate(decoys):
        _check_entry(d, i, "decoys", {"challenge_key", "index", "value"})
        _need(isinstance(d["challenge_key"], str) and CHALLENGE_KEY.fullmatch(d["challenge_key"]) is not None, f"/decoys/{i}/challenge_key", "bad challenge key")
        _need(_is_int(d["index"]), f"/decoys/{i}/index", "bad decoy index")
        _need(isinstance(d["value"], str) and FLAG.fullmatch(d["value"]) is not None, f"/decoys/{i}/value", "bad decoy format")
        d_out.append((d["challenge_key"], d["index"], d["value"]))
    _need(isinstance(digests, list) and 1 <= len(digests) <= 11, "/flag_digests", "flag_digests: 1 to 11 entries")
    for i, g in enumerate(digests):
        _check_entry(g, i, "flag_digests", {"challenge_key", "sha256"})
        _need(isinstance(g["challenge_key"], str) and CHALLENGE_KEY.fullmatch(g["challenge_key"]) is not None, f"/flag_digests/{i}/challenge_key", "bad challenge key")
        _need(isinstance(g["sha256"], str) and SHA256.fullmatch(g["sha256"]) is not None, f"/flag_digests/{i}/sha256", "bad digest")
        g_out.append((g["challenge_key"], g["sha256"]))
    _need(len({k for k, _ in f_out}) == len(f_out), "/flags", "one flag per challenge_key")
    _need(len({k for k, _ in g_out}) == len(g_out), "/flag_digests", "one digest per challenge_key")
    _need(isinstance(body["event_key"], str) and EVENT_KEY.fullmatch(body["event_key"]) is not None, "/event_key", "bad event key shape")
    _need(isinstance(body["seed"], str) and SEED.fullmatch(body["seed"]) is not None, "/seed", "bad seed shape")
    return tuple(f_out), tuple(d_out), tuple(g_out), body["event_key"], body["seed"]


CREATE_FIELDS = (
    "instance_id", "template_id", "epoch", "flags", "decoys", "flag_digests", "event_key", "seed", "owner_hash", "hostname", "limits",
)
RESET_FIELDS = ("epoch", "flags", "decoys", "flag_digests", "event_key", "seed")
ACCESS_FIELDS = ("access", "access_epoch")
LIMIT_FIELDS = ("memory_mb", "cpu_limit", "pids_limit", "idle_minutes", "max_minutes")
ACCESS_VALUES = ("open", "frozen", "closed")


def parse_create(body: object) -> CreateSpec:
    """Validate a create body (the IF-5 field names and limits) into a `CreateSpec`. Refuses any field that is not data.

    Errors carry the JSON Pointer of the field (`ValidationFailed.field`), also for a forbidden field."""
    body = _check_keys(body, CREATE_FIELDS)
    iid, tpl = body["instance_id"], body["template_id"]
    _need(isinstance(iid, str) and INSTANCE_ID.fullmatch(iid) is not None, "/instance_id", "bad instance id")
    _need(isinstance(tpl, str) and TEMPLATE_ID.fullmatch(tpl) is not None, "/template_id", "bad template name")
    _need(_is_int(body["epoch"], 1), "/epoch", "epoch is an integer of at least 1")
    _need(isinstance(body["owner_hash"], str) and OWNER_HASH.fullmatch(body["owner_hash"]) is not None, "/owner_hash", "owner_hash is 64 lowercase hex characters")
    flags, decoys, digests, event_key, seed = _parse_material(body)
    host = body["hostname"]
    _need(isinstance(host, str) and len(host) <= 253 and HOST.fullmatch(host) is not None, "/hostname", "bad host name")
    limits = body["limits"]
    _need(isinstance(limits, dict), "/limits", "limits is an object")
    for k in limits:
        _need(k in LIMIT_FIELDS, "/limits" + _pointer(k), "unknown limit")
    for k in LIMIT_FIELDS:
        _need(k in limits, f"/limits/{k}", f"{k} is required")
    _need(_is_int(limits["memory_mb"], 64, 8192), "/limits/memory_mb", "memory_mb is 64 to 8192")
    cpu = limits["cpu_limit"]
    _need(_is_number(cpu) and math.isfinite(cpu) and 0 < cpu <= 8, "/limits/cpu_limit", "cpu_limit is over 0 up to 8")
    _need(_is_int(limits["pids_limit"], 16, 4096), "/limits/pids_limit", "pids_limit is 16 to 4096")
    _need(_is_int(limits["idle_minutes"], 1, 1440), "/limits/idle_minutes", "idle_minutes is 1 to 1440")
    _need(_is_int(limits["max_minutes"], 1, 1440), "/limits/max_minutes", "max_minutes is 1 to 1440")
    return CreateSpec(
        instance_id=iid, template_id=tpl, epoch=body["epoch"], owner_hash=body["owner_hash"], hostname=host,
        flags=flags, decoys=decoys, flag_digests=digests, event_key=event_key, seed=seed,
        max_minutes=limits["max_minutes"], memory_mb=limits["memory_mb"], cpu_limit=float(cpu),
        pids_limit=limits["pids_limit"], idle_minutes=limits["idle_minutes"],
    )


@dataclass(frozen=True, slots=True)
class ResetSpec:
    """A validated reset body (story 3.4 will use it; the service validates it today and answers a placeholder)."""

    epoch: int
    flags: tuple[tuple[str, str], ...] = dc_field(repr=False)
    decoys: tuple[tuple[str, int, str], ...] = dc_field(repr=False)
    flag_digests: tuple[tuple[str, str], ...] = dc_field(repr=False)
    event_key: str = dc_field(repr=False)
    seed: str = dc_field(repr=False)


def parse_reset(body: object) -> ResetSpec:
    body = _check_keys(body, RESET_FIELDS)
    _need(_is_int(body["epoch"], 2), "/epoch", "epoch is an integer of at least 2")
    flags, decoys, digests, event_key, seed = _parse_material(body)
    return ResetSpec(body["epoch"], flags, decoys, digests, event_key, seed)


def parse_access(body: object) -> tuple[str, int]:
    body = _check_keys(body, ACCESS_FIELDS)
    _need(isinstance(body["access"], str) and body["access"] in ACCESS_VALUES, "/access", "access is open, frozen or closed")
    _need(_is_int(body["access_epoch"], 0), "/access_epoch", "access_epoch is an integer of at least 0")
    return body["access"], body["access_epoch"]


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
        health = HealthSpec(images.healthchecks.get(role) or _health_test(hc), int(hc["interval_s"]), int(hc["timeout_s"]), int(hc["retries"])) if hc else None
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
