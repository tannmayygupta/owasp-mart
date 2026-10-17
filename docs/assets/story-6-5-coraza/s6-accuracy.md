# S-6: Coraza and Core Rule Set accuracy (story 6.5)

Measured: local Docker Desktop, paranoia level 1, 0.5 CPU limit. Helper: `/app/crs-detect` in image vulnmart-sidecar:local (sha256:393710be58819529b7fd1dcb0a7a960a9d4707cefc226c8009e56e254d9d2b8b). These are local numbers; the `vm-i` numbers are a runbook step (docs/runbooks/detection-live-check.md). No flag, key or credential is in this file.

Mode: DetectionOnly. The helper answers matches only (rule ids, tags, anomaly score); nothing here blocks anything. The corpus requests go through the same document builder as the sidecar (cookie and authorization removed, credentials blanked, body cut to 8 KiB).

## Summary

- Exploit requests: 32 in 11 challenges. Requests with at least one CRS attack rule: 15 of 32.
- Challenges where CRS saw at least one exploit request: C03, C06, C10.
- Right family (an expected tag present, or none expected and none found): 31 of 32 exploit requests.
- Benign requests: 60. False positives (at least one CRS attack rule): 0, rate 0.0%. With an anomaly score of 5 or more (the CRS blocking threshold, not used here): 0, rate 0.0%.
- /inspect latency over 500 calls (measured inside the container, loopback): p50 2.76 ms, p95 64.28 ms, p99 80.46 ms, max 99.70 ms.
- Resident memory of the helper with CRS loaded: 64.1 MiB resident (VmRSS of the helper process after 704 calls), peak 64.1 MiB (VmHWM); `docker stats` for the container: 55.91MiB / 256MiB; limit 256 MiB.

Logic-bug challenges (C01, C02, C04, C07, C08, C09, C11) are expected `none`: their requests are ordinary HTTP, and the platform uses app events for them (FR-DET-02). `none` for them is a result, not a failure. C05 (a console left on) and C07 and C09 (rate based) are likewise not request-content attacks.

## Exploit requests

| Request | Challenge | Expected | CRS saw it | Right family | Tags (as sent) | Rules | Score | Note |
|---|---|---|---|---|---|---|---|---|
| C01-a | C01 | none | no | yes | - | 0 | 0 | seller reads an order of another store by number |
| C01-b | C01 | none | no | yes | - | 0 | 0 | the HTML page behind it |
| C02-a | C02 | none | no | yes | - | 0 | 0 | redeem a derived code |
| C02-b | C02 | none | no | yes | - | 0 | 0 | redeem the next serial |
| C03A-a | C03 | sqli | yes | yes | attack_sqli, language_multi, platform_multi | 3 | 15 | UNION probe |
| C03A-b | C03 | sqli | yes | yes | attack_sqli, language_multi, platform_multi | 4 | 20 | read the ops_notes table |
| C03A-c | C03 | sqli | yes | yes | attack_sqli, language_multi, platform_multi | 1 | 5 | tautology |
| C03A-d | C03 | sqli | yes | yes | attack_sqli, language_multi, platform_multi | 2 | 10 | time based |
| C03A-e | C03 | sqli | yes | yes | attack_sqli, language_multi, platform_multi | 1 | 5 | column count probe |
| C03A-f | C03 | sqli | yes | yes | attack_sqli, language_multi, platform_multi | 3 | 15 | schema read by concatenation |
| C03B-a | C03 | xss | yes | yes | attack_sqli, attack_xss, language_multi, platform_multi, platform_nodejs | 5 | 30 | image onerror payload |
| C03B-b | C03 | xss | yes | yes | attack_xss, language_multi, platform_multi, platform_nodejs | 4 | 20 | script tag payload |
| C04-a | C04 | none | no | yes | - | 0 | 0 | first quick refund |
| C04-b | C04 | none | no | yes | - | 0 | 0 | second quick refund with another key |
| C05-a | C05 | none | no | yes | - | 0 | 0 | operations console left on |
| C05-b | C05 | none | no | yes | - | 0 | 0 | console index |
| C05-c | C05 | none | no | yes | - | 0 | 0 | broken JSON for the stack trace |
| C06-a | C06 | injection | yes | yes | attack_injection_generic, attack_rce, language_javascript, platform_multi | 1 | 5 | __proto__ key in the options |
| C06-b | C06 | injection | yes | yes | attack_injection_generic, attack_rce, language_javascript, platform_multi | 1 | 5 | constructor.prototype keys |
| C07-a | C07 | none | no | yes | - | 0 | 0 | one guess of the 4 digit code |
| C07-b | C07 | none | no | yes | - | 0 | 0 | request the reset for the finance account |
| C08-a | C08 | none | no | yes | - | 0 | 0 | unsigned event with the sandbox header |
| C09-a | C09 | none | no | yes | - | 0 | 0 | one guess on the legacy route |
| C09-b | C09 | none | no | yes | - | 0 | 0 | another guess |
| C10-a | C10 | ssrf | yes | yes | attack_rfi, attack_ssrf, language_multi, platform_multi | 2 | 10 | link-local metadata address in a JSON body |
| C10-b | C10 | ssrf | no | no | - | 0 | 0 | internal name |
| C10-c | C10 | ssrf | yes | yes | attack_ssrf, language_multi, platform_multi | 1 | 5 | decimal form of the address (a blocklist bypass) |
| C10-d | C10 | ssrf | yes | yes | attack_rfi, attack_ssrf, language_multi, platform_multi | 2 | 10 | same as a form post |
| C10-e | C10 | ssrf | yes | yes | attack_rfi, attack_ssrf, language_multi, platform_multi | 2 | 10 | same in the query string |
| C10-f | C10 | ssrf | yes | yes | attack_rfi, attack_ssrf, language_multi, platform_multi | 2 | 10 | loopback address |
| C11-a | C11 | none | no | yes | - | 0 | 0 | tax_id[]=x |
| C11-b | C11 | none | no | yes | - | 0 | 0 | array tax id as JSON |

