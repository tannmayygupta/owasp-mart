// Staff-service state guards added for the PR #14 review (B): a resolved ticket
// is not silently reopened/re-resolved, and an admin cannot lock themselves out
// or remove the last active admin. Correct-flow checks over a seeded db.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { seedAll } from '../seed/registry.mjs';
import { createTicket } from '../src/domain/shop-service.mjs';
import { assignTicket, resolveTicket, setUserStatus } from '../src/domain/staff-service.mjs';

const CUSTOMER = { id: 3, role: 'customer', status: 'active' };
const SUPPORT = { id: 13, role: 'support_agent', status: 'active' };
const ADMIN = { id: 14, role: 'admin', status: 'active' }; // admin.root (seed)
let db;

beforeEach(async () => {
  db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
});

test('a resolved or closed ticket is not reopened by an assignment', () => {
  const id = createTicket(db, CUSTOMER, 'Help', 'My question');
  assert.doesNotThrow(() => assignTicket(db, SUPPORT, id, SUPPORT.id), 'an open ticket can be assigned');
  db.prepare("UPDATE tickets SET status = 'resolved' WHERE id = ?").run(id);
  assert.throws(() => assignTicket(db, SUPPORT, id, SUPPORT.id), /resolved or closed ticket cannot be assigned/);
  db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(id);
  assert.throws(() => assignTicket(db, SUPPORT, id, SUPPORT.id), /resolved or closed/);
});

test('only an open or pending ticket can be resolved (no re-resolve)', () => {
  const id = createTicket(db, CUSTOMER, 'Help', 'Q');
  assert.doesNotThrow(() => resolveTicket(db, SUPPORT, id));
  assert.equal(db.prepare('SELECT status FROM tickets WHERE id = ?').get(id).status, 'resolved');
  const audits = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'ticket.resolve'").get().c;
  assert.throws(() => resolveTicket(db, SUPPORT, id), /only an open or pending ticket can be resolved/);
  // The refused call wrote no second audit line and did not bump the row again.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'ticket.resolve'").get().c, audits);
});

test('an admin cannot suspend their own account', () => {
  assert.throws(() => setUserStatus(db, ADMIN, ADMIN.id, 'suspended'), /cannot suspend your own account/);
});

test('the last active admin cannot be suspended', () => {
  // admin.root (14) is the only active admin in the seed. A second, suspended
  // admin can still pass the role check but must not be able to remove the last.
  const row = db.prepare("INSERT INTO users (email, password_hash, role, status) VALUES ('a2@vulnmart.test','x','admin','suspended')").run();
  const staleAdmin = { id: Number(row.lastInsertRowid), role: 'admin', status: 'suspended' };
  assert.throws(() => setUserStatus(db, staleAdmin, ADMIN.id, 'suspended'), /last active admin/);
  // With a second ACTIVE admin, suspending one is allowed again.
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run('active', staleAdmin.id);
  assert.doesNotThrow(() => setUserStatus(db, staleAdmin, ADMIN.id, 'suspended'));
});
