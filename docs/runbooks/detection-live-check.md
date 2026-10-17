# Runbook: live check of flag detection on vm-i (story 6.4, task L-21 part 2, task T-32 with Sahil)

Owner of the run: Tanmay with Sahil. Claude helps read the outputs; it never runs these steps, never calls AWS and never sees a secret. Nothing in this runbook has been run live. The local loop (`scripts/detect_loop.py`, Docker Desktop, stub shop, fake ingest) proves the chain on a PC only; every number it prints is labelled LOCAL. This runbook is how the live number (NFR-PRF-03: a captured flag is credited in the live-update target, under 10 seconds from the request) is measured with the real edge relay, the real ingest and the real shop. Until you record a result in the dev-log, no document says the live check passed.

**Rules.** No flag, event key, digest, address or account ID goes into the repository, a document, a log or a chat message. Describe a result as a number or PASS/FAIL, never the value. Commands are for the host shell (Linux on `vm-i`) unless a step says PowerShell. Tick a box only when its check is true.

## Before you start

- [ ] The real edge (stories edge-1 and edge-2, task L-17/L-18) and Akshay's ingest endpoint (H-75) are deployed. If they are not, **stop**: the event path does not exist and the engine has nothing to read. Record that fact; the local loop is then the only proof.
- [ ] The release manifest carries the product sidecar image by digest (`infra/images.json`, built by the pipeline from `services/sidecar`), and the orchestrator on `vm-i` reads it.
- [ ] You have the platform's staff view or database read access to look at `events`, `milestones` and `evidence` rows (Akshay's tables, H-330). If the tables are not there yet, use the fake-ingest style read described in step 6 and say so.
- [ ] A test attempt (a learner account of your own) with one instance of the shop template.

## Steps

1. **Images.** On `vm-i` list the images the orchestrator will use and check that the sidecar reference is a digest, not a tag. Save the list (no secrets in it).
2. **Create a real instance** through the platform (start an attempt on a template with C05 and one other challenge). Wait for `ready`. Check on the host that the instance has an injector exit 0, a shop, a sidecar and the labels (`docker ps --filter label=vm.instance=<id>`). Save the state and the container list.
3. **The planted-flag request.** As the learner, open the instance through the edge and cause the shop to return the planted flag of C05 the way the challenge intends (the normal exploit path). Note the wall-clock time of the request (UTC, to the second).
4. **Read the credit.** In the platform, find the milestone of C05 for the attempt and its time. The live-update time is milestone time minus request time. Record the number and the two times (UTC). Target: under 10 seconds.
5. **Decoy and other instance.** Cause a decoy value of one challenge to appear in a response, then a flag of a second instance. Check: no milestone from either, a decoy integrity flag and a sharing integrity flag exist for the attempt.
6. **Evidence.** Through the report or review screen (or the `ReportPort` reader once it is wired) read the evidence of C05: one item, readable, holding the redacted request and no flag. Check that after the attempt's key is shredded (end the attempt through the normal purge path, not by hand) the body cannot be read any more (ATT-GONE).
7. **Paste.** In a second challenge paste the correct flag in the submit form: correct, credited. Paste a wrong value six times in ten minutes: the sixth answer is 429 with Retry-After.
8. **Activity.** Look at the activity buckets of the instance: counts per minute, no bodies. Note the last-activity value. (How it reaches the orchestrator's idle rule is open, H-122.)
9. **Scan.** On `vm-i` run `node scripts/scan-flags.mjs --instance <id>` before the instance is destroyed, and `node scripts/scan-flags.mjs --file <orchestrator log>` for the orchestrator log. Expected: exit 0.
10. **Clean up.** Destroy the instance through the platform. Check that no container, network or volume with the instance label remains.

## Evidence to save under `docs/assets/story-6-4-live-check/`

The container list of step 2, the times and the computed difference of step 4 (numbers only), the integrity flag and evidence listing of steps 5 and 6 (types and counts, no body), the scan outputs of step 9, and a one-line statement of the host, the date and who ran it. Mark the file names `live-`. Anything measured on a PC is named `local-` and is never mixed with these.

## What to write down if a step fails

The step number, the exact visible message or code, the time, and what you changed before the retry. Do not guess a cause; ask. A failure of step 1 or the first box means the edge is not deployed yet and is not a detection problem.

## Unverified

Wall-clock agreement between your clock and the platform's (use the platform's own times for both ends if the screen shows them), the names of the staff screens, and whether the evidence reader is wired to the real report screen yet.
