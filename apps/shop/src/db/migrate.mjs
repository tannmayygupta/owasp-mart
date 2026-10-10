// Idempotent migration runner for the shop (T-06). Applies the ordered
// migrations/*.sql files to a SQLite database and records each in a
// _migrations ledger so re-running is a no-op. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(HERE, '..', '..', 'migrations');

export function versionOf(file) {
  return Number(file.match(/^(\d+)_/)[1]);
}

// Migration files are `NNNN_name.sql`, applied in ascending numeric version
// order (not lexicographic, so a 2-digit and 4-digit version still order right).
// Two files sharing a version is a mistake and throws before anything is applied.
// Migration SQL must NOT contain its own BEGIN/COMMIT: the runner wraps each
// file in one transaction.
export function migrationFiles(dir = MIGRATIONS_DIR) {
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f));
  files.sort((a, b) => versionOf(a) - versionOf(b));
  const seen = new Map();
  for (const f of files) {
    const v = versionOf(f);
    if (seen.has(v)) throw new Error(`duplicate migration version ${v}: ${seen.get(v)} and ${f}`);
    seen.set(v, f);
  }
  return files;
}

// Apply all not-yet-applied migrations. Returns the versions applied this run.
export function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);

  const done = new Set(db.prepare('SELECT version FROM _migrations').all().map((r) => r.version));
  const applied = [];

  for (const file of migrationFiles(dir)) {
    const version = versionOf(file);
    if (done.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(version, file);
      db.exec('COMMIT');
    } catch (err) {
      // Roll back the partial migration; never let a ROLLBACK error mask the real one.
      try {
        db.exec('ROLLBACK');
      } catch {
        /* no active transaction to roll back */
      }
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
    applied.push(version);
  }
  return applied;
}

// Open the database at `dbPath`, migrate it, and return the open handle.
export function migrateFile(dbPath, dir = MIGRATIONS_DIR) {
  const db = openDb(dbPath);
  migrate(db, dir);
  return db;
}

export const HELP = `Apply the shop migrations to a SQLite database.
Usage: node apps/shop/src/db/migrate.mjs <dbfile>`;

export function main(argv) {
  const dbPath = argv[0];
  if (!dbPath || dbPath === '--help' || dbPath === '-h') {
    console.log(HELP);
    return dbPath ? 0 : 2;
  }
  const db = openDb(dbPath);
  let applied;
  try {
    applied = migrate(db);
  } finally {
    db.close();
  }
  console.log(applied.length ? `applied migrations: ${applied.join(', ')}` : 'up to date, nothing to apply');
  return 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
