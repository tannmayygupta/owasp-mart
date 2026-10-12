// The tag contracts-v1.0.0 (story L-09, docs/adr/0029, runbook docs/runbooks/contracts-tag.md).
// Usage: node scripts/tag-contracts.mjs [--dry-run | --create] [--root <dir>] [--tag <name>]
//   --dry-run (the default): checks every precondition and lists every one that fails (never stops at the first); when all are green it prints the
//                            `git tag -a` command and the push command, and creates nothing.
//   --create:                the same checks, after `git fetch origin main` (so origin/main is current); origin/main must exist (a dry run only warns when it
//                            does not). When all are green it creates the annotated tag LOCALLY. It never pushes: the push is the developer's.
// Exit 0: all preconditions green. Exit 1: at least one is red. Exit 2: the script could not run.
// The preconditions (contracts/COMPAT.md, section "Tag preconditions"): clean tree, branch main, the tag does not exist yet, versions in COMPAT.md
// are the newest changelog entries, every approval row of COMPAT.md is `approved`, every line of the done checklist in docs/dev/HANDOFFS.md is ticked.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadRegistry, changelogSection, sectionVersions, compatSection, tableOf, parseApprovers } from './check-contract-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_TAG = 'contracts-v1.0.0';
export const CHECKLIST_HEADING = 'Done checklist before contracts-v1.0.0 (L-09)';
const MAIN = 'main';

const lf = (s) => s.replace(/\r\n/g, '\n');
function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000 });
  if (r.error) throw new Error(`git ${args[0]} could not run: ${r.error.message}`);
  return r;
}
const read = (root, rel) => {
  const f = path.join(root, rel);
  return fs.existsSync(f) && fs.statSync(f).isFile() ? lf(fs.readFileSync(f, 'utf8')) : null;
};
const ver = (s) => (/^(\d+)\.(\d+)\.(\d+)$/.exec(s) ?? []).slice(1).map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const newest = (vs) => vs.reduce((m, v) => (m && cmp(m, v) >= 0 ? m : v), null);

// The lines `- [ ] ...` and `- [x] ...` between the checklist heading and the next `## ` heading.
export function checklist(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).trim() === CHECKLIST_HEADING);
  if (start < 0) return null;
  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break;
    const m = /^- \[([ xX])\]\s+(.*)$/.exec(lines[i]);
    if (m) items.push({ done: m[1] !== ' ', text: m[2].trim(), line: i + 1 });
  }
  return items;
}

