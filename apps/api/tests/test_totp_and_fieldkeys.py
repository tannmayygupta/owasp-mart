"""Story P-15: the TOTP code (RFC 6238 test vectors, window, replay, the otpauth address) and the field key (sealed secrets, keyed recovery hashes)."""
from __future__ import annotations

import base64
from datetime import UTC, datetime
from urllib.parse import parse_qs, unquote, urlsplit

import pytest

from vulnmart.accounts import totp
from vulnmart.accounts.fieldkeys import FieldKeyError, FieldKeys

# RFC 6238 appendix B: the SHA-1 secret is the ASCII text "12345678901234567890"; the table gives 8-digit codes, the last 6 digits are the 6-digit code
RFC_SECRET = base64.b32encode(b"12345678901234567890").decode()
RFC_VECTORS = [(59, "94287082"), (1111111109, "07081804"), (1111111111, "14050471"), (1234567890, "89005924"), (2000000000, "69279037"),
               (20000000000, "65353130")]


def at(seconds: int) -> datetime:
    return datetime.fromtimestamp(seconds, UTC)


@pytest.mark.parametrize("seconds,eight_digits", RFC_VECTORS)
def test_the_codes_match_the_rfc_6238_vectors(seconds, eight_digits):
    assert totp.code_for(RFC_SECRET, seconds // 30, digits=8) == eight_digits
    assert totp.code_for(RFC_SECRET, seconds // 30) == eight_digits[-6:], "the 6-digit code is the last six digits"


def test_a_code_of_the_current_step_and_one_step_either_side_is_accepted():
    now = 1234567890
    step = now // 30
    for offset in (-1, 0, 1):
        assert totp.verify(RFC_SECRET, totp.code_for(RFC_SECRET, step + offset), at(now)) == step + offset
    for offset in (-2, 2, 10):
        assert totp.verify(RFC_SECRET, totp.code_for(RFC_SECRET, step + offset), at(now)) is None


def test_a_code_works_once_a_step_not_newer_than_the_last_used_is_refused():
    now = 1234567890
    step = now // 30
    code = totp.code_for(RFC_SECRET, step)
    assert totp.verify(RFC_SECRET, code, at(now), last_used_step=step - 1) == step
    assert totp.verify(RFC_SECRET, code, at(now), last_used_step=step) is None, "the same code again"
    assert totp.verify(RFC_SECRET, totp.code_for(RFC_SECRET, step - 1), at(now), last_used_step=step) is None, "an older code after a newer one"
    assert totp.verify(RFC_SECRET, totp.code_for(RFC_SECRET, step + 1), at(now), last_used_step=step) == step + 1


@pytest.mark.parametrize("bad", ["", "12345", "1234567", "abcdef", "12 456", "١٢٣٤٥٦", "12345\n", " 123456"])
def test_anything_that_is_not_six_ascii_digits_is_refused(bad):
    assert totp.verify(RFC_SECRET, bad, at(1234567890)) is None


def test_a_secret_has_160_bits_in_base32_and_is_new_every_time():
    secrets_made = {totp.new_secret() for _ in range(50)}
    assert len(secrets_made) == 50
    for secret in secrets_made:
        assert len(secret) == 32 and len(base64.b32decode(secret)) == 20


def test_the_otpauth_address_names_the_issuer_the_account_and_the_settings_every_app_supports():
    uri = totp.otpauth_uri("ada+test@example.com", "JBSWY3DPEHPK3PXP")
    parts = urlsplit(uri)
    assert parts.scheme == "otpauth" and parts.netloc == "totp" and len(uri) <= 300
    assert unquote(parts.path) == "/VulnMart:ada+test@example.com" and "@" not in parts.path, "the address is percent-encoded in the label"
    query = {k: v[0] for k, v in parse_qs(parts.query).items()}
    assert query == {"secret": "JBSWY3DPEHPK3PXP", "issuer": "VulnMart", "algorithm": "SHA1", "digits": "6", "period": "30"}


# ---- the field key ---------------------------------------------------------------------------------------------------

SECRET = b"a field key secret of at least 32 bytes!!"


def test_a_sealed_secret_opens_only_for_the_same_key_and_the_same_account():
    keys = FieldKeys.from_secret(SECRET)
    sealed = keys.seal("JBSWY3DPEHPK3PXP", account="u-AAAAAAAAAAAAAAAA")
    assert sealed.startswith("v1.") and "JBSWY3DPEHPK3PXP" not in sealed
    assert keys.open(sealed, account="u-AAAAAAAAAAAAAAAA") == "JBSWY3DPEHPK3PXP"
    with pytest.raises(FieldKeyError):
        keys.open(sealed, account="u-BBBBBBBBBBBBBBBB")  # copied onto another account's row
    with pytest.raises(FieldKeyError):
        FieldKeys.from_secret(b"another field key secret of 32+ bytes").open(sealed, account="u-AAAAAAAAAAAAAAAA")


def test_a_damaged_or_foreign_value_is_refused_not_misread():
    keys = FieldKeys.from_secret(SECRET)
    sealed = keys.seal("JBSWY3DPEHPK3PXP", account="u-A")
    for bad in (sealed[:-3] + "AAA", "v1.", "v1.!!!!", "v2." + sealed[3:], "plain text", ""):
        with pytest.raises(FieldKeyError):
            keys.open(bad, account="u-A")


def test_sealing_is_randomised_so_equal_secrets_look_different():
    keys = FieldKeys.from_secret(SECRET)
    assert keys.seal("same", account="u-A") != keys.seal("same", account="u-A")


def test_a_short_field_key_secret_is_refused():
    with pytest.raises(ValueError):
        FieldKeys.from_secret(b"too short")


def test_a_recovery_hash_depends_on_the_key_the_account_and_the_code():
    keys, other = FieldKeys.from_secret(SECRET), FieldKeys.from_secret(b"another field key secret of 32+ bytes")
    h = keys.recovery_hash("u-A", "ABCDEFGHIJ")
    assert h == keys.recovery_hash("u-A", "ABCDEFGHIJ") and len(h) == 64 and "ABCDEFGHIJ" not in h
    assert h != keys.recovery_hash("u-B", "ABCDEFGHIJ") != keys.recovery_hash("u-B", "ABCDEFGHIK") and h != other.recovery_hash("u-A", "ABCDEFGHIJ")
