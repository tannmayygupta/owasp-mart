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
# A digest-pinned reference: `name@sha256:<hex>` or a bare image id `sha256:<hex>` (used for local test images).
DIGEST_REF = re.compile(r"^(?:[A-Za-z0-9][A-Za-z0-9._/:-]*@)?sha256:[0-9a-f]{64}$")


class ImageNotAllowed(ValidationFailed):
    """The template names an image role that is not in the allowlist."""


@dataclass(frozen=True, slots=True)
class ImageAllowlist:
    images: dict[str, str]
    entrypoints: dict[str, tuple[str, ...]] = field(default_factory=dict)
    commands: dict[str, tuple[str, ...]] = field(default_factory=dict)
    healthchecks: dict[str, tuple[str, ...]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for role, ref in self.images.items():
            if role not in ROLES:
                raise ValueError(f"unknown image role {role!r}")
            if not isinstance(ref, str) or not DIGEST_REF.match(ref):
                raise ValueError(f"image for role {role!r} is not pinned by a sha256 digest")
        for table in (self.entrypoints, self.commands, self.healthchecks):
            for role, argv in table.items():
                if role not in self.images:
                    raise ValueError(f"entrypoint or command for role {role!r} without an image")
                if not all(isinstance(a, str) for a in argv):
                    raise ValueError("entrypoints and commands are lists of strings")

    @classmethod
    def from_manifest(cls, data: dict) -> ImageAllowlist:
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
        )

    @classmethod
    def load(cls, path: str | Path) -> ImageAllowlist:
        return cls.from_manifest(json.loads(Path(path).read_text(encoding="utf-8")))

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