// Each precondition returns { name, ok, details }. They never throw for a missing file (that is a red precondition).
export function checkPreconditions(root, { tag = DEFAULT_TAG, create = false } = {}) {
  const out = [];
  const add = (name, ok, details) => out.push({ name, ok, details });

  const status = git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (status.status !== 0) add('clean-tree', false, [`git status failed: ${status.stderr.trim()}`]);
  else {
    const dirty = status.stdout.split('\n').filter(Boolean);
    add('clean-tree', !dirty.length, dirty.length ? [`the working tree is not clean (${dirty.length} path(s)): ${dirty.slice(0, 5).map((l) => l.trim()).join('; ')}${dirty.length > 5 ? '; ...' : ''}`] : ['the working tree is clean']);
  }

  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = branch.status === 0 ? branch.stdout.trim() : null;
  add('on-main', name === MAIN, [name === MAIN ? `on ${MAIN}` : `the current branch is ${name ?? 'unknown'}, not ${MAIN} (a tag on a feature branch would tag work that is not merged)`]);

  // HEAD must be the tip of origin/main as this clone knows it; a clone with no origin/main ref (a test repository) passes with a note.
  // --create fetches first: a stale origin/main would let a tag land on a commit that is no longer the tip. The fetch reads only; it never pushes.
  const fetched = create ? git(root, ['fetch', '--quiet', 'origin', MAIN]) : null;
  const remote = git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${MAIN}^{commit}`]);
  const head = git(root, ['rev-parse', 'HEAD']);
  if (fetched && fetched.status !== 0) add('up-to-date', false, [`git fetch origin ${MAIN} failed: ${fetched.stderr.trim().split('\n')[0] || 'no message'}; --create needs a current origin/${MAIN} (set the origin remote and check the network)`]);
  else if (remote.status !== 0) add('up-to-date', !create, [create ? `there is no origin/${MAIN} ref, so HEAD cannot be compared with it: --create refuses (fetch origin first)` : `WARNING: there is no origin/${MAIN} ref in this repository, so HEAD was not compared with it (--create would refuse)`]);
  else add('up-to-date', head.stdout.trim() === remote.stdout.trim(), [head.stdout.trim() === remote.stdout.trim() ? `HEAD is origin/${MAIN}` : `HEAD (${head.stdout.trim().slice(0, 10)}) is not origin/${MAIN} (${remote.stdout.trim().slice(0, 10)}); run \`git fetch origin\` first, then update ${MAIN} (git pull) so the tag lands on the merge commit that CI checked`]);

  const existing = git(root, ['tag', '--list', tag]).stdout.trim();
  add('tag-absent', !existing, [existing ? `the tag ${tag} already exists` : `the tag ${tag} does not exist yet`]);

  // COMPAT.md and the changelog
  const compat = read(root, 'contracts/COMPAT.md');
  const log = read(root, 'contracts/CHANGELOG.md');
  const { registry, error } = loadRegistry(root);
  if (compat === null || log === null || error) {
    add('versions', false, [compat === null ? 'contracts/COMPAT.md does not exist' : log === null ? 'contracts/CHANGELOG.md does not exist' : error]);
    add('release-labels', false, ['not evaluated: the contract files are missing']);
    add('approvals', false, ['not evaluated: the contract files are missing']);
  } else {
    const versions = new Map();
    const problems = [];
    const section = compatSection(compat, 'Versions');
    if (!section) problems.push('contracts/COMPAT.md has no "## Versions" section');
    else {
      for (const { cells, line } of tableOf(section).rows) {
        const c = registry.contracts.find((x) => x.id === cells[0]);
        if (!c) { problems.push(`line ${line}: contract "${cells[0]}" is not in contracts/registry.json`); continue; }
        const v = ver((cells[1] ?? '').replace(/^contracts-/, ''));
        if (v.length !== 3) { problems.push(`line ${line}: ${c.id} lists "${cells[1]}", not X.Y.Z`); continue; }
        versions.set(c.id, v.join('.'));
        const top = newest(sectionVersions(changelogSection(log, c.changelog)));
        if (!top) problems.push(`${c.id}: the changelog has no versioned entry under "## ${c.changelog}"`);
        else if (cmp(top, v) !== 0) problems.push(`${c.id}: COMPAT.md says ${v.join('.')} but the newest changelog entry is ${top.join('.')} (version mismatch)`);
      }
      for (const c of registry.contracts) if (!versions.has(c.id)) problems.push(`${c.id}: has no row in the Versions table of contracts/COMPAT.md`);
    }
    add('versions', !problems.length, problems.length ? problems : [`${versions.size} contract versions match the changelog: ${[...versions].map(([k, v]) => `${k} ${v}`).join(', ')}`]);

    // a tag contracts-v1.0.0 marks contracts that are all labelled 1.0.0 (ADR 0029: one release commit before the tag)
    const labelVersion = /^contracts-v1\.0\.0$/.test(tag) ? '1.0.0' : null;
    if (!labelVersion) add('release-labels', true, [`the tag ${tag} is not contracts-v1.0.0, so the 1.0.0 labels are not required`]);
    else {
      const wrong = [...versions].filter(([, v]) => v !== labelVersion).map(([k, v]) => `${k} ${v}`);
      add('release-labels', !wrong.length && versions.size > 0, wrong.length || !versions.size ? [`not every contract is labelled ${labelVersion} (${wrong.join(', ') || 'no versions read'}): relabel every contract 1.0.0 in a release commit first, see docs/runbooks/contracts-tag.md`] : [`every contract is labelled ${labelVersion}`]);
    }

    const parsed = parseApprovers(compat, registry);
    const ap = [...parsed.problems];
    const pending = [];
    for (const r of parsed.rows) {
      if (versions.has(r.contract) && r.version !== versions.get(r.contract)) ap.push(`line ${r.line}: ${r.contract} @${r.handle} signs version ${r.version}, but the Versions table says ${versions.get(r.contract)} (version mismatch)`);
      if (r.status !== 'approved') pending.push(`${r.contract} @${r.handle} (${r.role}, stream ${r.stream})`);
    }
    if (!parsed.rows.length && !parsed.problems.length) ap.push('the Approvals table has no rows');
    for (const c of registry.contracts) if (!parsed.rows.some((r) => r.contract === c.id && r.role === 'owner')) ap.push(`${c.id}: has no owner row in the Approvals table`);
    if (pending.length) ap.push(`${pending.length} sign-off(s) still pending: ${pending.join('; ')}`);
    add('approvals', !ap.length, ap.length ? ap : [`all ${parsed.rows.length} approval rows are approved`]);
  }

  // the handoff checklist
  const handoffs = read(root, 'docs/dev/HANDOFFS.md');
  if (handoffs === null) add('handoffs', false, ['docs/dev/HANDOFFS.md does not exist']);
  else {
    const items = checklist(handoffs);
    if (items === null) add('handoffs', false, [`docs/dev/HANDOFFS.md has no section "${CHECKLIST_HEADING}"`]);
    else if (!items.length) add('handoffs', false, [`the section "${CHECKLIST_HEADING}" has no checklist lines`]);
    else {
      const open = items.filter((i) => !i.done);
      add('handoffs', !open.length, open.length ? [`${open.length} of ${items.length} checklist line(s) are not ticked:`, ...open.map((i) => `  line ${i.line}: ${i.text}`)] : [`all ${items.length} checklist lines are ticked`]);
    }
  }
  return out;
}

