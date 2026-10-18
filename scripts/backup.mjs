// Encrypted backup of the platform Postgres, with a checksum, a manifest and a restore test (story 8.4, L-24 lean).
//
//   node scripts/backup.mjs backup       --out <dir> --pass-file <file> [--container N] [--user U] [--db D]
//   node scripts/backup.mjs verify       --file <dump.enc>
//   node scripts/backup.mjs restore-test --file <dump.enc> --pass-file <file> [--container N] [--user U]
//
// Format: pg_dump custom format, encrypted with `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt`.
// Next to the file: <file>.sha256 (hash of the ciphertext) and <file>.manifest.json (UTC time, byte sizes, table names
// with row counts, hash of the plain dump; counts only, no data). `verify` and `restore-test` check the ciphertext hash
// BEFORE any decryption. The pass phrase is read by openssl from the file (never an argument value, variable or log line).
// Limit (ADR D-98): AES-CBC gives no authentication by itself. Authenticity comes from the checksum file, which the
// runbook says to copy by another path, and from the restore test. `age` is the recorded follow-up.
// The pure parts are exported and tested in scripts/backup.test.mjs; the commands are proved by hand
// (docs/runbooks/backup-restore.md, evidence docs/assets/story-8-4-backup-fallback/).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = { container: 'vulnmart-postgres', user: 'vulnmart', db: 'vulnmart' };
export const SCRATCH_DB = 'vulnmart_restore_test';
export const PBKDF2_ITER = 600000;
export const USAGE = `Usage:
  node scripts/backup.mjs backup       --out <dir outside the repository> --pass-file <file> [--container N] [--user U] [--db D]
  node scripts/backup.mjs verify       --file <name>.dump.enc
  node scripts/backup.mjs restore-test --file <name>.dump.enc --pass-file <file> [--container N] [--user U]`;

// ---------- pure parts ----------
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!['backup', 'verify', 'restore-test'].includes(cmd)) return { error: `Unknown or missing command. ${USAGE}` };
  const opts = { cmd, ...DEFAULTS };
  const keys = { '--out': 'out', '--pass-file': 'passFile', '--file': 'file', '--container': 'container', '--user': 'user', '--db': 'db' };
  for (let i = 0; i < rest.length; i += 2) {
    const k = keys[rest[i]];
    if (!k) return { error: `Unknown option "${rest[i]}". ${USAGE}` };
    if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) return { error: `Option ${rest[i]} needs a value. ${USAGE}` };
    opts[k] = rest[i + 1];
  }
  const need = { backup: ['out', 'passFile'], verify: ['file'], 'restore-test': ['file', 'passFile'] }[cmd];
  const missing = need.filter((k) => !opts[k]);
  if (missing.length) return { error: `Missing ${missing.map((m) => '--' + m.replace('passFile', 'pass-file')).join(', ')}. ${USAGE}` };
  return opts;
}

export function utcStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export const backupFileName = (d) => `vulnmart-${utcStamp(d)}.dump.enc`;
export const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex');

// The repository folder must never receive a dump.
export function insideRepo(p, root = ROOT) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function opensslArgs(mode, passFile) {
  if (mode !== 'encrypt' && mode !== 'decrypt') throw new Error('mode must be encrypt or decrypt');
  return ['enc', mode === 'decrypt' ? '-d' : '-e', '-aes-256-cbc', '-pbkdf2', '-iter', String(PBKDF2_ITER), '-salt', '-pass', `file:${passFile}`];
}

export const dumpArgs = ({ container, user, db }) => ['exec', container, 'pg_dump', '-Fc', '-U', user, db];
export const psqlArgs = ({ container, user }, db, sql) => ['exec', container, 'psql', '-X', '-At', '-F', '|', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', sql];
export const createdbArgs = ({ container, user }) => ['exec', container, 'createdb', '-U', user, SCRATCH_DB];
export const dropdbArgs = ({ container, user }) => ['exec', container, 'dropdb', '--if-exists', '-U', user, SCRATCH_DB];
export const restoreArgs = ({ container, user }) => ['exec', '-i', container, 'pg_restore', '-U', user, '-d', SCRATCH_DB, '--no-owner', '--no-acl', '--exit-on-error'];

// One query that returns "schema.table|count" for every ordinary table outside the system schemas.
export const COUNT_SQL =
  "SELECT table_schema || '.' || table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text " +
  "FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1";

export function parseCounts(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^(.+)\|(\d+)$/.exec(line.trim()); // any table name (a dash, a dollar sign, non-ASCII letters), the count after the last bar
    if (!m) throw new Error(`unreadable count line: "${line.slice(0, 60)}"`);
    out[m[1]] = Number(m[2]);
  }
  return out;
}

