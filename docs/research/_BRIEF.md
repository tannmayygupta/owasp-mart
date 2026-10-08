# Research brief (shared by all research streams)

Written 2026-10-08. Every research stream reads this file and `initial.md` (source of truth) before starting.

## Project in one paragraph
VulnMart is a containerized, flag-based, **intentionally vulnerable online marketplace** used for (a) student practice on the OWASP Top 10 and (b) a recruiter-run hiring assessment. Every user gets their own isolated set of Docker containers. Unique per-instance flags prove exploitation; an automatic monitor detects it; two dashboards (learner, recruiter) show results. Decisions already made are D-01 to D-14 in `initial.md` Section 15. **Do not reopen them**; if research shows one is a problem, say so in "Open questions".

## Fixed constraints
- **Free tiers only** for hosting. **Online deployment is a must-have.** The architecture must be portable: moving to a paid server later must need **no architecture change**.
- **Live demo runs on one Windows 11 laptop** (Ryzen 5 5600H, 6 cores / 12 threads, 15.3 GB RAM, ~220 GB free on D:, only ~22 GB free on C:). Docker Desktop with WSL2 is installed but not yet set up. Demo load is one presenter, but the design must support many concurrent users.
- **Three developers** (Tanmay, Akshay, Sahil) build with **Claude Code**, working **independently** in separate work-streams without blocking each other. Prefer designs with clear, stable interfaces (API contracts, schemas, events).
- Deadline is the first week of November 2026, but **do not limit recommendations by time or team size**. Recommend the best industry practice.
- The user prefers **industry-ready, proven solutions** over custom ones, and plain-language explanations.
- Today is **2026-10-08**. Free-tier limits and prices change often. Always check the current official page and note when it was last updated.

## Rules for research
1. **Research first, do not assume.** Do not start from the assumption that the stack named in the synopsis is right; compare it with real alternatives.
2. Compare **at least three options** where the question allows, including the most-used industry choice and the one best matching our constraints.
3. **Cite sources.** Prefer official documentation, standards bodies and primary sources over blogs and vendor marketing. For every important claim record the URL and mark it **VERIFIED** (read in a primary source), **UNVERIFIED** (secondary source only), or **CONFLICTING** (sources disagree). Never invent a URL, a number, a limit, or an ID. If you cannot find something, say "not found".
4. Say clearly what **cannot be known without an experiment** (for example real memory use per container) and list it as a "spike to run later". Do not run experiments now.
5. Say when your recommendation would be **wrong** (conditions that flip it).
6. **Do not modify** `initial.md`, `CLAUDE.md`, any code, or any file other than your own output file. **Do not commit or push.** Do not install software, start Docker, or call any network service except web search and page fetch.
7. Write for non-experts: short sentences, plain words, jargon explained once.

## Output: one markdown file, `docs/research/<STREAM-ID>-<slug>.md`
Aim for roughly 1,500 to 3,000 words. Tables are welcome. Use exactly these sections:

```
# <STREAM-ID> — <title>
Status: DRAFT research, NOT confirmed by the user · Date: 2026-10-08

## 1. Questions answered
## 2. Options compared   (table: option | fit with our constraints | free-tier / cost | complexity | main risks | evidence)
## 3. Recommendation     (what, why, and "this would be wrong if ...")
## 4. Decision candidates for the user
   (numbered; each: the question in plain words, 2-4 options, which one you recommend, one-line reason.
    These will be put to the user as pick-one questions, so make each answerable in one choice.)
## 5. Evidence           (table: URL | what it supports | VERIFIED / UNVERIFIED / CONFLICTING)
## 6. Open questions and spikes to run later
## 7. Impact on other streams
```

## Streams
| ID | Topic | Initial.md items |
|---|---|---|
| RS-A | Hosting on free tiers, deployment topology, capacity numbers | R-02, R-12 |
| RS-B | Per-user container isolation, orchestration, flag generation, traffic monitor | R-03, R-04 |
| RS-C | Scoring model, "time taken", anti-cheat, assessment session design | R-05, R-10, R-11 |
| RS-D | Platform tech stack, API contracts, platform security, platform roles and lifecycles | R-07, R-14, R-01 (platform) |
| RS-E | Challenge design C01 to C06 | R-06 |
| RS-F | Challenge design C07 to C11 | R-06 |
| RS-G | Shop domain model, six shop roles, refunds, bots, seeding, shop stack | R-01 (shop), R-08 |
| RS-H | Privacy and data lifecycle (retention, consent, audit log, DPDP) | R-09, Q-19 |
