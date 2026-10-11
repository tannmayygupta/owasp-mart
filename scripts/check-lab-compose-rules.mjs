// Lint for the lab and harness compose files (D-43, ADR 0027): a lab container must not ask for rights that let it bypass the host filters.
// Fails on privileged: true, network_mode: host, pid: host, ipc: host, a mount of the Docker socket, userns_mode: host, an unconfined seccomp or apparmor
// profile, or a dangerous capability in cap_add (SYS_ADMIN, NET_ADMIN, SYS_PTRACE, SYS_MODULE, SYS_RAWIO, DAC_READ_SEARCH, ALL). There is no exception list:
// if a file ever needs one, change this script with a decision record. A root or privileged container can bypass host firewall rules (ADR 0027);
// the VPC security groups and network ACLs are the real boundary, so these rights are refused up front.
// Text based on purpose (no YAML library): comments are stripped first, so a comment that says "no privileged" does not fail.
// Usage: node scripts/check-lab-compose-rules.mjs [file or folder ...]   (default: every compose or harness file in the repository)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.terraform', '.venv', 'dist', 'build']);
const FILE_NAME = /^(docker-)?compose[^/]*\.ya?ml$|^harness[^/]*\.ya?ml$|^[^/]*\.compose\.ya?ml$/i;
export const DANGEROUS_CAPS = ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'SYS_RAWIO', 'DAC_READ_SEARCH', 'ALL'];

const stripComment = (line) => line.replace(/(^|\s)#.*$/, '');
const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');

/** @returns {string[]} one message per violation, with the line number */
export function checkComposeText(text, name = 'compose file') {
  const problems = [];
  const lines = text.split(/\r?\n/).map(stripComment);
  const fail = (i, msg) => problems.push(`${name}:${i + 1}: ${msg}`);
  const isTrue = (v) => /^(true|yes|on|1)$/i.test(unquote(v));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^\s*(?:-\s*)?privileged:\s*(.*)$/.exec(line)) && isTrue(m[1])) fail(i, 'privileged: true is not allowed');
    if ((m = /^\s*(?:-\s*)?network_mode:\s*(.*)$/.exec(line)) && /^host$/i.test(unquote(m[1]))) fail(i, 'network_mode: host is not allowed');
    if ((m = /^\s*(?:-\s*)?pid:\s*(.*)$/.exec(line)) && /^host$/i.test(unquote(m[1]))) fail(i, 'pid: host is not allowed');
    if ((m = /^\s*(?:-\s*)?ipc:\s*(.*)$/.exec(line)) && /^host$/i.test(unquote(m[1]))) fail(i, 'ipc: host is not allowed');
    if ((m = /^\s*(?:-\s*)?userns_mode:\s*(.*)$/.exec(line)) && /^host$/i.test(unquote(m[1]))) fail(i, 'userns_mode: host is not allowed');
    if (/docker\.sock/.test(line) || /\/run\/docker\b/.test(line)) fail(i, 'a Docker socket mount is not allowed');
    if (/(seccomp|apparmor)\s*[:=]\s*unconfined/i.test(line)) fail(i, 'an unconfined seccomp or apparmor profile is not allowed');
    if ((m = /^(\s*)cap_add:\s*(.*)$/.exec(line))) {
      const items = [];
      if (m[2].trim().startsWith('[')) items.push(...m[2].replace(/[[\]]/g, '').split(',').map(unquote));
      else {
        const indent = m[1].length;
        for (let j = i + 1; j < lines.length; j++) {
          const mm = /^(\s*)-\s*(.*)$/.exec(lines[j]);
          if (lines[j].trim() === '') continue;
          if (!mm || mm[1].length < indent) break;
          items.push(unquote(mm[2]));
        }
      }
      for (const cap of items) {
        const c = cap.toUpperCase().replace(/^CAP_/, '');
        if (DANGEROUS_CAPS.includes(c)) fail(i, `cap_add ${c} is not allowed`);
      }
    }
  }
  return problems;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (FILE_NAME.test(entry.name)) yield path.join(dir, entry.name);
  }
}

export function findComposeFiles(targets = [ROOT]) {
  const out = [];
  for (const t of targets) {
    const abs = path.resolve(t);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

export function checkFiles(files) {
  return files.flatMap((f) => checkComposeText(readFileSync(f, 'utf8'), path.relative(ROOT, f).split(path.sep).join('/')));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = findComposeFiles(process.argv.length > 2 ? process.argv.slice(2) : [ROOT]);
  const problems = checkFiles(files);
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  console.log(`PASS lab compose rules: ${files.length} file(s) checked, none uses privileged, host network or pid, the Docker socket, or a dangerous capability`);
}