# State reports proven live on vm-i and vm-p (H-347 point 1)

| Field | Value |
|---|---|
| Date | 2026-10-18 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay |
| Status | Done (live, test setup) |
| Report tag | live, edge, state reports |

## Requirements covered
FR-INS-07, FR-INS-11, NFR-SEC-03, FR-INS-10; handoff H-347 (point 1 closed); H-16.

## Summary
The developer authorised Claude to run the live steps itself (their SSH agent held the key). Claude started the receiver on vm-p from the api image with TLS, turned reports on for the orchestrator container on vm-i with the override file, created one instance through the orchestrator over mutual TLS with `scripts/orch_smoke.py`, destroyed it, and read the recorded history from vm-p. Evidence: `docs/assets/edge-vm-i/reports/h147-state-reports-live.txt`.

## Tests (real results)
- vm-p: unsigned post gave 401; log showed the receiver on https.
- vm-i: orchestrator healthy with `VM_ORCH_REPORT_KEY_FILE` and `SSL_CERT_FILE` set (paths only).
- Smoke: create accepted, resting state `failed` (fake image digests cannot be pulled), destroy `destroyed`, 0 failed pushes.
- vm-p history: transitions 1 to 5 (requested, provisioning, failed, stopping, destroyed), no gap, no duplicate.
- Mutual TLS: no client certificate gives an empty reply, a client certificate with an unsigned request gives 401. `9443` private only.

## Problems met and how they were fixed
- Claude's shell could not use SSH: the authorised key has a passphrase and Git's `ssh.exe` does not see the Windows agent; the Windows `ssh.exe` and `scp.exe` were used (the agent already held the key).
- PowerShell 5.1 removed double quotes inside the command passed to ssh (`bash -c` lost its argument); fixed by running script files.
- The certificate script failed on the developer's PC (no openssl config); fixed earlier (50a0195).

## Security notes
Test CA, keys and the demo token were removed from both hosts and the PC; the demo routes were on for this test only. Claude's failed SSH attempts once printed the two public host addresses in the session.

## Limitations and follow-ups
Not a real shop instance (images unpublished, L-12), in-memory receiver (D-96), no vm-p database, real vm-p client certificate (S-17) not tested. vm-i was left running; stop it to save credits.
