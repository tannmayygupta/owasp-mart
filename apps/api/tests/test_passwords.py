"""Story P-14: password quality (FR-ACC-08): the bundled common-password list, the rules, the Pwned Passwords range client and the
policy chosen by the settings."""
from __future__ import annotations

import hashlib
import io
import logging
import urllib.error

import pytest

from vulnmart.accounts.passwords import (
    BreachCheck, BreachCheckUnavailable, CommonPasswordList, InvalidPassword, PasswordPolicy, PwnedPasswordsRange, make_policy,
    _common_passwords,
)
from vulnmart.kernel.settings import Settings

GOOD = "correct horse battery staple"


def kind_of(policy, password, **kw):
    try:
        policy.check(password, **kw)
    except InvalidPassword as exc:
        return exc.kind
    return None


# ---- the bundled list ------------------------------------------------------------------------------------------------

def test_the_bundled_list_has_the_ten_thousand_common_passwords():
    listed = CommonPasswordList()
    assert len(listed) >= 9990 and all(p and p == p.strip() == p.lower() for p in _common_passwords())
    assert isinstance(listed, BreachCheck)
    for common in ("password", "123456", "qwerty", "PASSWORD", "Password"):
        assert listed.is_breached(common), common
    assert not listed.is_breached(GOOD) and not listed.is_breached("")


# ---- the rules -------------------------------------------------------------------------------------------------------

def test_length_is_12_to_128_characters_counted_as_characters():
    policy = PasswordPolicy()
    assert kind_of(policy, "abcdefghijk") == "password_length" and kind_of(policy, "abcdefghijkl") is None
    assert kind_of(policy, "abcd" * 32) is None and kind_of(policy, "abcd" * 32 + "e") == "password_length", "128 is the most"
    assert kind_of(policy, "pässwörd-ünïcode-✓✓") is None, "any character is allowed"
    assert kind_of(policy, "abcdefghijkl", min_length=16) == "password_length", "admins need 16"


@pytest.mark.parametrize("trivial", ["aaaaaaaaaaaa", "abababababab", "abcabcabcabc", "111111111111", "            "])
def test_a_password_of_fewer_than_four_different_characters_is_refused(trivial):
    assert kind_of(PasswordPolicy(), trivial) == "password_common"


def test_a_password_made_of_the_persons_own_details_is_refused():
    policy = PasswordPolicy()
    assert kind_of(policy, "xx-Ada.Lovelace@Example.com-xx", email="ada.lovelace@example.com") == "password_identity"
    assert kind_of(policy, "my-ada.lovelace-secret", email="ada.lovelace@example.com") == "password_identity", "the part before the @"
    assert kind_of(policy, "I am ADA LOVELACE, truly", display_name="Ada Lovelace") == "password_identity"
    assert kind_of(policy, "I am  Ada   Lovelace, truly", display_name="  ada lovelace ") == "password_identity", "spacing does not hide it"
    assert kind_of(policy, "Ada_Love-lace pass phrase", display_name="Ada Lovelace") == "password_identity", "separators do not hide it"
    assert kind_of(policy, "with-the-letters-ada-in-it", email="ada@example.com", display_name="Ada") is None, "under 4 characters is not checked"
    assert kind_of(policy, GOOD, email="ada.lovelace@example.com", display_name="Ada Lovelace") is None