export function buildManifest({ createdAt, plainBytes, plainSha256, encBytes, encSha256, counts }) {
  return { format: 'vulnmart-backup-1', createdAt: createdAt.toISOString(), cipher: 'aes-256-cbc', kdf: `pbkdf2-sha256-${PBKDF2_ITER}`, plainBytes, plainSha256, encBytes, encSha256, tables: counts };
}

export function compareCounts(expected, actual) {
  const names = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  const diffs = [];
  for (const n of names) {
    if (!(n in actual)) diffs.push(`${n}: missing after restore (manifest ${expected[n]})`);
    else if (!(n in expected)) diffs.push(`${n}: not in manifest (restored ${actual[n]})`);
    else if (expected[n] !== actual[n]) diffs.push(`${n}: manifest ${expected[n]}, restored ${actual[n]}`);
  }
  return { ok: diffs.length === 0, diffs, tables: names.length };
}

export function sidecarPaths(file) {
  return { sha: `${file}.sha256`, manifest: `${file}.manifest.json` };
}

export function parseShaFile(text) {
  const m = /^([0-9a-f]{64})\b/i.exec(String(text).trim());
  return m ? m[1].toLowerCase() : null;
}

// Pure check of a ciphertext against its checksum file and manifest. Returns {ok, reason}.
export function checkIntegrity({ encBuf, shaText, manifestText }) {
  if (manifestText == null) return { ok: false, reason: 'manifest missing' };
  if (shaText == null) return { ok: false, reason: 'checksum file missing' };
  const want = parseShaFile(shaText);
  if (!want) return { ok: false, reason: 'checksum file unreadable' };
  const got = sha256Buf(encBuf);
  if (got !== want) return { ok: false, reason: 'checksum mismatch: the file was changed or damaged (nothing was decrypted)' };
  let m;
  try {
    m = JSON.parse(manifestText);
  } catch {
    return { ok: false, reason: 'manifest unreadable' };
  }
  if (m.encSha256 !== got) return { ok: false, reason: 'manifest does not match the checksum file' };
  return { ok: true, reason: 'checksum and manifest agree', manifest: m };
}

// ---------- commands ----------
const BIG = 1024 * 1024 * 1024;
const docker = (args, opts = {}) => spawnSync('docker', args, { maxBuffer: BIG, timeout: 600000, windowsHide: true, ...opts });
const openssl = (args, input) => spawnSync('openssl', args, { input, maxBuffer: BIG, timeout: 300000, windowsHide: true });
const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  return 1;
};
const ok = (msg) => console.log(`PASS ${msg}`);

function checkPassFile(p) {
  if (!existsSync(p) || !statSync(p).isFile()) return 'pass-file does not exist';
  if (statSync(p).size === 0) return 'pass-file is empty';
  if (insideRepo(p)) return 'pass-file must be outside the repository';
  return null;
}

