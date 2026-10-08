# VulnMart (repo `owasp-mart`)

A containerized, flag-based, intentionally vulnerable online marketplace for OWASP Top 10 practice and for hiring assessments. Each user gets a private copy of the shop, attacks it, and every exploit is detected and scored automatically.

Built by three developers with Claude Code. Final submission: first week of November 2026.

## Where to start

| You are | Read first |
|---|---|
| Anyone | [initial.md](initial.md) (decisions and open questions), [CLAUDE.md](CLAUDE.md) (working rules) |
| Tanmay (Lab stream) | [docs/dev/dev1-tanmay.md](docs/dev/dev1-tanmay.md) |
| Akshay (Platform stream) | [docs/dev/dev2-akshay.md](docs/dev/dev2-akshay.md) |
| Sahil (Target stream) | [docs/dev/dev3-sahil.md](docs/dev/dev3-sahil.md) |

## Folder map

- `initial.md`: source of truth for decisions. `CLAUDE.md`: rules for Claude Code. `CHANGELOG.md`: what changed.
- `docs/`: everything written down (see [docs/README.md](docs/README.md)): requirements, architecture, research, decisions, task lists, dev-log.
- `.claude/` and `_bmad/`: the BMAD workflow skills and runtime that Claude Code uses. Do not edit or update them without the team agreeing; `node scripts/verify-skills.mjs` checks they are unchanged.
- `scripts/`: the documentation commit gate and the skills verifier. `.githooks/`: the git backstop for the gate (enable once per clone with `git config core.hooksPath .githooks`).

Application code (platform, lab and target) is not written yet; it starts with the Sprint 1 tasks.
