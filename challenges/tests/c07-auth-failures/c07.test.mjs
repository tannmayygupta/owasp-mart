// C07 self-test: the reset-code brute force takes over the finance account and
// reads the settlement flag on the vulnerable build (and emits the reset events),
// and fails on the fixed build (128-bit token + attempt limit). Boots with
// VM_TEST=1 so the test-only mailbox route exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../../apps/shop/src/db/index.mjs';
import { migrate } from '../../../apps/shop/src/db/migrate.mjs';
import { seedAll } from '../../../apps/shop/seed/registry.mjs';
import { createApp } from '../../../apps/shop/src/app.mjs';
import { runExploit } from '../runner/run-exploit.mjs';
import exploit from './exploit.mjs';

const MARKER = 'C07-SETTLEMENT-FLAG-MARKER';

async function bootShop(mode) {
  const prevTest = process.env.VM_TEST;
  process.env.VM_TEST = '1'; // the test-only mailbox route is read at app construction
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  db.prepare("INSERT INTO sentinel (key, value) VALUES ('c07', ?)").run(MARKER);
  const events = [];
  const app = createApp({ db, emit: (type, data) => events.push({ type, data }), challenges: { C07: mode } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const restore = () => { if (prevTest === undefined) delete process.env.VM_TEST; else process.env.VM_TEST = prevTest; };
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}`, events, restore };
}

test('C07 exploit PASSES on the vulnerable build (reset brute force takes over finance)', async () => {
  const { server, baseUrl, events, restore } = await bootShop('vulnerable');
  try {
    const r = await runExploit({ baseUrl, name: 'c07', test: exploit, timeoutMs: 30000 });
    assert.equal(r.passed, true, r.detail);
    assert.ok(events.some((e) => e.type === 'auth.reset_requested' && e.data.account_role === 'finance'), 'expected auth.reset_requested for finance');
    assert.ok(events.some((e) => e.type === 'auth.password_reset_completed' && e.data.account_role === 'finance'), 'expected the takeover event');
  } finally { server.close(); restore(); }
});

test('C07 exploit FAILS on the fixed build (128-bit token + attempt limit)', async () => {
  const { server, baseUrl, events, restore } = await bootShop('fixed');
  try {
    const r = await runExploit({ baseUrl, name: 'c07', test: exploit, timeoutMs: 30000 });
    assert.equal(r.passed, false);
    assert.equal(r.failed, true, 'the fixed build defeats the brute force (clean fail)');
    assert.equal(events.some((e) => e.type === 'auth.password_reset_completed'), false, 'no takeover on the fixed build');
  } finally { server.close(); restore(); }
});