def test_a_common_password_is_refused_whatever_its_case():
    listed = sorted(p for p in _common_passwords() if len(p) >= 12 and len(set(p)) >= 4)
    assert listed, "the list holds passwords long enough to be tested"
    policy = PasswordPolicy(CommonPasswordList())
    for password in (listed[0], listed[0].upper(), listed[-1], listed[len(listed) // 2].title()):
        assert kind_of(policy, password) == "password_common", password
    assert kind_of(policy, GOOD) is None


def test_the_rules_are_checked_in_a_fixed_order_and_the_list_costs_nothing_without_it():
    class Never:
        def is_breached(self, password):
            raise AssertionError("asked although an earlier rule refused")

    policy = PasswordPolicy(common=CommonPasswordList(), remote=Never())
    assert kind_of(policy, "short") == "password_length"
    assert kind_of(policy, "aaaaaaaaaaaaaaaa") == "password_common"
    assert kind_of(policy, "mail-ada@example.com-x", email="ada@example.com") == "password_identity"


# ---- a breach corpus -------------------------------------------------------------------------------------------------

class Remote:
    def __init__(self, breached=(), fail=False):
        self.breached, self.fail, self.asked = set(breached), fail, []

    def is_breached(self, password):
        self.asked.append(password)
        if self.fail:
            raise BreachCheckUnavailable("TimeoutError")
        return password in self.breached


def test_a_password_in_the_breach_corpus_is_refused_and_a_clean_one_passes():
    remote = Remote(breached={"Tr0ub4dor&3-leaked"})
    policy = PasswordPolicy(CommonPasswordList(), remote)
    assert kind_of(policy, "Tr0ub4dor&3-leaked") == "password_breached"
    assert kind_of(policy, GOOD) is None and remote.asked == ["Tr0ub4dor&3-leaked", GOOD]


def test_when_the_breach_service_does_not_answer_the_password_passes_on_the_other_rules_and_the_outage_is_logged(caplog):
    caplog.set_level(logging.WARNING)
    policy = PasswordPolicy(CommonPasswordList(), Remote(fail=True))
    assert kind_of(policy, GOOD) is None
    assert "did not answer" in caplog.text and GOOD not in caplog.text
    assert kind_of(policy, "password1234abc") != "password_breached"


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


SHA1_PASSWORD = hashlib.sha1(b"password", usedforsecurity=False).hexdigest().upper()  # 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8


def test_the_range_client_sends_only_five_characters_of_the_hash_and_finds_the_suffix():
    seen = {}
    body = (b"003CD215739D7C1B2218670D26F81408237:2\r\n"
            + SHA1_PASSWORD[5:].encode() + b":52372427\r\n"
            + b"0123456789ABCDEF0123456789ABCDEF012:0\r\n")  # a padding line has a count of 0

    def opener(request, timeout):
        seen.update(url=request.full_url, headers={k.lower(): v for k, v in request.header_items()}, timeout=timeout)
        return Response(body)

    client = PwnedPasswordsRange(opener=opener)
    assert client.is_breached("password") is True
    assert seen["url"] == "https://api.pwnedpasswords.com/range/5BAA6" and seen["headers"]["add-padding"] == "true" and seen["timeout"] == 3.0
    path = seen["url"].removeprefix("https://api.pwnedpasswords.com/range/")  # what the service is sent besides its own address
    assert path.upper() == "5BAA6" and "password" not in path.lower() and SHA1_PASSWORD[5:] not in seen["url"]


def test_the_range_client_ignores_padding_and_handles_a_missing_suffix():
    padded = SHA1_PASSWORD[5:].encode() + b":0\r\n"
    assert PwnedPasswordsRange(opener=lambda r, timeout: Response(padded)).is_breached("password") is False
    assert PwnedPasswordsRange(opener=lambda r, timeout: Response(b"")).is_breached("password") is False
    assert PwnedPasswordsRange(opener=lambda r, timeout: Response(b"garbage line\n:\nnot:a:count\n")).is_breached("password") is False


@pytest.mark.parametrize("error", [urllib.error.URLError("no route"), urllib.error.HTTPError("u", 503, "x", {}, io.BytesIO(b"")), TimeoutError(), OSError("reset")])
def test_the_range_client_turns_failures_into_unavailable(error):
    def opener(request, timeout):
        raise error

    with pytest.raises(BreachCheckUnavailable):
        PwnedPasswordsRange(opener=opener).is_breached("whatever-password")


# ---- the policy the settings choose ------------------------------------------------------------------------------------

def test_the_default_setting_checks_the_bundled_list_and_asks_nobody():
    policy = make_policy(Settings())
    assert kind_of(policy, "password") == "password_length" and policy._remote is None and policy._common is not None
    assert Settings().breach_check == "local"


def test_hibp_adds_the_range_client_and_off_is_for_dev_and_test_only():
    assert isinstance(make_policy(Settings(breach_check="hibp"))._remote, PwnedPasswordsRange)
    off = make_policy(Settings(breach_check="off"))
    assert off._common is None and off._remote is None
    for env in ("staging", "production"):
        with pytest.raises(RuntimeError, match="BREACH_CHECK=off"):
            make_policy(Settings(env=env, breach_check="off"))
        assert make_policy(Settings(env=env))._common is not None
