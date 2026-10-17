# Message for Akshay's and Sahil's Claude sessions: plan for the live presentation on 19 October

Paste the part for your stream into your Claude Code session in the repo. Written 2026-10-17 by Tanmay's Claude session. Read `CLAUDE.md` first and follow it (BMAD story per task, documentation rule, commit gate, no pushes to `main`, no tags). `main` now holds Sprint 2 of all three streams (PR #14, #15, #16, #17).

The goal for 19 October is one live, end-to-end loop on the real hosts: a learner signs up and logs in, starts a lab, attacks the shop through the edge, the flag is captured automatically, and a score is shown. Tanmay's stream (L) builds the edge, the event path, flags, capture, attempts and scoring, and goes live on `vm-p` and `vm-i`. Each of you has said you will finish all 32 tasks of your list. This message says in which order to work so that the loop works first, and what stream L expects from you. Nothing here changes a contract: contracts stay at 1.0.0 and the change rules in `contracts/CHANGELOG.md` apply.

## Calendar (proposal; Tanmay confirms)

- **17 Oct and 18 Oct until 18:00:** build. One branch each (`sprint-3-akshay`, `sprint-3-sahil`), one small pull request per group of tasks, merged to `main` as soon as CI is green, so that the others can use the work. Do not wait for one big pull request.
- **18 Oct 18:00:** code freeze for anything the loop needs. After that only fixes.
- **18 Oct evening to 19 Oct morning:** deploy, run the live checks together, rehearse.

## For Akshay (stream P): order of work

Do these first, in this order, because the loop needs them. The rest of your 32 tasks follow in list order.

1. **P-09** outbox, queue worker and email provider (signup mail needs it).
2. **P-11, P-12** signup, email verification, login, sessions, CSRF.
3. **P-17** audit log and the **real KeyPort** (stream L derives flags with it; until you deliver it L uses a fake KeyPort).
4. **The real `InstancePort`** over `HttpInstanceHost` (handoff H-126): create, reset, destroy, get, access (`open`, `frozen`, `closed`), with the quota numbers and the three IF-8 codes. Answer H-122 (activity signal: until answered the orchestrator ends an instance `idle_minutes` after ready, so send a large `idle_minutes` for the demo), H-123 (the list of wanted instances for the reconciler) and H-125 (socket proxy, live step).
5. **P-20, P-21** assessment template, invites, accepting an invite.
6. **P-22, P-23** live updates (SSE) and stream authorisation: the learner page needs the instance status and the score live.
7. **P-26** learner dashboard with "start lab", the instance link and hints; then P-27 and P-28.
8. The ingest endpoint for relayed events (IF-4, H-75) and attempt and score tables (IF-9, IF-10) must exist on the platform side; Tanmay's L-18, L-22 and L-23 call them through the ports. Tell Tanmay's session the exact port names as soon as they exist.

What stream L gives you and when (best effort, stated so you can plan): edge and gate for instance hostnames (L-17), event relay to your ingest (L-18), flag derivation and injection through KeyPort (L-19), automatic capture (L-20), milestones (L-21), attempt clock (L-22), scoring (L-23). Each lands in `main` through its own pull request; each adds a handoff row for you in `docs/dev/HANDOFFS.md`.

## For Sahil (stream T): order of work

1. **T-17, T-18** seller flows, refunds, disputes, commissions, payouts (the baseline the challenges plant their weakness on).
2. **The challenges T-19 to T-29** each with its exploit test and the event names of IF-4 section 7. Do first the ones that are quickest to show on stage: **C01** (T-19, cross-store order read), **C03** (T-21, injection), **C05** (T-23, diagnostics page), **C10** (T-28, SSRF), **C02** (T-20) and **C07** (T-25). Then the rest of the list in order.
3. **T-30** catalogue content (tags, tiers, briefs, hints, write-ups, decoy locations): stream L's milestone engine (L-21) reads the milestone rules and event names of every challenge from it; send the catalogue as soon as an entry is complete, not at the end.
4. **T-31** exploit tests as a CI release gate, **T-32** deployed verification on `vm-i` (with Tanmay: needs the host).

Keep what you already agreed: `healthchecks` argv emitted without `CMD` (the orchestrator adds it, H-124), argv[0] an absolute path, no shell. Every image in `infra/images.json` is built by the images workflow; the images workflow runs from `main`, so merge early.

## Both

- A task is ticked only when its Done-when is really met with recorded output (no "built, ticked").
- When a task changes something another stream depends on, add a handoff row in the same commit.
- Tell Tanmay's session (through Tanmay) as soon as something the loop needs lands in `main`.
