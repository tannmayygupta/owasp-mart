#!/usr/bin/env node
// Progress page for the guide meeting. Reads the three developers' task files (working tree or git ref),
// writes one static HTML file, or serves it on 127.0.0.1. Node built-ins only. Read-only: never edits a task file.
//   node scripts/progress-page.mjs [--out FILE] [--serve] [--port N] [--today YYYY-MM-DD]
//        [--dev1 PATH|REF] [--dev2 PATH|REF] [--dev3 PATH|REF] [--root DIR] [--help]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..');
export const DEFAULT_PORT = 8088;
export const DEFAULT_OUT = path.join('docs', 'progress', 'index.html');

export const STREAMS = [
  {
    key: 'dev1', id: 'lab', name: 'Lab', owner: 'Tanmay', file: 'docs/dev/dev1-tanmay.md',
    purpose: 'Builds the part that starts a private copy of the shop for each person, keeps it isolated, detects the attacks, and scores the attempt.',
  },
  {
    key: 'dev2', id: 'platform', name: 'Platform', owner: 'Akshay', file: 'docs/dev/dev2-akshay.md',
    purpose: 'Builds the website people use: sign-up, login, invitations from recruiters, and the dashboards that show progress and results.',
  },
  {
    key: 'dev3', id: 'target', name: 'Target', owner: 'Sahil', file: 'docs/dev/dev3-sahil.md',
    purpose: 'Builds the online shop that is deliberately vulnerable, with its 11 challenges, hints and the tests that prove each one can be solved.',
  },
];

export const HELP = `VulnMart progress page

Usage: node scripts/progress-page.mjs [options]

  --out FILE        Write the page to FILE (default ${DEFAULT_OUT.replace(/\\/g, '/')})
  --serve           Serve the page on 127.0.0.1 (read-only, only "/" answers)
  --port N          Port for --serve (default ${DEFAULT_PORT})
  --today DATE      Use DATE (YYYY-MM-DD) instead of the real date (for tests)
  --dev1 PATH|REF   Lab task file: a file path, or a git ref such as origin/sprint-1-tanmay
  --dev2 PATH|REF   Platform task file: a file path, or a git ref such as origin/sprint-1-akshay
  --dev3 PATH|REF   Target task file: a file path, or a git ref such as origin/sprint-1-sahil
  --root DIR        Repository folder (default: this repository)
  --help            Show this text

Exit codes: 0 ok, 1 a task file has no tasks, 2 bad argument, missing file or ref, or port in use.
`;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export class UsageError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.exitCode = code;
  }
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function isoDate(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function isValidDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3];
}

// "## Sprint 1 (8 Oct to 14 Oct 2026)" -> { number, start, end } as ISO dates. Returns null if not a sprint heading.
export function parseSprintHeading(line) {
  const m = /^## Sprint (\d+) \((\d{1,2}) ([A-Za-z]{3}) to (\d{1,2}) ([A-Za-z]{3}) (\d{4})\)\s*$/.exec(line);
  if (!m) return null;
  const startMonth = MONTHS[m[3].toLowerCase()];
  const endMonth = MONTHS[m[5].toLowerCase()];
  if (!startMonth || !endMonth) return null;
  const year = +m[6];
  const startYear = startMonth > endMonth ? year - 1 : year;
  return {
    number: +m[1],
    start: isoDate(startYear, startMonth, +m[2]),
    end: isoDate(year, endMonth, +m[4]),
  };
}

// Reads the task lines of one developer's file.
export function parseTasks(text) {
  const lines = text.split(/\r?\n/);
  const tasks = [];
  const sprints = [];
  let sprint = null;
  let task = null;
  for (const line of lines) {
    const heading = parseSprintHeading(line);
    if (heading) {
      sprint = heading;
      sprints.push(heading);
      task = null;
      continue;
    }
    if (/^## /.test(line)) {
      sprint = null;
      task = null;
      continue;
    }
    const t = /^- \[([ xX])\] \*\*([A-Z]-\d+)\. (.+?)\*\*/.exec(line);
    if (t) {
      task = { id: t[2], title: t[3].trim(), done: t[1] !== ' ', sprint: sprint ? sprint.number : null, build: '', waits: '' };
      tasks.push(task);
      continue;
    }
    if (task) {
      const b = /^\s+- Build: (.*)$/.exec(line);
      if (b) task.build = b[1].trim();
      const w = /^\s+- Waits on: (.*)$/.exec(line);
      if (w) task.waits = w[1].trim();
    }
  }
  return { tasks, sprints };
}

