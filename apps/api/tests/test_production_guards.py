"""Production readiness: staging and production refuse the in-memory stand-ins (wiring audit 2026-10-21, section 3). No database and no network is needed: the engines are lazy."""
from __future__ import annotations

import pytest

from vulnmart.kernel.services import build_ports
from vulnmart.kernel.settings import Settings
from vulnmart.live.publisher import LiveOutbox

DSN = "postgresql://vulnmart_app:not-a-secret@127.0.0.1:1/vulnmart"  # nothing listens here; build_ports never connects
KEYS = "postgresql://vulnmart_keys:not-a-secret@127.0.0.1:1/vm_keystore"


@pytest.mark.parametrize("env", ["staging", "production"])
def test_a_strict_environment_without_a_database_does_not_start(env):
    with pytest.raises(RuntimeError, match="VULNMART_POSTGRES_DSN"):
        Settings(env=env).check_stores_for_environment()


@pytest.mark.parametrize("service", ["api", "ingest", "live"])
def test_production_without_the_key_service_does_not_start_for_the_services_that_hold_keys(service):
    with pytest.raises(RuntimeError, match="VULNMART_KEYSTORE_DSN"):
        Settings(env="production", postgres_dsn=DSN, service=service).check_stores_for_environment()


def test_the_worker_needs_no_key_service_and_its_outbox_has_no_email_stand_in():
    Settings(env="production", postgres_dsn=DSN, service="worker").check_stores_for_environment()  # no error
    ports = build_ports(Settings(env="production", postgres_dsn=DSN, service="worker"))
    assert isinstance(ports.outbox, LiveOutbox)
    with pytest.raises(RuntimeError, match="domain events only"):
        ports.outbox.enqueue_email(template="account.verify", to_user_id="u1")


def test_get_settings_runs_both_checks(monkeypatch):
    from vulnmart.kernel.settings import get_settings

    get_settings.cache_clear()
    for k, v in {"VULNMART_ENV": "production", "VULNMART_EMAIL_PROVIDER": "brevo", "VULNMART_BREVO_API_KEY": "key-for-the-test"}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("VULNMART_POSTGRES_DSN", raising=False)
    try:
        with pytest.raises(RuntimeError, match="VULNMART_POSTGRES_DSN"):
            get_settings()
    finally:
        get_settings.cache_clear()


def test_development_keeps_the_stand_ins_so_the_tests_and_the_dev_stack_still_work():
    ports = build_ports(Settings(env="dev"))
    assert ports.engine is None  # the in-memory ports, as before
    dev = build_ports(Settings(env="dev", postgres_dsn=DSN))
    assert isinstance(dev.outbox, LiveOutbox)
    assert dev.outbox.enqueue_email(template="account.verify", to_user_id="u1") is not None
