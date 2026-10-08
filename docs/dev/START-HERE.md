# Start here: how we build VulnMart with BMAD and Claude Code

Message to Tanmay, Akshay and Sahil. Requirements, architecture and decisions are done. From now on we only build, one task at a time, and every task leaves a written record for the college report.

Repo: https://github.com/tannmayygupta/owasp-mart (private). Akshay and Sahil: you have been added as contributors, so accept the invitation and clone it.

Your task list: [dev1-tanmay.md](dev1-tanmay.md) · [dev2-akshay.md](dev2-akshay.md) · [dev3-sahil.md](dev3-sahil.md). Each has 4 weekly sprints of 7 to 8 tasks (8 Oct to 4 Nov 2026, proposed dates).

## 1. The seven rules

1. **One task at a time.** Do not start the next task until the current one is closed (tests passed, docs written, ticked).
2. **Every task = one BMAD story.** Create it with `bmad-ticket`, build it with `bmad-build`. Do not code outside a story.
3. **Claude does the paperwork, you check it.** Dev-log entry, changelog line, traceability rows, tracker state, tick in your task file. The commit gate blocks a code commit without them.
4. **Real results only.** Write the real test command and real output. Never write "passed" for something that was not run.
5. **Never guess.** If a requirement, decision or open question (OI-xx) is unclear, ask the team or the owner. Do not decide it alone.
6. **Stay in your lane.** Edit only your own stream's folders and your own tracker folder (`docs/bmad/initiative-<yours>/`). Another stream's code or a contract changes only through that owner's pull request approval.
7. **No secrets, no real flag values** in code comments, stories, docs or chat. SSH only for git, never HTTPS or tokens. Never push to `main`. Never force-push.

## 2. One-time setup on your machine (about 30 minutes)

You need: Git, Node.js 24 LTS, Docker Desktop, Claude Code, and `uv` (BMAD scripts run through it).

1. Install `uv`. Mac: `brew install uv`. Windows: `winget install astral-sh.uv`. Then **open a new terminal**.
2. Clone with SSH using your own GitHub account: `git clone git@github.com:tannmayygupta/owasp-mart.git`, then `cd owasp-mart`.
3. Turn on the commit backstop (once per clone): `git config core.hooksPath .githooks`
4. Check the BMAD skills are untouched: `node scripts/verify-skills.mjs`. Expected: `OK: all 217 installed skill files match the manifest.` If it fails, stop and tell the team.
5. Choose your own tracker. Create the file `_bmad/custom/config.user.toml` (it is git-ignored, personal to you) with exactly:
   - Akshay: `[core]` then `active_initiative = "initiative-platform"`
   - Tanmay: `[core]` then `active_initiative = "initiative-lab"`
   - Sahil: `[core]` then `active_initiative = "initiative-target"`
6. Start Claude Code in the repo folder (`claude`) and say: `Use bmad-ticket: what is ready to start?` It should list stories from your tracker. If it reports `uv` missing, redo step 1.
7. Never run `npx skills update`, never install or update BMAD skills, never run `bmad setup` that changes versions. After every `git pull`, run `node scripts/verify-skills.mjs` again.

Sahil: also check Docker and Node 24 on your PC (this is your first task, T-01). Akshay: same on your Mac (P-01).

## 3. Who does what in BMAD

Claude plays the BMAD roles for you. Ask for one by name. Our requirements and architecture already exist, so you do **not** recreate a PRD, brief or architecture.

