// Checks that everything the college report needs from the repository is present and non-empty, and that none of it holds
// secret-looking content (story 8.6, L-31). Read-only. The matched value is never printed, only file and line.
//
//   node scripts/check-submission-pack.mjs [--root <folder>]      exit 0 only when every item is PASS and nothing secret-looking is found
//
// The list below is the same as docs/runbooks/submission-pack.md; change both together.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTable } from './demo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// kind 'file': must exist with at least `min` bytes of non-space text. kind 'dir': at least `count` entries (files, recursive) matching `pattern`, each non-empty.
export const REQUIRED = [
  { name: 'source of truth (decision log, open questions)', kind: 'file', path: 'initial.md', min: 500 },
  { name: 'project rules', kind: 'file', path: 'CLAUDE.md', min: 200 },
  { name: 'PRD', kind: 'file', path: 'docs/prd/PRD.md', min: 2000 },
  { name: 'architecture overview', kind: 'file', path: 'docs/architecture/01-overview-and-components.md', min: 500 },
  { name: 'architecture deployment', kind: 'file', path: 'docs/architecture/02-deployment-and-network.md', min: 500 },
  { name: 'architecture origins and access', kind: 'file', path: 'docs/architecture/03-origins-and-access.md', min: 500 },
  { name: 'architecture data and state', kind: 'file', path: 'docs/architecture/04-data-and-state.md', min: 500 },
  { name: 'architecture key flows', kind: 'file', path: 'docs/architecture/05-key-flows.md', min: 500 },
  { name: 'architecture security', kind: 'file', path: 'docs/architecture/06-security.md', min: 500 },
  { name: 'decision records (ADRs)', kind: 'dir', path: 'docs/adr', pattern: /^\d{4}-.+\.md$/, count: 10 },
  { name: 'dev-log entries', kind: 'dir', path: 'docs/dev-log', pattern: /^\d{4}-\d{2}-\d{2}-.+\.md$/, count: 10 },
  { name: 'traceability matrix', kind: 'file', path: 'docs/traceability.md', min: 2000 },
  { name: 'changelog', kind: 'file', path: 'CHANGELOG.md', min: 200 },
  { name: 'evidence folders (docs/assets)', kind: 'dir', path: 'docs/assets', pattern: /\.(txt|json|md|png|jpg)$/i, count: 5 },
  { name: 'runbook: local demo', kind: 'file', path: 'docs/runbooks/local-demo.md', min: 500 },
  { name: 'runbook: backup and restore', kind: 'file', path: 'docs/runbooks/backup-restore.md', min: 500 },
  { name: 'runbook: laptop fallback', kind: 'file', path: 'docs/runbooks/laptop-fallback.md', min: 500 },
  { name: 'runbook: VM-I hardening audit', kind: 'file', path: 'docs/runbooks/vmi-hardening.md', min: 500 },
  { name: 'runbook: demo 19 Oct', kind: 'file', path: 'docs/runbooks/demo-19-oct.md', min: 1000 },
  { name: 'runbook: submission pack', kind: 'file', path: 'docs/runbooks/submission-pack.md', min: 500 },
  { name: 'handoffs register', kind: 'file', path: 'docs/dev/HANDOFFS.md', min: 200 },
];

// Folders whose text files are scanned for secret-looking content (the pack that goes into the report).
export const SCAN_DIRS = ['docs/adr', 'docs/dev-log', 'docs/assets', 'docs/runbooks', 'docs/architecture', 'docs/prd', 'docs/design', 'docs/research', 'docs/report', 'docs/dev', 'docs/bmad'];
export const SCAN_FILES = ['initial.md', 'CLAUDE.md', 'CHANGELOG.md', 'docs/traceability.md', 'docs/dev/HANDOFFS.md'];
// every kind of file that holds text: evidence is often a .log, a helper a .sh or .ps1 (review finding D9)
const TEXT = /\.(md|txt|json|toml|ya?ml|mjs|js|py|sh|ps1|csv|log|conf|cfg|ini|env|sql|html)$/i;
// a file that is a key or a secret by its name is a finding whatever it holds
export const SECRET_FILE_NAME = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks)|id_(rsa|ed25519|ecdsa)|.*\.(tfstate|tfstate\.backup))$/i;