## Per challenge

| Challenge | Requests | Seen by CRS | Expected family | Tags found |
|---|---|---|---|---|
| C01 | 2 | 0 | none | - |
| C02 | 2 | 0 | none | - |
| C03 | 8 | 8 | sqli, xss | attack_sqli, language_multi, platform_multi, attack_xss, platform_nodejs |
| C04 | 2 | 0 | none | - |
| C05 | 3 | 0 | none | - |
| C06 | 2 | 2 | injection | attack_injection_generic, attack_rce, language_javascript, platform_multi |
| C07 | 2 | 0 | none | - |
| C08 | 1 | 0 | none | - |
| C09 | 2 | 0 | none | - |
| C10 | 6 | 5 | ssrf | attack_rfi, attack_ssrf, language_multi, platform_multi |
| C11 | 2 | 0 | none | - |

## False positives on benign traffic

None.

## Tags seen in this run (answers the CRS part of OI-35)

`attack_injection_generic`, `attack_rce`, `attack_rfi`, `attack_sqli`, `attack_ssrf`, `attack_xss`, `language_javascript`, `language_multi`, `platform_multi`, `platform_nodejs`

## Notes and limits

- The benign set is 60 hand-written requests: a small sample. 0 false positives here does not show 0 on real traffic; the real rate is a runbook step on `vm-i`.
- Two things were found and fixed before the final run, and both are reported so the numbers are honest. (1) The corpus had no Content-Length on POST bodies; a real client sends one, and without it CRS rule 920180 flagged every POST (first run: 23 of 60 benign flagged). The script now adds the header, as a real client would. (2) The CRS default method list is GET HEAD POST OPTIONS, so the shop's PUT, PATCH and DELETE were flagged by rule 911100 (3 of 60). `directives.conf` now sets `tx.allowed_methods` to include them; this is not a paranoia change and TRACE and the like are still flagged (Go test).
- The latency p95 and p99 are much higher than the p50: the cause was not investigated (the container has 0.5 CPU).
- C10 `metadata.vulnmart.internal` (an internal name) is not seen: CRS has no rule for a made-up internal host name. The other C10 forms are seen as `attack_ssrf`, so the sidecar label can name SSRF for the address forms only; C10 progress for the name form comes from `importer.fetch_attempt` and `meta.request_served`.
- C06 is seen only as `attack_injection_generic` and `attack_rce` (prototype keys), score 5, exactly at the CRS blocking threshold. This is a request-visible challenge but the label is not specific.
- A paranoia level above 1 was not measured.

Corpus: 92 requests (32 exploit, 60 benign), `services/sidecar/crs/corpus.json`.
