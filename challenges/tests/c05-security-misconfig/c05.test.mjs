// C05 self-test: the verbose error + unauthenticated diagnostics page hold on the
// vulnerable build and fail on the fixed build (generic error + 404), and the
// ops.page_served / shop.verbose_error signals fire only on the vulnerable build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../../apps/shop/src/db/index.mjs';
import { migrate } from '../../../apps/shop/src/db/migrate.mjs';
import { seedAll } from '../../../apps/shop/seed/registry.mjs';
import { createApp } from '../../../apps/shop/src/app.mjs';
import { runExploit } from '../runner/run-exploit.mjs';
import exploit from './exploit.mjs';

const MARKER = 'C05-OPS-FLAG-MARKER';

async function bootShop(mode) {
  const db = openDb(':memory:');
  migrate(db);
  await seedAll(db);
  db.prepare("INSERT INTO sentinel (key, value) VALUES ('c05', ?)").run(MARKER);
  const events = [];
  const app = createApp({ db, emit: (type, data) => events.push({ type, data }), challenges: { C05: mode } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { db, server, baseUrl: `http://127.0.0.1:${server.address().port}`, events };
}

test('C05 exploit PASSES on the vulnerable build (verbose error + open diagnostics)', async () => {
  const { server, baseUrl, events } = await bootShop('vulnerable');
  try {
    assert.equal((await runExploit({ baseUrl, name: 'c05', test: exploit })).passed, true);
    assert.ok(events.some((e) => e.type === 'shop.verbose_error' && e.data.handler === 'c05_api'));
    assert.ok(events.some((e) => e.type === 'ops.page_served' && e.data.path === '/_ops/diagnostics'));
  } finally { server.close(); }
});

test('C05 exploit FAILS on the fixed build (generic error + /_ops 404)', async () => {
  const { server, baseUrl, events } = await bootShop('fixed');
  try {
    const r = await runExploit({ baseUrl, name: 'c05', test: exploit });
    assert.equal(r.passed, false);
    assert.equal(r.failed, true, 'fixed build is a clean fail');
    assert.equal(events.some((e) => e.type === 'ops.page_served'), false, 'no ops page served on the fixed build');
    // A broken request still answers — generically, with a correlation id.
    const res = await fetch(`${baseUrl}/api/cart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.correlation_id, 'fixed build returns a correlation id');
    assert.equal('stack' in body, false, 'no stack in the fixed error');
  } finally { server.close(); }
});
