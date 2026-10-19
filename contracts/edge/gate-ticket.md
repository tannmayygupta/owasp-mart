# Gate contract: ticket, cookie, access state, hostname rule (GATE)

Status: 1.0.0, stable (shipped; live on vm-i since 2026-10-17) (ADR 0004 is decided on the developer's delegation, D-60; the developer confirms). Owner: stream L. Consumers: the platform API (it signs tickets, stream P) and the orchestrator (it pushes the access state, stream L). Code: `apps/edge/src/`. Vectors: `examples/ticket-vectors.json`, checked by `apps/edge/test/vectors.test.mjs`.

## 1. Words

- **Instance id**: `i-` plus 16 Base32 characters in upper case, `^i-[A-Z2-7]{16}$` (IF-5).
- **Host label**: the same id in lower case. The instance hostname is `<host label>.<zone>`, for example `i-abcdefghijklmnop.labs.example`.
- **Owner hash**: 64 lower-case hex characters (IF-5 `owner_hash`). The gate never sees an account id.
- **Access epoch** (`ae`): integer 0 to 2^53 - 1. A new open raises it; older tickets and cookies stop working.
- **Gate key**: HMAC key of at least 32 bytes, shared by the API and the gate only (ADR 0009). The gate accepts two keys, `current` and `previous` (rotation: sign with `current`; remove `previous` after the longest ticket life and the cookie life have passed). Tests and vectors use throwaway keys.
- All times are unix seconds. All tokens are ASCII.

## 2. Ticket

`ticket = b64u(payload) "." b64u(HMAC-SHA256(key, "vm-ticket-v1\n" + b64u(payload)))`

`b64u` is base64url without padding; a receiver accepts only the canonical form (re-encoding gives the same text; no padding, no standard-alphabet characters, no whitespace). The payload is a JSON object with exactly these members and no others:

| Member | Type | Rule |
|---|---|---|
| `v` | integer | 1 |
| `inst` | string | instance id |
| `own` | string | owner hash |
| `ae` | integer | access epoch, at least 0 |
| `exp` | integer | expiry (unix seconds) |
| `jti` | string | 16 random bytes as base64url (22 characters), single use |

The signer sets `exp` to at most 60 seconds after signing. There is no `iat`, so the verifier enforces the life with its own clock: a ticket is valid while `exp > now` and `exp - now <= 60`. A ticket with `exp - now > 60` is refused (`too-far`). Signer and gate clocks are expected to agree within a few seconds (open point: skew allowance).

Verdict order of the verifier: shape and base64 (`malformed`), signature against `current` then `previous` (`signature`), payload members and types (`claims`), `exp <= now` (`expired`), `exp - now > 60` (`too-far`). The gate answers every refusal with the same page; the reason exists for the vectors and the logs only.

Gate checks after the signature (section 6): `inst` equals the host's instance, `own` equals the state's owner, `ae` equals the state's access epoch (a ticket older than the state is refused; a ticket newer than the state is refused too), and `jti` has not been seen (kept until `exp`, at most 10000 ids; when the set is full a new ticket is refused rather than an id forgotten).

## 3. Cookie

`cookie value = b64u(payload) "." b64u(HMAC-SHA256(key, "vm-cookie-v1\n" + b64u(payload)))`, payload members exactly `v` (1), `inst`, `own`, `ae` as above, no `exp` (session lifetime). The two prefixes keep a ticket from working as a cookie and the reverse.

Set-Cookie sent by the gate on a good ticket: `__Host-vm_gate=<value>; Path=/; Secure; HttpOnly; SameSite=Lax` with no `Domain`, no `Max-Age`, no `Expires`. The `__Host-` prefix makes the browser keep it host-only. The gate removes this cookie (and only this one) from the Cookie header before it forwards a request. The name twice in one Cookie header is refused.

## 4. Hostname rule (D-68)

Only the `Host` header counts (never `X-Forwarded-Host`). A host is accepted only if it equals `<label>.<zone>` where `<label>` matches `^i-[a-z2-7]{16}$` and `<zone>` is the configured zone exactly. Nothing is lower-cased, trimmed or normalised: an upper-case letter, a port, a trailing dot, a userinfo part, two labels in front, a label of 15 or 17 characters, another zone, an IP address or a missing Host are all refused, before any state lookup, with the same answer as an unknown instance (410, "ended" page). The zone is lower case with at least two labels, no port and no trailing dot; the gate does not start with another value.

## 5. Access state and admin API

State per instance, pushed by the orchestrator, kept in memory only: `{hostname, instance_id, epoch, owner, access, access_epoch}`.

| Member | Rule |
|---|---|
| `hostname` | exactly `<host label>.<zone>` of the `instance_id` |
| `instance_id` | instance id |
| `epoch` | integer at least 1 (the container epoch; names the upstream) |
| `owner` | owner hash |
| `access` | `open`, `frozen` or `closed` |
| `access_epoch` | integer at least 0 |

An instance without a record behaves as closed (fail closed). A gate restart loses the state and the used-ticket set: everything is closed until the orchestrator syncs; a replay inside the 60 s window after a restart is the accepted residual.

Admin calls need the header `X-VM-Gate-Admin` equal to the secret read from a file (constant-time comparison; a missing, empty or shorter than 16 characters secret refuses every call). Bodies are `application/json`, closed (unknown or missing members are refused), at most 4 KiB (one record) or 1 MiB (sync).

| Call | Effect | Answers |
|---|---|---|
| `PUT /internal/v1/gate/instances/{instance_id}` | store one record; `instance_id` of the path equals the body | 204; 401, 404, 405, 409, 413, 415, 422 |
| `DELETE /internal/v1/gate/instances/{instance_id}` | remove the record (the instance becomes unknown); repeatable | 204 |
| `PUT /internal/v1/gate/sync` | body `{"instances": [record, ...]}` replaces everything, all or nothing, at most 2000 | 204; as above |

Epoch rule (like IF-5): the push is refused with 409 and the state unchanged when `access_epoch` is lower than the stored one, when `epoch` is lower than the stored one, or when `access_epoch` is equal and `access` or `owner` differs. An equal push with the same values is accepted (idempotent). A sync applies the rule to every entry that already exists, and one conflict refuses the whole sync. Errors are `application/problem+json` with `type` `about:blank`, `title`, `status` and an optional `detail` (the gate is internal; the IF-8 code registry does not apply).

## 6. Decision per request

In this order; the first rule that applies decides.

1. Host rule (section 4): refused is 410.
2. State: unknown or `closed` is 410 ("ended"); `frozen` is 423 ("paused"). Static pages, never forwarded.
3. Reserved path: a path that is `/_vm` or starts with `/_vm/` after percent-decoding, backslash to slash, dot-segment removal and slash collapsing (any case) belongs to the gate. Only `GET /_vm/enter?t=<ticket>` (exactly one `t`) does something; everything else under `/_vm/` is 404, never forwarded. A ticket that fails any check of section 2 is 403 (the same page for forged, expired, replayed, wrong owner, wrong instance, old or new epoch). A good ticket is 302 to `/` with the Set-Cookie of section 3, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`; the ticket is then spent.
4. Cookie: absent, malformed, forged, `inst` other than the host's instance, `own` other than the state's owner, or `ae` other than the state's access epoch is 403.
5. Allow: forward to `vm-<instance id lower case>-e<epoch>-sidecar:8080` (built only from validated fields) with the gate cookie removed. The gate adds no CSP, HSTS or other security header to shop responses (architecture 03 section 2.4).

All comparisons of secrets, signatures, owner hashes and ids are constant time. A refusal never says why.

## 7. Open points

- Clock skew between the signer and the gate (section 2): none allowed now.
- 403 for a bad ticket on a known instance and 410 for an unknown one are different answers; a prober who guesses a 80-bit host label learns nothing before it succeeds, so this stays as decided.
- Platform side: the API signs the ticket with `current` and gets the owner hash and access epoch from IF-5 (stream P, via the handoff of story 5).
