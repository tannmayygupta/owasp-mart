# Helpers for the live check of state reports

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay |
| Status | Done locally |
| Report tag | live, helpers |

## Requirements covered
FR-INS-07, FR-INS-11 (H-147 point 1).

## Summary
Two helpers for the developer's live run on vm-p and vm-i: `scripts/make-test-certs.ps1` and `scripts/orch_smoke.py`.

## Tests
- `make-test-certs.ps1`: the orchestrator, ingest and client certificates pass `openssl verify -x509_strict` against the test CA.
- `orch_smoke.py` against a TLS orchestrator (fake backend, host process, mutual TLS): `create ...: accepted, state requested`, `resting state: ready`, `destroy: destroyed`.
- vm-p ingest from the api image with TLS and a report key (local Docker): an unsigned post answers 401.

## Problems met and how they were fixed
- A CA made with plain `openssl req -x509` was refused by Python 3.14 (CA cert does not include key usage extension); the test CA now has basicConstraints and keyUsage, the leaves have their own keyUsage and SAN. The CA of the first vm-i run had this flaw (it only served; no client verified it).
- PowerShell 5.1 turned openssl's stderr into errors, and `[IO.File]::WriteAllText` wrote into the process folder, not the current location; fixed with `cmd /c` and full paths.

## Limitations and follow-ups
Not run live yet; the live result is the developer's.

## Follow-up 2026-10-18
The developer's first run of `make-test-certs.ps1` failed at the first `openssl req` (no message, because the script hid stderr). The script worked on Claude's PC, so the likely cause is a Windows openssl build without a config file (the edge-7 proof also writes its own). The script now writes a minimal config when `OPENSSL_CONF` is unset or missing and prints the last openssl error lines. Tested with a normal setup and with `OPENSSL_CONF` pointing to a missing file: both made all certificates and passed `openssl verify -x509_strict`. The developer's real cause is not confirmed until the retry.
