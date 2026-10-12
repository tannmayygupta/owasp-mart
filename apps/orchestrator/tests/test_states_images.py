import json
import re

import pytest
import yaml
from support import OPENAPI, allowlist, digest

from vulnmart_orchestrator.images import ImageAllowlist, ImageNotAllowed
from vulnmart_orchestrator.states import (
    INJECTOR_EXIT_CODES, TRANSITIONS, ErrorCode, InstanceState, check_transition, injector_error_code,
)

SPEC = yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))
SCHEMAS = SPEC["components"]["schemas"]


def test_states_equal_the_openapi_enum():
    assert {s.value for s in InstanceState} == set(SCHEMAS["State"]["enum"])


def test_error_codes_have_the_openapi_shape_and_orch_codes_are_in_the_registry():
    pattern = re.compile(SCHEMAS["ErrorCode"]["pattern"])
    codes = [v for k, v in vars(ErrorCode).items() if not k.startswith("_")]
    assert codes and all(pattern.match(c) for c in codes)
    from vulnmart_models.error_codes import ERRORS, ErrorCode as RegistryCode

    for c in (c for c in codes if c.startswith("ORCH-") and c != "ORCH-ERROR"):  # ORCH-ERROR is the label of the base class, never sent
        assert RegistryCode(c) in ERRORS, c


def test_state_report_error_code_fields_use_the_same_schema():
    report = SCHEMAS["StateReport"]["properties"]
    assert "error_code" in report


def test_transition_table_matches_the_contract():
    assert (None, InstanceState.REQUESTED) in TRANSITIONS
    assert (InstanceState.STARTING, InstanceState.READY) in TRANSITIONS
    assert (InstanceState.READY, InstanceState.STARTING) not in TRANSITIONS
    assert (InstanceState.DESTROYED, InstanceState.READY) not in TRANSITIONS
    for frm in ("ready", "active", "idle", "provisioning", "starting", "requested", "failed"):
        assert (InstanceState(frm), InstanceState.STOPPING) in TRANSITIONS
    with pytest.raises(ValueError):
        check_transition(InstanceState.READY, InstanceState.STARTING)


def test_injector_exit_codes():
    assert injector_error_code(10) == "INST-INJECT-BAD-DOCUMENT"
    assert injector_error_code(11) == "INST-INJECT-SNAPSHOT-PATCH"
    assert injector_error_code(12) == "INST-INJECT-PLACEMENT-WRITE"
    assert injector_error_code(13) == "INST-INJECT-MARKER-WRITE"
    assert injector_error_code(137) == "INST-INJECT-FAILED"
    assert set(INJECTOR_EXIT_CODES) == {10, 11, 12, 13}


def test_allowlist_resolves_only_its_roles():
    a = allowlist(roles=("shop",))
    assert a.resolve("{image:shop}").endswith(digest("shop"))
    with pytest.raises(ImageNotAllowed):
        a.resolve("{image:sidecar}")
    for bad in ("shop", "{image:}", "evil/image:latest", "{image:shop}x", ""):
        with pytest.raises(ImageNotAllowed):
            a.resolve(bad)


def test_allowlist_needs_digests_and_known_roles():
    with pytest.raises(ValueError):
        ImageAllowlist({"shop": "registry.invalid/shop:latest"})
    with pytest.raises(ValueError):
        ImageAllowlist({"other": "sha256:" + "a" * 64}, allow_local_ids=True)
    with pytest.raises(ValueError):
        ImageAllowlist({"shop": "sha256:" + "a" * 64}, commands={"sidecar": ("x",)}, allow_local_ids=True)


def test_allowlist_loads_a_manifest_file(tmp_path):
    f = tmp_path / "release.json"
    f.write_text(json.dumps({"images": {"shop": "r.invalid/shop@" + digest("shop")}, "commands": {"shop": ["shop"]}}), encoding="utf-8")
    a = ImageAllowlist.load(f)
    assert a.commands["shop"] == ("shop",)
    f.write_text(json.dumps({"images": {}, "extra": 1}), encoding="utf-8")
    with pytest.raises(ValueError):
        ImageAllowlist.load(f)

def test_manifest_healthchecks_override_the_template_check_for_an_image_without_wget():
    from vulnmart_orchestrator.images import ImageAllowlist
    from vulnmart_orchestrator.builder import CreateSpec, build_plan  # noqa: F401
    from support import allowlist, digest, template, body
    import copy

    manifest = {"images": {"shop": "r.invalid/shop@" + digest("shop")}, "healthchecks": {"shop": ["CMD", "/nodejs/bin/node", "-e", "process.exit(0)"]}}
    a = ImageAllowlist.from_manifest(manifest)
    assert a.healthchecks["shop"][1] == "/nodejs/bin/node"
    with pytest.raises(ValueError):
        ImageAllowlist.from_manifest({"images": {"shop": "r.invalid/shop@" + digest("shop")}, "healthchecks": {"sidecar": ["CMD", "x"]}})


# ---- L20: the digest check matches the whole reference; a bare image id is for tests and the local demo only ----
@pytest.mark.parametrize("ref", [
    "registry.invalid/shop@sha256:" + "a" * 64 + "\n",  # a trailing newline passed the old `$` anchor
    "registry.invalid/shop@sha256:" + "a" * 64 + " x",
    "registry.invalid/shop@sha256:" + "a" * 63,
    "registry.invalid/shop@sha256:" + "A" * 64,
    "registry.invalid/shop:latest",
])
def test_a_malformed_digest_reference_is_refused(ref):
    with pytest.raises(ValueError):
        ImageAllowlist({"shop": ref}, allow_local_ids=True)


def test_a_bare_image_id_is_refused_unless_the_allowlist_is_made_for_local_use(tmp_path):
    bare = "sha256:" + "a" * 64
    with pytest.raises(ValueError, match="bare image id"):
        ImageAllowlist({"shop": bare})
    assert ImageAllowlist({"shop": bare}, allow_local_ids=True).images["shop"] == bare
    f = tmp_path / "images.json"
    f.write_text(json.dumps({"images": {"shop": bare}}), encoding="utf-8")
    with pytest.raises(ValueError, match="bare image id"):
        ImageAllowlist.load(f)
    assert ImageAllowlist.load(f, allow_local_ids=True).images["shop"] == bare
