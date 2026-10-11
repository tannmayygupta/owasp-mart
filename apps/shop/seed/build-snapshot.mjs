// Build a seeded snapshot database (T-08, FR-SHP-12). Migrates a fresh SQLite
// file, runs every seed contribution, and prints row counts and the elapsed
// build time (an input to the S-4 cold-start budget). CI builds this artifact
// once and the in-container copy-on-ready (T-09) ships it to each instance, so
// all instances are identical; the snapshot file itself is not byte-for-byte
// reproducible across rebuilds (random password salts, migration timestamp),
// but the seeded rows are deterministic. The per-instance injector is T-04.
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { seedAll } from './registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Default output when no path is given, so `pnpm run snapshot` builds something.
export const DEFAULT_SNAPSHOT = path.join(HERE, '..', 'build', 'snapshot.db');
const SIDECARS = ['-journal', '-wal', '-shm'];

// Remove a stale db file and any SQLite sidecars so a rebuild starts clean.
function removeDbFile(dbPath) {
  if (dbPath === ':memory:') return;
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).isDirectory()) {
    throw new TypeError(`snapshot path is a directory: ${dbPath}`);
  }
  for (const suffix of ['', ...SIDECARS]) fs.rmSync(dbPath + suffix, { force: true });
}

export async function buildSnapshot(dbPath) {
  if (!dbPath) throw new TypeError('buildSnapshot: a database path is required');
  removeDbFile(dbPath); // always a fresh build
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const started = performance.now();
  const db = openDb(dbPath);
  try {
    migrate(db);
    const ran = await seedAll(db);
    if (ran.length === 0) throw new Error('no seed contributions found — snapshot would be empty');
    // Count every table that holds seeded rows, so later contributions are
    // reported without editing this file.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'")
      .all()
      .map((r) => r.name);
    const counts = {};
    for (const t of tables) {
      const c = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      if (c > 0) counts[t] = c;
    }
    const elapsedMs = Math.round(performance.now() - started);
    return { dbPath, contributions: ran, counts, elapsedMs };
  } finally {
    db.close();
  }
}

export const HELP = `Build a seeded snapshot database.
Usage: node apps/shop/seed/build-snapshot.mjs [dbfile]   (default: ${DEFAULT_SNAPSHOT})`;

export async function main(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP);
    return 0;
  }
  const dbPath = argv[0] ? path.resolve(argv[0]) : DEFAULT_SNAPSHOT;
  const r = await buildSnapshot(dbPath);
  console.log(`snapshot built at ${r.dbPath} in ${r.elapsedMs} ms`);
  console.log(`contributions: ${r.contributions.join(', ')}`);
  console.log(`counts: ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}
