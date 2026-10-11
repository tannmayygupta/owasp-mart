// Per-epic seed registry (T-08, FR-SHP-12). Later epics add seed data by
// dropping a module in `contributions/` named `NNN-<name>.mjs` whose default
// export is `seed(db, ctx)` — no shared file is edited. Contributions run in
// ascending filename order (the numeric prefix sequences them).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONTRIBUTIONS_DIR = path.join(HERE, 'contributions');

// A fixed timestamp for all seed rows, so the application-visible world is
// deterministic (FR-SHP-12: identical world, only flags/secrets differ). Note
// the snapshot FILE is not byte-for-byte reproducible across rebuilds — the
// password hashes carry random salts and the migration ledger stamps a build
// time — but the snapshot is built once in CI and copied to every instance, so
// all instances are identical, and the seeded rows match across builds.
export const SEED_TIMESTAMP = '2026-01-01T00:00:00Z';

const prefixOf = (f) => Number(f.match(/^(\d+)-/)[1]);

// Contribution module files in ascending NUMERIC prefix order (so 20- precedes
// 100-). Two files sharing a prefix is a mistake and throws before anything runs.
export function contributionFiles(dir = CONTRIBUTIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /^\d+-.*\.mjs$/.test(f));
  files.sort((a, b) => prefixOf(a) - prefixOf(b));
  const seen = new Map();
  for (const f of files) {
    const p = prefixOf(f);
    if (seen.has(p)) throw new Error(`duplicate seed contribution prefix ${p}: ${seen.get(p)} and ${f}`);
    seen.set(p, f);
  }
  return files;
}

// Load the contribution modules (default export must be a function).
export async function discoverContributions(dir = CONTRIBUTIONS_DIR) {
  const out = [];
  for (const file of contributionFiles(dir)) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    if (typeof mod.default !== 'function') {
      throw new Error(`seed contribution ${file} must export default a function`);
    }
    out.push({ name: file, seed: mod.default });
  }
  return out;
}

// Run the given contributions in order, inside one transaction, with a shared
// ctx (the fixed timestamp and a small helper set). Returns the names run.
export function runSeeds(db, contributions, ctx = {}) {
  const fullCtx = { ts: SEED_TIMESTAMP, ...ctx };
  const ran = [];
  let current = '(none)';
  try {
    db.exec('BEGIN');
    for (const c of contributions) {
      current = c.name;
      c.seed(db, fullCtx);
      ran.push(c.name);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* no active transaction */
    }
    throw new Error(`seed contribution ${current} failed: ${err.message}`);
  }
  return ran;
}

// Convenience: discover and run every contribution against an open db.
export async function seedAll(db, ctx = {}) {
  return runSeeds(db, await discoverContributions(), ctx);
}
