# First live run on vm-i: orchestrator container, secret modes and private bind (H-347 points 2 and 3)

| Field | Value |
|---|---|
| Date | 2026-10-17 |
| Developer | tannmayygupta |
| Branch / commit | sprint-3-tanmay |
| Status | Done for points 2 and 3 of H-347; point 1 (state reports) open |
| Report tag | live, isolation, edge |

## Requirements covered
FR-INS-10, NFR-SEC-04; handoff H-347; decision H-343 (orchestrator as a container).

## Summary
The developer ran the orchestrator container on vm-i (AWS Sydney) following steps written by Claude, and pasted the results. Claude did not use SSH or AWS. The container refuses a key file at mode 644, starts healthy at mode 400 owned by 65532 from bind-mounted files, and publishes 9443 on the private address only. This was a test setup: a throwaway test CA, fake image digests in the release manifest, and no real instance (images are not published yet, L-12).

## What was built
Nothing new in code. `docs/runbooks/edge-vm-i.md` step 3 got five corrections found live; evidence is `docs/assets/edge-vm-i/start/h147-vm-i-run.txt`.

## Tests
Live, by the developer: mode 644 refused (log line recorded), mode 400 healthy (`Up 20 seconds (healthy)`), `ss` shows `<private>:9443` only, `docker ps` shows `<private>:9443->8443/tcp`. Not yet recorded at the time of writing: the refusal of a TLS client without a certificate (the local proof of story edge-6 covers it on Docker Desktop).

## Problems met and how they were fixed
- SSH timed out: the security group did not allow the developer's new address; fixed by adding it to `ssh_source_cidrs` and a Terraform apply (13 rules replaced).
- Windows PowerShell 5.1 corrupts a binary pipe, so the code was copied as a tar file with scp.
- `chmod` with a glob run by `ubuntu` did nothing on mode-700 folders; Docker needed `sudo -E`.
- An empty templates folder, the CI build list used as a release manifest, and a certificate and key from two different runs each stopped the container (messages recorded in the evidence file).

## Limitations and follow-ups
Point 1 of H-347 needs Akshay's platform route `POST /internal/v1/orch/state` (H-16) and an https report URL. No real instance was created on vm-i; that needs L-12 (published images) and a real release manifest. The vm-p client certificate (S-17) is not tested.