export const STATUS = {
  DONE: 'Done',
  NOW: 'Being implemented',
  LATE: 'Being implemented (late)',
  NEXT: 'Next',
};

// Rules: ticked = Done. Unticked in the sprint whose dates include today = Being implemented.
// Unticked in an earlier sprint = Being implemented (late). Unticked in a later sprint = Next.
export function computeStatus(task, sprints, today) {
  if (task.done) return STATUS.DONE;
  const sprint = sprints.find((s) => s.number === task.sprint);
  if (!sprint) return STATUS.NEXT;
  if (today > sprint.end) return STATUS.LATE;
  if (today >= sprint.start) return STATUS.NOW;
  return STATUS.NEXT;
}

function safeRef(ref) {
  return ref && !ref.startsWith('-') && !/[\0\r\n]/.test(ref);
}

// Returns the text of a stream's task file, from a path, from a git ref, or from the working tree.
export function readStreamText(stream, value, root) {
  if (value === undefined) {
    const p = path.join(root, stream.file);
    if (!existsSync(p)) throw new UsageError(`${stream.name} (${stream.key}): task file not found: ${stream.file}`);
    return readFileSync(p, 'utf8');
  }
  const asPath = path.resolve(process.cwd(), value);
  if (existsSync(asPath)) return readFileSync(asPath, 'utf8');
  if (!safeRef(value)) throw new UsageError(`${stream.name} (${stream.key}): not a file and not a usable git ref: ${value}`);
  try {
    return execFileSync('git', ['show', `${value}:${stream.file}`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    throw new UsageError(`${stream.name} (${stream.key}): cannot read ${stream.file} from file or git ref "${value}"`);
  }
}

// ---------- page content (plain English; every "already runs" box names its source) ----------

const STEPS = [
  ['Sign up or accept an invitation', 'A learner signs up on the VulnMart website. A candidate is invited by a recruiter and accepts the invitation.'],
  ['Get a private copy of the shop', 'The Lab starts one separate copy of the shop just for that person, with its own data, so nobody can disturb anybody else.'],
  ['Attack the shop', 'The shop looks like a real online marketplace and contains 11 deliberate weaknesses (challenges). Each one hides a secret value called a flag that is different in every copy.'],
  ['The attack is noticed', 'A watcher next to the shop records what happens and recognises a successful attack by itself. Pasting the flag is the backup way to prove it.'],
  ['The attempt is scored', 'The Lab scores the attempt automatically, using the challenges solved, the time taken and the hints used.'],
  ['Results are shown', 'The learner sees progress and hints. A recruiter sees the score, the time per challenge and the technique used. The private copy is then reset or removed.'],
];

const PROOF = [
  {
    title: 'A whole shop copy starts and is checked (stand-in shop)',
    command: 'node scripts/dev.mjs harness',
    result: 'Starts one complete copy with a small stand-in shop, the watcher and the front door, checks it against the written rules: "conformance: PASS (20 rules)" and "harness: PASS". Nothing is left running afterwards.',
    sources: ['docs/dev-log/2026-10-10-tannmayygupta-stub-shop-and-lab-harness.md', 'docs/assets/l-06-stub-harness/harness-run.txt'],
  },
  {
    title: 'The written agreements between the three streams are valid',
    command: 'pnpm run contracts:check',
    result: 'Checks the four agreements (instance rules, instance events, the Lab control interface with 8 operations, the Lab website interface with 18 operations): PASS.',
    sources: ['docs/dev-log/2026-10-10-tannmayygupta-contract-checks-live-in-ci.md', 'docs/dev-log/2026-10-11-tannmayygupta-sprint-1-audit-remediation.md'],
  },
  {
    title: 'A change to an agreement is checked automatically',
    command: 'node scripts/check-contract-rules.mjs --base origin/main',
    result: 'Compares the agreements with the main branch and refuses an unannounced breaking change. Last recorded run: 17 PASS, 0 FAIL, 4 NOT-APPLICABLE (parts that do not exist yet).',
    sources: ['docs/dev-log/2026-10-11-tannmayygupta-sprint-1-audit-remediation.md', 'docs/dev-log/2026-10-10-tannmayygupta-contract-checks-live-in-ci.md'],
  },
  {
    title: 'Two cloud servers in Sydney are set up and checked',
    command: 'node scripts/verify-hosts.mjs',
    result: 'Two servers on AWS: key-only login, only the planned ports open. Recorded: "RESULT PASS (94 checks)".',
    sources: ['docs/dev-log/2026-10-11-tannmayygupta-aws-free-plan-sydney-hosts.md', 'docs/assets/l-08-aws-hosts/verify-hosts.txt'],
  },
  {
    title: 'The two servers talk to each other over an encrypted private link',
    command: 'node scripts/private-link-check.mjs',
    result: 'Mutual TLS 1.3 works in both directions, a client without a certificate is refused, an unplanned port is dropped. Recorded: "RESULT PASS (22 checks)".',
    sources: ['docs/dev-log/2026-10-11-tannmayygupta-aws-free-plan-sydney-hosts.md', 'docs/assets/l-08-aws-hosts/private-link-check.txt'],
  },
  {
    title: 'Automated tests on the developer PC',
    command: 'node --test "scripts/*.test.mjs" "contracts/mocks/stub-instance/**/*.test.mjs"',
    result: 'Recorded on 2026-10-11: 434 of 434 unit tests pass; 393 Python tests pass; 61 of 61 end-to-end tests pass. A first run on GitHub found one failing text check, which was then fixed.',
    sources: ['docs/dev-log/2026-10-11-tannmayygupta-sprint-1-audit-remediation.md'],
  },
  {
    title: 'The developer tools start a hardened container',
    command: 'node scripts/dev.mjs hello',
    result: 'Starts a small locked-down container, checks it answers, removes it: exit 0, no container left.',
    sources: ['docs/dev-log/2026-10-08-tannmayygupta-repository-skeleton.md'],
  },
];

const NOT_YET = 'Not shown as running yet: the real shop, the sign-up website, scoring and the dashboards. Those are the tasks listed as "Being implemented" and "Next" below. The Platform and Target progress appears here when their branches are read with --dev2 and --dev3.';

const CONTRACTS = [
  ['IF-1', 'Website API (platform)', 'Akshay (Platform)'],
  ['IF-2', 'Lab API for the website', 'Tanmay (Lab)'],
  ['IF-3', 'Live-update events for dashboards', 'Akshay (Platform)'],
  ['IF-4', 'Events sent from a shop copy to the Lab', 'Tanmay (Lab)'],
  ['IF-5', 'Lab control interface (orchestrator)', 'Tanmay (Lab)'],
  ['IF-6', 'What a shop copy must look like (instance contract)', 'Tanmay (Lab) with Sahil (Target)'],
  ['IF-7', 'Challenge catalogue', 'Sahil (Target)'],
  ['IF-8', 'Error codes and format', 'Akshay (Platform)'],
  ['IF-9', 'Internal interfaces between Platform and Lab', 'The side that provides each one'],
  ['IF-10', 'Database table ownership', 'Akshay (Platform)'],
];

// ---------- rendering ----------

const STATUS_CLASS = {
  [STATUS.DONE]: 'done',
  [STATUS.NOW]: 'now',
  [STATUS.LATE]: 'late',
  [STATUS.NEXT]: 'next',
};

function renderTask(task, status) {
  const build = task.build ? `<p class="build">${escapeHtml(task.build)}</p>` : '';
  const waits = task.waits ? `<p class="waits">Waits on: ${escapeHtml(task.waits)}</p>` : '';
  return `<li class="task ${STATUS_CLASS[status]}"><div class="head"><span class="tid">${escapeHtml(task.id)}</span> <span class="ttitle">${escapeHtml(task.title)}</span> <span class="status">${escapeHtml(status)}</span></div>${build}${waits}</li>`;
}

function renderStream(stream, parsed, today, origin) {
  const withStatus = parsed.tasks.map((t) => ({ t, s: computeStatus(t, parsed.sprints, today) }));
  const count = (s) => withStatus.filter((x) => x.s === s).length;
  const summary = `${count(STATUS.DONE)} done, ${count(STATUS.NOW) + count(STATUS.LATE)} being implemented, ${count(STATUS.NEXT)} next, ${withStatus.length} tasks in total.`;
  const groups = parsed.sprints.map((sp) => {
    const items = withStatus.filter((x) => x.t.sprint === sp.number).map((x) => renderTask(x.t, x.s)).join('\n');
    return `<h3>Sprint ${sp.number} <span class="dates">(${sp.start} to ${sp.end})</span></h3>\n<ul class="tasks">\n${items}\n</ul>`;
  }).join('\n');
  return `<section id="${stream.id}">
<h2>${escapeHtml(stream.name)} stream: ${escapeHtml(stream.owner)}</h2>
<p>${escapeHtml(stream.purpose)}</p>
<p class="summary"><strong>${escapeHtml(summary)}</strong></p>
<p class="source">source: ${escapeHtml(origin)}</p>
${groups}
</section>`;
}

function renderProof() {
  const boxes = PROOF.map((p) => `<div class="box">
<h3>${escapeHtml(p.title)}</h3>
<p class="cmd"><code>${escapeHtml(p.command)}</code></p>
<p>${escapeHtml(p.result)}</p>
<p class="source">source: ${p.sources.map(escapeHtml).join('; ')}</p>
</div>`).join('\n');
  return `<section id="proof">
<h2>What already runs</h2>
<p>Each box is a command that exists in the repository, with the result written in a development log or an evidence file. Nothing is shown here that no file records.</p>
${boxes}
<p class="note">${escapeHtml(NOT_YET)}</p>
</section>`;
}

function renderHome(streamSummaries, today) {
  const steps = STEPS.map(([h, p]) => `<li><strong>${escapeHtml(h)}.</strong> ${escapeHtml(p)}</li>`).join('\n');
  const cards = streamSummaries.map((s) => `<div class="card"><h3><a href="#${s.stream.id}">${escapeHtml(s.stream.name)}: ${escapeHtml(s.stream.owner)}</a></h3><p>${escapeHtml(s.stream.purpose)}</p><p class="summary">${escapeHtml(s.summary)}</p></div>`).join('\n');
  const rows = CONTRACTS.map(([id, name, owner]) => `<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(name)}</td><td>${escapeHtml(owner)}</td></tr>`).join('\n');
  return `<section id="home">
<h1>VulnMart: progress for the guide meeting</h1>
<p class="lead">VulnMart is an online marketplace that is intentionally vulnerable. Each person gets a private copy, attacks it to practise the OWASP Top 10 weaknesses (or to be assessed by a recruiter), and every successful attack is detected and scored automatically.</p>
<p class="source">source: README.md, initial.md</p>
<h2>What we are making, whether it is achievable, and who is doing it</h2>
<ul>
<li><strong>What we are making:</strong> a practice and hiring platform with 11 challenges, built by three developers.</li>
<li><strong>It is achievable:</strong> the first parts already run and are checked with real commands (see "What already runs").</li>
<li><strong>It is being implemented by three people:</strong> Lab, Platform and Target, each with a task list in weekly sprints. Final submission: first week of November 2026.</li>
</ul>
<h2>How it works in six steps</h2>
<ol class="steps">
${steps}
</ol>
<p class="source">source: initial.md (decisions D-01, D-03, D-06, D-26), docs/architecture/07-repo-and-workstreams.md</p>
<h2>The three streams</h2>
<div class="cards">
${cards}
</div>
<h2>Contracts between the streams</h2>
<p>Each stream builds against written agreements, so the three people can work at the same time. Names and owners only.</p>
<table>
<thead><tr><th>Id</th><th>Agreement</th><th>Owner</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="source">source: docs/architecture/07-repo-and-workstreams.md</p>
<p class="gen">Generated on ${escapeHtml(today)} from the developers' task files.</p>
</section>`;
}

const CSS = `:root{--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--card:#f6f8fa;--done:#1a7f37;--now:#9a6700;--late:#cf222e;--next:#57606a;--link:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--card:#161b22;--done:#3fb950;--now:#d29922;--late:#f85149;--next:#9da7b3;--link:#58a6ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
nav{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:6px 18px;z-index:2}
nav a{color:var(--link);text-decoration:none;font-weight:600}
main{max-width:980px;margin:0 auto;padding:8px 16px 48px}
section{padding-top:24px;border-top:1px solid var(--line);margin-top:24px}
section#home{border-top:0;margin-top:0}
h1{font-size:2rem;margin:.6em 0 .3em}h2{font-size:1.4rem;margin:1.4em 0 .4em}h3{font-size:1.1rem;margin:1.2em 0 .3em}
.lead{font-size:1.15rem}
.source{color:var(--muted);font-size:.82rem;margin:.2em 0 .8em;overflow-wrap:anywhere}
.note,.gen{color:var(--muted)}
.steps li{margin:.4em 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.card,.box{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:4px 16px 8px;margin:10px 0}
.cmd code{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:2px 6px;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--card)}
.dates{color:var(--muted);font-weight:400;font-size:.9rem}
ul.tasks{list-style:none;padding:0;margin:0}
.task{border:1px solid var(--line);border-left-width:6px;border-radius:6px;padding:8px 12px;margin:8px 0;background:var(--card)}
.task.done{border-left-color:var(--done)}.task.now{border-left-color:var(--now)}.task.late{border-left-color:var(--late)}.task.next{border-left-color:var(--next)}
.tid{font-weight:700}.status{float:right;font-weight:700}
.task.done .status{color:var(--done)}.task.now .status{color:var(--now)}.task.late .status{color:var(--late)}.task.next .status{color:var(--next)}
.build,.waits{margin:.3em 0 0;color:var(--muted);font-size:.92rem}
@media (max-width:600px){.status{float:none;display:block}}`;

export function renderPage({ streams, today }) {
  const summaries = streams.map(({ stream, parsed }) => {
    const sts = parsed.tasks.map((t) => computeStatus(t, parsed.sprints, today));
    const n = (s) => sts.filter((x) => x === s).length;
    return { stream, summary: `${n(STATUS.DONE)} done, ${n(STATUS.NOW) + n(STATUS.LATE)} being implemented, ${n(STATUS.NEXT)} next, of ${sts.length} tasks.` };
  });
  const body = [
    renderHome(summaries, today),
    renderProof(),
    ...streams.map(({ stream, parsed, origin }) => renderStream(stream, parsed, today, origin)),
  ].join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VulnMart progress</title>
<style>
${CSS}
</style>
</head>
<body>
<nav><a href="#home">Home</a><a href="#proof">What already runs</a><a href="#lab">Lab (Tanmay)</a><a href="#platform">Platform (Akshay)</a><a href="#target">Target (Sahil)</a></nav>
<main>
${body}
</main>
</body>
</html>
`;
}

export function todayIso() {
  const d = new Date();
  return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// Builds the page for the given options. Throws UsageError (exit 2 or 1) and writes nothing on failure.
export function buildPage(opts = {}) {
  const root = opts.root ? path.resolve(opts.root) : DEFAULT_ROOT;
  const today = opts.today || todayIso();
  if (!isValidDate(today)) throw new UsageError(`--today must be a real date written YYYY-MM-DD, got "${today}"`);
  const streams = STREAMS.map((stream) => {
    const value = opts[stream.key];
    const text = readStreamText(stream, value, root);
    const parsed = parseTasks(text);
    if (parsed.tasks.length === 0) throw new UsageError(`${stream.name} (${stream.key}): no task lines found in the task file`, 1);
    const origin = value === undefined ? `${stream.file} (working tree)` : (existsSync(path.resolve(process.cwd(), value)) ? `${value} (file)` : `${stream.file} on git ref ${value}`);
    return { stream, parsed, origin };
  });
  return renderPage({ streams, today });
}

export function parseArgs(argv) {
  const opts = { serve: false, port: DEFAULT_PORT };
  const needValue = new Set(['--out', '--port', '--today', '--dev1', '--dev2', '--dev3', '--root']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--serve') { opts.serve = true; continue; }
    if (!needValue.has(a)) throw new UsageError(`Unknown argument: ${a}. Try --help.`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value.`);
    if (a === '--port') {
      if (!/^\d+$/.test(v) || +v > 65535) throw new UsageError(`--port must be a number from 0 to 65535, got "${v}".`);
      opts.port = +v;
    } else opts[a.slice(2)] = v;
  }
  return opts;
}