| Use | What it is for | When |
|---|---|---|
| `bmad-ticket` | Find the next story, create it, split an epic into stories, mark a story blocked or done | Start and end of every task |
| `bmad-build` | The story engine: plan, implement, review and verify one story | Every task |
| `bmad-agent-dev` (Amelia, the developer) | Work with you on the code interactively | While building, when you want to pair on a hard part |
| `bmad-code-review` | Several independent reviewers read your changes and report findings | Before every pull request; always for security-sensitive work (login, keys, isolation, scoring, challenges) |
| `bmad-review` | Review a document, contract or other artifact | When you change a contract, ADR or spec |
| `bmad-qa-generate-e2e-tests` | Generate API and end-to-end tests for a finished feature | After a feature with visible or API behaviour |
| `bmad-walkthrough` | Explains a commit or a pull request step by step | Before asking someone to review your pull request |
| `bmad-agent-architect` (Winston) | A design question the architecture docs do not answer | Rarely; if the answer is a decision, record it as an ADR and tell the team |
| `bmad-agent-ux-designer` (Sally), `bmad-ux` | Screen layout and behaviour | Akshay's dashboard tasks (P-26, P-27, P-30) |
| `bmad-correct-course` | A big change mid-sprint (a decision changed, a task cannot work as written) | When a change hits more than your own task; talk to the team first |
| `bmad-retrospective` | Review a finished epic against the evidence it left | When an epic is complete |

Not used now: `bmad-prd`, `bmad-product-brief`, `bmad-spec`, `bmad-architecture`, `bmad-agent-pm` (John), `bmad-agent-analyst` (Mary). The documents they produce already exist.

## 4. The cycle for ONE task

Do these steps in order. The prompts are suggestions you can paste into Claude Code.

**Step 0. Start the day.** `git pull`, then `node scripts/verify-skills.mjs`. Open your task file and find the first unticked task whose "Waits on" items are done. If it waits on another developer's task that is not merged yet, use the mock or fake named in the task, and tell the team in the chat.

**Step 1. Branch.** First task of a sprint: `git switch main`, `git pull`, `git switch -c sprint-<n>-<yourname>` (for example `sprint-1-akshay`). All normal tasks of that sprint go on this branch. A task marked **EARLY PR** goes on its own branch (see section 6).

**Step 2. Create the story.**
> Read CLAUDE.md and my task file docs/dev/dev<N>-<name>.md. Take task <ID>. Use bmad-ticket to find or create its story, and show me the story before we build. Only one task.

The line "BMAD story" under the task tells you if the story already exists. If it says "not planned yet", follow section 5 first. If `bmad-ticket` lists the story as blocked only because of an **unknown** (a note about something it waits on), settle that with Claude first (section 5, second bullet).

**Step 3. Build.**
> Use bmad-build with the full route on story <ref>. Ask me before anything unclear.

Claude plans, shows you the plan (read it and approve or correct it), implements, reviews and verifies. Claude may ask permission to use subagents once; say yes. If the working tree is dirty, Claude stops: commit or stash first, so each task starts clean. If a session ends, start a new one and say `Resume my in-progress story with bmad-build`; the plan file remembers where it was.

**Step 4. Review.**
> Run bmad-code-review on the changes of task <ID>. Fix the real findings and tell me which ones you did not fix and why.

**Step 5. Test.** The story's own tests must pass, and for features with visible or API behaviour:
> Run the story's tests and bmad-qa-generate-e2e-tests for task <ID>. Record the exact commands and the real output.

If a test fails, fix it. Do not close the task.

**Step 6. Close (the documentation rule).**
> Close task <ID>: write the dev-log entry from docs/dev-log/_TEMPLATE.md, the CHANGELOG.md line, the docs/traceability.md rows for the requirement ids it covers, an ADR if we made a significant decision, evidence in docs/assets/<task-slug>/. Tick my task in docs/dev/dev<N>-<name>.md, mark the story done with bmad-ticket, then commit on my branch.

Claude does all of that. You check: are the commands and results real? Is there any flag value, secret or personal data? If a commit is blocked, it is the documentation gate asking for the dev-log, changelog or tracker update; let Claude add it and retry. Do not use `[no-doc]` for features or fixes.

**Step 7. Excel, by hand.** Open `docs/bmad/VulnMart-Tracker.xlsx`, your sheet, set the task's Done cell to Yes. Nothing updates it automatically.

**Step 8. Next task.** Only now. Ask Claude: `What is ready next?`

