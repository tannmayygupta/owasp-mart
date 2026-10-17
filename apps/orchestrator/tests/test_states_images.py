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


# ---- Story 3.7 (D-56): the pipeline's release file `{commit, repo, images, healthchecks}` is accepted ----
import shutil
import subprocess
import sys
from pathlib import Path

NODE_PROBE = ["/nodejs/bin/node", "-e", "process.exit(0)"]


def release_data(**over):
    d = {
        "commit": "a" * 40, "repo": "owner/name",
        "images": {r: f"ghcr.io/owner/name/{r}@" + digest(r) for r in ("hello", "shop", "mock-services", "import-service", "bot-controller")},
        "healthchecks": {r: list(NODE_PROBE) for r in ("shop", "mock-services", "import-service", "bot-controller")},
    }
    d.update(over)
    return d


def test_release_file_gives_four_roles_with_cmd_tests_and_skips_hello():
    a = ImageAllowlist.from_release(release_data())
    assert sorted(a.images) == ["bot-controller", "import-service", "mock-services", "shop"]
    assert "hello" not in a.images
    assert a.healthchecks["shop"] == ("CMD", *NODE_PROBE)


def test_release_file_is_used_by_build_plan_for_the_shop_template():
    from support import template
    from vulnmart_orchestrator.builder import build_plan, parse_create
    from support import body

    a = ImageAllowlist.from_release(release_data(images={r: f"ghcr.io/o/n/{r}@" + digest(r) for r in ("shop", "sidecar", "injector", "import-service", "mock-services", "bot-controller", "volume-keeper")}))
    plan = build_plan(template(), parse_create(body()), a)
    shop = next(c for c in plan.containers if c.role == "shop")
    assert shop.healthcheck.test[0] == "CMD" and shop.healthcheck.test[1] == "/nodejs/bin/node"


def test_release_file_with_an_unknown_top_level_key_is_refused():
    with pytest.raises(ValueError, match="foo"):
        ImageAllowlist.from_release(release_data(foo=1))


def test_release_file_healthcheck_without_an_image_is_refused():
    d = release_data()
    del d["images"]["shop"]
    with pytest.raises(ValueError, match="shop"):
        ImageAllowlist.from_release(d)


@pytest.mark.parametrize("argv", [
    ["/bin/sh", "-c", "exit 0"], ["/bin/bash", "-c", "x"], ["/usr/bin/wget", "-q", "x"], ["wget", "x"], ["/usr/bin/curl", "x"], ["/bin/nc", "x"],
    ["node", "-e", "1"], [], [""], ["/x"] + ["a"] * 16, ["/x", "a" * 513], ["/x", 1], "node",
])
def test_release_file_refuses_a_bad_healthcheck(argv):
    with pytest.raises(ValueError):
        ImageAllowlist.from_release(release_data(healthchecks={"shop": argv}))


def test_release_file_bad_digest_is_refused():
    d = release_data()
    d["images"]["shop"] = "ghcr.io/o/n/shop:latest"
    with pytest.raises(ValueError):
        ImageAllowlist.from_release(d)


def test_release_file_healthcheck_that_starts_with_cmd_is_not_doubled():
    a = ImageAllowlist.from_release(release_data(healthchecks={"shop": ["CMD", *NODE_PROBE]}))
    assert a.healthchecks["shop"] == ("CMD", *NODE_PROBE)


def test_the_strict_manifest_still_refuses_commit_and_repo():
    with pytest.raises(ValueError):
        ImageAllowlist.from_manifest(release_data())


def test_load_picks_the_loader_by_file_form(tmp_path):
    f = tmp_path / "release.json"
    f.write_text(json.dumps(release_data()), encoding="utf-8")
    assert ImageAllowlist.load(f).healthchecks["shop"][0] == "CMD"
    f.write_text(json.dumps({"images": {"shop": "r.invalid/shop@" + digest("shop")}, "healthchecks": {"shop": list(NODE_PROBE)}}), encoding="utf-8")
    assert ImageAllowlist.load(f).healthchecks["shop"] == ("CMD", *NODE_PROBE)
    f.write_text(json.dumps({"images": {}, "foo": 1}), encoding="utf-8")
    with pytest.raises(ValueError):
        ImageAllowlist.load(f)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_output_of_the_real_release_script_is_loaded(tmp_path):
    """Runs the real `buildRelease` of scripts/images-release.mjs (a pure function: no git or registry) on the five image names (infra/images.json lists only hello until the shop PR merges), adds the healthchecks the shop PR adds, loads the result."""
    root = Path(__file__).resolve().parents[3]
    script = (
        "import {buildRelease} from './scripts/images-release.mjs';"
        "const d={registry:'ghcr.io',images:['hello','shop','mock-services','import-service','bot-controller'].map((name)=>({name}))};const dg={};for(const i of d.images)dg[i.name]='sha256:'+'b'.repeat(64);"
        "process.stdout.write(JSON.stringify(buildRelease(d,dg,{commit:'a'.repeat(40),repo:'Owner/Name'})));"
    )
    out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=root, capture_output=True, text=True, check=True).stdout
    rel = json.loads(out)
    rel["healthchecks"] = {r: list(NODE_PROBE) for r in rel["images"] if r != "hello"}
    f = tmp_path / "release.json"
    f.write_text(json.dumps(rel), encoding="utf-8")
    a = ImageAllowlist.load(f)
    assert "hello" not in a.images and a.healthchecks["shop"][:2] == ("CMD", "/nodejs/bin/node")
