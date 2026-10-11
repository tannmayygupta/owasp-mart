// SQLite access for the shop, on Node 24's built-in node:sqlite (ADR 0017).
// This thin wrapper is the ONE place the driver is named, so the rest of the
// shop (and later stories) never import node:sqlite directly and the driver
// stays swappable.
//
// node:sqlite is experimental in Node 24 and prints an ExperimentalWarning on
// first use; that is expected and harmless.
import { DatabaseSync } from 'node:sqlite';

// Open a database and enforce foreign keys for the connection. Pass ':memory:'
// for a throwaway database (tests).
export function openDb(path) {
  if (!path) throw new TypeError('openDb: a path (or ":memory:") is required');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