export function tagMessage(root, tag) {
  const compat = read(root, 'contracts/COMPAT.md') ?? '';
  const section = compatSection(compat, 'Versions');
  const rows = section ? tableOf(section).rows.map((r) => `${r.cells[0]} ${r.cells[1]}`) : [];
  return `${tag}: ${rows.join(', ')}`;
}

export function run(argv, { root = ROOT, out = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const create = argv.includes('--create');
  if (create && argv.includes('--dry-run')) { out('use either --dry-run or --create, not both'); return 2; }
  const dir = opt('--root') ? path.resolve(opt('--root')) : root;
  const tag = opt('--tag') ?? DEFAULT_TAG;
  if (!/^contracts-v\d+\.\d+\.\d+$/.test(tag)) { out(`the tag name ${tag} must look like contracts-vX.Y.Z`); return 2; }
  let results;
  try {
    results = checkPreconditions(dir, { tag, create });
  } catch (e) {
    out(`tag-contracts could not run: ${e.message}`);
    return 2;
  }
  for (const r of results) {
    const [first, ...rest] = r.details;
    out(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${first}`);
    for (const d of rest) out(`      ${d}`);
  }
  const red = results.filter((r) => !r.ok);
  out('');
  if (red.length) {
    out(`NOT READY: ${red.length} of ${results.length} preconditions failed (${red.map((r) => r.name).join(', ')}). No tag was created.`);
    return 1;
  }
  const message = tagMessage(dir, tag);
  const command = `git tag -a ${tag} -m "${message}"`;
  if (!create) {
    out(`READY (dry run, nothing was created). To tag, run: node scripts/tag-contracts.mjs --create`);
    out(`  ${command}`);
    out(`Then, by hand and only when you decide to publish it (SSH remote, never from this script):`);
    out(`  git push origin ${tag}`);
    return 0;
  }
  const r = git(dir, ['tag', '-a', tag, '-m', message]);
  if (r.status !== 0) { out(`git tag failed: ${r.stderr.trim()}`); return 2; }
  out(`CREATED the local tag ${tag} (${message}). It is not pushed. To publish it, run by hand: git push origin ${tag}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));
