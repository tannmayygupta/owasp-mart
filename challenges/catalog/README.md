
## exploit_test and fixed_build (T-30 note)

`exploit_test` and `fixed_build` in each entry are **logical references** keyed to
the challenge (`challenges/tests/cNN`, `challenges/fixed/cNN`), kept for schema
stability. In the implementation:

- the real self-test folder is the key with a descriptive suffix —
  `challenges/tests/cNN-<name>` (e.g. `challenges/tests/c01-cross-store-order`);
- there is **no separate fixed-build directory**: the fixed and vulnerable builds
  are one codebase gated by the env flag `VM_CHALLENGE_<KEY>` (unset or any
  non-`vulnerable` value selects the fixed/default build), run by the exploit
  self-test and by `scripts/release-gate.mjs`.
