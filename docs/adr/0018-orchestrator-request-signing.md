# 0018. Signing of platform-to-orchestrator requests (IF-5)

- **Status:** Proposed (written during story L-04; to be confirmed by Akshay, stream P, in the team chat)
- **Date:** 2026-10-09
- **Deciders:** Tanmay (stream L). Consumer to confirm: Akshay (the platform worker is the client).
- **Requirements:** NFR-SEC-04, FR-INS-01; architecture 06 (mTLS plus a signed body with timestamp and nonce, rate limits, audit); IF-5 (`contracts/orchestrator/orchestrator-api.md`)

## Context
Architecture 06 says calls from the platform worker to the orchestrator use mutual TLS and also carry a signed body with a timestamp and a nonce, with the request-signing key separate from the TLS certificate. It does not say how the request is signed. The orchestrator is the most privileged component, so the form must be written down before either stream builds against it.

## Options considered
1. **A small custom HMAC form (proposed in the contract).** HMAC-SHA256 with a shared key over a string made of the version, method, request target, timestamp, nonce and the SHA-256 of the body, carried in three headers (`X-VM-Timestamp`, `X-VM-Nonce`, `X-VM-Signature`); skew 60 seconds, nonce remembered for 5 minutes. Pros: tiny, easy to implement identically in Python and Node (a shared signing vector tests it), same family as the event signing of ADR 0017. Cons: custom format; interoperability only with our own code.
2. **RFC 9421 HTTP Message Signatures with HMAC.** The standard defines the signature base, the `Signature-Input` and `Signature` headers and the `created`, `expires` and `nonce` parameters; HMAC is allowed. Pros: a standard, library support, covers chosen components. Cons: more moving parts (component identifiers, structured fields), the verifier must still enforce the window and the nonce store itself; libraries for both languages would be new dependencies.
3. **AWS Signature Version 4 style.** Well known, but built around cloud credentials and regions; more than needed here.

## Decision (proposed)
Option 1 for v0, because the pair of clients and servers is ours and small, and a fixed signing vector keeps both languages in step. The contract keeps the form behind a version prefix (`v1=`), so a later move to option 2 is a new version, not a rewrite. mTLS remains the first layer; responses are not signed in v0 and rely on mTLS (an open point).

## Consequences
Easier: no new dependency, one test vector, symmetrical with the event signing. Harder: we own the format and its review; the nonce cache is per process (replay protection restarts with the process and does not span replicas, an open point for the real orchestrator). Revisit before the contract is tagged v1.0.0 (story L-09).

## Evidence
- [RFC 9421, HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421) (via the IANA registry and secondary articles: parameters `created`, `expires`, `nonce`; the verifier enforces the window and the nonce). The RFC text itself was not read in full.
- The comparison with custom HMAC schemes and with AWS Signature Version 4 is from general knowledge; no primary source was read (UNVERIFIED).
- Architecture 06 lines 13, 27, 64 and 84 (mTLS, signed body, timestamp, nonce, separate key).