function containerUp(c) {
  const r = docker(['inspect', '-f', '{{.State.Running}}', c], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'true';
}

function readCounts(o, db) {
  const r = docker(psqlArgs(o, db, COUNT_SQL), { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed: ${String(r.stderr).split(/\r?\n/)[0]}`);
  return parseCounts(r.stdout);
}

export function cmdBackup(o) {
  const pe = checkPassFile(o.passFile);
  if (pe) return fail(pe);
  if (insideRepo(o.out)) return fail('--out must be outside the repository (a dump must never be committed)');
  if (!containerUp(o.container)) return fail(`container ${o.container} is not running; start the platform stack first (nothing was created)`);
  const now = new Date();
  // The row counts go into the manifest and the restore test compares them with the restored copy, so they must describe the dump: counted before
  // and after it, and the backup is repeated (at most 3 times) when the database changed meanwhile (review finding D7).
  let counts;
  let d;
  try {
    for (let attempt = 1; ; attempt++) {
      counts = readCounts(o, o.db);
      d = docker(dumpArgs(o));
      if (d.status !== 0 || !d.stdout?.length) return fail(`pg_dump failed: ${String(d.stderr).split(/\r?\n/)[0]}`);
      const after = readCounts(o, o.db);
      if (compareCounts(counts, after).ok) break;
      if (attempt >= 3) return fail('the database changed during every attempt of the backup: nothing was written; try again when it is quiet');
    }
  } catch (err) {
    return fail(`counting the rows failed: ${err.message}`);
  }
  const e = openssl(opensslArgs('encrypt', o.passFile), d.stdout);
  if (e.status !== 0 || !e.stdout?.length) return fail('openssl encryption failed');
  mkdirSync(o.out, { recursive: true });
  const file = path.join(o.out, backupFileName(now));
  const { sha, manifest } = sidecarPaths(file);
  const encSha256 = sha256Buf(e.stdout);
  writeFileSync(file, e.stdout);
  writeFileSync(sha, `${encSha256}  ${path.basename(file)}\n`);
  writeFileSync(manifest, JSON.stringify(buildManifest({ createdAt: now, plainBytes: d.stdout.length, plainSha256: sha256Buf(d.stdout), encBytes: e.stdout.length, encSha256, counts }), null, 2) + '\n');
  ok(`backup written: ${path.basename(file)} (${e.stdout.length} bytes encrypted, ${Object.keys(counts).length} tables, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows counted)`);
  console.log(`     files: ${path.basename(file)}, ${path.basename(sha)}, ${path.basename(manifest)}`);
  return 0;
}

function loadIntegrity(file) {
  if (!existsSync(file)) return { ok: false, reason: 'backup file does not exist' };
  const { sha, manifest } = sidecarPaths(file);
  return checkIntegrity({
    encBuf: readFileSync(file),
    shaText: existsSync(sha) ? readFileSync(sha, 'utf8') : null,
    manifestText: existsSync(manifest) ? readFileSync(manifest, 'utf8') : null,
  });
}

export function cmdVerify(o) {
  const r = loadIntegrity(o.file);
  return r.ok ? (ok(`verify: ${r.reason}`), 0) : fail(`verify: ${r.reason}`);
}

export function cmdRestoreTest(o) {
  const pe = checkPassFile(o.passFile);
  if (pe) return fail(pe);
  const v = loadIntegrity(o.file);
  if (!v.ok) return fail(`verify: ${v.reason}`);
  ok(`verify: ${v.reason}`);
  if (!containerUp(o.container)) return fail(`container ${o.container} is not running (nothing was created)`);
  const dec = openssl(opensslArgs('decrypt', o.passFile), readFileSync(o.file));
  if (dec.status !== 0 || !dec.stdout?.length) return fail('decryption failed (wrong pass phrase?); no scratch database was created');
  if (sha256Buf(dec.stdout) !== v.manifest.plainSha256) return fail('decryption failed (wrong pass phrase: the decrypted bytes do not match the manifest); no scratch database was created');
  ok('decrypt: plain dump matches the manifest hash');
  const tmp = path.join(os.tmpdir(), `vulnmart-restore-${process.pid}.dump`);
  let created = false;
  try {
    writeFileSync(tmp, dec.stdout, { mode: 0o600 });
    docker(dropdbArgs(o)); // scratch name only; clears a leftover of a killed run
    const c = docker(createdbArgs(o), { encoding: 'utf8' });
    if (c.status !== 0) return fail(`createdb failed: ${String(c.stderr).split(/\r?\n/)[0]}`);
    created = true;
    const r = docker(restoreArgs(o), { input: readFileSync(tmp), encoding: 'utf8' });
    if (r.status !== 0) return fail(`pg_restore failed: ${String(r.stderr).split(/\r?\n/)[0]}`);
    ok(`restore: pg_restore into scratch database ${SCRATCH_DB}`);
    const cmp = compareCounts(v.manifest.tables, readCounts(o, SCRATCH_DB));
    if (!cmp.ok) return fail(`row counts differ: ${cmp.diffs.join('; ')}`);
    ok(`compare: ${cmp.tables} tables, every row count equal to the manifest`);
    return 0;
  } catch (e) {
    return fail(String(e.message));
  } finally {
    rmSync(tmp, { force: true });
    if (created) {
      const dr = docker(dropdbArgs(o), { encoding: 'utf8' });
      console.log(dr.status === 0 ? `PASS cleanup: scratch database ${SCRATCH_DB} dropped, temporary file removed` : `FAIL cleanup: could not drop ${SCRATCH_DB}; drop it by hand`);
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.error) {
    console.error(o.error);
    return 2;
  }
  return { backup: cmdBackup, verify: cmdVerify, 'restore-test': cmdRestoreTest }[o.cmd](o);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
