"""The image allowlist: `{image:<role>}` to an image reference pinned by digest.

The real source is the release manifest of L-12, a JSON file written by the release, never by a request:

    {"images": {"shop": "registry/name@sha256:<64 hex>", ...},
     "entrypoints": {"role": ["..."]},   (optional, per role)
     "commands": {"role": ["..."]},      (optional, per role)
     "healthchecks": {"role": ["CMD", "..."]}}   (optional, per role: the test of the Docker health check, for an image without `wget`)

A request can only name a template; it cannot add an image, entrypoint or command.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .states import ValidationFailed

ROLES = ("shop", "sidecar", "injector", "import-service", "mock-services", "bot-controller", "volume-keeper")
PLACEHOLDER = re.compile(r"^\{image:([a-z][a-z-]*)\}$")
# A digest-pinned reference: `name@sha256:<hex>`, matched as a whole (fullmatch: a trailing newline or text never passes).
DIGEST_REF = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}")
# A bare image id `sha256:<hex>` names no registry and no repository: it is only what a local build gives. It is accepted only when the
# allowlist is made for tests or the local demo (`allow_local_ids`, CLI `--allow-local-images`), never for a release manifest.
LOCAL_IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")


_FORBIDDEN_HEALTH_PROGRAMS = {"sh", "bash", "ash", "dash", "wget", "curl", "nc"}


def _is_release_form(data: object) -> bool:
    """`commit` or `repo` marks the pipeline's file; so does `healthchecks` without the orchestrator-only `entrypoints`/`commands`."""
    if not isinstance(data, dict) or not isinstance(data.get("images"), dict):
        return False
    if "commit" in data or "repo" in data:
        return True
    return "healthchecks" in data and "entrypoints" not in data and "commands" not in data


def _health_test_from_argv(role: str, argv: object) -> tuple[str, ...]:
    """Validates an exec-form health argv and returns the Docker `Test` list (`CMD` first, never doubled)."""
    if not isinstance(argv, list) or not argv:
        raise ValueError(f"healthcheck for role {role!r} must be a non-empty list")
    items = list(argv)
    if items[0] == "CMD":
        items = items[1:]
    if not items or len(items) > 16:
        raise ValueError(f"healthcheck for role {role!r} must have 1 to 16 items")
    for item in items:
        if not isinstance(item, str) or not item or len(item) > 512:
            raise ValueError(f"healthcheck for role {role!r} has an item that is not a non-empty string of at most 512 characters")
    if not items[0].startswith("/"):
        raise ValueError(f"healthcheck for role {role!r} must start with an absolute path")
    if items[0].rsplit("/", 1)[-1] in _FORBIDDEN_HEALTH_PROGRAMS:
        raise ValueError(f"healthcheck for role {role!r} must not use a shell, wget, curl or nc")
    return ("CMD", *items)


class ImageNotAllowed(ValidationFailed):
    """The template names an image role that is not in the allowlist."""


