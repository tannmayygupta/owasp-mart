import copy
import json

import jsonschema
import pytest
from support import EVENT_KEY, FLAG_A, IID, OWNER, SEED, TEMPLATE_SCHEMA, allowlist, body, template

from vulnmart_orchestrator.builder import (
    FORBIDDEN_FIELDS, LABELS, TemplateInvalid, build_plan, injection_document, parse_create, sidecar_document,
)
from vulnmart_orchestrator.images import ImageNotAllowed
from vulnmart_orchestrator.states import FieldForbidden, ValidationFailed

SPEC = parse_create(body())


def plan(t=None, images=None):
    return build_plan(t or template(), SPEC, images or allowlist())


def test_the_example_template_is_valid_against_the_schema():
    schema = json.loads(TEMPLATE_SCHEMA.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator(schema).validate(template())


def test_plan_has_the_fixed_runtime_profile_for_every_container():
    p = plan()
    assert len(p.containers) == 7 and p.keeper.component == "volume-keeper" and p.injector.component == "injector"
    for c in p.containers:
        assert (c.user, c.read_only, c.privileged, c.cap_drop) == ("65532:65532", True, False, ("ALL",))
        assert c.security_opt == ("no-new-privileges:true",)
        assert {t for t, _ in c.tmpfs} <= {"/tmp", "/data"}
        assert "@sha256:" in c.image
        assert set(c.labels) == set(LABELS) and c.labels["vm.instance"] == IID and c.labels["vm.kind"] == "inst"
        assert c.labels["vm.owner"] == OWNER and c.labels["vm.epoch"] == "1"
    assert p.network.internal is True and p.network.labels["vm.instance"] == IID
    assert all(v.labels["vm.instance"] == IID and v.driver_opts["type"] == "tmpfs" for v in p.volumes)
    assert all("e1" in v.name and IID.lower() in v.name for v in p.volumes)


def test_networks_injector_and_keeper():
    p = plan()
    assert p.injector.network == "none" and p.injector.stdin == "injection"
    assert p.keeper.network == "none" and all(m.read_only for m in p.keeper.mounts) and len(p.keeper.mounts) == 4
    by = {c.component: c for c in p.others}
    assert by["shop"].network == p.network.name and by["shop"].aliases == ("shop",)
    assert by["import-service"].network == "none"
    assert by["sidecar"].stdin == "sidecar" and by["shop"].stdin is None
    assert by["shop"].healthcheck.test[-1].endswith("/readyz")


def test_placeholders_are_filled_and_no_secret_is_in_env_or_labels():
    p = plan()
    shop = next(c for c in p.others if c.component == "shop")
    assert shop.env["VM_INSTANCE_ID"] == IID and shop.env["VM_EPOCH"] == "1"
    assert shop.env["VM_PUBLIC_HOST"] == SPEC.hostname
    for c in p.containers:
        blob = json.dumps([c.env, c.labels, c.command, c.entrypoint])
        for secret in (FLAG_A, SEED, EVENT_KEY):
            assert secret not in blob
        assert not any(k.startswith("VM_FLAG_") for k in c.env)


def test_flag_in_env_exception_only_for_the_shop():
    t = template()
    shop = next(c for c in t["components"] if c["role"] == "shop")
    shop["flag_delivery_env"] = {"challenge_key": "C01", "env_name": "VM_FLAG_C01", "reason": "This challenge needs the flag in the shop environment."}
    p = plan(t)
    assert next(c for c in p.others if c.component == "shop").env["VM_FLAG_C01"] == FLAG_A
    assert all("VM_FLAG_C01" not in c.env for c in p.containers if c.component != "shop")
    t2 = copy.deepcopy(t)
    next(c for c in t2["components"] if c["role"] == "sidecar")["flag_delivery_env"] = shop["flag_delivery_env"]
    with pytest.raises(TemplateInvalid):
        plan(t2)
    t3 = copy.deepcopy(t)
    next(c for c in t3["components"] if c["role"] == "shop")["flag_delivery_env"]["challenge_key"] = "C09"
    with pytest.raises(TemplateInvalid):
        plan(t3)


def test_image_not_in_the_allowlist_is_refused():
    with pytest.raises(ImageNotAllowed):
        plan(images=allowlist(roles=("shop", "sidecar", "injector")))
    with pytest.raises(ImageNotAllowed):  # no volume-keeper image
        plan(images=allowlist(roles=("shop", "sidecar", "injector", "import-service", "mock-services", "bot-controller")))
    t = template()
    next(c for c in t["components"] if c["role"] == "shop")["image"] = "evil/image:latest"
    with pytest.raises(ImageNotAllowed):
        plan(t)
    t = template()
    next(c for c in t["components"] if c["role"] == "shop")["image"] = "{image:sidecar}"
    with pytest.raises(TemplateInvalid):
        plan(t)


@pytest.mark.parametrize("mutate", [
    lambda c: c.update(privileged=True),
    lambda c: c.update(user="0:0"),
    lambda c: c.update(read_only=False),
    lambda c: c.update(cap_drop=[]),
    lambda c: c.update(network_mode="host"),
    lambda c: c["mounts"].append({"type": "bind", "target": "/tmp/x", "source": "/etc"}),
    lambda c: c["mounts"].append({"type": "tmpfs", "target": "/var", "size_mb": 1}),
    lambda c: c["env"].update(VM_FLAG_C01="x"),
    lambda c: c["env"].update(API_KEY="x"),
    lambda c: c["mounts"].append({"type": "volume", "target": "/run/vm", "source": "undeclared", "read_only": True}),
])
def test_a_template_that_breaks_the_profile_is_refused(mutate):
    t = template()
    mutate(next(c for c in t["components"] if c["role"] == "shop"))
    with pytest.raises(TemplateInvalid):
        plan(t)


@pytest.mark.parametrize("field", sorted(FORBIDDEN_FIELDS))
def test_a_request_cannot_carry_container_fields(field):
    with pytest.raises(FieldForbidden):
        parse_create({**body(), field: "x"})


def test_unknown_or_malformed_request_fields_are_validation_errors():
    for bad in ({**body(), "surprise": 1}, {**body(), "epoch": 0}, {**body(), "epoch": True}, {**body(), "epoch": 1.0},
                {**body(), "instance_id": "i-abc"}, {**body(), "template_id": "../x"}, {**body(), "seed": "short"},
                {k: v for k, v in body().items() if k != "owner_hash"}, [], {**body(), "limits": {}}):
        with pytest.raises(ValidationFailed):
            parse_create(bad)


def test_no_request_value_changes_any_image_command_volume_port_or_env_name():
    """Whatever the request values are, the structural parts of every container are the same."""
    other = parse_create(body(iid="i-ZZZZZZZZZZZZZZZZ", epoch=7, hostname="other.example.invalid"))
    a, b = plan(), build_plan(template(), other, allowlist())

    def shape(c):
        return (c.role, c.image, c.entrypoint, c.command, sorted(c.env), [(m.target, m.read_only) for m in c.mounts],
                c.tmpfs, c.memory_mb, c.cpu_limit, c.pids_limit, c.healthcheck, c.user, c.cap_drop)

    assert [shape(c) for c in a.containers] == [shape(c) for c in b.containers]


def test_documents_hold_what_the_contract_says_and_the_sidecar_gets_digests_only():
    inj = json.loads(injection_document(SPEC))
    assert set(inj) == {"schema_version", "instance_id", "epoch", "seed", "flags", "decoys"}
    assert inj["flags"][0] == {"challenge_key": "C01", "flag": FLAG_A}
    side = json.loads(sidecar_document(SPEC))
    assert set(side) == {"schema_version", "instance_id", "epoch", "event_key", "flag_digests"}
    assert FLAG_A not in json.dumps(side) and SEED not in json.dumps(side)
    assert {d["kind"] for d in side["flag_digests"]} == {"real", "decoy"}


def test_fingerprint_changes_with_any_field_and_repr_hides_secrets():
    assert SPEC.fingerprint() == parse_create(body()).fingerprint()
    assert SPEC.fingerprint() != parse_create(body(seed="Z" * 40)).fingerprint()
    text = repr(SPEC)
    for secret in (FLAG_A, SEED, EVENT_KEY, OWNER):
        assert secret not in text