// Patterns are deliberately narrow: the repository uses fake development values on purpose ("...-not-a-secret") and test flags made of one repeated letter.
export const SECRET_PATTERNS = [
  { kind: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'AWS secret access key', re: /(?:aws_secret_access_key|secret_?access_?key)["']?\s*[=:]\s*["']?[A-Za-z0-9/+=]{30,}/i },
  { kind: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'real-looking flag value', re: /\bVM\{(?!(.)\1{11,}\})[A-Za-z0-9_+/=-]{16,}\}/ },
  { kind: 'secret assignment with a long random value', re: /\b(?:password|passphrase|secret|api[_-]?key|token)\b["']?\s*[:=]\s*["']?(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}["']?(?!\S*not-a-secret)/i },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

// ---------- pure parts ----------
export function scanText(file, text) {
  const hits = [];
  String(text).split('\n').forEach((line, i) => {
    for (const p of SECRET_PATTERNS) if (p.re.test(line)) hits.push({ file, line: i + 1, kind: p.kind });
  });
  return hits;
}

export function checkFile(item, root, io) {
  const p = path.join(root, item.path);
  if (!io.exists(p)) return { status: 'FAIL', name: item.name, detail: `missing: ${item.path}` };
  const text = io.read(p);
  const n = text.replace(/\s+/g, '').length;
  if (n === 0) return { status: 'FAIL', name: item.name, detail: `empty: ${item.path}` };
  if (n < (item.min ?? 1)) return { status: 'FAIL', name: item.name, detail: `too short (${n} characters, want at least ${item.min}): ${item.path}` };
  return { status: 'PASS', name: item.name, detail: `${item.path} (${n} characters)` };
}

export function checkDir(item, root, io) {
  const p = path.join(root, item.path);
  if (!io.exists(p)) return { status: 'FAIL', name: item.name, detail: `missing folder: ${item.path}` };
  const files = io.walk(p).filter((f) => item.pattern.test(path.basename(f)));
  const empty = files.filter((f) => io.read(f).trim().length === 0 && !/\.(png|jpg)$/i.test(f));
  if (files.length < item.count) return { status: 'FAIL', name: item.name, detail: `${files.length} matching file(s) in ${item.path}, want at least ${item.count}` };
  if (empty.length) return { status: 'FAIL', name: item.name, detail: `${empty.length} empty file(s), first: ${path.relative(root, empty[0]).replace(/\\/g, '/')}` };
  return { status: 'PASS', name: item.name, detail: `${files.length} file(s) in ${item.path}` };
}

export function runChecks(root, io, required = REQUIRED) {
  return required.map((it) => (it.kind === 'dir' ? checkDir(it, root, io) : checkFile(it, root, io)));
}

export function scanPack(root, io) {
  const files = [...SCAN_FILES.map((f) => path.join(root, f)).filter((f) => io.exists(f)), ...SCAN_DIRS.flatMap((d) => (io.exists(path.join(root, d)) ? io.walk(path.join(root, d)) : []))].filter((f) => TEXT.test(f));
  const hits = [];
  for (const f of files) hits.push(...scanText(path.relative(root, f).replace(/\\/g, '/'), io.read(f)));
  const everything = [...SCAN_DIRS.flatMap((d) => (io.exists(path.join(root, d)) ? io.walk(path.join(root, d)) : []))];
  for (const f of everything) {
    const rel = path.relative(root, f).replace(/\\/g, '/');
    if (SECRET_FILE_NAME.test(rel)) hits.push({ file: rel, line: 0, kind: 'a key or secret file by its name' });
  }
  return { files: files.length, hits };
}

export const exitCodeOf = (rows, hits) => (rows.some((r) => r.status !== 'PASS') || hits.length ? 1 : 0);

// ---------- IO ----------
export const realIo = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
  walk: (dir) => {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...realIo.walk(f));
      else if (statSync(f).isFile()) out.push(f);
    }
    return out;
  },
};

export function main(argv = process.argv.slice(2), io = realIo) {
  let root = ROOT;
  if (argv[0] === '--root') {
    root = path.resolve(argv[1] ?? '');
    if (!argv[1]) return console.error('--root needs a folder'), 2;
  } else if (argv.length) return console.error('Usage: node scripts/check-submission-pack.mjs [--root <folder>]'), 2;
  const rows = runChecks(root, io);
  const scan = scanPack(root, io);
  rows.push({ status: scan.hits.length ? 'FAIL' : 'PASS', name: 'no secret-looking content', detail: scan.hits.length ? `${scan.hits.length} hit(s) in ${scan.files} files` : `${scan.files} files scanned, no hit` });
  console.log(formatTable(rows));
  for (const h of scan.hits) console.log(`  ${h.file}:${h.line} ${h.kind}`);
  const code = exitCodeOf(rows, scan.hits);
  console.log(code === 0 ? '\nsubmission pack: PASS' : '\nsubmission pack: FAIL (fix the items above)');
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
