"""The challenge catalogue as the lab API needs it (IF-7): titles, tags, tier and hint texts, read from `challenges/catalog/cNN.yaml`.

Stream T owns the files (T-30 writes the hint texts); this reads them, never writes them. A hint with no text yet shows a plain
placeholder, so the route answers before the content exists. A flag, a placement, a test path or a write-up never leaves this module
(IF-2: no answer shows a flag or where it is). `YAML` is parsed with `safe_load` only.
"""
from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger("vulnmart.lab.catalog")

CATALOG_DIR_VAR = "VULNMART_CATALOG_DIR"
HINT_KINDS = ("nudge", "direction", "near_solution")
PLACEHOLDER = "This hint has not been written yet."


@dataclass(frozen=True, slots=True)
class CatalogEntry:
    key: str  # C01
    title: str
    owasp_2021: str | None
    owasp_2025: str | None
    cwe: tuple[str, ...]
    attack: tuple[str, ...]
    difficulty: int
    tier: str
    hints: tuple[str | None, str | None, str | None]


class Catalog:
    def __init__(self, entries: Mapping[str, CatalogEntry]) -> None:
        self._entries = dict(entries)

    def get(self, key: str) -> CatalogEntry | None:
        return self._entries.get(key)

    def keys(self) -> list[str]:
        return sorted(self._entries)

    def hint_text(self, key: str, level: int) -> str:
        entry = self._entries.get(key)
        text = entry.hints[level - 1] if entry and 1 <= level <= 3 else None
        return text.strip() if isinstance(text, str) and text.strip() else PLACEHOLDER


def _entry(data: Mapping[str, Any]) -> CatalogEntry:
    owasp = data.get("owasp") or {}
    cwe = data.get("cwe") or {}
    hints: list[str | None] = [None, None, None]
    for h in data.get("hints") or ():
        if isinstance(h, Mapping) and h.get("level") in (1, 2, 3):
            hints[h["level"] - 1] = h.get("text") if isinstance(h.get("text"), str) else None
    return CatalogEntry(
        key=str(data["key"]).upper(), title=str(data["title"]), owasp_2021=_s(owasp.get("2021")), owasp_2025=_s(owasp.get("2025")),
        cwe=tuple(x for x in [cwe.get("primary"), *(cwe.get("related") or ())] if isinstance(x, str)),
        attack=tuple(str(a) for a in (data.get("attack") or ())), difficulty=int(data.get("difficulty", 1)),
        tier=str(data.get("tier", "")), hints=(hints[0], hints[1], hints[2]))


def _s(value: Any) -> str | None:
    return None if value is None else str(value)


def load_catalog(directory: str | os.PathLike[str] | None) -> Catalog:
    """Read every `cNN.yaml` of the directory. A missing directory or a bad file is logged and skipped: the lab still answers."""
    entries: dict[str, CatalogEntry] = {}
    if directory and Path(directory).is_dir():
        for path in sorted(Path(directory).glob("c[0-9][0-9].yaml")):
            try:
                entry = _entry(yaml.safe_load(path.read_text(encoding="utf-8")))
                entries[entry.key] = entry
            except (OSError, KeyError, ValueError, TypeError, yaml.YAMLError):
                log.exception("catalogue file %s is unusable and was skipped", path.name)
    else:
        log.warning("no catalogue directory (%s): titles and hints fall back to keys and placeholders", CATALOG_DIR_VAR)
    return Catalog(entries)


def default_catalog_dir(environ: Mapping[str, str] | None = None) -> str | None:
    env = os.environ if environ is None else environ
    if env.get(CATALOG_DIR_VAR):
        return env[CATALOG_DIR_VAR]
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "challenges" / "catalog"
        if candidate.is_dir():
            return str(candidate)
    return None