@dataclass(frozen=True, slots=True)
class ImageAllowlist:
    images: dict[str, str]
    entrypoints: dict[str, tuple[str, ...]] = field(default_factory=dict)
    commands: dict[str, tuple[str, ...]] = field(default_factory=dict)
    healthchecks: dict[str, tuple[str, ...]] = field(default_factory=dict)
    allow_local_ids: bool = False  # tests and the local demo only: also accept a bare local image id `sha256:<hex>`

    def __post_init__(self) -> None:
        for role, ref in self.images.items():
            if role not in ROLES:
                raise ValueError(f"unknown image role {role!r}")
            if not isinstance(ref, str):
                raise ValueError(f"image for role {role!r} is not pinned by a sha256 digest")
            if DIGEST_REF.fullmatch(ref):
                continue
            if self.allow_local_ids and LOCAL_IMAGE_ID.fullmatch(ref):
                continue
            if LOCAL_IMAGE_ID.fullmatch(ref):
                raise ValueError(f"image for role {role!r} is a bare image id: a release manifest needs <name>@sha256:<digest> (local images need --allow-local-images)")
            raise ValueError(f"image for role {role!r} is not pinned by a sha256 digest")
        for table in (self.entrypoints, self.commands, self.healthchecks):
            for role, argv in table.items():
                if role not in self.images:
                    raise ValueError(f"entrypoint or command for role {role!r} without an image")
                if not all(isinstance(a, str) for a in argv):
                    raise ValueError("entrypoints and commands are lists of strings")

    @classmethod
    def from_manifest(cls, data: dict, *, allow_local_ids: bool = False) -> ImageAllowlist:
        if not isinstance(data, dict) or not isinstance(data.get("images"), dict):
            raise ValueError("release manifest needs an `images` object")
        extra = set(data) - {"images", "entrypoints", "commands", "healthchecks"}
        if extra:
            raise ValueError(f"unknown manifest keys: {sorted(extra)}")
        return cls(
            images=dict(data["images"]),
            entrypoints={r: tuple(v) for r, v in (data.get("entrypoints") or {}).items()},
            commands={r: tuple(v) for r, v in (data.get("commands") or {}).items()},
            healthchecks={r: tuple(v) for r, v in (data.get("healthchecks") or {}).items()},
            allow_local_ids=allow_local_ids,
        )

    @classmethod
    def from_release(cls, data: dict, *, allow_local_ids: bool = False) -> ImageAllowlist:
        """The file written by `scripts/images-release.mjs`: `{commit, repo, images, healthchecks}` (D-56).

        Only `images` and `healthchecks` are read. An image that is not an orchestrator role (for example `hello`) is skipped.
        Each role's health check is an argv; it becomes a Docker `Test` list starting with `CMD`.
        """
        if not isinstance(data, dict) or not isinstance(data.get("images"), dict):
            raise ValueError("release file needs an `images` object")
        extra = set(data) - {"images", "healthchecks", "commit", "repo"}
        if extra:
            raise ValueError(f"unknown release keys: {sorted(extra)}")
        images = data["images"]
        checks = data.get("healthchecks") or {}
        if not isinstance(checks, dict):
            raise ValueError("`healthchecks` must be an object")
        tests: dict[str, tuple[str, ...]] = {}
        for role, argv in checks.items():
            if role not in images:
                raise ValueError(f"healthcheck for role {role!r} without an image")
            if role not in ROLES:
                continue  # not an orchestrator role: skipped with its image
            tests[role] = _health_test_from_argv(role, argv)
        return cls(
            images={r: ref for r, ref in images.items() if r in ROLES},
            healthchecks=tests,
            allow_local_ids=allow_local_ids,
        )

    @classmethod
    def load(cls, path: str | Path, *, allow_local_ids: bool = False) -> ImageAllowlist:
        """Reads either file form: the orchestrator's own manifest (strict) or the release file of the pipeline."""
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if _is_release_form(data):
            return cls.from_release(data, allow_local_ids=allow_local_ids)
        return cls.from_manifest(data, allow_local_ids=allow_local_ids)

    def role_of(self, placeholder: str) -> str:
        m = PLACEHOLDER.match(placeholder or "")
        if not m:
            raise ImageNotAllowed("an image must be written as {image:<role>}")
        return m.group(1)

    def resolve(self, placeholder: str) -> str:
        role = self.role_of(placeholder)
        ref = self.images.get(role)
        if ref is None:
            raise ImageNotAllowed(f"image role {role!r} is not in the allowlist")
        return ref

    def resolve_role(self, role: str) -> str:
        ref = self.images.get(role)
        if ref is None:
            raise ImageNotAllowed(f"image role {role!r} is not in the allowlist")
        return ref

def fake_allowlist() -> ImageAllowlist:
    """Image references for the test backend (`--backend fake`): well-formed and pinned by digest, never pulled."""
    import hashlib

    return ImageAllowlist({r: f"registry.invalid/vm/{r}@sha256:{hashlib.sha256(r.encode()).hexdigest()}" for r in ROLES})