// A tiny read-only server: GET or HEAD on "/" returns the page; everything else is refused. Bound to 127.0.0.1 only.
export function startServer({ getPage, port = DEFAULT_PORT }) {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed\n');
      return;
    }
    if (urlPath !== '/') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
      return;
    }
    let page;
    try {
      page = getPage();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Cannot build the page: ${e.message}\n`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(req.method === 'HEAD' ? undefined : page);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export async function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) { io.out(HELP); return 0; }
    const page = buildPage(opts);
    if (opts.serve) {
      const root = opts.root;
      let last = page;
      const getPage = () => { try { last = buildPage({ ...opts, root }); } catch { /* keep the last good page */ } return last; };
      let server;
      try {
        server = await startServer({ getPage, port: opts.port });
      } catch (e) {
        if (e && e.code === 'EADDRINUSE') throw new UsageError(`Port ${opts.port} is already in use on 127.0.0.1. Stop whatever listens on it or use --port, then run this command again.`);
        throw e;
      }
      io.out(`Serving the progress page on http://127.0.0.1:${server.address().port}/ (Ctrl+C to stop)\n`);
      return { server };
    }
    const rootDir = opts.root ? path.resolve(opts.root) : DEFAULT_ROOT;
    const outFile = path.resolve(opts.out ? process.cwd() : rootDir, opts.out || DEFAULT_OUT);
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, page, 'utf8');
    io.out(`Wrote ${outFile}\n`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n`);
      return e.exitCode;
    }
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main(process.argv.slice(2));
  if (typeof result === 'number') process.exit(result);
  // serving: keep the process alive until Ctrl+C
}
