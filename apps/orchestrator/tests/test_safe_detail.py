"""The operator's log line for a refused start must say what the host refused and never carry a flag, a key or a long hex value (found live, story L-29)."""
from vulnmart_orchestrator.engine import safe_detail


def test_the_host_error_is_one_short_line_without_a_flag_a_key_or_a_long_hex_value():
    flag = "VM{" + "ABCDEFGH" * 3 + "}"
    key = "k" * 50
    digest = "a" * 64
    text = f"APIError: 400 Client Error: OCI runtime create failed: env {flag}\nimage sha256:{digest} token {key} unknown or invalid runtime name: kata"
    out = safe_detail(text)
    assert flag not in out and key not in out and digest not in out
    assert "\n" not in out and "unknown or invalid runtime name: kata" in out and "<removed>" in out
    assert len(safe_detail("x " * 500)) <= 220
    assert safe_detail("no such container") == "no such container"