## 5. First task of an epic (creating its stories)

Epic 1 (the baseline) of every stream already has its stories, because they were planned in sprint zero. All other epics are outlines. The first time you reach an epic with no stories, split it once:

> Use bmad-ticket to incept epic <epic-slug>. Use the tasks listed for this epic in my task file docs/dev/dev<N>-<name>.md as the breakdown, one story per task, with their "Covers" and "Waits on". Run the validation and show me the result before saving.

Check that every requirement id in the task's "Covers" is in the story, and approve. Two things to know:

- A story can be listed as blocked in `bmad-ticket` because of an **unknown** (for example "waits on Tanmay's L-01 being merged"). When the thing it waits on is true, tell Claude to remove the unknown and write a dated Decision line, then the story becomes ready.
- Never edit another developer's tracker folder.

## 6. Branches and pull requests

- **One branch and one pull request per sprint**, after your 8 tasks: `sprint-1-<name>`, `sprint-2-<name>`, `sprint-3-<name>`, `sprint-4-<name>` (4 per developer).
- **Exception, EARLY PR.** Tasks that another developer waits on in the same sprint (for example L-01 and the contract tasks) are marked EARLY PR in the task files. Do such a task on its own branch from fresh `main`: `git switch main`, `git pull`, `git switch -c shared-<task-id>`. When done, open a small pull request right away, get it reviewed and merged, then bring it into your sprint branch with `git switch sprint-<n>-<name>` and `git merge main`.
- **Pushing:** only when you ask Claude to. Say `Push my branch`. It uses SSH. Never push to `main`.
- **Pull request text:** ask Claude to write it (what changed, which task IDs, real test results). Use `bmad-walkthrough` to help the reviewer.
- **Review:** optional during initial development (decision D-37, 2026-10-08): you may merge your own pull request once CI is green. If you touched a contract or another stream's folder, tell that owner in the team chat so they can look at it afterwards (CODEOWNERS and the contract rules in `docs/architecture/07-repo-and-workstreams.md` still name the owners).
- **After the merge:** `git switch main`, `git pull`, `node scripts/verify-skills.mjs`, then create the next sprint branch.

## 7. When something goes wrong

| Situation | Do this |
|---|---|
| A task waits on another developer | Use the mock or fake named in the task. Mark the story blocked (`bmad-ticket`, reason written). Tell the team. Never fake the owner's code. |
| The requirement or decision is unclear or open (OI-xx) | Stop that part. Ask the team or Tanmay. Do not decide alone; decisions are recorded in `initial.md` only after confirmation. |
| You need to change a contract or the architecture | Open a pull request on the contract (the owner approves) or ask Winston, and record an ADR. |
| A test cannot pass because of the design | Do not weaken the test. Write the problem in the story and talk to the team. `bmad-correct-course` if it changes other tasks. |
| Claude wants to update BMAD skills or install something | Say no and tell the team. |
| You are far behind in a sprint | Say it in the chat the same day, so the team can agree what to cut. |

## 8. What Claude does automatically (rules in CLAUDE.md)

- Works only on the task you name, one at a time, always through a BMAD story.
- Uses `bmad-ticket` to find, create and close the story, and keeps the tracker state true.
- Writes the dev-log, changelog, traceability, ADR and evidence, and ticks your task.
- Refuses to write "passed" for tests that were not run.
- Does not push unless you ask, and never force-pushes.
- Blocks a code commit that has no dev-log entry, changelog line or tracker update.

## 9. Reminders about the first week

- **Tanmay does L-01 first** (the repository skeleton), as a small EARLY PR. Akshay's P-01 and Sahil's T-01 and T-02 wait on it. Until it is merged, Akshay and Sahil do their machine setup (section 2) and read their task file and the architecture.
- Open questions with owners are listed inside the tasks (for example the email provider, CAPTCHA, clock start). Answer them at the start of the sprint that needs them.
- The sprint dates and task order are a proposal. Say so in the chat if something is wrong.
