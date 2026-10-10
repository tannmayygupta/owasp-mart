# 0018. Shop password hashing: Node built-in scrypt

- **Status:** Accepted
- **Date:** 2026-10-09
- **Deciders:** Sahil (stream T), in T-07
- **Requirements:** FR-SHP-09, FR-CHL-03 (C02 cross-solve guard), D-26

## Context
The shop must hash all user passwords with a strong adaptive hash, with no MD5 or unsalted hashes anywhere, so a leaked shop hash cannot help solve C02 (FR-SHP-09). The shop runs as a hardened, non-root, read-only distroless container (T-01) with no build toolchain, and ADR 0017 already chose Node's built-in SQLite to avoid native modules.

## Options considered
1. **`crypto.scrypt` (Node built-in).** Pros: no dependency, no native build (fits distroless); a memory-hard adaptive hash on OWASP's accepted list; tunable cost. Cons: parameters must be chosen and kept current by hand.
2. **argon2 (argon2id).** OWASP's first choice, but a native addon — reintroduces the Docker build/ABI problem ADR 0017 avoids.
3. **bcrypt.** Widely used, but a native addon (same problem) and a 72-byte input cap.

## Decision
Use **`crypto.scrypt`** behind `apps/shop/src/identity/password.mjs`, with a 16-byte random salt per password, cost N=2^15, r=8, p=1, 32-byte output, a timing-safe comparison, and a self-describing PHC-style stored string (`scrypt$N=…,r=…,p=…$salt$hash`). The parameters live in one module so they can be raised later.

## Consequences
- Easier: no native build in the hardened image; hashing and verify are standard-library; parameters are centralised.
- Harder / watch: scrypt parameters are a manual choice — revisit against OWASP guidance periodically; scrypt is memory-hard, so very high cost affects per-login memory (acceptable at the shop's scale).
- The weak-hash weakness C02 needs is a separate, isolated path in that challenge's own story, never the shop's real password store.

## Evidence
- OWASP Password Storage Cheat Sheet lists scrypt as an acceptable adaptive hash with the parameter guidance used here (not re-fetched in this session; UNVERIFIED exact current numbers).
- Node.js `crypto.scrypt`/`scryptSync` and `crypto.timingSafeEqual` documented APIs; verified available on the repo's pinned Node 24.
