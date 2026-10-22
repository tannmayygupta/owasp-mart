// C03 part A — Injection: UNION SQL injection in product search (OWASP A03,
// CWE-89). The search runs against a SEPARATE, read-only catalog store (its own
// SQLite database: only products, reviews and ops_notes — no users, orders,
// tokens or other flags, per FR-INS-02), so even a successful injection cannot
// reach anything but merchandising data.
//
//   FIXED (default): the query is parameterised, so `q` is data, never SQL.
//   VULNERABLE (VM_CHALLENGE_C03A=vulnerable): the query is built by string
//     concatenation, so a `UNION SELECT ... FROM ops_notes` reads the ops notes
//     (one holds a marker, one the flag). A malformed `q` raises a SQL error,
//     which emits shop.catalog_query_error (the part-A M1 signal).
//
// The fix is a parameterised query (+ allow-listed sort, least-privilege account,
// generic errors); see the challenge spec.
import { openDb } from '../db/index.mjs';
import { isVulnerable } from './mode.mjs';

// Build the separate catalog store from the shop's published products, plus the
// ops_notes table the challenge reads. `flag` is the per-instance flag value
// (injected); the tests pass a neutral marker.
export function buildCatalogStore(db, { flag = 'C03A-FLAG-MARKER', opsMarker = 'C03A-OPS-NOTE-MARKER' } = {}) {
  const cat = openDb(':memory:');
  cat.exec(`
    CREATE TABLE catalog_products (id INTEGER PRIMARY KEY, name TEXT, price INTEGER, store TEXT, status TEXT);
    CREATE TABLE ops_notes (id INTEGER PRIMARY KEY, body TEXT);
  `);
  const rows = db.prepare("SELECT p.id, p.title AS name, p.price_cents AS price, s.name AS store, p.status FROM products p JOIN stores s ON s.id = p.store_id WHERE p.status = 'published'").all();
  const ins = cat.prepare('INSERT INTO catalog_products (id, name, price, store, status) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.id, r.name, r.price, r.store, r.status);
  cat.prepare('INSERT INTO ops_notes (id, body) VALUES (1, ?)').run(opsMarker);
  cat.prepare('INSERT INTO ops_notes (id, body) VALUES (2, ?)').run(flag);
  return cat;
}

// Search the catalog. `catalogDb` is the separate store from buildCatalogStore.
export function searchCatalog(catalogDb, q, { challenges = {}, emit = () => {} } = {}) {
  const term = String(q ?? '');
  if (isVulnerable('C03A', challenges)) {
    // VULNERABLE: the term is concatenated straight into the SQL text.
    const sql = `SELECT id,name,price,store FROM catalog_products WHERE status='published' AND name LIKE '%${term}%'`;
    try {
      return catalogDb.prepare(sql).all();
    } catch (err) {
      // A malformed term produces a SQL error — the part-A M1 detection signal.
      emit('shop.catalog_query_error', { route: 'web', error_class: err?.code || 'sql_error' });
      // The page shows the database's own message (a search box that prints SQL errors is the first sign of the weakness).
      return Object.assign([], { error: String(err?.message ?? 'sql error') });
    }
  }
  // FIXED: the term is a bound parameter — data, not SQL.
  // wildcards in the text are literal (a search for "50%" is not a match-all), as the shop's own listing does
  const literal = term.replace(/[\\%_]/g, '\\$&');
  return catalogDb.prepare("SELECT id,name,price,store FROM catalog_products WHERE status='published' AND name LIKE ? ESCAPE '\\'").all(`%${literal}%`);
}
