// Checks that the project records agree with each other (tracker audit of 2026-10-21, section 6). Run: node scripts/check-records.mjs [--root <folder>]
// 1. every requirement id of the PRD (FR-xxx-nn) has a row in docs/traceability.md;
// 2. every handoff row of docs/dev/HANDOFFS.md uses the one status vocabulary;
// 3. every decision record file in docs/adr/ has a row in docs/adr/README.md, and every row points at a file;
// 4. every BMAD story plan has a status from the known list.
// Exit code 0 when no problem, 1 when any, 2 on a usage error. Warnings (none yet) never fail the run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HANDOFF_STATUS = /^(done|open|superseded|blocked-external|in-progress-wp)\b/;
export const PLAN_STATUS = new Set(['planned', 'backlog', 'in-progress', 'in-review', 'review', 'built', 'done', 'blocked', 'dropped']);

const read = (file) => fs.readFileSync(file, 'utf8');
const exists = (file) => fs.existsSync(file);

// split a markdown table row on pipes that are not escaped
export function cells(line) {
  const out = []; let cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (line[i] === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += line[i];
  }
  out.push(cur.trim());
  return out.slice(1, -1); // outer pipes
}

function walk(dir, keep, out = []) {
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, out); else if (keep(p)) out.push(p);
  }
  return out;
}

export function checkRecords(root) {
  const problems = []; const warnings = [];
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');

  // 1. PRD ids against the traceability file
  const prd = path.join(root, 'docs', 'prd', 'PRD.md'); const trace = path.join(root, 'docs', 'traceability.md');
  if (exists(prd) && exists(trace)) {
    const ids = [...new Set(read(prd).match(/\bFR-[A-Z]{2,4}-\d{2}\b/g) ?? [])];
    const traceText = read(trace);
    const missing = ids.filter((id) => !traceText.includes(id));
    if (missing.length) problems.push(`docs/traceability.md has no row for ${missing.length} PRD requirement(s): ${missing.join(', ')}`);
  } else problems.push('docs/prd/PRD.md or docs/traceability.md is missing');

  // 2. handoff statuses
  const hand = path.join(root, 'docs', 'dev', 'HANDOFFS.md');
  if (exists(hand)) {
    const seen = new Set();
    for (const line of read(hand).split(/\r?\n/)) {
      if (!/^\| H-\d+ \|/.test(line)) continue;
      const c = cells(line);
      if (seen.has(c[0])) problems.push(`HANDOFFS.md: ${c[0]} appears twice`);
      seen.add(c[0]);
      const status = c[5] ?? '';
      if (!HANDOFF_STATUS.test(status)) problems.push(`HANDOFFS.md: ${c[0]} has the status "${status.slice(0, 40)}"; allowed: done, open, superseded, blocked-external, in-progress-wp`);
    }
    if (seen.size === 0) problems.push('HANDOFFS.md: no handoff rows found');
  } else problems.push('docs/dev/HANDOFFS.md is missing');

  // 3. decision records against their index
  const adrDir = path.join(root, 'docs', 'adr'); const readme = path.join(adrDir, 'README.md');
  if (exists(readme)) {
    const index = read(readme);
    const files = fs.readdirSync(adrDir).filter((f) => /^\d{4}-.+\.md$/.test(f) && !f.startsWith('0000-'));
    for (const f of files) if (!index.includes(`(${f})`)) problems.push(`docs/adr/README.md has no row for ${f}`);
    for (const m of index.matchAll(/\]\((\d{4}-[^)]+\.md)\)/g)) if (!exists(path.join(adrDir, m[1]))) problems.push(`docs/adr/README.md points at ${m[1]}, which does not exist`);
    const numbers = files.map((f) => f.slice(0, 4));
    const dup = numbers.filter((n, i) => numbers.indexOf(n) !== i);
    if (dup.length) problems.push(`docs/adr/: the number ${[...new Set(dup)].join(', ')} is used by two files`);
  }

  // 4. story plans
  const bmad = path.join(root, 'docs', 'bmad');
  for (const plan of walk(bmad, (p) => p.endsWith('-plan.md'))) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(read(plan));
    const status = m && /^status:\s*['"]?([a-z-]+)['"]?\s*$/m.exec(m[1])?.[1];
    if (!status) { problems.push(`${rel(plan)}: no status in the front matter`); continue; }
    if (!PLAN_STATUS.has(status)) problems.push(`${rel(plan)}: unknown status "${status}"`);
  }

  return { problems, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (args.length) {
    if (args[0] !== '--root' || !args[1]) { console.error('usage: node scripts/check-records.mjs [--root <folder>]'); process.exit(2); }
    root = path.resolve(args[1]);
  }
  const { problems, warnings } = checkRecords(root);
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const p of problems) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `records: ${problems.length} problem(s), ${warnings.length} warning(s)` : `records: PASS (${warnings.length} warning(s))`);
  process.exit(problems.length ? 1 : 0);
}
