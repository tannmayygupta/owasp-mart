# Progress page

A single offline web page for the guide meeting: what VulnMart is, how a session works in six steps, what already runs (with the command and the file that records the result), and one section per stream (Lab, Platform, Target) listing each task as Done, Being implemented or Next.

`index.html` is a generated snapshot (it shows its generation date). Do not edit it by hand; regenerate it.

## Run it

Needs only Node. Nothing is installed and nothing leaves the laptop.

| Command | What it does |
|---|---|
| `pnpm run progress` or `node scripts/progress-page.mjs --serve` | Serves the page on `http://127.0.0.1:8088/` (this laptop only; press Ctrl+C to stop) |
| `node scripts/progress-page.mjs` | Rewrites the snapshot `docs/progress/index.html` |
| `node scripts/progress-page.mjs --out other.html` | Writes the page to another file |
| `node scripts/progress-page.mjs --port 9000 --serve` | Serves on another port (exit 2 if the port is in use) |

## Show each developer's own branch

Each stream's task file can be read from that developer's git branch, so progress shows before the branches are merged. Run `git fetch` first.

```
node scripts/progress-page.mjs --serve --dev2 origin/sprint-1-akshay --dev3 origin/sprint-1-sahil
```

`--dev1`, `--dev2` and `--dev3` take either a file path or a git ref. An unknown ref or file stops with exit 2 and writes nothing.

## How the statuses are decided

- Done: the task's checkbox is ticked in the owner's task file.
- Being implemented: not ticked, and the task belongs to the sprint whose dates include today.
- Being implemented (late): not ticked, and its sprint has already ended.
- Next: not ticked, and its sprint has not started.

The script only reads the task files. It never edits a task file or a tracker.

## Where the "what already runs" claims come from

Each box on the proof page names its source line (a dev-log or an evidence file under `docs/assets/`). If a claim has no recorded result, it is not on the page.

Tests: `node --test scripts/progress-page.test.mjs`.
