# 0026. Trusted base checker for the contract rules

- **Status:** Proposed (decided on the developer's delegation 2026-10-11, story 1.15)
- **Date:** 2026-10-11
- **Deciders:** Tanmay (delegated the design to Claude Code; to be confirmed)
- **Requirements:** L-07 (contract rules), D-46, architecture 07 section 5 and rules 3, 4, 8, 9

## Context
The contract rules (scripts/check-contract-rules.mjs, L-07) grade a pull request: a changelog entry, a mock change, a declared breaking change. In the
old CI job the checker, the registry (`contracts/registry.json`) and the oasdiff pins were all read from the pull request head. A pull request could
therefore edit the grader itself: drop a contract from the registry, add a decoy mock path, mark a folder as reserved, turn off a check, or swap the
oasdiff pin, and the job would still be green. Three more gaps were found in the same audit: deleting a whole contract passed with a notice; the
marker `\bBREAKING\b` matched "no BREAKING changes"; unlisted JSON and YAML files under a contract folder were not compared.

## Options considered
1. **`pull_request_target` with the base as the workflow definition.** It runs with a write token and secrets in the context of the base, which is the
   known "pwn request" pattern as soon as any head code or data reaches a shell, an install script or an expression. Rejected.
2. **Copy only the checker from the base and keep the head registry.** The registry is the rule set (which folders are reserved or generated, which
   mocks count, `noMock`), so a head registry weakens the base checker just as well. Rejected.
3. **Read the base scripts with `git show` into a temporary directory.** It works, but it needs a second mechanism (a temp copy, a second module
   resolution path, pins and `tools/.bin` somewhere else) and hides which tree ran. A second checkout is simpler to read and to test. Rejected.
4. **Two checkouts, trusted checker from the base commit (chosen).** The head goes to `head/` and the base commit to `base/`; the job runs
   `node base/scripts/check-contract-rules.mjs --root head --base <base sha> --tools base/tools/oasdiff.json` with `permissions: contents: read` and
   `persist-credentials: false`.

## Decision
- **Trusted base checker.** Job `contract-rules` runs the checker, the oasdiff pin file and the oasdiff binary cache from the base commit. The head
  tree is only read as data (git, file reads). Never `pull_request_target`; all actions stay pinned by the same commit SHAs as the rest of ci.yml.
- **Base registry is the authority.** In trusted mode `containers`, `reserved`, `generated`, `mockRoot`, `noMock` and the changelog heading come from
  the registry of the base tip; folders and mocks of an existing contract are the union of base and head, but the mock rule only counts the base mock
  paths (a decoy folder added by the pull request does not satisfy it). Entries that exist only in the head are accepted as data.
- **Changes to the engine are reported.** Any change to `contracts/registry.json`, `scripts/check-contract-rules.mjs`, `scripts/schema-diff.mjs`,
  `scripts/oasdiff.mjs`, `tools/oasdiff.json` or `.github/workflows/**` is a FAIL (`trusted-base`) unless a new entry line of
  `contracts/CHANGELOG.md` reads `registry change: <reason>`. CODEOWNERS now lists these paths so that review is required.
- **Location checks.** Trusted mode refuses to run when the checker or the pin file is inside the head tree (except the declared bootstrap run).
- **Head code runs elsewhere.** The checks that execute head code (the `contracts:bundle:check` package script, the Alembic and table-owner Python)
  are skipped in trusted mode and run in the separate job `contract-rules-untrusted` (`--untrusted-only`, `contents: read`, no credentials, no
  secrets). That job also uses the base checker, so a pull request cannot skip them by editing the checker; it still has to run the head
  `package.json` script and install the head dependencies, which is code of the pull request by nature.
- **Bootstrap.** When `base/scripts/check-contract-rules.mjs` does not exist or does not carry the marker `trusted-base-checker-v1`, the workflow runs
  the head copy with `--trusted --bootstrap` and prints a NOTICE: this run does not protect against a weakening pull request. This is the first pull
  request that introduces the mechanism (story 1.15).
- **Whole-contract deletion is breaking.** A contract of the base registry that is missing in the head is compared with its base entry (each missing
  file is "file removed"); it needs a raised version and a `BREAKING:` line in its changelog section, exactly like any breaking change. A rename or a
  merge passes only when another head entry lists the same files and covers the same folders.
- **Exact marker.** One constant: a bullet line starting with `BREAKING:` followed by a reason, case-sensitive, not a negation ("none", "no"). Used in
  the per-pull-request rule and in the since-tag rule (the marker must sit in an entry newer than the tag).
- **Other gaps.** Fewer oneOf/anyOf branches than before is breaking even if the position walk finds nothing narrower; unlisted `.json`/`.yaml`
  files under a contract folder (not `examples/`, not generated) are compared (JSON as a schema diff, a changed YAML file flags breaking because no
  tool compares it); a missing contracts-v tag baseline prints a NOTICE; the oasdiff tests skip with a message when the binary cannot be downloaded.

## Consequences
- A pull request cannot weaken the rules unseen: either it fails, or a CODEOWNERS reviewer reads the `registry change:` reason.
- A legitimate registry change (new mock folder for an existing contract, a changed pin) now needs one changelog line and a review. New contracts
  need no extra step beyond that line because they are head-only entries.
- Two jobs and two checkouts: roughly one extra minute of CI.
- Pins: `tools/oasdiff.json` carries a sha256 for the archive and for the extracted binary, so a swapped binary is refused. The cross-check against the
  release `checksums.txt` is **not independent trust**: it comes from the same GitHub release as the archive, so it only catches a corrupted
  download, not a replaced release. The independent anchor is the pin committed in the base commit (now protected by the guard and CODEOWNERS).

## Residual risks
- **First pull request (bootstrap):** the head checker runs; it is unprotected. Review it by hand.
- **Admin bypass:** a repository admin can merge without the review or change the branch protection; CODEOWNERS and the guard do not stop that.
- **Head code in the untrusted job:** the Python checks run the base scripts but with the head's data, the bundle check runs the head's
  `package.json` script, and the head's dependencies are installed. It has no token and no secrets, but it is not a sandbox against everything a
  runner allows (network, the runner's disk during the job).
- **Declared escape hatch:** a `registry change:` line lets a change through to review; a careless review defeats it.
- **Stale branch:** the authority is the base tip, the comparison is against the merge base; a branch that is not up to date may show trunk changes as
  its own removals (it fails safe; merge the base into the branch).
- **Not run in this environment:** the workflow itself (no Actions runner), the pnpm and uv steps, and the real two-checkout layout on GitHub. Only
  the checker, its CLI form against a local copy, and the workflow text were tested.

## Evidence
- GitHub Docs, Security hardening for GitHub Actions: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- GitHub Security Lab, Preventing pwn requests: https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/
- Tests: scripts/check-contract-rules.test.mjs (D-46 tests), scripts/ci-workflow-shape.test.mjs, scripts/oasdiff.test.mjs, scripts/schema-diff.test.mjs.
- Unverified: behaviour of `pnpm/action-setup` with `package_json_file` and of `actions/checkout` with two paths on a real runner.
